import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runGauntlet,
  nullTest,
  shuffleReturns,
  mulberry32,
  toPrices,
  evaluate,
  DEFAULT_GAUNTLET,
  type Candidate,
  type GauntletConfig,
} from "./gauntlet.js";
import { generateCandidates, randomCandidate } from "./candidates.js";

const config: GauntletConfig = { ...DEFAULT_GAUNTLET };

/** A price series with a real drift and realistic noise, long enough for the gauntlet's splits. */
function returnSeries(n: number, seed: number, drift = 0.0004, vol = 0.011): number[] {
  const rand = mulberry32(seed);
  const out = [0];
  for (let i = 1; i < n; i++) {
    // Sum of three uniforms ≈ normal, scaled to the requested standard deviation.
    const shock = (rand() + rand() + rand() - 1.5) * 2 * vol * 0.8165;
    out.push(drift + shock);
  }
  return out;
}

/** Cheats: goes long whenever tomorrow rises. Used to prove the harness rejects lookahead. */
const clairvoyant: Candidate = {
  describe: () => "clairvoyant",
  jitter: () => clairvoyant,
  signals: (close) => {
    const sig = new Array(close.length).fill(0);
    for (let i = 0; i < close.length - 1; i++) sig[i] = close[i + 1] > close[i] ? 1 : 0;
    return sig;
  },
};

/** Never trades. Must be rejected at the first gate, not crash. */
const inert: Candidate = {
  describe: () => "inert",
  jitter: () => inert,
  signals: (close) => new Array(close.length).fill(0),
};

test("a candidate that never trades is rejected, not crashed on", () => {
  const ret = returnSeries(1200, 1);
  const v = runGauntlet(inert, toPrices(ret), ret, mulberry32(2), config);
  assert.equal(v.passed, false);
  assert.equal(v.diedAt, "too_few_trades");
});

test("a series too short for the splits is rejected rather than silently mis-scored", () => {
  const ret = returnSeries(300, 3);
  const v = runGauntlet(randomCandidate(mulberry32(4)), toPrices(ret), ret, mulberry32(5), config);
  assert.equal(v.passed, false);
});

/**
 * The lookahead guard. `clairvoyant` reads bar i+1 to set bar i's signal, so with the runner's
 * one-bar lag its position at bar i is set by bar i-1's knowledge of bar i — it is long on exactly
 * the up days and flat on exactly the down days. If the runner's lag were missing or off, this
 * would be even more absurd. Either way the result is unmistakable: an impossible Sharpe.
 *
 * The assertion is that the harness REPORTS the cheat rather than laundering it. A harness that
 * quietly returns an ordinary-looking number for a clairvoyant strategy is broken.
 */
test("a clairvoyant strategy produces an impossible Sharpe — the harness does not launder cheating", () => {
  const ret = returnSeries(1200, 7);
  const v = runGauntlet(clairvoyant, toPrices(ret), ret, mulberry32(8), config);
  assert.ok(v.passed, "a strategy that can see the future should clear every stage");
  assert.ok(
    v.oosSharpe > 5,
    `clairvoyance scored only ${v.oosSharpe.toFixed(2)} — the harness is not measuring what it claims to`,
  );
});

test("the one-bar lag is real: signals cannot spend the bar they were computed on", () => {
  // A candidate whose signal is a pure function of TODAY's direction. Lagged honestly, yesterday's
  // direction says nothing about today's, so the result must be ordinary. Un-lagged, it would be
  // long on every up day and flat on every down day — the same clairvoyance as above.
  const readsToday: Candidate = {
    describe: () => "long if today rose",
    jitter: () => readsToday,
    signals: (close) => {
      const sig = new Array(close.length).fill(0);
      for (let i = 1; i < close.length; i++) sig[i] = close[i] > close[i - 1] ? 1 : 0;
      return sig;
    },
  };

  const ret = returnSeries(1200, 11);
  const v = runGauntlet(readsToday, toPrices(ret), ret, mulberry32(12), config);
  assert.ok(
    v.oosSharpe < 4,
    `Sharpe ${v.oosSharpe.toFixed(2)} on a coin-flip signal is not skill, it is a one-bar lookahead leak`,
  );
});

