import type { ExchangeAdapter, OrderRequest, OrderResult } from "./types.js";

export class MockExchangeAdapter implements ExchangeAdapter {
  readonly name = "mock";
  private orderCounter = 0;

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    this.orderCounter += 1;
    const fakePrice = 100; // deterministic placeholder, not a real quote
    console.log(
      `[mock-exchange] would place ${order.side} order: ${order.symbol} $${order.sizeUsd}`,
    );
    return {
      orderId: `mock-${this.orderCounter}`,
      symbol: order.symbol,
      side: order.side,
      sizeUsd: order.sizeUsd,
      filledPrice: fakePrice,
      status: "filled",
    };
  }
}
