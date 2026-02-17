import { createError, ErrorCode } from "../../lib/errors";
import { generateId, nowISO } from "../../lib/utils";
import type {
  Account,
  Asset,
  BrokerProvider,
  ListOrdersParams,
  MarketClock,
  MarketDay,
  Order,
  OrderParams,
  PortfolioHistory,
  PortfolioHistoryParams,
  Position,
} from "../types";
import { createKalshiClient, type KalshiClient } from "./client";

interface MockMarket {
  symbol: string;
  title: string;
  basePrice: number;
}

interface MockPositionState {
  qty: number;
  avgEntryPrice: number;
}

interface MockAccountState {
  startingCash: number;
  cash: number;
  lastEquity: number;
  positions: Record<string, MockPositionState>;
  orders: Record<string, Order>;
  equityHistory: Array<{ timestamp: number; equity: number }>;
}

interface KalshiBalanceResponse {
  balance?: number;
  available_balance?: number;
  portfolio_value?: number;
  [key: string]: unknown;
}

interface KalshiPositionRow {
  ticker: string;
  position: number;
  market_exposure?: number;
  total_traded?: number;
  [key: string]: unknown;
}

interface KalshiPositionsResponse {
  market_positions?: KalshiPositionRow[];
  cursor?: string | null;
}

interface KalshiMarket {
  ticker: string;
  title?: string;
  yes_ask?: number | null;
  yes_bid?: number | null;
  no_ask?: number | null;
  no_bid?: number | null;
  last_price?: number | null;
  status?: string;
  [key: string]: unknown;
}

interface KalshiMarketEnvelope {
  market?: KalshiMarket;
  markets?: KalshiMarket[];
  ticker?: string;
  title?: string;
  yes_ask?: number | null;
  yes_bid?: number | null;
  no_ask?: number | null;
  no_bid?: number | null;
  last_price?: number | null;
  status?: string;
}

interface KalshiOrderRaw {
  order_id: string;
  client_order_id?: string;
  ticker: string;
  side: "yes" | "no";
  action: "buy" | "sell";
  status: string;
  type?: string;
  initial_count?: number;
  remaining_count?: number;
  fill_count?: number;
  yes_price?: number | null;
  no_price?: number | null;
  created_time?: string;
  last_update_time?: string;
  expiration_time?: string | null;
  time_in_force?: string;
  [key: string]: unknown;
}

interface KalshiOrderEnvelope {
  order?: KalshiOrderRaw;
}

interface KalshiOrdersResponse {
  orders?: KalshiOrderRaw[];
  cursor?: string | null;
}

interface KalshiExchangeStatusResponse {
  trading_active?: boolean;
  exchange_estimated_resume_time?: string | null;
}

const MOCK_MARKETS: MockMarket[] = [
  { symbol: "USREC-2026", title: "US recession in 2026", basePrice: 0.41 },
  { symbol: "FEDCUT-2026Q2", title: "Fed cuts before Q2 end", basePrice: 0.58 },
  { symbol: "BTC-2026-120K", title: "BTC above 120k in 2026", basePrice: 0.37 },
  { symbol: "SNP-2026-6500", title: "S&P 500 above 6500 in 2026", basePrice: 0.46 },
];

const mockAccounts = new Map<string, MockAccountState>();

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function toOrderStatus(isRejected: boolean): Order["status"] {
  return isRejected ? "rejected" : "filled";
}

function toDollarsFromCents(cents: number): number {
  return round(cents / 100, 4);
}

