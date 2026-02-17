import { createError, ErrorCode } from "../../lib/errors";

type QueryValue = string | number | boolean | null | undefined;

export type KalshiQueryParams = Record<string, QueryValue | QueryValue[]>;

export interface KalshiClientConfig {
  accessKeyId: string;
  privateKey: string;
  baseUrl?: string;
}

interface KalshiRequestOptions {
  query?: KalshiQueryParams;
  body?: unknown;
  auth?: boolean;
}

function encodeQuery(params: KalshiQueryParams | undefined): string {
  if (!params) return "";
  const search = new URLSearchParams();
  for (const [key, raw] of Object.entries(params)) {
    if (Array.isArray(raw)) {
      for (const value of raw) {
        if (value === null || value === undefined) continue;
        search.append(key, String(value));
      }
      continue;
    }
    if (raw === null || raw === undefined) continue;
    search.set(key, String(raw));
  }
  return search.toString();
}

function normalizePem(rawPem: string): string {
  return rawPem.includes("\\n") ? rawPem.replace(/\\n/g, "\n") : rawPem;
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const normalized = normalizePem(pem).trim();
  if (!normalized.includes("BEGIN PRIVATE KEY")) {
    throw createError(
      ErrorCode.INVALID_INPUT,
      "KALSHI_API_PRIVATE_KEY must be a PKCS#8 PEM (BEGIN PRIVATE KEY ... END PRIVATE KEY)"
    );
  }

  const b64 = normalized
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");

  if (!b64) {
    throw createError(ErrorCode.INVALID_INPUT, "KALSHI_API_PRIVATE_KEY is empty");
  }

  let binary = "";
  if (typeof atob === "function") {
    binary = atob(b64);
  } else {
    binary = Buffer.from(b64, "base64").toString("binary");
  }

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary);
  }
  return Buffer.from(bytes).toString("base64");
}

function extractErrorMessage(errorBody: unknown): string | null {
  if (typeof errorBody === "string") return errorBody;
  if (!errorBody || typeof errorBody !== "object") return null;
  const body = errorBody as Record<string, unknown>;

  const directKeys = ["message", "error", "detail"];
  for (const key of directKeys) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) return value;
    if (value && typeof value === "object") {
      const nested = extractErrorMessage(value);
      if (nested) return nested;
    }
  }

  const code = typeof body.code === "string" ? body.code : null;
  const reason = typeof body.reason === "string" ? body.reason : null;
  if (code && reason) return `${code}: ${reason}`;
  if (code) return code;
  if (reason) return reason;
  return null;
}

export function buildKalshiStringToSign(timestampMs: string, method: string, path: string): string {
  const pathWithoutQuery = path.split("?")[0] ?? path;
  return `${timestampMs}${method.toUpperCase()}${pathWithoutQuery}`;
}

export class KalshiClient {
  private readonly baseUrl: string;
  private signingKeyPromise: Promise<CryptoKey> | null = null;

  constructor(private readonly config: KalshiClientConfig) {
    if (!config.accessKeyId) {
      throw createError(ErrorCode.INVALID_INPUT, "KALSHI_API_KEY_ID is required for live mode");
    }
    if (!config.privateKey) {
      throw createError(ErrorCode.INVALID_INPUT, "KALSHI_API_PRIVATE_KEY is required for live mode");
    }

    const base = config.baseUrl || "https://demo-api.kalshi.co";
    this.baseUrl = base.endsWith("/") ? base.slice(0, -1) : base;
  }

  async get<T>(path: string, query?: KalshiQueryParams): Promise<T> {
    return this.request<T>("GET", path, { query });
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, { body });
  }

  async delete<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }

  async request<T>(method: string, path: string, options: KalshiRequestOptions = {}): Promise<T> {
    if (!path.startsWith("/")) {
      throw createError(ErrorCode.INVALID_INPUT, `Kalshi path must start with '/': ${path}`);
    }

    const queryString = encodeQuery(options.query);
    const pathWithQuery = queryString ? `${path}?${queryString}` : path;
    const url = `${this.baseUrl}${pathWithQuery}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
    };

    if (options.auth !== false) {
      Object.assign(headers, await this.buildAuthHeaders(method, path));
    }
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = errorText;
      try {
        const json = JSON.parse(errorText) as unknown;
        errorMessage = extractErrorMessage(json) ?? errorText;
      } catch {
        // keep raw text
      }
      if (!errorMessage || !errorMessage.trim()) {
        errorMessage = response.statusText || "Unknown Kalshi error";
      }

      if (response.status === 400) {
        throw createError(ErrorCode.INVALID_INPUT, `Kalshi validation error: ${errorMessage}`);
      }
      if (response.status === 401) {
        throw createError(ErrorCode.UNAUTHORIZED, `Kalshi authentication failed: ${errorMessage}`);
      }
      if (response.status === 403) {
        throw createError(ErrorCode.FORBIDDEN, `Kalshi access denied: ${errorMessage}`);
      }
      if (response.status === 404) {
        throw createError(ErrorCode.NOT_FOUND, `Kalshi resource not found: ${errorMessage}`);
      }
      if (response.status === 409) {
        throw createError(ErrorCode.CONFLICT, `Kalshi conflict: ${errorMessage}`);
      }
      if (response.status === 429) {
        throw createError(ErrorCode.RATE_LIMITED, `Kalshi rate limit exceeded: ${errorMessage}`);
      }

      throw createError(ErrorCode.PROVIDER_ERROR, `Kalshi API error (${response.status}): ${errorMessage}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const text = await response.text();
    if (!text.trim()) {
      return undefined as T;
    }
    return JSON.parse(text) as T;
  }

  private async buildAuthHeaders(method: string, path: string): Promise<Record<string, string>> {
    const timestampMs = Date.now().toString();
    const payload = buildKalshiStringToSign(timestampMs, method, path);
    const signature = await this.sign(payload);
    return {
      "KALSHI-ACCESS-KEY": this.config.accessKeyId,
      "KALSHI-ACCESS-SIGNATURE": signature,
      "KALSHI-ACCESS-TIMESTAMP": timestampMs,
    };
  }

  private async sign(payload: string): Promise<string> {
    const key = await this.getSigningKey();
    const encoded = new TextEncoder().encode(payload);
    const signature = await crypto.subtle.sign(
      {
        name: "RSA-PSS",
        saltLength: 32,
      },
      key,
      encoded
    );
    return bytesToBase64(new Uint8Array(signature));
  }

  private async getSigningKey(): Promise<CryptoKey> {
    if (!this.signingKeyPromise) {
      this.signingKeyPromise = crypto.subtle
        .importKey(
          "pkcs8",
          pemToPkcs8(this.config.privateKey),
          {
            name: "RSA-PSS",
            hash: "SHA-256",
          },
          false,
          ["sign"]
        )
        .catch((error) => {
          throw createError(ErrorCode.INVALID_INPUT, `Invalid KALSHI_API_PRIVATE_KEY: ${String(error)}`);
        });
    }
    return this.signingKeyPromise;
  }
}

export function createKalshiClient(config: KalshiClientConfig): KalshiClient {
  return new KalshiClient(config);
}
