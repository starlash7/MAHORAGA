import { constants, generateKeyPairSync, verify } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorCode } from "../../lib/errors";
import { buildKalshiStringToSign, createKalshiClient } from "./client";

describe("KalshiClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("signs requests with RSA-PSS headers using path without query", async () => {
    const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privatePem = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicKey = keyPair.publicKey;

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const client = createKalshiClient({
      accessKeyId: "kalshi-key-id",
      privateKey: privatePem,
      baseUrl: "https://demo-api.kalshi.co",
    });

    await client.get("/trade-api/v2/markets", { limit: 1, cursor: "abc" });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] ?? [];
    const headers = new Headers((init?.headers ?? {}) as HeadersInit);

    expect(headers.get("KALSHI-ACCESS-KEY")).toBe("kalshi-key-id");
    const timestamp = headers.get("KALSHI-ACCESS-TIMESTAMP");
    const signature = headers.get("KALSHI-ACCESS-SIGNATURE");
    expect(timestamp).toBeTruthy();
    expect(signature).toBeTruthy();

    const message = buildKalshiStringToSign(timestamp ?? "", "GET", "/trade-api/v2/markets");
    const verified = verify(
      "sha256",
      Buffer.from(message),
      { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
      Buffer.from(signature ?? "", "base64")
    );
    expect(verified).toBe(true);

    const wrongMessage = `${timestamp ?? ""}GET/trade-api/v2/markets?limit=1&cursor=abc`;
    const wrongVerified = verify(
      "sha256",
      Buffer.from(wrongMessage),
      { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
      Buffer.from(signature ?? "", "base64")
    );
    expect(wrongVerified).toBe(false);
  });

  it("maps HTTP 401 to UNAUTHORIZED MahoragaError", async () => {
    const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privatePem = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "bad token" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    );

    const client = createKalshiClient({
      accessKeyId: "kalshi-key-id",
      privateKey: privatePem,
    });

    await expect(client.get("/trade-api/v2/portfolio/balance")).rejects.toMatchObject({
      code: ErrorCode.UNAUTHORIZED,
    });
  });
});
