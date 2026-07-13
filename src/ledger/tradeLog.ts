import { appendFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const LOG_PATH = path.resolve(process.cwd(), "logs/trades.csv");

const HEADER =
  "timestamp,exchange,symbol,side,status,sizeUsd,filledPrice,estimatedFeeUsd,netUsd,orderId,reasoning,blockedReason\n";

export interface TradeLogEntry {
  exchange: string;
  symbol: string;
  side: "buy" | "sell";
  status: "filled" | "rejected" | "blocked";
  sizeUsd: number;
  filledPrice?: number;
  orderId?: string;
  reasoning?: string;
  blockedReason?: string;
  feeRate?: number;
}

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export async function appendTradeLog(entry: TradeLogEntry): Promise<void> {
  await mkdir(path.dirname(LOG_PATH), { recursive: true });

  const isNewFile = !existsSync(LOG_PATH);
  const feeRate = entry.feeRate ?? 0.01;
  const feeUsd = entry.status === "filled" ? entry.sizeUsd * feeRate : 0;
  const netUsd = entry.status === "filled" ? entry.sizeUsd - feeUsd : 0;

  const row = [
    new Date().toISOString(),
    entry.exchange,
    entry.symbol,
    entry.side,
    entry.status,
    entry.sizeUsd.toFixed(2),
    entry.filledPrice?.toFixed(2) ?? "",
    feeUsd.toFixed(2),
    netUsd.toFixed(2),
    entry.orderId ?? "",
    csvEscape(entry.reasoning ?? ""),
    csvEscape(entry.blockedReason ?? ""),
  ].join(",");

  const content = (isNewFile ? HEADER : "") + row + "\n";
  await appendFile(LOG_PATH, content, "utf-8");
}

export const TRADE_LOG_PATH = LOG_PATH;
