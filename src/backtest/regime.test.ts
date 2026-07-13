import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRegimeSeries } from "./regime.js";
import type { Candle } from "./indicators.js";

function candle(close: number, high?: number, low?: number): Candle {
  return { openTime: 0, open: close, high: high ?? close, low: low ?? close, close, volume: 1 };
}

test("a steadily rising series is classified as trending", () => {
  const candles = Array.from({ length: 30 }, (_, i) => candle(100 + i, 100 + i + 0.5, 100 + i - 0.5));
  const regimes = classifyRegimeSeries(candles, { lookback: 10, trendingThreshold: 0.6 });
  assert.equal(regimes[29], "trending");
});

test("a flat oscillating series is classified as ranging", () => {
  const candles = Array.from({ length: 30 }, (_, i) => {
    const price = 100 + (i % 2 === 0 ? 5 : -5);
    return candle(price, price + 0.5, price - 0.5);
  });
  const regimes = classifyRegimeSeries(candles, { lookback: 10, trendingThreshold: 0.6 });
  assert.equal(regimes[29], "ranging");
});

test("defaults to ranging before enough lookback history exists", () => {
  const candles = [candle(100), candle(101), candle(102)];
  const regimes = classifyRegimeSeries(candles, { lookback: 10, trendingThreshold: 0.6 });
  assert.equal(regimes[2], "ranging");
});

test("matches the observed 30-day BTCUSDT regime (net -2.48%, range 15.37% -> ranging)", () => {
  // Reconstructs the shape of the real observation: small net drift inside a wide range.
  const candles: Candle[] = [];
  const lookback = 20;
  // build a window that ends near where it started but swings widely in between
  for (let i = 0; i <= lookback; i++) {
    const t = i / lookback;
    // swings from 0 up to +15 and back down to -2.48 net drift, roughly matching the ratio 0.161
    const price = 100 + Math.sin(t * Math.PI * 2) * 15 - t * 2.48;
    candles.push(candle(price, price + 0.3, price - 0.3));
  }
  const regimes = classifyRegimeSeries(candles, { lookback, trendingThreshold: 0.6 });
  assert.equal(regimes[lookback], "ranging");
});
