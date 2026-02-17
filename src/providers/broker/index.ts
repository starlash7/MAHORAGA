import type { Env } from "../../env.d";
import { createAlpacaProviders } from "../alpaca";
import { createKalshiProviders } from "../kalshi";
import type { BrokerProvider, MarketDataProvider, OptionsProvider } from "../types";

export type BrokerProviderName = "alpaca" | "kalshi";

export interface ActiveBrokerProviders {
  name: BrokerProviderName;
  trading: BrokerProvider;
  marketData: MarketDataProvider | null;
  options: OptionsProvider | null;
}

export function getBrokerProviderName(env: Env): BrokerProviderName {
  return env.BROKER_PROVIDER === "alpaca" ? "alpaca" : "kalshi";
}

export function createBrokerProviders(env: Env): ActiveBrokerProviders {
  const name = getBrokerProviderName(env);
  if (name === "alpaca") {
    const alpaca = createAlpacaProviders(env);
    return {
      name,
      trading: alpaca.trading,
      marketData: alpaca.marketData,
      options: alpaca.options,
    };
  }

  const kalshi = createKalshiProviders(env);
  return {
    name,
    trading: kalshi.trading,
    marketData: kalshi.marketData,
    options: kalshi.options,
  };
}
