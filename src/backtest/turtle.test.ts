import { test } from "node:test";
import assert from "node:assert/strict";
import { runTurtleBacktest, TURTLE_SYSTEM_1, type TurtleConfig } from "./turtle.js";
import { computeAtrSeries, type Candle } from "./indicators.js";

function candle(openTime: number, close: number, high?: number, low?: number, volume = 1): Candle {
  return { openTime, open: close, high: high ?? close, low: low ?? close, close, volume };
}

const noFriction: TurtleConfig = { ...TURTLE_SYSTEM_1, feePct: 0, slippagePctPerSide: 0 };

test("empty and flat series produce no trades", () => {
  assert.equal(runTurtleBacktest([], noFriction).totalTrades, 0);

  const flat = Array.from({ length: 100 }, (_, i) => candle(i, 100));
  assert.equal(runTurtleBacktest(flat, noFriction).totalTrades, 0);
});

test("ATR is zero-width on flat data and never negative", () => {
  const flat = Array.from({ length: 50 }, (_, i) => candle(i, 100));
  const atr = computeAtrSeries(flat, 20);
  assert.equal(atr[30], 0);
  assert.ok(atr.slice(21).every((v) => v >= 0));
});

// Explicit OHLC — the `candle()` helper ties open to close, which fabricates gaps that the
// gap-aware fill logic then (correctly) reacts to. These cases need the open controlled.
function ohlc(openTime: number, open: number, high: number, low: number, close: number): Candle {
  return { openTime, open, high, low, close, volume: 1 };
}

test("a breakout above the prior 20-bar high opens a long that is banked on the channel exit", () => {
  const candles: Candle[] = [];
  for (let i = 0; i < 30; i++) candles.push(ohlc(i, 100, 101, 99, 100)); // range 99-101
  candles.push(ohlc(30, 100, 110, 100, 109)); // opens inside the range, breaks out to 110
  for (let i = 31; i < 45; i++) candles.push(ohlc(i, 109, 113, 108, 112)); // trend up
  for (let i = 45; i < 60; i++) candles.push(ohlc(i, 107, 108, 100, 101)); // fade through the 10-bar low

  const result = runTurtleBacktest(candles, noFriction);
  assert.ok(result.trades.length >= 1, "the breakout should produce a completed trade");
  assert.equal(result.trades[0].side, "long");
  // The open (100) was below the channel high (101), so the stop order fills at the channel level.
  assert.ok(
    Math.abs(result.trades[0].entryPrice - 101) < 1e-9,
    `expected an entry at the channel high 101, got ${result.trades[0].entryPrice}`,
  );
});

test("touching the prior high without exceeding it is not a breakout", () => {
  // Every bar's high is exactly 101 — the channel high. A `>=` check would fire on every bar.
  const candles = Array.from({ length: 60 }, (_, i) => candle(i, 100, 101, 99));
  const result = runTurtleBacktest(candles, noFriction);
  assert.equal(result.totalTrades, 0);
});

test("long-only config never opens a short, even on a downside breakout", () => {
  const candles: Candle[] = [];
  for (let i = 0; i < 30; i++) candles.push(candle(i, 100, 101, 99));
  for (let i = 30; i < 60; i++) candles.push(candle(i, 80, 81, 79)); // hard break down

  const result = runTurtleBacktest(candles, { ...noFriction, longOnly: true });
  assert.ok(result.trades.every((t) => t.side === "long"));
});

test("slippage always works against the trade, never in its favor", () => {
  const candles: Candle[] = [];
  for (let i = 0; i < 30; i++) candles.push(candle(i, 100, 101, 99));
  candles.push(candle(30, 110, 110, 100));
  for (let i = 31; i < 60; i++) candles.push(candle(i, 112, 113, 111));
  candles.push(candle(60, 90, 91, 89)); // collapse to force an exit

  const clean = runTurtleBacktest(candles, noFriction);
  const slipped = runTurtleBacktest(candles, { ...noFriction, slippagePctPerSide: 0.01 });

  assert.ok(clean.trades.length > 0 && slipped.trades.length > 0);
  // Worse entry AND worse exit: the slipped result must be strictly worse.
  assert.ok(
    slipped.trades[0].resultPct < clean.trades[0].resultPct,
    `slipped ${slipped.trades[0].resultPct} should be worse than clean ${clean.trades[0].resultPct}`,
  );
  assert.ok(slipped.trades[0].entryPrice > clean.trades[0].entryPrice, "long entry fill should be worse (higher)");
});

