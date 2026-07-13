import type { Candle } from "./indicators.js";

/**
 * A strategy-discovery gauntlet, and the control that tells you what it is worth.
 *
 * PRIOR ART, STATED UP FRONT. Nothing statistical here is original. Permutation testing for trading
 * systems has a literature and a textbook:
 *
 *   - Timothy Masters, "Permutation and Randomization Tests for Trading System Development" (2020).
 *     A whole book, with C++ code, covering overfitting, luck-versus-skill, selection bias when
 *     screening indicators, and — exactly what `nullTest` below does — testing the reliability of a
 *     "trading system factory". Read that instead of this comment.
 *   - Halbert White, "A Reality Check for Data Snooping" (2000).
 *   - Bailey & Lopez de Prado, "The Deflated Sharpe Ratio" (2014), and the Probability of Backtest
 *     Overfitting — the standard analytic corrections for selection bias across N trials.
 *
 * This file is a MEASUREMENT, not a discovery: the standard test, run against a realistic modern
 * gauntlet, in code you can execute. The permutation test measures directly what DSR approximates
 * analytically, which is useful mainly because it needs no distributional assumptions.
 *
 * Serious open-source quant projects now put candidate strategies through a gauntlet designed to
 * kill them: walk-forward out-of-sample folds, doubled fees and slippage, Monte-Carlo bootstrap on
 * the trade sequence, regime splits, parameter jitter. That discipline is real and it kills most
 * candidates. But a gauntlet does not solve multiple testing. It only raises the bar noise has to
 * clear — and a generator that can propose unlimited candidates will clear any fixed bar eventually.
 *
 * A gauntlet without a null distribution cannot tell a survivor from a lucky fraud. Almost everyone
 * in this field can recite that. Very few have run the number for their own pipeline. So: run the
 * same candidates through the same gauntlet on data where an edge cannot exist, and count the
 * survivors. That number is the gauntlet's false-positive rate.
 *
 * WHAT THIS FOUND (400 candidates, SPY daily, 10 years — reproduce with `npm run gauntlet`):
 *
 *   book         real SPY     SHUFFLED (drift kept)   ZERO-DRIFT WALK   beat buy & hold
 *   long-only    4.0%         4.7%                    0.0%              0 of 16
 *   long/short   0.5%         0.0%                    0.1%              0 of 2
 *
 * The shuffled series has the same mean, volatility, skew and fat tails as the real one — it is
 * literally the same returns, reordered. The only thing destroyed is the sequence, which is the only
 * thing a rule could exploit. No structure can exist there, by construction.
 *
 * THE DIAGONAL IS THE PROOF. Same shuffled data, same gauntlet, one difference — whether shorting is
 * allowed. Long-only: 4.7% survive. Long/short: 0.0% survive. Since there is nothing to find in that
 * data, the only thing the long-only survivors can be doing is SITTING IN THE DRIFT. Allow them to
 * short, the drift cancels, and the survivor count goes to zero immediately.
 *
 * The zero-drift column confirms it from the other side: strip the drift out of the world entirely
 * and long-only survivors go to 0.0% — not "lower", zero, out of 4000.
 *
 * The survivors that look most convincing come from data with nothing in it:
 *   MA cross 5/45  — OOS Sharpe 1.12, +88.6%   (in shuffled data)
 *   momentum 65d   — OOS Sharpe 1.01, +74.5%   (in shuffled data)
 * Both cleared walk-forward, Monte-Carlo, doubled costs and ±10% parameter jitter.
 *
 * So there are two different ways to contain no edge, and this gauntlet passes both:
 *   LONG-ONLY survivors are BETA  — they die the moment the drift is removed.
 *   LONG/SHORT survivors are NOISE — they clear the gauntlet on real data (0.5%) at the same rate
 *                                    they clear it on a pure random walk (0.1%). Both are the floor.
 *
 * A GAUNTLET CANNOT TELL "FOUND AN EDGE" FROM "WAS LONG DURING AN UPTREND." Every stage in it — the
 * folds, the bootstrap, the jitter — tests whether a result is STABLE, and passive exposure to a
 * drifting market is extremely stable.
 *
 * Which is why NOT ONE survivor in either book beat buy-and-hold (+60.6% over the same stretch). The
 * gauntlet only ever asks "is it profitable" — never "is it better than doing nothing."
 *
 * ON THE NUMBERS: the survivor RATES carry seed noise (the shuffled long-only rate moved between
 * roughly 2% and 6% across seeds during development). Do not quote them to one decimal place. What
 * is stable, and what the argument rests on, is the SHAPE: shuffled ≈ real for long-only; zero once
 * the drift is gone; long/short at the noise floor everywhere; and nothing, anywhere, beating
 * buy-and-hold.
 *
 * Use this on your own pipeline: run your generator and your gauntlet against `shuffleReturns()`
 * output and count what gets through. Then run it long/short. If your long-only survivors vanish
 * when they are allowed to short, they were never strategies — they were exposure.
 */

