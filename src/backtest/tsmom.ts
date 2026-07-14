/**
 * Time-series momentum on a diversified futures portfolio.
 *
 * This exists because it is the strongest surviving claim against everything else in this repo.
 * `gauntlet.ts` shows that a full validation stack cannot tell an edge from being long a drifting
 * market — but it only ever looked at SPY, one asset, and the academic case for trend-following is
 * built on the *cross-section*: 67 markets, four asset classes, and (Hurst, Ooi & Pedersen 2017) a
 * positive return in every decade since 1880. A single-asset test has no power against that claim.
 * So this file tests that claim, on its own terms, with its own construction.
 *
 * The construction is Moskowitz, Ooi & Pedersen (2012), not a strawman of it:
 *
 *   signal_t   = sign(return over the past 12 months)
 *   position_t = signal_t * (targetVol / sigma_t)      -- sigma_t is ex-ante, EWMA, com=60 days
 *   portfolio  = mean over instruments, rebalanced monthly
 *
 * The scaling means every instrument contributes the same risk, so a 4% vol bond future takes ten
 * times the notional of a 40% vol gas future. That is their design and it is load-bearing; without
 * it the portfolio is just a commodity fund.
 *
 * The point of the file is not to run TSMOM. It is to run TSMOM *alongside the controls that tell
 * you whether its returns require any predictive ability at all* — see `Control` below.
 */

export interface Series {
  symbol: string;
  assetClass: string;
  dates: number[];   // ms
  close: number[];
}

/**
 * What generates the position sign. The whole experiment lives in this type.
 *
 * TSMOM          — sign of the trailing 12-month return. The real strategy.
 * DRIFT          — sign of the *expanding-window historical mean* return, causal, no lookahead.
 *                  This is Huang, Li, Wang & Zhou (2020, JFE)'s control: a strategy that needs no
 *                  predictability whatsoever, only the knowledge that some things have gone up so
 *                  far. They report TSMOM's performance is "virtually the same" as this. If that
 *                  reproduces here, TSMOM's returns do not come from timing.
 * ALWAYS_LONG    — sign is always +1. The dumbest possible drift harvester.
 * RANDOM         — sign is a coin flip, redrawn each rebalance, same vol scaling. The noise floor.
 */
export type Control = "tsmom" | "drift" | "always_long" | "random";

export interface TsmomConfig {
  lookbackMonths: number;   // 12
  targetVol: number;        // 0.40 annualised, per instrument, as in MOP
  volCom: number;           // 60-day center of mass for the EWMA vol
  maxLeverage: number;      // per-instrument cap on |position|; MOP apply none. 0 = uncapped.
  costPerSide: number;      // fraction of notional, charged on |Δposition|
  periodsPerYear: number;   // 252
}

export const DEFAULT_CONFIG: TsmomConfig = {
  lookbackMonths: 12,
  targetVol: 0.40,
  volCom: 60,
  maxLeverage: 0,
  costPerSide: 0.0001,      // 1bp/side. Liquid futures; AQR's own estimates are in this range.
  periodsPerYear: 252,
};

export interface Perf {
  annReturn: number;
  annVol: number;
  sharpe: number;
  maxDrawdown: number;
  totalReturn: number;
  turnover: number;   // annualised, sum of |Δposition| across instruments
  months: number;
}

function pctReturns(close: number[]): number[] {
  const r = new Array(close.length).fill(0);
  for (let i = 1; i < close.length; i++) r[i] = close[i] / close[i - 1] - 1;
  return r;
}

/**
 * Ex-ante annualised volatility, exponentially weighted with a 60-day centre of mass.
 *
 * Uses returns strictly before i. A vol estimate that includes today's return is a lookahead: it
 * would shrink position size on exactly the days that turned out to be violent.
 */
function ewmaVol(returns: number[], com: number, ppy: number): number[] {
  const lambda = com / (com + 1);
  const out = new Array(returns.length).fill(NaN);
  let ewmaVar = NaN;
  let mean = 0;
  for (let i = 1; i < returns.length; i++) {
    const r = returns[i - 1];             // strictly before i
    if (Number.isNaN(ewmaVar)) {
      ewmaVar = r * r;
      mean = r;
    } else {
      mean = lambda * mean + (1 - lambda) * r;
      const dev = r - mean;
      ewmaVar = lambda * ewmaVar + (1 - lambda) * dev * dev;
    }
    out[i] = Math.sqrt(ewmaVar * ppy);
  }
  return out;
}

