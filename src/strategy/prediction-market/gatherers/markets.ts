import type { Signal } from "../../../core/types";
import { createError, ErrorCode } from "../../../lib/errors";
import { createKalshiClient } from "../../../providers/kalshi/client";
import type { Gatherer, StrategyContext } from "../../types";

interface KalshiMarketPayload {
  market?: {
    ticker?: string;
    title?: string;
    yes_bid?: number | null;
    yes_ask?: number | null;
    last_price?: number | null;
    status?: string;
  };
  ticker?: string;
  title?: string;
  yes_bid?: number | null;
  yes_ask?: number | null;
  last_price?: number | null;
  status?: string;
}

interface PredictionMarketState {
  lastProbability: number;
  emaProbability: number;
  updatedAt: number;
}

type PredictionStateMap = Record<string, PredictionMarketState>;

const DEFAULT_WATCHLIST = ["USREC-2026", "FEDCUT-2026Q2", "BTC-2026-120K", "SNP-2026-6500"];
const EMA_ALPHA = 0.2;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function asFinite(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseWatchlist(raw: string | undefined, fallback: string[]): string[] {
  if (!raw || raw.trim().length === 0) return fallback;
  const parts = raw
    .split(",")
    .map((entry) => entry.trim().toUpperCase())
    .filter((entry) => entry.length > 0);
  return parts.length > 0 ? Array.from(new Set(parts)) : fallback;
}

function deterministicMockProbability(symbol: string): number {
  let hash = 0;
  for (const ch of symbol) {
    hash = (hash * 31 + ch.charCodeAt(0)) % 10000;
  }
  const base = 0.2 + (hash % 6000) / 10000;
  const oscillation = Math.sin(Date.now() / 240000 + hash / 333) * 0.04;
  return clamp(base + oscillation, 0.03, 0.97);
}

function parseMarketProbability(payload: KalshiMarketPayload): {
  probability: number | null;
  spreadCents: number | null;
  status: string | null;
} {
  const market = payload.market ?? payload;
  const yesBid = asFinite(market.yes_bid);
  const yesAsk = asFinite(market.yes_ask);
  const lastPrice = asFinite(market.last_price);

  let probability: number | null = null;
  if (yesBid !== null && yesAsk !== null && yesBid > 0 && yesAsk > 0) {
    probability = (yesBid + yesAsk) / 200;
  } else if (yesAsk !== null && yesAsk > 0) {
    probability = yesAsk / 100;
  } else if (yesBid !== null && yesBid > 0) {
    probability = yesBid / 100;
  } else if (lastPrice !== null && lastPrice > 0) {
    probability = lastPrice / 100;
  }

  if (probability !== null) {
    probability = clamp(probability, 0.01, 0.99);
  }

  const spreadCents =
    yesBid !== null && yesAsk !== null && yesBid > 0 && yesAsk > 0 ? Math.max(0, Math.round(yesAsk - yesBid)) : null;
  const status = typeof market.status === "string" ? market.status : null;

  return { probability, spreadCents, status };
}

function computeSentiment(
  probability: number,
  previous: PredictionMarketState | undefined
): {
  sentiment: number;
  rawSentiment: number;
  momentum: number;
  edge: number;
  nextState: PredictionMarketState;
} {
  const now = Date.now();
  const previousProbability = previous?.lastProbability ?? probability;
  const previousEma = previous?.emaProbability ?? probability;
  const momentum = probability - previousProbability;
  const ema = previousEma * (1 - EMA_ALPHA) + probability * EMA_ALPHA;
  const edge = ema - probability;

  // Mean reversion bias with light momentum confirmation.
  const edgeScore = clamp(edge / 0.08, -1, 1);
  const momentumScore = clamp(momentum / 0.03, -1, 1);
  const sentiment = clamp(edgeScore * 0.75 + momentumScore * 0.25, -1, 1);

  return {
    sentiment,
    rawSentiment: Math.max(0, sentiment),
    momentum,
    edge,
    nextState: {
      lastProbability: probability,
      emaProbability: ema,
      updatedAt: now,
    },
  };
}

async function fetchLiveProbability(
  ctx: StrategyContext,
  symbol: string
): Promise<{
  probability: number | null;
  spreadCents: number | null;
  status: string | null;
}> {
  if (!ctx.env.KALSHI_API_KEY_ID || !ctx.env.KALSHI_API_PRIVATE_KEY) {
    throw createError(
      ErrorCode.INVALID_INPUT,
      "KALSHI_API_KEY_ID and KALSHI_API_PRIVATE_KEY are required for live prediction gatherer"
    );
  }

  const client = createKalshiClient({
    accessKeyId: ctx.env.KALSHI_API_KEY_ID,
    privateKey: ctx.env.KALSHI_API_PRIVATE_KEY,
    baseUrl: ctx.env.KALSHI_BASE_URL,
  });

  const payload = await client.get<KalshiMarketPayload>(`/trade-api/v2/markets/${encodeURIComponent(symbol)}`);
  return parseMarketProbability(payload);
}

async function buildSignal(
  ctx: StrategyContext,
  symbol: string,
  previous: PredictionMarketState | undefined
): Promise<{ signal: Signal | null; nextState: PredictionMarketState | null }> {
  const isMockMode = (ctx.env.KALSHI_MOCK_MODE || "true").toLowerCase() !== "false";
  let probability: number | null = null;
  let spreadCents: number | null = null;
  let status: string | null = null;

  if (isMockMode) {
    probability = deterministicMockProbability(symbol);
    spreadCents = 5;
    status = "open";
  } else {
    const live = await fetchLiveProbability(ctx, symbol);
    probability = live.probability;
    spreadCents = live.spreadCents;
    status = live.status;
  }

  if (probability === null) {
    return { signal: null, nextState: null };
  }

  if (status && !["open", "active", "initialized", "listed"].includes(status.toLowerCase())) {
    return { signal: null, nextState: null };
  }

  const computed = computeSentiment(probability, previous);
  const spreadPenalty = spreadCents !== null ? clamp(1 - spreadCents / 25, 0.3, 1) : 0.7;
  const quality = clamp((Math.abs(computed.sentiment) * 0.7 + spreadPenalty * 0.3) * 100, 0, 100);
  const volume = spreadCents !== null ? Math.max(10, 150 - spreadCents * 4) : 80;

  const signal: Signal = {
    symbol,
    source: "prediction_market",
    source_detail: "kalshi_probability_edge",
    sentiment: computed.sentiment,
    raw_sentiment: computed.rawSentiment,
    volume,
    freshness: 1,
    source_weight: 1,
    reason: `YES ${(probability * 100).toFixed(1)}%, edge ${(computed.edge * 100).toFixed(2)}pp, mom ${(computed.momentum * 100).toFixed(2)}pp`,
    momentum: computed.momentum,
    price: probability,
    quality_score: quality,
    timestamp: Date.now(),
  };

  return {
    signal,
    nextState: computed.nextState,
  };
}

async function gatherPredictionMarkets(ctx: StrategyContext): Promise<Signal[]> {
  const heldSymbols = await ctx.broker
    .getPositions()
    .then((positions) => positions.map((position) => position.symbol.toUpperCase()))
    .catch(() => []);
  const configured = parseWatchlist(ctx.env.KALSHI_MARKETS_WATCHLIST, DEFAULT_WATCHLIST);
  const symbols = Array.from(new Set([...configured, ...heldSymbols])).slice(0, 30);

  const state = ctx.state.get<PredictionStateMap>("predictionMarketState") ?? {};
  const nextState: PredictionStateMap = { ...state };
  const signals: Signal[] = [];

  for (const symbol of symbols) {
    try {
      const result = await buildSignal(ctx, symbol, state[symbol]);
      if (result.signal) {
        signals.push(result.signal);
      }
      if (result.nextState) {
        nextState[symbol] = result.nextState;
      }
      await ctx.sleep(120);
    } catch (error) {
      ctx.log("PredictionGatherer", "market_signal_failed", {
        symbol,
        error: String(error),
      });
    }
  }

  ctx.state.set("predictionMarketState", nextState);
  ctx.log("PredictionGatherer", "gather_complete", {
    symbols: symbols.length,
    signals: signals.length,
  });

  return signals;
}

export const predictionMarketGatherer: Gatherer = {
  name: "prediction-markets",
  gather: gatherPredictionMarkets,
};
