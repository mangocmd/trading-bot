import { createHmac } from "node:crypto";
import type { ExchangeAdapter, OrderRequest, OrderResult } from "./types.js";

const MEXC_BASE_URL = "https://api.mexc.com";

export interface MexcConfig {
  apiKey: string;
  apiSecret: string;
}

function sign(queryString: string, secret: string): string {
  return createHmac("sha256", secret).update(queryString).digest("hex");
}

export class MexcExchangeAdapter implements ExchangeAdapter {
  readonly name = "mexc";

  constructor(private config: MexcConfig) {
    if (!config.apiKey || !config.apiSecret) {
      throw new Error(
        "MEXC_API_KEY and MEXC_API_SECRET must be set to use the live MEXC adapter",
      );
    }
  }

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    const timestamp = Date.now();
    const params = new URLSearchParams({
      symbol: order.symbol,
      side: order.side.toUpperCase(),
      type: "MARKET",
      quoteOrderQty: order.sizeUsd.toString(),
      timestamp: timestamp.toString(),
    });

    const signature = sign(params.toString(), this.config.apiSecret);
    params.append("signature", signature);

    const response = await fetch(`${MEXC_BASE_URL}/api/v3/order?${params.toString()}`, {
      method: "POST",
      headers: {
        "X-MEXC-APIKEY": this.config.apiKey,
      },
    });

    const body = await response.json();

    if (!response.ok) {
      return {
        orderId: "",
        symbol: order.symbol,
        side: order.side,
        sizeUsd: order.sizeUsd,
        filledPrice: 0,
        status: "rejected",
        raw: body,
      };
    }

    return {
      orderId: String(body.orderId ?? ""),
      symbol: order.symbol,
      side: order.side,
      sizeUsd: order.sizeUsd,
      filledPrice: Number(body.price ?? 0),
      status: "filled",
      raw: body,
    };
  }
}