function toCentsFromDollars(dollars: number): number {
  return Math.round(dollars * 100);
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function normalizeSymbol(symbol: string): string {
  return symbol.toUpperCase();
}

function buildEmptyAccount(id: string, cash: number, lastEquity: number): Account {
  return {
    id,
    account_number: id,
    status: "ACTIVE",
    currency: "USD",
    cash,
    buying_power: cash,
    regt_buying_power: cash,
    daytrading_buying_power: cash,
    equity: cash,
    last_equity: lastEquity,
    long_market_value: 0,
    short_market_value: 0,
    portfolio_value: cash,
    pattern_day_trader: false,
    trading_blocked: false,
    transfers_blocked: false,
    account_blocked: false,
    multiplier: "1",
    shorting_enabled: false,
    maintenance_margin: 0,
    initial_margin: 0,
    daytrade_count: 0,
    created_at: new Date().toISOString(),
  };
}

function marketPrice(symbol: string): number {
  const market = MOCK_MARKETS.find((m) => m.symbol === symbol);
  const base = market?.basePrice ?? 0.5;
  const minuteWave = Math.sin(Date.now() / 180000 + symbol.length) * 0.04;
  return clamp(round(base + minuteWave, 4), 0.03, 0.97);
}

function buildMockPosition(symbol: string, state: MockPositionState): Position {
  const currentPrice = marketPrice(symbol);
  const marketValue = round(state.qty * currentPrice, 2);
  const costBasis = round(state.qty * state.avgEntryPrice, 2);
  const unrealizedPl = round(marketValue - costBasis, 2);
  const unrealizedPlpc = costBasis > 0 ? unrealizedPl / costBasis : 0;
  const lastDayPrice = clamp(round(currentPrice - 0.015, 4), 0.01, 0.99);
  const changeToday = lastDayPrice > 0 ? (currentPrice - lastDayPrice) / lastDayPrice : 0;

  return {
    asset_id: `kalshi-${symbol}`,
    symbol,
    exchange: "KALSHI",
    asset_class: "prediction_contract",
    avg_entry_price: round(state.avgEntryPrice, 4),
    qty: round(state.qty, 6),
    side: "long",
    market_value: marketValue,
    cost_basis: costBasis,
    unrealized_pl: unrealizedPl,
    unrealized_plpc: unrealizedPlpc,
    unrealized_intraday_pl: unrealizedPl,
    unrealized_intraday_plpc: unrealizedPlpc,
    current_price: currentPrice,
    lastday_price: lastDayPrice,
    change_today: changeToday,
    prediction_outcome: "yes",
    prediction_probability: currentPrice,
  };
}

function getMockAccountState(accountId: string, startingCash: number): MockAccountState {
  const existing = mockAccounts.get(accountId);
  if (existing) return existing;

  const now = Date.now();
  const created: MockAccountState = {
    startingCash,
    cash: startingCash,
    lastEquity: startingCash,
    positions: {},
    orders: {},
    equityHistory: [{ timestamp: now, equity: startingCash }],
  };
  mockAccounts.set(accountId, created);
  return created;
}

function buildMockOrder(params: {
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  filledQty: number;
  fillPrice: number;
  type: OrderParams["type"];
  timeInForce: OrderParams["time_in_force"];
  status: Order["status"];
}): Order {
  const now = nowISO();
  return {
    id: generateId(),
    client_order_id: `kalshi-${generateId().slice(0, 12)}`,
    symbol: params.symbol,
    asset_id: `kalshi-${params.symbol}`,
    asset_class: "prediction_contract",
    qty: String(params.qty),
    filled_qty: String(params.filledQty),
    filled_avg_price: params.filledQty > 0 ? String(params.fillPrice) : null,
    order_class: "simple",
    order_type: params.type,
    type: params.type,
    side: params.side,
    time_in_force: params.timeInForce,
    limit_price: null,
    stop_price: null,
    status: params.status,
    extended_hours: true,
    created_at: now,
    updated_at: now,
    submitted_at: now,
    filled_at: params.filledQty > 0 ? now : null,
    expired_at: null,
    canceled_at: null,
    failed_at: params.status === "rejected" ? now : null,
  };
}

function mapKalshiStatus(raw: string, remainingCount: number, fillCount: number): Order["status"] {
  const status = raw.toLowerCase();
  if (status.includes("cancel")) return "canceled";
  if (status.includes("reject") || status.includes("error") || status.includes("fail")) return "rejected";
  if (status.includes("execut") || status.includes("filled") || status.includes("complete")) return "filled";
  if (fillCount > 0 && remainingCount > 0) return "partially_filled";
  if (status.includes("open") || status.includes("rest")) return "new";
  return "accepted";
}

function mapKalshiTimeInForce(raw?: string): Order["time_in_force"] {
  const tif = (raw || "").toLowerCase();
  if (tif === "immediate_or_cancel") return "ioc";
  if (tif === "fill_or_kill") return "fok";
  return "gtc";
}

function mapGenericTimeInForce(
  raw: OrderParams["time_in_force"]
): "good_till_canceled" | "immediate_or_cancel" | "fill_or_kill" {
  if (raw === "ioc") return "immediate_or_cancel";
  if (raw === "fok") return "fill_or_kill";
  return "good_till_canceled";
}

function mapPositionSide(position: number): "yes" | "no" {
  return position >= 0 ? "yes" : "no";
}

function deriveNoPriceFromYes(yesPriceCents: number | null | undefined): number | null {
  if (yesPriceCents === null || yesPriceCents === undefined) return null;
  return clamp(100 - yesPriceCents, 1, 99);
}

function markPriceCents(market: KalshiMarket | null, contractSide: "yes" | "no"): number {
  if (!market) return 50;

  const bid =
    contractSide === "yes"
      ? asNumber(market.yes_bid ?? null, Number.NaN)
      : asNumber(market.no_bid ?? deriveNoPriceFromYes(asNumber(market.yes_ask ?? null, Number.NaN)), Number.NaN);
  const ask =
    contractSide === "yes"
      ? asNumber(market.yes_ask ?? null, Number.NaN)
      : asNumber(market.no_ask ?? deriveNoPriceFromYes(asNumber(market.yes_bid ?? null, Number.NaN)), Number.NaN);

  if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
    return clamp(Math.round((bid + ask) / 2), 1, 99);
  }
  if (Number.isFinite(ask) && ask > 0) return clamp(Math.round(ask), 1, 99);
  if (Number.isFinite(bid) && bid > 0) return clamp(Math.round(bid), 1, 99);

  const lastPrice = asNumber(market.last_price ?? null, Number.NaN);
  if (Number.isFinite(lastPrice) && lastPrice > 0) {
    if (contractSide === "yes") return clamp(Math.round(lastPrice), 1, 99);
    return clamp(Math.round(100 - lastPrice), 1, 99);
  }

  return 50;
}

