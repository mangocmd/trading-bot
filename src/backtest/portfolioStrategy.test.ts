import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runVolManagedPortfolio,
  DEFAULT_VOL_MANAGED_CONFIG,
  type VolManagedConfig,
} from "./portfolioStrategy.js";
import type { Candle } from "./indicators.js";

function candle(openTime: number, close: number): Candle {
  return { openTime, open: close, high: close * 1.01, low: close * 0.99, close, volume: 1 };
}

/** A deterministic price walk — same seed, same series, so tests don't flake. */
function series(n: number, seed: number, drift = 0.0004, amp = 0.02): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const shock = ((s / 0x7fffffff) - 0.5) * amp;
    price *= 1 + drift + shock;
    out.push(candle(i, price));
  }
  return out;
}

const config: VolManagedConfig = { ...DEFAULT_VOL_MANAGED_CONFIG, volWindow: 10 };

test("empty or too-short input returns a zeroed result rather than crashing", () => {
  assert.equal(runVolManagedPortfolio({}, config).dailyReturns.length, 0);
  assert.equal(runVolManagedPortfolio({ A: series(5, 1) }, config).dailyReturns.length, 0);
});

/**
 * The test that matters, and the one that is easy to fake.
 *
 * The bug it guards against is a one-bar leak in the volatility window: sizing bar i using
 * volatility that includes bar i. Get that wrong and the book shrinks on precisely the day the
 * crash arrives, dodging a loss it could not possibly have seen coming. It looks like risk
 * management. It is clairvoyance, and it is how the ensemble work in this project once produced
 * a Sharpe of 7.
 *
 * The setup makes the leak impossible to hide: 200 near-flat bars, then a single -25% bar. Sized
 * honestly, the trailing window sees only the calm stretch, forecasts near-zero volatility, and
 * holds the maximum — so the strategy MUST eat the crash almost in full. Sized with the leak, the
 * crash bar's own move inflates the volatility estimate, exposure collapses toward zero, and the
 * loss largely vanishes. So the assertion is inverted from the usual instinct: we require the
 * strategy to LOSE money here. A version that escapes is a broken one.
 */
test("no lookahead: the strategy takes the full hit on the first bar of a crash", () => {
  const calm: Candle[] = [];
  let price = 100;
  for (let i = 0; i < 200; i++) {
    price *= 1 + (i % 2 === 0 ? 0.0005 : -0.0004); // barely moves: forecast vol ≈ 0
    calm.push(candle(i, price));
  }
  calm.push(candle(200, price * 0.75)); // the crash: -25%, out of a clear blue sky

  const result = runVolManagedPortfolio({ A: calm }, config);
  const worstDay = Math.min(...result.dailyReturns);

  assert.ok(
    worstDay < -0.20,
    `worst day was only ${(worstDay * 100).toFixed(1)}% against a -25% crash — the book shrank ` +
      `before the crash it could not have known about. Volatility is being measured with the ` +
      `current bar included (lookahead).`,
  );

  // And it must have been near-fully invested going in, since the past gave it no warning at all.
  const exposureIntoTheCrash = result.exposures[result.exposures.length - 1];
  assert.ok(
    exposureIntoTheCrash > 0.9,
    `held only ${exposureIntoTheCrash.toFixed(2)} into an unforeseeable crash — it saw it coming`,
  );
});

test("no lookahead: rewriting the distant future leaves the past untouched", () => {
  // Weaker than the crash test (a one-bar leak slips past this one) but it still catches coarser
  // leaks, like a volatility figure computed over the whole series in one pass.
  const original = { A: series(300, 7), B: series(300, 13) };
  const base = runVolManagedPortfolio(original, config);

  const CUT = 200;
  const mutated: Record<string, Candle[]> = {
    A: original.A.map((c, i) => (i >= CUT ? candle(c.openTime, c.close * 3) : c)),
    B: original.B.map((c, i) => (i >= CUT ? candle(c.openTime, c.close * 0.2) : c)),
  };
  const after = runVolManagedPortfolio(mutated, config);

  const comparable = CUT - config.volWindow - 3;
  assert.ok(comparable > 20, "test needs a meaningful pre-cut stretch to compare");
  for (let i = 0; i < comparable; i++) {
    assert.equal(
      base.dailyReturns[i],
      after.dailyReturns[i],
      `day ${i} changed after the future was rewritten — future data is leaking backwards`,
    );
  }
});