export interface GauntletConfig {
  /** Per-side cost as a fraction. Stocks ≈ 0.0003; crypto ≈ 0.0008. */
  costPerSide: number;
  /** Minimum in-sample profit factor to be considered a candidate at all. */
  minInSamplePF: number;
  /** Minimum in-sample trades — fewer than this and the statistics mean nothing. */
  minTrades: number;
  /** How many of the 4 walk-forward folds must be profitable. */
  minPositiveFolds: number;
  /** Monte-Carlo: the 95th-percentile drawdown must stay under this (as a fraction). */
  maxBootstrapDrawdown: number;
  /** Parameter jitter: how many of 10 ±10%-nudged variants must stay profitable. */
  minJitterSurvivors: number;
  /** Bars per year, for annualizing. */
  periodsPerYear: number;
}

export const DEFAULT_GAUNTLET: GauntletConfig = {
  costPerSide: 0.0003,
  minInSamplePF: 1.2,
  minTrades: 20,
  minPositiveFolds: 3,
  maxBootstrapDrawdown: 0.35,
  minJitterSurvivors: 7,
  periodsPerYear: 252,
};

/** Where a candidate died. `SURVIVED` means it cleared every stage. */
export type GauntletStage =
  | "too_few_trades"
  | "weak_in_sample"
  | "dies_on_doubled_costs"
  | "fails_walk_forward"
  | "fails_regime_split"
  | "too_few_oos_trades"
  | "monte_carlo_downside"
  | "monte_carlo_drawdown"
  | "edge_evaporates_on_jitter"
  | "SURVIVED";

export interface GauntletVerdict {
  passed: boolean;
  diedAt: GauntletStage;
  oosSharpe: number;
  oosTotalPct: number;
  /** The question the gauntlet forgets to ask. */
  beatsBuyAndHold: boolean;
}

/** A candidate: a signal generator plus the parameters that a jitter step can perturb. */
export interface Candidate {
  describe(): string;
  /**
   * -1 = short, 0 = flat, +1 = long, per bar. The runner applies the one-bar lag; do not lag here.
   *
   * The short side is not decoration. A long-only book can earn a market's drift just by being in
   * it, so a long-only candidate can clear a gauntlet without detecting anything — see the module
   * comment. A long/short book has no drift to sit in, which makes it the harder and more honest
   * test of whether a rule found any structure at all.
   */
  signals(close: number[]): number[];
  /** Return a copy with every parameter multiplied by a factor near 1. */
  jitter(rand: () => number): Candidate;
}

function mean(v: number[]): number {
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}
function stdev(v: number[]): number {
  if (v.length < 2) return 0;
  const m = mean(v);
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
}

export interface Perf {
  daily: number[];
  trades: number[];
  sharpe: number;
  totalPct: number;
  profitFactor: number;
}

/**
 * Scores a signal series. Exported because it is the piece worth reusing and the piece worth
 * testing: everything the gauntlet concludes rests on this function pricing exposure honestly.
 *
 * Signal from bar i-1 earns bar i's return. A signal computed on bar i knows bar i's close, so
 * spending it on bar i's return is buying with knowledge of the move being harvested — the one-bar
 * leak that produced a fake Sharpe of 7 elsewhere in this project.
 */