function quotePriceCents(market: KalshiMarket | null, contractSide: "yes" | "no", action: "buy" | "sell"): number {
  if (!market) return action === "buy" ? 55 : 45;

  const bestBid =
    contractSide === "yes" ? asNumber(market.yes_bid ?? null, Number.NaN) : asNumber(market.no_bid ?? null, Number.NaN);
  const bestAsk =
    contractSide === "yes" ? asNumber(market.yes_ask ?? null, Number.NaN) : asNumber(market.no_ask ?? null, Number.NaN);

  if (action === "buy") {
    if (Number.isFinite(bestAsk) && bestAsk > 0) return clamp(Math.round(bestAsk), 1, 99);
    if (Number.isFinite(bestBid) && bestBid > 0) return clamp(Math.round(bestBid), 1, 99);
  } else {
    if (Number.isFinite(bestBid) && bestBid > 0) return clamp(Math.round(bestBid), 1, 99);
    if (Number.isFinite(bestAsk) && bestAsk > 0) return clamp(Math.round(bestAsk), 1, 99);
  }

  return markPriceCents(market, contractSide);
}

function pickKalshiBalanceCents(balance: KalshiBalanceResponse): number {
  const candidates = [
    asNumber(balance.available_balance, Number.NaN),
    asNumber(balance.balance, Number.NaN),
    asNumber(balance.cash, Number.NaN),
  ];
  const selected = candidates.find((v) => Number.isFinite(v) && v >= 0);
  return selected !== undefined ? selected : 0;
}