test("fees reduce every trade's result by exactly the round-trip fee", () => {
  const candles: Candle[] = [];
  for (let i = 0; i < 30; i++) candles.push(candle(i, 100, 101, 99));
  candles.push(candle(30, 110, 110, 100));
  for (let i = 31; i < 60; i++) candles.push(candle(i, 112, 113, 111));
  candles.push(candle(60, 90, 91, 89));

  const free = runTurtleBacktest(candles, noFriction);
  const paid = runTurtleBacktest(candles, { ...noFriction, feePct: 0.0016 });

  assert.equal(free.trades.length, paid.trades.length);
  const delta = free.trades[0].resultPct - paid.trades[0].resultPct;
  assert.ok(Math.abs(delta - 0.16) < 1e-9, `expected a 0.16% fee drag, got ${delta}`);
});

test("an ATR stop caps the loss on a trade that immediately reverses", () => {
  const candles: Candle[] = [];
  for (let i = 0; i < 30; i++) candles.push(candle(i, 100, 101, 99));
  candles.push(candle(30, 110, 110, 100)); // breakout entry
  for (let i = 31; i < 45; i++) candles.push(candle(i, 60, 61, 59)); // immediate collapse

  const result = runTurtleBacktest(candles, noFriction);
  assert.ok(result.trades.length >= 1);
  const first = result.trades[0];
  assert.equal(first.exitReason, "stop_loss");
  // The stop must bound the loss well above a full collapse to 60 (-45%).
  assert.ok(first.resultPct > -30, `stop should cap the loss, got ${first.resultPct}%`);
});

test("a bar that breaks out and collapses through the stop is booked as a loss, not skipped", () => {
  const candles: Candle[] = [];
  for (let i = 0; i < 30; i++) candles.push(candle(i, 100, 101, 99));
  // Spikes to 115 (breakout) then collapses to 70 within the same bar.
  candles.push({ openTime: 30, open: 100, high: 115, low: 70, close: 75, volume: 1 });
  for (let i = 31; i < 40; i++) candles.push(candle(i, 75, 76, 74));

  const result = runTurtleBacktest(candles, noFriction);
  assert.equal(result.totalTrades, 1, "the same-bar reversal must be recorded, not dropped");
  assert.equal(result.trades[0].exitReason, "stop_loss");
  assert.ok(result.trades[0].resultPct < 0);
});

test("a stop that gaps through fills at the open, not at the stop price", () => {
  const candles: Candle[] = [];
  for (let i = 0; i < 30; i++) candles.push(ohlc(i, 100, 101, 99, 100));
  candles.push(ohlc(30, 100, 110, 100, 109)); // breakout: entry at the channel high, 101
  candles.push(ohlc(31, 109, 110, 108, 109)); // holds; well clear of the ~2*ATR stop
  candles.push(ohlc(32, 80, 81, 78, 79)); // opens at 80, far BELOW the stop

  const result = runTurtleBacktest(candles, noFriction);
  assert.equal(result.trades.length, 1);
  const t = result.trades[0];
  assert.equal(t.exitReason, "stop_loss");
  assert.ok(t.exitPrice <= 80, `fill should be at/below the gapped open (80), got ${t.exitPrice}`);
  // Entry 101, exit 80 => about -20%, far worse than a fill at the stop level would imply.
  assert.ok(t.resultPct < -15, `gap loss should be severe, got ${t.resultPct}%`);
});

test("drawdown is compounded and stays within 0-100%", () => {
  const candles: Candle[] = [];
  for (let i = 0; i < 30; i++) candles.push(candle(i, 100, 101, 99));
  for (let i = 30; i < 200; i++) {
    const base = 100 + Math.sin(i / 7) * 15;
    candles.push(candle(i, base, base + 2, base - 2));
  }

  const result = runTurtleBacktest(candles, TURTLE_SYSTEM_1);
  assert.ok(result.maxDrawdownPct >= 0 && result.maxDrawdownPct <= 100);
  assert.ok(result.totalReturnPct > -100, "compounded equity cannot lose more than everything");
});
