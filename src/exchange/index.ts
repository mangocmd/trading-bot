import type { ExchangeAdapter } from "./types.js";
import { MockExchangeAdapter } from "./mockAdapter.js";
import { MexcExchangeAdapter } from "./mexcAdapter.js";

export function createExchangeAdapter(): ExchangeAdapter {
  const mode = process.env.EXCHANGE_MODE ?? "mock";

  if (mode === "mock") {
    return new MockExchangeAdapter();
  }

  if (mode === "mexc") {
    return new MexcExchangeAdapter({
      apiKey: process.env.MEXC_API_KEY ?? "",
      apiSecret: process.env.MEXC_API_SECRET ?? "",
    });
  }

  throw new Error(`Unknown EXCHANGE_MODE: ${mode}. Use "mock" or "mexc".`);
}

export type { ExchangeAdapter, OrderRequest, OrderResult } from "./types.js";
