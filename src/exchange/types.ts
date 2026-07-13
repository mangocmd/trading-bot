export type OrderSide = "buy" | "sell";

export interface OrderRequest {
  symbol: string;
  side: OrderSide;
  sizeUsd: number;
}

export interface OrderResult {
  orderId: string;
  symbol: string;
  side: OrderSide;
  sizeUsd: number;
  filledPrice: number;
  status: "filled" | "rejected";
  raw?: unknown;
}

export interface ExchangeAdapter {
  readonly name: string;
  placeOrder(order: OrderRequest): Promise<OrderResult>;
}