test("shuffling preserves the distribution and destroys only the order", () => {
  const ret = returnSeries(2000, 13);
  const shuffled = shuffleReturns(ret, mulberry32(14));

  const sum = (v: number[]) => v.slice(1).reduce((a, b) => a + b, 0);
  const sumSq = (v: number[]) => v.slice(1).reduce((a, b) => a + b * b, 0);

  // Same multiset of returns: mean and variance are identical to floating-point noise.
  assert.ok(Math.abs(sum(ret) - sum(shuffled)) < 1e-9, "shuffling changed the mean — it is not a permutation");
  assert.ok(Math.abs(sumSq(ret) - sumSq(shuffled)) < 1e-9, "shuffling changed the variance — it is not a permutation");

  // But the order is genuinely different.
  let sameSlot = 0;
  for (let i = 1; i < ret.length; i++) if (ret[i] === shuffled[i]) sameSlot++;
  assert.ok(sameSlot < ret.length * 0.1, "the shuffle barely moved anything — the null is not a null");
});

test("costs are charged: doubling them cannot improve a strategy", () => {
  const ret = returnSeries(1500, 17);
  const close = toPrices(ret);
  const cand = randomCandidate(mulberry32(18));

  const cheap = runGauntlet(cand, close, ret, mulberry32(19), { ...config, costPerSide: 0 });
  const dear = runGauntlet(cand, close, ret, mulberry32(19), { ...config, costPerSide: 0.02 });

  // A 2%-per-side cost must not leave a candidate better off than a free one.
  assert.ok(
    dear.oosTotalPct <= cheap.oosTotalPct + 1e-9,
    `charging 2% per side improved the result (${dear.oosTotalPct.toFixed(1)}% vs ${cheap.oosTotalPct.toFixed(1)}%) — costs are not being applied`,
  );
});

/**
 * The headline claim, pinned as a test: pure noise clears the gauntlet at a non-trivial rate.
 *
 * If this ever starts asserting zero survivors, either the gauntlet was tightened (fine — but then
 * the documented 5.6% is stale and the README must change) or the null is broken (not fine). Either
 * way somebody has to look. That is what this test is for.
 */
test("the gauntlet passes strategies fitted to pure noise — this is the whole point", () => {
  const rand = mulberry32(20260714);
  const candidates = generateCandidates(60, rand);
  const real = returnSeries(2500, 42);

  const result = nullTest(candidates, real, 3, mulberry32(99), config);

  assert.ok(
    result.nullCandidatesTested === 180,
    `expected 60 candidates x 3 permutations, got ${result.nullCandidatesTested}`,
  );
  assert.ok(
    result.falsePositiveRate > 0,
    "not one noise-fitted strategy survived — suspicious; verify the null data is really being used",
  );
  assert.ok(
    result.falsePositiveRate < 0.5,
    `${(result.falsePositiveRate * 100).toFixed(1)}% of pure noise survived — the gauntlet is not filtering at all`,
  );
});

test("the null test reports what it tested, so a reader can check the arithmetic", () => {
  const rand = mulberry32(5);
  const candidates = generateCandidates(20, rand);
  const real = returnSeries(2500, 6);
  const result = nullTest(candidates, real, 2, mulberry32(7), config);

  assert.equal(result.candidatesTested, 20);
  assert.equal(result.nullCandidatesTested, 40);
  assert.ok(result.realSurvivors <= result.candidatesTested);
  assert.ok(result.nullSurvivors <= result.nullCandidatesTested);
  assert.ok(result.realBeatBuyAndHold <= result.realSurvivors, "more survivors beat buy-and-hold than exist");
  assert.ok(Number.isFinite(result.falsePositiveRate));
});

test("jittered candidates keep their shape and stay valid", () => {
  const rand = mulberry32(31);
  const close = toPrices(returnSeries(800, 32));
  for (let i = 0; i < 20; i++) {
    const c = randomCandidate(rand, "long_short");
    const j = c.jitter(rand);
    const sig = j.signals(close);
    assert.equal(sig.length, close.length, "a jittered candidate must still emit one signal per bar");
    assert.ok(sig.every((s) => s === -1 || s === 0 || s === 1), "signals must be -1, 0 or 1");
  }
});