export function evaluate(sig: number[], ret: number[], from: number, to: number, cost: number, ppy: number): Perf {
  const daily: number[] = [];
  const trades: number[] = [];
  let prev = 0;
  let openTrade = 0;
  let inTrade = false;

  for (let i = from; i < to; i++) {
    const exposure = sig[i - 1] ?? 0;
    // Cost is charged on the CHANGE in exposure, so a long→short flip pays for two units of
    // turnover, not one. An earlier version only recognised `exposure === 1` as a position, which
    // silently priced every short as free.
    const r = exposure * ret[i] - Math.abs(exposure - prev) * cost;
    daily.push(r);
    if (exposure !== 0) {
      openTrade += r;
      inTrade = true;
    } else if (inTrade) {
      trades.push(openTrade);
      openTrade = 0;
      inTrade = false;
    }
    prev = exposure;
  }
  if (inTrade) trades.push(openTrade);

  const m = mean(daily);
  const sd = stdev(daily);
  let equity = 1;
  for (const r of daily) equity *= 1 + r;

  const gross = trades.filter((t) => t > 0).reduce((a, b) => a + b, 0);
  const loss = Math.abs(trades.filter((t) => t <= 0).reduce((a, b) => a + b, 0));

  return {
    daily,
    trades,
    sharpe: sd > 0 ? (m / sd) * Math.sqrt(ppy) : 0,
    totalPct: (equity - 1) * 100,
    profitFactor: loss > 0 ? gross / loss : gross > 0 ? Infinity : 0,
  };
}

/**
 * Puts one candidate through every stage. Cheap filters run first, exactly as a real pipeline
 * would order them — there is no point bootstrapping a strategy that never traded.
 */
export function runGauntlet(
  candidate: Candidate,
  close: number[],
  ret: number[],
  rand: () => number,
  config: GauntletConfig = DEFAULT_GAUNTLET,
): GauntletVerdict {
  const n = close.length;
  const warmup = 220;
  const mid = Math.floor((warmup + n) / 2);
  const fail = (diedAt: GauntletStage): GauntletVerdict => ({
    passed: false, diedAt, oosSharpe: 0, oosTotalPct: 0, beatsBuyAndHold: false,
  });

  if (n < warmup + 200) return fail("too_few_trades");

  const sig = candidate.signals(close);
  const doubled = config.costPerSide * 2;

  // 1. In-sample: is this even a candidate?
  const is = evaluate(sig, ret, warmup, mid, config.costPerSide, config.periodsPerYear);
  if (is.trades.length < config.minTrades) return fail("too_few_trades");
  if (is.profitFactor < config.minInSamplePF) return fail("weak_in_sample");

  // 2. Doubled costs: is the edge a fee artifact?
  const isCostly = evaluate(sig, ret, warmup, mid, doubled, config.periodsPerYear);
  if (isCostly.profitFactor < 1.05) return fail("dies_on_doubled_costs");

  // 3. Walk-forward: 4 out-of-sample folds, most must be profitable.
  const oosLen = n - mid;
  const fold = Math.floor(oosLen / 4);
  let positiveFolds = 0;
  for (let f = 0; f < 4; f++) {
    const p = evaluate(sig, ret, mid + f * fold, mid + (f + 1) * fold, doubled, config.periodsPerYear);
    if (p.totalPct > 0) positiveFolds++;
  }
  if (positiveFolds < config.minPositiveFolds) return fail("fails_walk_forward");

  // 4. Regime split: profitable in both halves of the out-of-sample stretch.
  const half = mid + Math.floor(oosLen / 2);
  const h1 = evaluate(sig, ret, mid, half, doubled, config.periodsPerYear);
  const h2 = evaluate(sig, ret, half, n, doubled, config.periodsPerYear);
  if (h1.totalPct <= 0 || h2.totalPct <= 0) return fail("fails_regime_split");

  const oos = evaluate(sig, ret, mid, n, doubled, config.periodsPerYear);

  // 5. Monte-Carlo: resample the trade sequence. Was the ORDER of the trades doing the work?
  if (oos.trades.length < 10) return fail("too_few_oos_trades");
  const RUNS = 500;
  const totals: number[] = [];
  const drawdowns: number[] = [];
  for (let b = 0; b < RUNS; b++) {
    let equity = 1, peak = 1, dd = 0;
    for (let k = 0; k < oos.trades.length; k++) {
      equity *= 1 + oos.trades[Math.floor(rand() * oos.trades.length)];
      peak = Math.max(peak, equity);
      dd = Math.max(dd, (peak - equity) / peak);
    }
    totals.push(equity - 1);
    drawdowns.push(dd);
  }
  totals.sort((a, b) => a - b);
  drawdowns.sort((a, b) => a - b);
  if (totals[Math.floor(0.05 * RUNS)] < 0) return fail("monte_carlo_downside");
  if (drawdowns[Math.floor(0.95 * RUNS)] > config.maxBootstrapDrawdown) return fail("monte_carlo_drawdown");

  // 6. Parameter jitter: nudge every parameter ±10%. A real edge is a plateau, not a spike.
  let survived = 0;
  for (let j = 0; j < 10; j++) {
    const nudged = candidate.jitter(rand);
    const jp = evaluate(nudged.signals(close), ret, mid, n, doubled, config.periodsPerYear);
    if (jp.totalPct > 0) survived++;
  }
  if (survived < config.minJitterSurvivors) return fail("edge_evaporates_on_jitter");

  // Cleared everything. Now the question the gauntlet never asks.
  let bh = 1;
  for (let i = mid; i < n; i++) bh *= 1 + ret[i];

  return {
    passed: true,
    diedAt: "SURVIVED",
    oosSharpe: oos.sharpe,
    oosTotalPct: oos.totalPct,
    beatsBuyAndHold: oos.totalPct > (bh - 1) * 100,
  };
}

