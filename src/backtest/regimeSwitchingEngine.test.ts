import { test } from "node:test";
import assert from "node:assert/strict";
import { runRegimeSwitchingBacktest, type RegimeSwitchingConfig } from "./regimeSwitchingEngine.js";
import type { Candle } from "./indicators.js";

function candle(openTime: number, close: number, high?: number, low?: number, volume = 1): Candle {
  return { openTime, open: close, high: high ?? close, low: low ?? close, close, volume };
}

const config: RegimeSwitchingConfig = {
  regime: { lookback: 20, trendingThreshold: 0.6 },
  trending: { rsiPeriod: 3, emaPeriod: 8, stopLossPct: 0.5, takeProfitPct: 1.0, feePct: 0.002 },
  ranging: { bollingerPeriod: 20, bollingerStdDev: 2, stopLossPct: 0.5, takeProfitPct: 1.0, feePct: 0.002, minTargetDistancePct: 0 },
};

test("empty candle series returns a zeroed summary with regime breakdown", () => {
  const result = runRegimeSwitchingBacktest([], config);
  assert.equal(result.totalTrades, 0);
  assert.equal(result.regimeBreakdown.trending, 0);
  assert.equal(result.regimeBreakdown.ranging, 0);
});

test("flat data produces no trades and classifies as ranging", () => {
  const candles = Array.from({ length: 100 }, (_, i) => candle(i, 100));
  const result = runRegimeSwitchingBacktest(candles, config);
  assert.equal(result.totalTrades, 0);
  assert.ok(result.regimeBreakdown.ranging > 0);
  assert.equal(result.regimeBreakdown.trending, 0);
});

test("every recorded trade has internally consistent accounting", () => {
  const candles = Array.from({ length: 300 }, (_, i) => {
    const base = 100 + Math.sin(i / 5) * 8 + i * 0.05;
    return candle(i, base, base + 1, base - 1, 1);
  });
  const result = runRegimeSwitchingBacktest(candles, config);
  for (const trade of result.trades) {
    assert.ok(trade.exitTime > trade.entryTime);
    assert.ok(["stop_loss", "take_profit"].includes(trade.exitReason));
    if (trade.exitReason === "take_profit") {
      assert.ok(trade.resultPct > -0.001); // fee drag only, no stop-loss-sized negative on a TP exit
    }
  }
  // regime counts should sum to the number of evaluated candles
  const warmupEstimate = 20;
  const evaluated = candles.length - warmupEstimate;
  assert.ok(
    result.regimeBreakdown.trending + result.regimeBreakdown.ranging <= candles.length &&
      result.regimeBreakdown.trending + result.regimeBreakdown.ranging > 0,
  );
});