/**
 * The book flag must actually change the book, not be a field nobody reads.
 *
 * This matters more than it looks. The long-only / long-short distinction is what separates
 * "this rule found structure" from "this rule was in a rising market" — the central finding in the
 * module comment. If `book: "long_short"` silently produced a long-only signal, that finding would
 * be measuring the same thing twice and nobody would notice.
 */
test("a long/short candidate actually shorts, and a long-only one never does", () => {
  const rand = mulberry32(41);
  const close = toPrices(returnSeries(1500, 42));

  let anyShorts = false;
  for (let i = 0; i < 40; i++) {
    const ls = randomCandidate(rand, "long_short");
    if (ls.signals(close).some((s) => s === -1)) anyShorts = true;

    const lo = randomCandidate(rand, "long_only");
    assert.ok(
      lo.signals(close).every((s) => s === 0 || s === 1),
      `a long-only candidate emitted a short: ${lo.describe()}`,
    );
  }
  assert.ok(anyShorts, "not one long/short candidate ever shorted — the book flag is being ignored");
});

/**
 * Shorting must cost money, and a long→short flip must cost DOUBLE — it is two units of turnover,
 * not one. An earlier version of the runner only recognised `exposure === 1` as an open position,
 * which silently priced every short as free. That bug would have flattered precisely the book this
 * project uses to make its strongest claim, so it gets pinned directly.
 *
 * Tested against `evaluate` rather than `runGauntlet`, because the gauntlet reports 0% for anything
 * that fails a gate — so a deliberately terrible strategy scores 0 either way and the test proves
 * nothing. The first version of this test did exactly that and passed vacuously against the bug.
 */
test("a long→short flip costs two units of turnover, not one, and shorts are not free", () => {
  const ret = returnSeries(400, 51);
  const COST = 0.01;
  const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);

  // Cost is subtracted linearly from each bar's return, so the difference between a free run and a
  // costly one, summed over the daily series, is EXACTLY the turnover charged. Comparing compounded
  // totals instead would smear that with the compounding and blunt the assertion.
  const unitsCharged = (sig: number[]): number =>
    (sum(evaluate(sig, ret, 200, 400, 0, 252).daily) - sum(evaluate(sig, ret, 200, 400, COST, 252).daily)) / COST;

  // The runner assumes flat at the start of the scored window, so every one of these pays one unit
  // to enter. That is deliberate and conservative; what matters here is what it pays ON TOP.
  const heldLong = new Array(400).fill(0);
  for (let i = 100; i < 400; i++) heldLong[i] = 1;

  const heldShort = new Array(400).fill(0);
  for (let i = 100; i < 400; i++) heldShort[i] = -1;

  // Long for the first half of the window, short for the second: entry (1 unit) plus one
  // long→short flip worth |1 − (−1)| = 2 units.
  const flipped = new Array(400).fill(0);
  for (let i = 100; i < 300; i++) flipped[i] = 1;
  for (let i = 300; i < 400; i++) flipped[i] = -1;

  const longUnits = unitsCharged(heldLong);
  const shortUnits = unitsCharged(heldShort);
  const flipUnits = unitsCharged(flipped);

  assert.ok(
    Math.abs(shortUnits - longUnits) < 1e-6,
    `holding a short was charged ${shortUnits.toFixed(3)} units against ${longUnits.toFixed(3)} for an ` +
      `identical long — shorts are being priced differently, and cheaply.`,
  );
  assert.ok(
    shortUnits > 0.5,
    `holding a short was charged ${shortUnits.toFixed(3)} units of turnover — shorts are free.`,
  );
  assert.ok(
    Math.abs(flipUnits - longUnits - 2) < 1e-6,
    `a long→short flip was charged ${(flipUnits - longUnits).toFixed(3)} extra units, expected exactly 2. ` +
      `Crossing from +1 to −1 is two units of turnover, not one.`,
  );
});
