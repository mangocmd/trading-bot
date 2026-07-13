import type { Candle } from "./indicators.js";

const MEXC_BASE_URL = "https://api.mexc.com";
// MEXC's public klines endpoint returns at most 500 candles per request
// regardless of the `limit` value passed (empirically verified), so pagination
// must advance by however many candles actually came back, not by MAX_LIMIT.
const REQUEST_LIMIT = 1000;

interface RawKline extends Array<string | number> {
  0: number; // open time
  1: string; // open
  2: string; // high
  3: string; // low
  4: string; // close
  5: string; // volume
  6: number; // close time
}

/**
 * Fetches 1-minute klines from MEXC's public API for the given time range,
 * paginating since MEXC caps a single request at 1000 candles.
 */
export async function fetchKlines(
  symbol: string,
  startTime: number,
  endTime: number,
  interval = "1m",
): Promise<Candle[]> {
  const candles: Candle[] = [];
  let cursor = startTime;

  while (cursor < endTime) {
    const params = new URLSearchParams({
      symbol,
      interval,
      startTime: cursor.toString(),
      endTime: endTime.toString(),
      limit: REQUEST_LIMIT.toString(),
    });

    const response = await fetch(`${MEXC_BASE_URL}/api/v3/klines?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`MEXC klines request failed: ${response.status} ${await response.text()}`);
    }

    const raw = (await response.json()) as RawKline[];
    if (raw.length === 0) break;

    for (const k of raw) {
      candles.push({
        openTime: k[0],
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5]),
      });
    }

    const lastOpenTime = raw[raw.length - 1][0];
    if (lastOpenTime <= cursor) break; // safety against non-advancing cursor

    if (raw.length < 2) break; // can't infer candle spacing from a single candle
    const candleSpacingMs = raw[raw.length - 1][0] - raw[raw.length - 2][0];
    cursor = lastOpenTime + Math.max(candleSpacingMs, 1);
  }

  return candles;
}
