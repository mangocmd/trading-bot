import { test } from "node:test";
import assert from "node:assert/strict";
import { computeVwapSeries, computeRsiSeries, computeEmaSeries, computeBollingerBands, type Candle } from "./indicators.js";

function makeCandle(close: number, high?: number, low?: number, volume = 1): Candle {
  return { openTime: 0, open: close, high: high ?? close, low: low ?? close, close, volume };
}

test("VWAP equals typical price on a flat single-volume series", () => {
  const candles = [makeCandle(100), makeCandle(100), makeCandle(100)];
  const vwap = computeVwapSeries(candles);
  for (const v of vwap) assert.equal(v, 100);
});

test("VWAP weights by volume", () => {
  const candles = [
    { openTime: 0, open: 100, high: 100, low: 100, close: 100, volume: 1 },
    { openTime: 0, open: 200, high: 200, low: 200, close: 200, volume: 9 },
  ];
  const vwap = computeVwapSeries(candles);
  // (100*1 + 200*9) / 10 = 190
  assert.equal(vwap[1], 190);
});

test("RSI is 100 when all changes are gains", () => {
  const closes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
  const candles = closes.map((c) => makeCandle(c));
  const rsi = computeRsiSeries(candles, 14);
  assert.equal(rsi[14], 100);
});

test("RSI is 0 when all changes are losses", () => {
  const closes = [15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
  const candles = closes.map((c) => makeCandle(c));
  const rsi = computeRsiSeries(candles, 14);
  assert.equal(rsi[14], 0);
});

test("RSI is NaN before enough data is available", () => {
  const candles = [makeCandle(1), makeCandle(2), makeCandle(3)];
  const rsi = computeRsiSeries(candles, 14);
  assert.ok(Number.isNaN(rsi[2]));
});

test("EMA seeds with SMA and is NaN before the period fills", () => {
  const closes = [1, 2, 3, 4, 5];
  const candles = closes.map((c) => makeCandle(c));
  const ema = computeEmaSeries(candles, 3);
  assert.ok(Number.isNaN(ema[1]));
  // seed = average of first 3 closes = 2
  assert.equal(ema[2], 2);
});

test("EMA converges toward a constant series", () => {
  const candles = new Array(50).fill(0).map(() => makeCandle(100));
  const ema = computeEmaSeries(candles, 8);
  assert.equal(ema[49], 100);
});

test("Bollinger Bands collapse to the price on a flat series (zero stdev)", () => {
  const candles = new Array(20).fill(0).map(() => makeCandle(100));
  const bb = computeBollingerBands(candles, 5, 2);
  assert.equal(bb.middle[19], 100);
  assert.equal(bb.upper[19], 100);
  assert.equal(bb.lower[19], 100);
});

test("Bollinger Bands widen with volatility", () => {
  // alternating 90/110 series has a known population stdev of 10
  const closes = [90, 110, 90, 110, 90, 110, 90, 110];
  const candles = closes.map((c) => makeCandle(c));
  const bb = computeBollingerBands(candles, 8, 2);
  assert.equal(bb.middle[7], 100);
  assert.equal(bb.upper[7], 120); // 100 + 2*10
  assert.equal(bb.lower[7], 80); // 100 - 2*10
});

test("Bollinger Bands are NaN before the period fills", () => {
  const candles = [makeCandle(100), makeCandle(101)];
  const bb = computeBollingerBands(candles, 5, 2);
  assert.ok(Number.isNaN(bb.middle[1]));
});