export interface NullTestResult {
  realSurvivors: number;
  realBeatBuyAndHold: number;
  nullSurvivors: number;
  candidatesTested: number;
  nullCandidatesTested: number;
  /** The number that makes the gauntlet mean anything: how often pure noise gets through. */
  falsePositiveRate: number;
  realSurvivorRate: number;
  /** Survivors found in data where no edge can exist, for inspection. They look convincing. */
  nullExamples: string[];
}

/**
 * The permutation control: same candidates, same gauntlet, on data with the structure destroyed.
 *
 * Shuffling returns preserves every distributional property — mean, volatility, skew, kurtosis, the
 * fat tails — and destroys exactly one thing: the ORDER. Any strategy that "works" on the shuffled
 * series is reading something that does not exist. Count them, and you have the false-positive rate
 * of your gauntlet.
 */
export function nullTest(
  candidates: Candidate[],
  realReturns: number[],
  permutations: number,
  rand: () => number,
  config: GauntletConfig = DEFAULT_GAUNTLET,
): NullTestResult {
  const realClose = toPrices(realReturns);
  let realSurvivors = 0;
  let realBeat = 0;
  for (const c of candidates) {
    const v = runGauntlet(c, realClose, realReturns, rand, config);
    if (v.passed) {
      realSurvivors++;
      if (v.beatsBuyAndHold) realBeat++;
    }
  }

  let nullSurvivors = 0;
  const nullExamples: string[] = [];
  for (let p = 0; p < permutations; p++) {
    const shuffled = shuffleReturns(realReturns, rand);
    const close = toPrices(shuffled);
    for (const c of candidates) {
      const v = runGauntlet(c, close, shuffled, rand, config);
      if (v.passed) {
        nullSurvivors++;
        if (nullExamples.length < 5) {
          nullExamples.push(
            `${c.describe()} — OOS Sharpe ${v.oosSharpe.toFixed(2)}, ${v.oosTotalPct.toFixed(1)}% (in data with NO structure)`,
          );
        }
      }
    }
  }

  const nullTested = candidates.length * permutations;
  return {
    realSurvivors,
    realBeatBuyAndHold: realBeat,
    nullSurvivors,
    candidatesTested: candidates.length,
    nullCandidatesTested: nullTested,
    falsePositiveRate: nullTested > 0 ? nullSurvivors / nullTested : 0,
    realSurvivorRate: candidates.length > 0 ? realSurvivors / candidates.length : 0,
    nullExamples,
  };
}

/**
 * Fisher-Yates on the returns. Index 0 is left in place because it is the zero-return seed bar.
 *
 * Note the PRNG: an earlier version of this work used a bare linear congruential generator and it
 * produced an 88.7% win rate on a fair coin, because glibc-style LCG output is serially correlated
 * enough to corrupt a simulation. A random number generator can also be a lookahead bug. Use
 * `mulberry32` below, or something equally well-behaved.
 */
export function shuffleReturns(returns: number[], rand: () => number): number[] {
  const out = [...returns];
  for (let i = out.length - 1; i > 1; i--) {
    const j = 1 + Math.floor(rand() * i);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** mulberry32 — small, fast, and passes the statistical tests an LCG fails. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function toPrices(returns: number[], start = 100): number[] {
  const out = [start];
  for (let i = 1; i < returns.length; i++) out.push(out[out.length - 1] * (1 + returns[i]));
  return out;
}

export function returnsFromCandles(candles: Candle[]): number[] {
  const out = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1].close;
    out[i] = prev === 0 ? 0 : (candles[i].close - prev) / prev;
  }
  return out;
}
