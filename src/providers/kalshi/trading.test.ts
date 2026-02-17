import { describe, expect, it, vi } from "vitest";
import { ErrorCode } from "../../lib/errors";
import type { KalshiClient } from "./client";
import { createKalshiTradingProvider } from "./trading";

describe("KalshiTradingProvider (mock mode)", () => {
  it("returns a bootstrapped account with mock cash", async () => {
    const provider = createKalshiTradingProvider({
      mockMode: true,
      mockStartingCash: 2500,
      accountId: `test-${Date.now()}-account`,
    });

    const account = await provider.getAccount();
    expect(account.cash).toBe(2500);
    expect(account.equity).toBe(2500);
  });

  it("updates positions after buy + close cycle", async () => {
    const provider = createKalshiTradingProvider({
      mockMode: true,
      mockStartingCash: 2000,
      accountId: `test-${Date.now()}-trade`,
    });

    const buy = await provider.createOrder({
      symbol: "USREC-2026",
      side: "buy",
      notional: 200,
      type: "market",
      time_in_force: "ioc",
    });
    expect(buy.status).toBe("filled");

    const positionsAfterBuy = await provider.getPositions();
    expect(positionsAfterBuy.length).toBeGreaterThan(0);

    const close = await provider.closePosition("USREC-2026");
    expect(["filled", "rejected"]).toContain(close.status);

    const positionsAfterClose = await provider.getPositions();
    expect(positionsAfterClose.find((p) => p.symbol === "USREC-2026")).toBeUndefined();
  });

  it("throws in live mode when credentials/client are missing", async () => {
    const provider = createKalshiTradingProvider({
      mockMode: false,
      mockStartingCash: 1000,
      accountId: `test-${Date.now()}-live`,
    });

    await expect(provider.getAccount()).rejects.toMatchObject({
      code: ErrorCode.INVALID_INPUT,
    });
  });

  it("submits live order through Kalshi client and maps response", async () => {
    const mockClient = {
      get: vi.fn(async (path: string) => {
        if (path.startsWith("/trade-api/v2/markets/")) {
          return {
            ticker: "USREC-2026",
            yes_bid: 45,
            yes_ask: 46,
            no_bid: 54,
            no_ask: 55,
            last_price: 45,
            status: "open",
          };
        }
        return {};
      }),
      post: vi.fn(async () => ({
        order: {
          order_id: "ord-live-1",
          client_order_id: "client-live-1",
          ticker: "USREC-2026",
          side: "yes",
          action: "buy",
          status: "executed",
          type: "limit",
          initial_count: 4,
          remaining_count: 0,
          fill_count: 4,
          yes_price: 47,
          created_time: "2026-02-17T00:00:00.000Z",
          last_update_time: "2026-02-17T00:00:01.000Z",
          time_in_force: "immediate_or_cancel",
        },
      })),
      delete: vi.fn(async () => undefined),
    } as unknown as KalshiClient;

    const provider = createKalshiTradingProvider({
      mockMode: false,
      mockStartingCash: 1000,
      accountId: "test-live-account",
      liveClient: mockClient,
    });

    const order = await provider.createOrder({
      symbol: "USREC-2026",
      side: "buy",
      notional: 2,
      type: "market",
      time_in_force: "ioc",
    });

    expect(mockClient.get).toHaveBeenCalled();
    expect(mockClient.post).toHaveBeenCalledWith(
      "/trade-api/v2/portfolio/orders",
      expect.objectContaining({
        ticker: "USREC-2026",
        side: "yes",
        action: "buy",
      })
    );
    expect(order.id).toBe("ord-live-1");
    expect(order.status).toBe("filled");
    expect(order.symbol).toBe("USREC-2026");
  });
});
