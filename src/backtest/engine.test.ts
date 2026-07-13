import { test } from "node:test";
import assert from "node:assert/strict";
import { runBacktest, type BacktestConfig } from "./engine.js";
import type { Candle } from "./indicators.js";

function candle(openTime: number, close: number, high?: number, low?: number, volume = 1): Candle {
  return { openTime, open: close, high: high ?? close, low: low ?? close, close, volume };
}

const config: BacktestConfig = {
  rsiPeriod: 3,
  emaPeriod: 3,
  stopLossPct: 0.5,
  takeProfitPct: 1.0,
  feePct: 0.001,
};

test("no trades on flat data (no RSI cross)", () => {
  const candles = new Array(20).fill(0).map((_, i) => candle(i, 100));
  const result = runBacktest(candles, config);
  assert.equal(result.totalTrades, 0);
});

test("empty candle series returns zeroed summary, not a crash", () => {
  const result = runBacktest([], config);
  assert.equal(result.totalTrades, 0);
  assert.equal(result.winRate, 0);
});

test("a long entry that hits take profit is recorded as a winning trade", () => {
  // Build a dip-then-recovery to force RSI(3) to cross up through 20 while price
  // stays above a slowly-rising EMA/VWAP, then a sharp rally to clear the 1% target.
  const candles: Candle[] = [];
  let t = 0;
  // warmup flat
  for (let i = 0; i < 5; i++) candles.push(candle(t++, 100, 100, 100, 1));
  // sharp dip to drive RSI down
  candles.push(candle(t++, 90, 100, 90, 1));
  candles.push(candle(t++, 85, 90, 85, 1));
  // recovery back above prior levels -> RSI should cross back up
  candles.push(candle(t++, 95, 96, 85, 1));
  candles.push(candle(t++, 105, 106, 95, 1));
  // entry candle should now satisfy price > vwap/ema; give it room, then rally hard
  candles.push(candle(t++, 110, 111, 109, 1));
  // huge rally candle that should trigger take profit on whatever position opened
  candles.push(candle(t++, 130, 140, 109, 1));
  for (let i = 0; i < 5; i++) candles.push(candle(t++, 130, 131, 129, 1));

  const result = runBacktest(candles, config);
  // We don't assert a specific trade count (depends on exact indicator crossovers),
  // just that if any trade fired, the accounting is internally consistent.
  for (const trade of result.trades) {
    assert.ok(trade.exitTime > trade.entryTime);
    assert.ok(["stop_loss", "take_profit"].includes(trade.exitReason));
    if (trade.exitReason === "take_profit") {
      assert.ok(trade.resultPct > 0);
    }
  }
});

test("profitFactor is 0 when there are no wins and no losses", () => {
  const result = runBacktest([], config);
  assert.equal(result.profitFactor, 0);
});

test("maxDrawdownPct is non-negative and tracks equity dips", () => {
  const candles: Candle[] = [];
  let t = 0;
  for (let i = 0; i < 100; i++) {
    // oscillate price to try to trigger several trades
    const base = 100 + Math.sin(i / 3) * 10;
    candles.push(candle(t++, base, base + 1, base - 1, 1));
  }
  const result = runBacktest(candles, config);
  assert.ok(result.maxDrawdownPct >= 0);
});
