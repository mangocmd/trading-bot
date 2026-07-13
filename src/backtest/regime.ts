import type { Candle } from "./indicators.js";

export type MarketRegime = "trending" | "ranging";

export interface RegimeConfig {
  lookback: number; // how many candles back to measure
  trendingThreshold: number; // net-move/range ratio at or above this = trending
}

/**
 * Classifies market regime candle-by-candle using a rolling lookback window:
 * ratio = |close[i] - close[i-lookback]| / (max(high) - min(low)) over the window.
 * Ratio close to 1 means price moved directionally (trending); close to 0 means
 * price oscillated within a range without net progress (ranging).
 * Returns "ranging" for indices before enough history exists (conservative default —
 * mean-reversion strategies tend to have tighter, more frequent stops than trend strategies).
 */
export function classifyRegimeSeries(candles: Candle[], config: RegimeConfig): MarketRegime[] {
  const regimes: MarketRegime[] = new Array(candles.length).fill("ranging");

  for (let i = config.lookback; i < candles.length; i++) {
    const windowStart = i - config.lookback;
    let high = -Infinity;
    let low = Infinity;
    for (let j = windowStart; j <= i; j++) {
      high = Math.max(high, candles[j].high);
      low = Math.min(low, candles[j].low);
    }

    const netMove = Math.abs(candles[i].close - candles[windowStart].close);
    const range = high - low;
    const ratio = range > 0 ? netMove / range : 0;

    regimes[i] = ratio >= config.trendingThreshold ? "trending" : "ranging";
  }

  return regimes;
}