/** Month boundaries: the last index of each calendar month. Rebalance happens on these. */
function monthEnds(dates: number[]): number[] {
  const ends: number[] = [];
  for (let i = 0; i < dates.length - 1; i++) {
    const a = new Date(dates[i]);
    const b = new Date(dates[i + 1]);
    if (a.getUTCMonth() !== b.getUTCMonth() || a.getUTCFullYear() !== b.getUTCFullYear()) ends.push(i);
  }
  return ends;
}

function perf(daily: number[], turnoverTotal: number, ppy: number, months: number): Perf {
  const n = daily.length;
  if (n === 0) return { annReturn: 0, annVol: 0, sharpe: 0, maxDrawdown: 0, totalReturn: 0, turnover: 0, months: 0 };
  const mean = daily.reduce((a, b) => a + b, 0) / n;
  const variance = daily.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1);
  const sd = Math.sqrt(variance);

  let equity = 1, peak = 1, maxDd = 0;
  for (const r of daily) {
    equity *= 1 + r;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, (peak - equity) / peak);
  }
  const years = n / ppy;
  return {
    annReturn: equity > 0 ? equity ** (1 / years) - 1 : -1,
    annVol: sd * Math.sqrt(ppy),
    sharpe: sd > 0 ? (mean * ppy) / (sd * Math.sqrt(ppy)) : 0,
    maxDrawdown: maxDd,
    totalReturn: equity - 1,
    turnover: turnoverTotal / years,
    months,
  };
}

/**
 * Runs one book over an aligned panel of instruments.
 *
 * `panel` must be date-aligned: every series has the same dates array. Positions are set at month
 * ends from information available at that close, and earn the following days' returns. The one-bar
 * lag is enforced by construction: a position set at index `e` first earns at index `e + 1`.
 */
export function runBook(
  panel: Series[],
  control: Control,
  config: TsmomConfig,
  rand: () => number = Math.random,
): Perf {
  const n = panel[0].dates.length;
  const rets = panel.map((s) => pctReturns(s.close));
  const vols = rets.map((r) => ewmaVol(r, config.volCom, config.periodsPerYear));
  const ends = monthEnds(panel[0].dates);
  const lookbackDays = Math.round(config.lookbackMonths * config.periodsPerYear / 12);

  const positions = new Array(panel.length).fill(0);
  const daily: number[] = [];
  let turnoverTotal = 0;
  let rebalances = 0;

  // Expanding-window cumulative return per instrument, for the DRIFT control. Causal: at a
  // rebalance at index e it only ever sees closes up to e.
  const firstUsable = lookbackDays + 1;

  let nextEnd = 0;
  for (let i = firstUsable; i < n; i++) {
    // Earn today on yesterday's positions, before any rebalance can touch them.
    let r = 0;
    for (let k = 0; k < panel.length; k++) r += positions[k] * rets[k][i];
    daily.push(r / panel.length);

    // Rebalance at a month end, using information available at this close.
    while (nextEnd < ends.length && ends[nextEnd] < i) nextEnd++;
    if (nextEnd < ends.length && ends[nextEnd] === i) {
      rebalances++;
      for (let k = 0; k < panel.length; k++) {
        const close = panel[k].close;
        const sigma = vols[k][i];
        if (!Number.isFinite(sigma) || sigma <= 0) { positions[k] = 0; continue; }

        let sign: number;
        switch (control) {
          case "tsmom":
            sign = Math.sign(close[i] / close[i - lookbackDays] - 1);
            break;
          case "drift": {
            // Sign of the mean daily return over everything seen so far. No forecast, no timing —
            // just "has this thing gone up, historically."
            let sum = 0;
            for (let j = 1; j <= i; j++) sum += rets[k][j];
            sign = Math.sign(sum);
            break;
          }
          case "always_long":
            sign = 1;
            break;
          case "random":
            sign = rand() < 0.5 ? -1 : 1;
            break;
        }
        if (sign === 0) sign = 0;

        let target = sign * (config.targetVol / sigma);
        if (config.maxLeverage > 0) target = Math.max(-config.maxLeverage, Math.min(config.maxLeverage, target));

        const delta = Math.abs(target - positions[k]);
        // Both the cost and the reported turnover are divided by the book size, so both are
        // expressed per unit of portfolio. Reporting the raw sum while charging the average would
        // print a turnover figure 24x larger than the one the cost model actually used.
        turnoverTotal += delta / panel.length;
        daily[daily.length - 1] -= (delta * config.costPerSide) / panel.length;
        positions[k] = target;
      }
    }
  }

  return perf(daily, turnoverTotal, config.periodsPerYear, rebalances);
}

