import type { Candle } from "./indicators.js";

/**
 * Daily OHLCV bars from Yahoo Finance's chart endpoint (public, no key).
 *
 * Two things differ from the crypto feed and both matter for backtests:
 *   - Stocks gap overnight. The gap-aware fill logic in turtle.ts exists for this.
 *   - Yahoo returns nulls on halted/untraded days; those bars are dropped rather than
 *     forward-filled, since a fabricated bar can invent a breakout that never happened.
 */
export async function fetchStockCandles(
  symbol: string,
  range = "5y",
  interval = "1d",
): Promise<Candle[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Yahoo chart request failed for ${symbol}: ${res.status}`);

  const json = (await res.json()) as {
    chart: {
      result?: Array<{
        timestamp?: number[];
        indicators: { quote: Array<{ open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }> };
      }>;
      error?: { description?: string } | null;
    };
  };

  if (json.chart.error) throw new Error(`Yahoo error for ${symbol}: ${json.chart.error.description ?? "unknown"}`);
  const result = json.chart.result?.[0];
  if (!result?.timestamp) return [];

  const q = result.indicators.quote[0];
  const candles: Candle[] = [];

  for (let i = 0; i < result.timestamp.length; i++) {
    const open = q.open?.[i], high = q.high?.[i], low = q.low?.[i], close = q.close?.[i], volume = q.volume?.[i];
    if (open == null || high == null || low == null || close == null) continue; // halted day — skip, don't invent one
    candles.push({
      openTime: result.timestamp[i] * 1000,
      open,
      high,
      low,
      close,
      volume: volume ?? 0,
    });
  }

  return candles;
}
