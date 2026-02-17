import { describe, expect, it, vi } from "vitest";
import type { Account, Position } from "../../core/types";
import type { Env } from "../../env.d";
import type { StrategyContext } from "../types";
import { predictionMarketGatherer } from "./gatherers/markets";
import { selectPredictionEntries } from "./rules/entries";
import { selectPredictionExits } from "./rules/exits";

function createAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: "acc-1",
    account_number: "acc-1",
    status: "ACTIVE",
    currency: "USD",
    cash: 1000,
    buying_power: 1000,
    regt_buying_power: 1000,
    daytrading_buying_power: 1000,
    equity: 1000,
    last_equity: 1000,
    long_market_value: 0,
    short_market_value: 0,
    portfolio_value: 1000,
    pattern_day_trader: false,
    trading_blocked: false,
    transfers_blocked: false,
    account_blocked: false,
    multiplier: "1",
    shorting_enabled: false,
    maintenance_margin: 0,
    initial_margin: 0,
    daytrade_count: 0,
    created_at: "2026-02-17T00:00:00.000Z",
    ...overrides,
  };
}

function createPosition(overrides: Partial<Position> = {}): Position {
  return {
    asset_id: "kalshi-1",
    symbol: "USREC-2026",
    exchange: "KALSHI",
    asset_class: "prediction_contract",
    avg_entry_price: 0.42,
    qty: 10,
    side: "long",
    market_value: 4.2,
    cost_basis: 4.2,
    unrealized_pl: 0,
    unrealized_plpc: 0,
    unrealized_intraday_pl: 0,
    unrealized_intraday_plpc: 0,
    current_price: 0.42,
    lastday_price: 0.42,
    change_today: 0,
    prediction_outcome: "yes",
    prediction_probability: 0.42,
    ...overrides,
  };
}

function createContext(overrides?: { positions?: Position[]; account?: Account; watchlist?: string }): StrategyContext {
  const values = new Map<string, unknown>();
  const positions = overrides?.positions ?? [];
  const account = overrides?.account ?? createAccount();

  const env = {
    KALSHI_MOCK_MODE: "true",
    KALSHI_MARKETS_WATCHLIST: overrides?.watchlist || "USREC-2026,FEDCUT-2026Q2",
  } as unknown as Env;

  return {
    env,
    config: {
      data_poll_interval_ms: 30_000,
      analyst_interval_ms: 60_000,
      premarket_plan_window_minutes: 1,
      market_open_execute_window_minutes: 0,
      max_position_value: 200,
      max_positions: 5,
      min_sentiment_score: 0.2,
      min_analyst_confidence: 0.6,
      take_profit_pct: 10,
      stop_loss_pct: 5,
      position_size_pct_of_cash: 25,
      stale_position_enabled: false,
      stale_min_hold_hours: 24,
      stale_max_hold_days: 3,
      stale_min_gain_pct: 5,
      stale_mid_hold_days: 2,
      stale_mid_min_gain_pct: 3,
      stale_social_volume_decay: 0.3,
      llm_provider: "openai-raw",
      llm_model: "gpt-4o-mini",
      llm_analyst_model: "gpt-4o",
      llm_min_hold_minutes: 30,
      options_enabled: false,
      options_min_confidence: 0.8,
      options_max_pct_per_trade: 0.02,
      options_min_dte: 30,
      options_max_dte: 60,
      options_target_delta: 0.45,
      options_min_delta: 0.3,
      options_max_delta: 0.7,
      options_stop_loss_pct: 50,
      options_take_profit_pct: 100,
      crypto_enabled: false,
      crypto_symbols: ["BTC/USD"],
      crypto_momentum_threshold: 2,
      crypto_max_position_value: 1000,
      crypto_take_profit_pct: 10,
      crypto_stop_loss_pct: 5,
      ticker_blacklist: [],
      allowed_exchanges: ["KALSHI"],
    },
    llm: null,
    log: vi.fn(),
    trackLLMCost: () => 0,
    sleep: async () => undefined,
    broker: {
      getAccount: async () => account,
      getPositions: async () => positions,
      getClock: async () => ({
        timestamp: "2026-02-17T00:00:00.000Z",
        is_open: true,
        next_open: "2026-02-17T00:00:00.000Z",
        next_close: "2026-02-17T01:00:00.000Z",
      }),
      buy: async () => true,
      sell: async () => true,
    },
    state: {
      get: <T>(key: string): T | undefined => values.get(key) as T | undefined,
      set: <T>(key: string, value: T): void => {
        values.set(key, value);
      },
    },
    signals: [],
    positionEntries: {},
  };
}

describe("prediction-market strategy", () => {
  it("gathers mock signals and persists market state", async () => {
    const ctx = createContext();
    const signals = await predictionMarketGatherer.gather(ctx);

    expect(signals.length).toBeGreaterThan(0);
    expect(signals[0]?.source).toBe("prediction_market");
    const state = ctx.state.get<Record<string, unknown>>("predictionMarketState");
    expect(state).toBeTruthy();
  });

  it("selects entries from positive prediction signals", () => {
    const ctx = createContext({
      account: createAccount({ cash: 500 }),
    });

    ctx.signals = [
      {
        symbol: "USREC-2026",
        source: "prediction_market",
        source_detail: "kalshi_probability_edge",
        sentiment: 0.8,
        raw_sentiment: 0.8,
        volume: 100,
        freshness: 1,
        source_weight: 1,
        reason: "edge + momentum",
        timestamp: Date.now(),
        price: 0.4,
        quality_score: 90,
      },
      {
        symbol: "FEDCUT-2026Q2",
        source: "prediction_market",
        source_detail: "kalshi_probability_edge",
        sentiment: 0.1,
        raw_sentiment: 0.1,
        volume: 100,
        freshness: 1,
        source_weight: 1,
        reason: "weak",
        timestamp: Date.now(),
        price: 0.4,
      },
    ];

    const entries = selectPredictionEntries(ctx, [], createAccount({ cash: 500 }));
    expect(entries.length).toBe(1);
    expect(entries[0]?.symbol).toBe("USREC-2026");
    expect(entries[0]?.notional).toBeGreaterThanOrEqual(5);
  });

  it("selects exits on reversal and risk thresholds", () => {
    const ctx = createContext();
    ctx.signals = [
      {
        symbol: "USREC-2026",
        source: "prediction_market",
        source_detail: "kalshi_probability_edge",
        sentiment: -0.6,
        raw_sentiment: 0,
        volume: 100,
        freshness: 1,
        source_weight: 1,
        reason: "reversal",
        timestamp: Date.now(),
      },
    ];

    const exits = selectPredictionExits(
      ctx,
      [
        createPosition({
          symbol: "USREC-2026",
          unrealized_plpc: 0.01,
          prediction_probability: 0.55,
        }),
      ],
      createAccount()
    );
    expect(exits.length).toBe(1);
    expect(exits[0]?.reason).toContain("reversal");
  });
});