test("volatility targeting shrinks exposure when volatility rises", () => {
  const calm = { A: series(300, 3, 0.0004, 0.004) };  // gentle
  const wild = { A: series(300, 3, 0.0004, 0.06) };   // same seed, 15x the shock

  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const calmExp = avg(runVolManagedPortfolio(calm, config).exposures);
  const wildExp = avg(runVolManagedPortfolio(wild, config).exposures);

  assert.ok(
    wildExp < calmExp,
    `a wild market should be held smaller: wild ${wildExp.toFixed(3)} vs calm ${calmExp.toFixed(3)}`,
  );
});

/**
 * The control that keeps the whole premise honest. Averaging 0.9 exposure instead of 1.0 would cut
 * drawdowns all by itself, with no cleverness whatsoever — so if exposure barely moves, this is
 * just "own less" wearing a costume. The strategy earns its name only if the exposure it holds
 * genuinely varies over time.
 */
test("exposure actually varies over time — otherwise this is just constant de-leveraging", () => {
  // A series that is calm for a long stretch and then turbulent, so a working overlay must respond.
  const mixed = [...series(200, 5, 0.0004, 0.004), ...series(200, 5, 0.0004, 0.05)];
  const reindexed = mixed.map((c, i) => candle(i, c.close));

  const { exposures } = runVolManagedPortfolio({ A: reindexed }, config);
  const spread = Math.max(...exposures) - Math.min(...exposures);

  assert.ok(
    spread > 0.3,
    `exposure only moved ${spread.toFixed(2)} across a calm-then-turbulent market — the overlay is ` +
      `not actually timing anything, it is holding a near-constant position`,
  );
});

test("exposure never exceeds maxExposure, no matter how calm the market gets", () => {
  // Near-zero volatility would send targetVol/realizedVol toward infinity without the cap.
  const glassy: Candle[] = Array.from({ length: 200 }, (_, i) => candle(i, 100 + i * 0.0001));
  const { exposures } = runVolManagedPortfolio({ A: glassy }, config);
  for (const e of exposures) {
    assert.ok(e <= config.maxExposure + 1e-12, `exposure ${e} exceeded the cap ${config.maxExposure}`);
    assert.ok(e >= 0, `exposure ${e} went negative`);
  }
});

test("costs are charged: a costly run must underperform a free one", () => {
  const data = { A: series(400, 11), B: series(400, 17) };
  const free = runVolManagedPortfolio(data, { ...config, costPerSide: 0 });
  const costly = runVolManagedPortfolio(data, { ...config, costPerSide: 0.01 });
  assert.ok(
    costly.totalReturnPct < free.totalReturnPct,
    "charging 1% per side must reduce the result — costs were silently dropped",
  );
});

test("a flat market produces no exposure and no return, not a divide-by-zero", () => {
  const flat: Candle[] = Array.from({ length: 200 }, (_, i) => candle(i, 100));
  const result = runVolManagedPortfolio({ A: flat }, config);
  assert.ok(result.dailyReturns.every((r) => Number.isFinite(r)));
  assert.ok(result.exposures.every(Number.isFinite));
  assert.equal(result.maxDrawdownPct, 0);
});

test("drawdown is compounded and bounded, and equity cannot fall below zero", () => {
  const data = { A: series(500, 33, -0.001, 0.05) }; // a nasty, choppy downtrend
  const result = runVolManagedPortfolio(data, config);
  assert.ok(result.maxDrawdownPct >= 0 && result.maxDrawdownPct <= 100);
  assert.ok(result.totalReturnPct > -100, "compounded equity cannot lose more than everything");
  assert.ok(Number.isFinite(result.sharpe));
});

test("a basket is equal-weighted: one symbol's move is diluted by the others", () => {
  const mover = series(300, 41, 0.003, 0.01);   // strong drift
  const still: Candle[] = Array.from({ length: 300 }, (_, i) => candle(i, 100));

  const alone = runVolManagedPortfolio({ A: mover }, config);
  const diluted = runVolManagedPortfolio({ A: mover, B: still }, config);

  assert.ok(
    diluted.totalReturnPct < alone.totalReturnPct,
    "pairing a rising asset with a flat one must dilute the return — weights are not equal",
  );
});