/**
 * Destroys the time-ordering of returns while preserving each instrument's mean, vol, skew and fat
 * tails, then rebuilds prices. Nothing is forecastable in the result *except* each instrument's
 * drift — so any book that still makes money here is harvesting drift, not timing anything.
 *
 * `synchronized` is not a detail. It decides what the null actually holds fixed, and getting it
 * wrong breaks the null:
 *
 *   true  — ONE permutation of the day indices, applied to every instrument. Day t of the null is
 *           therefore a REAL day: the cross-sectional co-movement of that day survives intact, and
 *           crashes still hit everything at once. Only the ORDER of days is destroyed. This is the
 *           null that isolates timing skill and nothing else. Trust this one.
 *
 *   false — each instrument gets its own permutation, which ALSO destroys the cross-asset
 *           correlation. That makes the null world *kinder* than the real one: crashes are
 *           scattered instead of synchronised, so an equal-weighted long book collects a
 *           diversification bonus that reality never offered it. Measured: an always-long book
 *           scores Sharpe 0.49 on real data and 0.97 on this null, beating the real data in 200 of
 *           200 draws. That is not a strategy succeeding. That is a broken control group.
 *
 * Second time in this repo a control turned out not to be controlled. The first was a synthetic
 * series labelled "zero-structure random walk" that still had SPY's drift baked into it.
 */
export function shufflePanel(panel: Series[], rand: () => number, synchronized = true): Series[] {
  const n = panel[0].close.length - 1;

  const sharedOrder = Array.from({ length: n }, (_, i) => i);
  if (synchronized) {
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [sharedOrder[i], sharedOrder[j]] = [sharedOrder[j], sharedOrder[i]];
    }
  }

  return panel.map((s) => {
    const r = pctReturns(s.close).slice(1);
    let body: number[];
    if (synchronized) {
      body = sharedOrder.map((i) => r[i]);
    } else {
      body = [...r];
      for (let i = body.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [body[i], body[j]] = [body[j], body[i]];
      }
    }
    const close = [s.close[0]];
    for (const x of body) close.push(close[close.length - 1] * (1 + x));
    return { ...s, close };
  });
}

/** mulberry32 — the LCG that came before it produced an 88.7% win rate on a fair coin. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Aligns a set of series onto their common trading days. Instruments with gaps are dropped, not
 * forward-filled — a fabricated bar can invent a trend that never happened.
 *
 * Bucketing is by UTC calendar day, not by raw timestamp. Futures and equities carry different
 * session timestamps for the same trading day (a future's session opens the previous evening), so
 * intersecting the raw millisecond keys silently yields the empty set. That bug produced a NaN
 * benchmark on the first run of this experiment, which is a loud failure; had it produced a *number*
 * instead, the comparison the whole file exists to make would have been quietly wrong.
 */
export function alignPanel(series: Series[]): Series[] {
  const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const counts = new Map<string, number>();
  for (const s of series) {
    const seen = new Set(s.dates.map(dayOf)); // a series must not vote twice for one day
    for (const d of seen) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  const common = new Set([...counts.entries()].filter(([, c]) => c === series.length).map(([d]) => d));
  return series.map((s) => {
    const dates: number[] = [], close: number[] = [];
    const taken = new Set<string>();
    for (let i = 0; i < s.dates.length; i++) {
      const d = dayOf(s.dates[i]);
      if (common.has(d) && !taken.has(d)) { taken.add(d); dates.push(s.dates[i]); close.push(s.close[i]); }
    }
    return { ...s, dates, close };
  });
}
