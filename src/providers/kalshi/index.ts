import type { Env } from "../../env.d";
import { parseBoolean, parseNumber } from "../../lib/utils";
import {
  createDefaultKalshiLiveClientFromEnv,
  createKalshiTradingProvider,
  type KalshiTradingProvider,
} from "./trading";

export interface KalshiProviders {
  trading: KalshiTradingProvider;
  marketData: null;
  options: null;
}

export function createKalshiProviders(env: Env): KalshiProviders {
  const mockMode = parseBoolean(env.KALSHI_MOCK_MODE, true);
  const startingCash = parseNumber(env.KALSHI_MOCK_STARTING_CASH, 10_000);
  const accountId = env.KALSHI_MOCK_ACCOUNT_ID || env.KALSHI_API_KEY_ID || "kalshi-mock-account";
  const liveClient = !mockMode
    ? createDefaultKalshiLiveClientFromEnv({
        accessKeyId: env.KALSHI_API_KEY_ID,
        privateKey: env.KALSHI_API_PRIVATE_KEY,
        baseUrl: env.KALSHI_BASE_URL,
      })
    : null;

  return {
    trading: createKalshiTradingProvider({
      mockMode,
      mockStartingCash: startingCash,
      accountId,
      liveClient,
    }),
    marketData: null,
    options: null,
  };
}