function pickKalshiPortfolioValueCents(balance: KalshiBalanceResponse): number | null {
  const value = asNumber(balance.portfolio_value, Number.NaN);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

function unwrapMarket(symbol: string, payload: unknown): KalshiMarket | null {
  if (!payload || typeof payload !== "object") return null;
  const body = payload as KalshiMarketEnvelope;

  if (body.market && typeof body.market === "object") {
    return { ...body.market, ticker: body.market.ticker || symbol };
  }
  if (Array.isArray(body.markets) && body.markets.length > 0) {
    return body.markets[0] ?? null;
  }
  if (typeof body.ticker === "string") {
    return {
      ticker: body.ticker,
      title: body.title,
      yes_ask: body.yes_ask,
      yes_bid: body.yes_bid,
      no_ask: body.no_ask,
      no_bid: body.no_bid,
      last_price: body.last_price,
      status: body.status,
    };
  }
  return null;
}

function unwrapOrder(payload: unknown): KalshiOrderRaw {
  if (!payload || typeof payload !== "object") {
    throw createError(ErrorCode.PROVIDER_ERROR, "Kalshi order response was empty");
  }

  const envelope = payload as KalshiOrderEnvelope;
  if (envelope.order && typeof envelope.order === "object") {
    return envelope.order;
  }

  const raw = payload as KalshiOrderRaw;
  if (typeof raw.order_id === "string") {
    return raw;
  }

  throw createError(ErrorCode.PROVIDER_ERROR, "Kalshi order response did not include an order object");
}

function toProviderOrder(raw: KalshiOrderRaw): Order {
  const now = nowISO();
  const remaining = Math.max(0, asNumber(raw.remaining_count, 0));
  const fillCount = Math.max(0, asNumber(raw.fill_count, asNumber(raw.initial_count, 0) - remaining));
  const initialCount = Math.max(fillCount + remaining, asNumber(raw.initial_count, 0));
  const priceCents = raw.side === "no" ? asNumber(raw.no_price, Number.NaN) : asNumber(raw.yes_price, Number.NaN);
  const parsedPrice = Number.isFinite(priceCents) ? toDollarsFromCents(priceCents) : null;
  const status = mapKalshiStatus(raw.status, remaining, fillCount);
  const createdAt = raw.created_time || now;
  const updatedAt = raw.last_update_time || createdAt;

  return {
    id: raw.order_id,
    client_order_id: raw.client_order_id || `kalshi-${raw.order_id}`,
    symbol: raw.ticker,
    asset_id: `kalshi-${raw.ticker}`,
    asset_class: "prediction_contract",
    qty: String(initialCount),
    filled_qty: String(fillCount),
    filled_avg_price: parsedPrice !== null ? String(parsedPrice) : null,
    order_class: "simple",
    order_type: (raw.type || "limit") as Order["order_type"],
    type: (raw.type || "limit") as Order["type"],
    side: raw.action,
    time_in_force: mapKalshiTimeInForce(raw.time_in_force),
    limit_price: parsedPrice !== null ? String(parsedPrice) : null,
    stop_price: null,
    status,
    extended_hours: true,
    created_at: createdAt,
    updated_at: updatedAt,
    submitted_at: createdAt,
    filled_at: status === "filled" || status === "partially_filled" ? updatedAt : null,
    expired_at: raw.expiration_time ?? null,
    canceled_at: status === "canceled" ? updatedAt : null,
    failed_at: status === "rejected" ? updatedAt : null,
  };
}

export interface KalshiTradingProviderOptions {
  accountId?: string;
  mockMode: boolean;
  mockStartingCash: number;
  liveClient?: KalshiClient | null;
}

/**
 * Kalshi trading provider.
 * - mockMode=true: in-memory simulated trading for local development
 * - mockMode=false: signed REST calls to Kalshi Trade API v2
 */
export class KalshiTradingProvider implements BrokerProvider {
  private readonly accountId: string;
  private readonly liveClient: KalshiClient | null;
  private liveLastEquity: number | null = null;
  private liveEquityHistory: Array<{ timestamp: number; equity: number }> = [];

  constructor(private options: KalshiTradingProviderOptions) {
    this.accountId = options.accountId || "kalshi-mock-account";
    this.liveClient = options.liveClient || null;
  }

  private get state(): MockAccountState {
    return getMockAccountState(this.accountId, this.options.mockStartingCash);
  }

  private getClient(): KalshiClient {
    if (!this.liveClient) {
      throw createError(
        ErrorCode.INVALID_INPUT,
        "Kalshi live mode client is not configured. Set KALSHI_API_KEY_ID and KALSHI_API_PRIVATE_KEY."
      );
    }
    return this.liveClient;
  }

  private collectMockPositions(): Position[] {
    return Object.entries(this.state.positions)
      .filter(([, p]) => p.qty > 0)
      .map(([symbol, p]) => buildMockPosition(symbol, p));
  }

  private markMockEquityPoint(equity: number): void {
    const now = Date.now();
    const prev = this.state.equityHistory[this.state.equityHistory.length - 1];
    if (prev && now - prev.timestamp < 60_000) {
      prev.timestamp = now;
      prev.equity = equity;
      return;
    }
    this.state.equityHistory.push({ timestamp: now, equity });
    if (this.state.equityHistory.length > 500) {
      this.state.equityHistory = this.state.equityHistory.slice(-500);
    }
  }

  private markLiveEquityPoint(equity: number): void {
    const now = Date.now();
    const prev = this.liveEquityHistory[this.liveEquityHistory.length - 1];
    if (prev && now - prev.timestamp < 60_000) {
      prev.timestamp = now;
      prev.equity = equity;
      return;
    }
    this.liveEquityHistory.push({ timestamp: now, equity });
    if (this.liveEquityHistory.length > 500) {
      this.liveEquityHistory = this.liveEquityHistory.slice(-500);
    }
  }

  private async getAllLivePositions(): Promise<KalshiPositionRow[]> {
    const client = this.getClient();
    const all: KalshiPositionRow[] = [];
    let cursor: string | undefined;

    while (true) {
      const response = await client.get<KalshiPositionsResponse>("/trade-api/v2/portfolio/positions", {
        limit: 200,
        cursor,
      });
      const page = response.market_positions ?? [];
      all.push(...page);
      cursor = response.cursor || undefined;
      if (!cursor) break;
    }

    return all;
  }

  private async getLiveMarket(symbol: string): Promise<KalshiMarket | null> {
    const client = this.getClient();
    try {
      const payload = await client.get<unknown>(`/trade-api/v2/markets/${encodeURIComponent(symbol)}`);
      return unwrapMarket(symbol, payload);
    } catch (error) {
      if ((error as { code?: string }).code === ErrorCode.NOT_FOUND) {
        return null;
      }
      throw error;
    }
  }

  private toLivePosition(row: KalshiPositionRow, market: KalshiMarket | null): Position {
    const signedPosition = asNumber(row.position, 0);
    const quantity = Math.abs(signedPosition);
    const contractSide = mapPositionSide(signedPosition);
    const markCents = markPriceCents(market, contractSide);
    const yesProbCents = markPriceCents(market, "yes");

    const costBasisCents = Math.abs(asNumber(row.total_traded, 0));
    const fallbackCostBasisCents = Math.round(markCents * quantity);
    const normalizedCostBasisCents = costBasisCents > 0 ? costBasisCents : fallbackCostBasisCents;

    const avgEntryPrice = quantity > 0 ? toDollarsFromCents(normalizedCostBasisCents / quantity) : 0;
    const marketValue = toDollarsFromCents(markCents * quantity);
    const costBasis = toDollarsFromCents(normalizedCostBasisCents);
    const unrealizedPl = round(marketValue - costBasis, 4);
    const unrealizedPlpc = costBasis > 0 ? unrealizedPl / costBasis : 0;

    return {
      asset_id: `kalshi-${row.ticker}`,
      symbol: row.ticker,
      exchange: "KALSHI",
      asset_class: "prediction_contract",
      avg_entry_price: avgEntryPrice,
      qty: quantity,
      side: "long",
      market_value: marketValue,
      cost_basis: costBasis,
      unrealized_pl: unrealizedPl,
      unrealized_plpc: unrealizedPlpc,
      unrealized_intraday_pl: unrealizedPl,
      unrealized_intraday_plpc: unrealizedPlpc,
      current_price: toDollarsFromCents(markCents),
      lastday_price: toDollarsFromCents(markCents),
      change_today: 0,
      prediction_outcome: contractSide,
      prediction_probability: toDollarsFromCents(yesProbCents),
    };
  }

  private async placeLiveOrder(params: OrderParams, contractSide: "yes" | "no" = "yes"): Promise<Order> {
    if (!["market", "limit"].includes(params.type)) {
      throw createError(
        ErrorCode.NOT_SUPPORTED,
        `Kalshi provider only supports market/limit orders (received: ${params.type})`
      );
    }

    const client = this.getClient();
    const symbol = normalizeSymbol(params.symbol);
    const market = await this.getLiveMarket(symbol);

    let count = params.qty ? Math.floor(params.qty) : 0;
    if (count <= 0 && params.notional !== undefined) {
      const quoteCents = quotePriceCents(market, contractSide, params.side);
      if (quoteCents <= 0) {
        throw createError(ErrorCode.INVALID_INPUT, "Unable to derive Kalshi quote for notional-based order");
      }
      count = Math.floor((params.notional * 100) / quoteCents);
    }

    if (!Number.isFinite(count) || count <= 0) {
      throw createError(ErrorCode.INVALID_INPUT, "Order quantity must be > 0 for Kalshi order placement");
    }

    const quoteCents = quotePriceCents(market, contractSide, params.side);
    const requestedLimitCents = params.limit_price !== undefined ? toCentsFromDollars(params.limit_price) : quoteCents;

    // Kalshi market orders are emulated as aggressive limits for predictable fill behavior.
    const aggressiveLimit =
      params.type === "market"
        ? params.side === "buy"
          ? requestedLimitCents + 2
          : requestedLimitCents - 2
        : requestedLimitCents;
    const finalLimitCents = clamp(Math.round(aggressiveLimit), 1, 99);

    const body: Record<string, unknown> = {
      action: params.side,
      client_order_id: params.client_order_id || `mah-${generateId().slice(0, 24)}`,
      count,
      side: contractSide,
      ticker: symbol,
      type: "limit",
      time_in_force: mapGenericTimeInForce(params.time_in_force),
    };

    if (contractSide === "yes") {
      body.yes_price = finalLimitCents;
    } else {
      body.no_price = finalLimitCents;
    }

    const payload = await client.post<unknown>("/trade-api/v2/portfolio/orders", body);
    const raw = unwrapOrder(payload);
    return toProviderOrder(raw);
  }

  async getAccount(): Promise<Account> {
    if (this.options.mockMode) {
      const positions = this.collectMockPositions();
      const longValue = round(
        positions.reduce((sum, p) => sum + p.market_value, 0),
        2
      );
      const equity = round(this.state.cash + longValue, 2);
      const account = buildEmptyAccount(this.accountId, round(this.state.cash, 2), this.state.lastEquity);
      account.long_market_value = longValue;
      account.portfolio_value = equity;
      account.equity = equity;
      account.last_equity = this.state.lastEquity;
      account.buying_power = round(this.state.cash, 2);
      account.regt_buying_power = round(this.state.cash, 2);
      account.daytrading_buying_power = round(this.state.cash, 2);
      this.state.lastEquity = equity;
      this.markMockEquityPoint(equity);
      return account;
    }

    const client = this.getClient();
    const [balancePayload, positions] = await Promise.all([
      client.get<KalshiBalanceResponse>("/trade-api/v2/portfolio/balance"),
      this.getPositions(),
    ]);

    const cash = toDollarsFromCents(pickKalshiBalanceCents(balancePayload));
    const longValue = round(
      positions.reduce((sum, p) => sum + p.market_value, 0),
      2
    );
    const portfolioValueCents = pickKalshiPortfolioValueCents(balancePayload);
    const portfolioValue =
      portfolioValueCents !== null ? toDollarsFromCents(portfolioValueCents) : round(cash + longValue, 2);
    const lastEquity = this.liveLastEquity ?? portfolioValue;

    const account = buildEmptyAccount(this.accountId, cash, lastEquity);
    account.long_market_value = longValue;
    account.equity = portfolioValue;
    account.portfolio_value = portfolioValue;
    account.last_equity = lastEquity;
    account.buying_power = cash;
    account.regt_buying_power = cash;
    account.daytrading_buying_power = cash;

    this.liveLastEquity = portfolioValue;
    this.markLiveEquityPoint(portfolioValue);
    return account;
  }

  async getPositions(): Promise<Position[]> {
    if (this.options.mockMode) {
      return this.collectMockPositions();
    }

    const rows = await this.getAllLivePositions();
    if (rows.length === 0) return [];

    const normalizedRows = rows.filter((row) => Math.abs(asNumber(row.position, 0)) > 0);
    const markets = await Promise.all(normalizedRows.map((row) => this.getLiveMarket(row.ticker)));

    return normalizedRows.map((row, idx) => this.toLivePosition(row, markets[idx] ?? null));
  }

  async getPosition(symbol: string): Promise<Position | null> {
    const normalized = normalizeSymbol(symbol);
    const positions = await this.getPositions();
    return positions.find((p) => normalizeSymbol(p.symbol) === normalized) ?? null;
  }

  async closePosition(symbol: string, qty?: number, percentage?: number): Promise<Order> {
    if (this.options.mockMode) {
      const current = this.state.positions[symbol];
      if (!current || current.qty <= 0) {
        const rejected = buildMockOrder({
          symbol,
          side: "sell",
          qty: qty ?? 0,
          filledQty: 0,
          fillPrice: marketPrice(symbol),
          type: "market",
          timeInForce: "ioc",
          status: "rejected",
        });
        this.state.orders[rejected.id] = rejected;
        return rejected;
      }

      let sellQty = qty ?? current.qty;
      if (percentage !== undefined) {
        sellQty = round(current.qty * (percentage / 100), 6);
      }

      return this.createOrder({
        symbol,
        side: "sell",
        qty: clamp(sellQty, 0, current.qty),
        type: "market",
        time_in_force: "ioc",
      });
    }

    const normalized = normalizeSymbol(symbol);
    const rows = await this.getAllLivePositions();
    const row = rows.find((entry) => normalizeSymbol(entry.ticker) === normalized);

    if (!row || Math.abs(asNumber(row.position, 0)) <= 0) {
      throw createError(ErrorCode.NOT_FOUND, `No open Kalshi position for ${symbol}`);
    }

    const currentQty = Math.abs(asNumber(row.position, 0));
    let closeQty = qty ? Math.floor(qty) : currentQty;

    if (percentage !== undefined) {
      closeQty = Math.floor(currentQty * (percentage / 100));
    }

    if (closeQty <= 0) {
      throw createError(ErrorCode.INVALID_INPUT, "Close quantity resolved to zero");
    }

    return this.placeLiveOrder(
      {
        symbol: normalized,
        side: "sell",
        qty: closeQty,
        type: "market",
        time_in_force: "ioc",
      },
      mapPositionSide(asNumber(row.position, 0))
    );
  }

  async createOrder(params: OrderParams): Promise<Order> {
    if (this.options.mockMode) {
      const symbol = params.symbol;
      const side = params.side;
      const fillPrice = params.limit_price ?? marketPrice(symbol);
      let orderQty = params.qty ?? 0;

      if (orderQty <= 0 && params.notional && fillPrice > 0) {
        orderQty = round(params.notional / fillPrice, 6);
      }

      if (!Number.isFinite(orderQty) || orderQty <= 0) {
        const rejected = buildMockOrder({
          symbol,
          side,
          qty: 0,
          filledQty: 0,
          fillPrice,
          type: params.type,
          timeInForce: params.time_in_force,
          status: "rejected",
        });
        this.state.orders[rejected.id] = rejected;
        return rejected;
      }

      let filledQty = orderQty;
      let rejected = false;
      const existing = this.state.positions[symbol] ?? { qty: 0, avgEntryPrice: fillPrice };

      if (side === "buy") {
        const cost = round(orderQty * fillPrice, 2);
        if (cost > this.state.cash) {
          filledQty = round(this.state.cash / fillPrice, 6);
        }
        if (!Number.isFinite(filledQty) || filledQty <= 0) {
          rejected = true;
        } else {
          const finalCost = round(filledQty * fillPrice, 2);
          const nextQty = existing.qty + filledQty;
          const nextAvg = nextQty > 0 ? (existing.qty * existing.avgEntryPrice + filledQty * fillPrice) / nextQty : 0;

          this.state.cash = round(this.state.cash - finalCost, 2);
          this.state.positions[symbol] = {
            qty: round(nextQty, 6),
            avgEntryPrice: round(nextAvg, 6),
          };
        }
      } else {
        const available = existing.qty;
        if (available <= 0) {
          rejected = true;
          filledQty = 0;
        } else {
          filledQty = clamp(filledQty, 0, available);
          const proceeds = round(filledQty * fillPrice, 2);
          const remainingQty = round(available - filledQty, 6);
          this.state.cash = round(this.state.cash + proceeds, 2);
          if (remainingQty <= 0) {
            delete this.state.positions[symbol];
          } else {
            this.state.positions[symbol] = {
              qty: remainingQty,
              avgEntryPrice: existing.avgEntryPrice,
            };
          }
        }
      }

      const order = buildMockOrder({
        symbol,
        side,
        qty: round(orderQty, 6),
        filledQty: round(filledQty, 6),
        fillPrice: round(fillPrice, 6),
        type: params.type,
        timeInForce: params.time_in_force,
        status: toOrderStatus(rejected),
      });
      this.state.orders[order.id] = order;
      return order;
    }

    return this.placeLiveOrder(params, "yes");
  }

  async getOrder(orderId: string): Promise<Order> {
    if (this.options.mockMode) {
      const order = this.state.orders[orderId];
      if (!order) {
        throw createError(ErrorCode.NOT_FOUND, `Order not found: ${orderId}`);
      }
      return order;
    }

    const client = this.getClient();
    const payload = await client.get<unknown>(`/trade-api/v2/portfolio/orders/${encodeURIComponent(orderId)}`);
    return toProviderOrder(unwrapOrder(payload));
  }

  async listOrders(params?: ListOrdersParams): Promise<Order[]> {
    if (this.options.mockMode) {
      let orders = Object.values(this.state.orders);
      if (params?.symbols?.length) {
        const allowed = new Set(params.symbols.map((s) => s.toUpperCase()));
        orders = orders.filter((o) => allowed.has(o.symbol.toUpperCase()));
      }
      if (params?.status === "open") {
        orders = orders.filter((o) => o.status === "new" || o.status === "pending_new");
      }
      if (params?.status === "closed") {
        orders = orders.filter((o) => !["new", "pending_new"].includes(o.status));
      }
      const sorted = orders.sort((a, b) => b.created_at.localeCompare(a.created_at));
      if (params?.limit && params.limit > 0) {
        return sorted.slice(0, params.limit);
      }
      return sorted;
    }

    const client = this.getClient();
    const targetLimit = Math.max(1, Math.min(params?.limit ?? 200, 1000));
    const orders: Order[] = [];
    let cursor: string | undefined;

    while (true) {
      const page = await client.get<KalshiOrdersResponse>("/trade-api/v2/portfolio/orders", {
        limit: Math.min(targetLimit, 200),
        cursor,
      });

      const batch = (page.orders ?? []).map((raw) => toProviderOrder(raw));
      orders.push(...batch);

      cursor = page.cursor || undefined;
      if (!cursor || orders.length >= targetLimit) break;
    }

    let filtered = orders;
    if (params?.symbols?.length) {
      const symbols = new Set(params.symbols.map((s) => normalizeSymbol(s)));
      filtered = filtered.filter((order) => symbols.has(normalizeSymbol(order.symbol)));
    }

    if (params?.status === "open") {
      filtered = filtered.filter((order) => order.status === "new" || order.status === "pending_new");
    }
    if (params?.status === "closed") {
      filtered = filtered.filter((order) => !["new", "pending_new"].includes(order.status));
    }

    const sorted = filtered.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return params?.limit ? sorted.slice(0, params.limit) : sorted;
  }

  async cancelOrder(orderId: string): Promise<void> {
    if (this.options.mockMode) {
      const order = this.state.orders[orderId];
      if (!order) return;
      order.status = "canceled";
      order.canceled_at = nowISO();
      order.updated_at = order.canceled_at;
      return;
    }

    const client = this.getClient();
    await client.delete<void>(`/trade-api/v2/portfolio/orders/${encodeURIComponent(orderId)}`);
  }

  async cancelAllOrders(): Promise<void> {
    const orderIds = (await this.listOrders({ status: "open", limit: 500 })).map((order) => order.id);
    for (const id of orderIds) {
      await this.cancelOrder(id);
    }
  }

  async getClock(): Promise<MarketClock> {
    if (this.options.mockMode) {
      const now = new Date();
      const nextClose = new Date(now.getTime() + 60 * 60 * 1000);
      return {
        timestamp: now.toISOString(),
        is_open: true,
        next_open: now.toISOString(),
        next_close: nextClose.toISOString(),
      };
    }

    const client = this.getClient();
    const status = await client.get<KalshiExchangeStatusResponse>("/trade-api/v2/exchange/status");
    const nowIso = new Date().toISOString();
    const estimatedResume = status.exchange_estimated_resume_time || null;
    const isOpen = status.trading_active !== false;

    return {
      timestamp: nowIso,
      is_open: isOpen,
      next_open: !isOpen && estimatedResume ? estimatedResume : nowIso,
      next_close: isOpen && estimatedResume ? estimatedResume : nowIso,
    };
  }

  async getCalendar(_start: string, _end: string): Promise<MarketDay[]> {
    return [];
  }

  async getAsset(symbol: string): Promise<Asset | null> {
    if (this.options.mockMode) {
      const market = MOCK_MARKETS.find((m) => m.symbol.toUpperCase() === symbol.toUpperCase());
      if (!market) return null;
      return {
        id: `kalshi-${market.symbol}`,
        class: "prediction_contract",
        exchange: "KALSHI",
        symbol: market.symbol,
        name: market.title,
        status: "active",
        tradable: true,
        marginable: false,
        shortable: false,
        fractionable: true,
      };
    }

    const market = await this.getLiveMarket(normalizeSymbol(symbol));
    if (!market) return null;

    const status = (market.status || "active").toLowerCase();
    const tradable = ["open", "active", "initialized", "listed"].includes(status);

    return {
      id: `kalshi-${market.ticker}`,
      class: "prediction_contract",
      exchange: "KALSHI",
      symbol: market.ticker,
      name: market.title || market.ticker,
      status: tradable ? "active" : "inactive",
      tradable,
      marginable: false,
      shortable: false,
      fractionable: true,
    };
  }

  async getPortfolioHistory(_params?: PortfolioHistoryParams): Promise<PortfolioHistory> {
    if (this.options.mockMode) {
      await this.getAccount();
      const series = this.state.equityHistory.slice(-200);
      const base = series[0]?.equity ?? this.state.startingCash;
      const timestamps = series.map((p) => Math.floor(p.timestamp / 1000));
      const equity = series.map((p) => round(p.equity, 2));
      const profit_loss = equity.map((v) => round(v - base, 2));
      const profit_loss_pct = equity.map((v) => (base > 0 ? round((v - base) / base, 6) : 0));

      return {
        timestamp: timestamps,
        equity,
        profit_loss,
        profit_loss_pct,
        base_value: round(base, 2),
        base_value_asof: new Date(series[0]?.timestamp ?? Date.now()).toISOString(),
        timeframe: "prediction-market",
      };
    }

    await this.getAccount();
    const series = this.liveEquityHistory.slice(-200);
    const base = series[0]?.equity ?? this.liveLastEquity ?? 0;
    const timestamps = series.map((p) => Math.floor(p.timestamp / 1000));
    const equity = series.map((p) => round(p.equity, 2));
    const profit_loss = equity.map((v) => round(v - base, 2));
    const profit_loss_pct = equity.map((v) => (base > 0 ? round((v - base) / base, 6) : 0));

    return {
      timestamp: timestamps,
      equity,
      profit_loss,
      profit_loss_pct,
      base_value: round(base, 2),
      base_value_asof: new Date(series[0]?.timestamp ?? Date.now()).toISOString(),
      timeframe: "prediction-market",
    };
  }
}

export function createKalshiTradingProvider(options: KalshiTradingProviderOptions): KalshiTradingProvider {
  return new KalshiTradingProvider(options);
}

export function createDefaultKalshiLiveClientFromEnv(params: {
  accessKeyId?: string;
  privateKey?: string;
  baseUrl?: string;
}): KalshiClient | null {
  if (!params.accessKeyId || !params.privateKey) return null;
  return createKalshiClient({
    accessKeyId: params.accessKeyId,
    privateKey: params.privateKey,
    baseUrl: params.baseUrl,
  });
}
