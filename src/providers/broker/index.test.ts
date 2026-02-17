import { describe, expect, it } from "vitest";
import type { Env } from "../../env.d";
import { createBrokerProviders, getBrokerProviderName } from "./index";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    CACHE: {} as KVNamespace,
    ARTIFACTS: {} as R2Bucket,
    SESSION: {} as DurableObjectNamespace,
    MAHORAGA_HARNESS: {} as DurableObjectNamespace,
    BROKER_PROVIDER: "kalshi",
    ALPACA_API_KEY: "test-alpaca-key",
    ALPACA_API_SECRET: "test-alpaca-secret",
    ALPACA_PAPER: "true",
    KALSHI_MOCK_MODE: "true",
    KALSHI_MOCK_STARTING_CASH: "10000",
    KALSHI_MOCK_ACCOUNT_ID: "kalshi-test",
    OPENAI_API_KEY: "test-openai-key",
    MAHORAGA_API_TOKEN: "test-api-token",
    KILL_SWITCH_SECRET: "test-kill-switch",
    ENVIRONMENT: "test",
    FEATURE_LLM_RESEARCH: "false",
    FEATURE_OPTIONS: "false",
    DEFAULT_MAX_POSITION_PCT: "0.10",
    DEFAULT_MAX_NOTIONAL_PER_TRADE: "5000",
    DEFAULT_MAX_DAILY_LOSS_PCT: "0.02",
    DEFAULT_COOLDOWN_MINUTES: "30",
    DEFAULT_MAX_OPEN_POSITIONS: "10",
    DEFAULT_APPROVAL_TTL_SECONDS: "300",
    ...overrides,
  };
}

describe("broker provider factory", () => {
  it("defaults to kalshi when BROKER_PROVIDER is not set", () => {
    const env = makeEnv({ BROKER_PROVIDER: undefined });
    expect(getBrokerProviderName(env)).toBe("kalshi");
  });

  it("creates kalshi provider bundle", () => {
    const providers = createBrokerProviders(makeEnv({ BROKER_PROVIDER: "kalshi" }));
    expect(providers.name).toBe("kalshi");
    expect(providers.marketData).toBeNull();
    expect(providers.options).toBeNull();
  });

  it("creates alpaca provider bundle when requested", () => {
    const providers = createBrokerProviders(makeEnv({ BROKER_PROVIDER: "alpaca" }));
    expect(providers.name).toBe("alpaca");
    expect(providers.marketData).not.toBeNull();
    expect(providers.options).not.toBeNull();
  });
});
