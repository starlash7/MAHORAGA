import type { Strategy } from "../types";
import { predictionMarketGatherer } from "./gatherers/markets";
import { selectPredictionEntries } from "./rules/entries";
import { selectPredictionExits } from "./rules/exits";

export const predictionMarketStrategy: Strategy = {
  name: "prediction-market",
  configSchema: null,
  defaultConfig: {
    data_poll_interval_ms: 30_000,
    analyst_interval_ms: 60_000,
    options_enabled: false,
    crypto_enabled: false,
    stale_position_enabled: false,
    premarket_plan_window_minutes: 1,
    market_open_execute_window_minutes: 0,
  },
  gatherers: [predictionMarketGatherer],
  prompts: {
    researchSignal: null,
    researchPosition: null,
    analyzeSignals: null,
    premarketAnalysis: null,
  },
  selectEntries: (ctx, _research, positions, account) => selectPredictionEntries(ctx, positions, account),
  selectExits: (ctx, positions, account) => selectPredictionExits(ctx, positions, account),
};
