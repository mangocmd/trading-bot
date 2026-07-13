import type { Candle } from "./indicators.js";

/**
 * A volatility-managed basket: hold everything, all the time, and vary only HOW MUCH you hold,
 * sized so the book's forecast volatility stays near a target.
 *
 * WHAT CHANGED, AND WHY. This module used to run two signal engines (trend / mean-reversion) and
 * rotate between them, on the theory that recent strategy performance is anti-predictive. An
 * ablation over 9 sector ETFs and 10 years, in four non-overlapping blocks, killed that theory:
 *
 *              engines + rotation + vol sizing      vol sizing alone
 *   return           4.3%/yr                            9.6%/yr
 *   Sharpe           0.55                               0.80
 *   max drawdown    17.0%                              18.0%
 *
 * The engines cost more than half the return and bought essentially no extra protection (17.0% vs
 * 18.0% drawdown), and they did so in every block. Every scrap of this strategy's value was coming
 * from the sizing overlay; the signals on top were decoration. So they are gone. Three other ideas
 * were tested at the same time and all three failed: an EWMA volatility forecast (identical Sharpe
 * to a plain trailing window), a deadband to suppress churn (no gain), and leverage above 1.0
 * (worse in all four blocks once a 6%/yr borrow cost is charged).
 *
 * WHY IT WORKS AT ALL. It rests on the single thing this project's testing found to be genuinely
 * predictable: volatility clusters, while direction does not. Next-day direction carries about 2.5%
 * of information and needs ~53.6% accuracy to clear costs, so the strategy never predicts direction.
 * It only asks how turbulent the recent past was, and holds less when the answer is "very".
 *
 * IT IS NOT JUST 'HOLDING LESS'. The obvious objection is that it averages 0.93 exposure against
 * buy-and-hold's 1.00, so of course it draws down less. That was tested against the control that
 * holds a CONSTANT 0.93 — the control lands at Sharpe 0.68 and a 35.0% drawdown, versus 0.77 and
 * 18.0% here. Same average exposure, half the drawdown. The timing is doing the work.
 *
 * IT IS NOT OVERFIT. Across a 6x6 grid of volWindow (10-63) and targetVol (10%-25%), all 36
 * combinations beat buy-and-hold on Sharpe and all 36 cut the drawdown. A real effect is a plateau.
 * The defaults below sit in the middle of it rather than on its best cell, deliberately.
 *
 * THE UNDERLYING MATTERS MORE THAN THE OVERLAY. A second round of pre-registered hypothesis tests
 * found the biggest lever is not the formula but the basket it runs on: the same overlay applied
 * to SPY alone returned 12.1%/yr (Sharpe 0.94, drawdown 19.6%) versus 9.7% on the equal-weight
 * sector basket — most of the "return gap" against the index was the equal-weight basket lagging
 * SPY, not the overlay's cost. No code change needed; pass the better underlying in.
 *
 * Three refinements were tested in the same round and REJECTED — recorded so nobody retries them:
 *   - Moreira & Muir's own 1/σ² scaling: beat the 1/σ baseline in 1 of 4 walk-forward blocks.
 *   - Risk-parity weights across symbols: the no-overlay control showed the weights alone
 *     contribute nothing (Sharpe 0.70 vs equal weight's 0.71); everything was still the overlay.
 *   - Sizing on downside semideviation: the interesting one. It beat full vol in 4/4 blocks and
 *     cut the drawdown in 36/36 grid cells — a genuinely consistent sign — but the mean Sharpe
 *     gain across the grid was +0.007, an order of magnitude below the overlay's own effect.
 *     A consistent sign with negligible magnitude does not pay for a subtler formula.
 *
 * IT IS STILL NOT A MONEY-MAKER, AND IT DOES NOT WORK ON CRYPTO. It returns less than the index
 * (9.2%/yr vs SPY's 13.4%) — it buys a halved drawdown with some return, which is a trade, not a
 * free lunch. And on an 8-coin crypto basket it collapses to a Sharpe of 0.40 against a constant-
 * exposure control's 0.39: crypto's 0.16% round-trip costs and 7.9x/yr turnover eat the entire
 * effect, leaving nothing but "hold half as much". Use this on low-cost markets or not at all.
 */
export interface VolManagedConfig {
  /** Bars of trailing returns used to forecast volatility. */
  volWindow: number;
  /** Annualized volatility target for the book, e.g. 0.15 for 15%. */
  targetVol: number;
  /**
   * Hard cap on exposure. Leave at 1.0. Raising it means borrowing, and leverage tested worse in
   * every block once the borrow was actually charged — quiet markets are not reliably good ones.
   */
  maxExposure: number;
  /** Per-side cost as a fraction, charged on changes in exposure. */
  costPerSide: number;
  /** Bars per year, for annualizing (252 for stocks, 365 for crypto). */
  periodsPerYear: number;
}

export const DEFAULT_VOL_MANAGED_CONFIG: VolManagedConfig = {
  volWindow: 21,
  targetVol: 0.15,
  maxExposure: 1.0,
  costPerSide: 0.0003,
  periodsPerYear: 252,
};

export interface PortfolioResult {
  dailyReturns: number[];
  annualizedPct: number;
  sharpe: number;
  maxDrawdownPct: number;
  totalReturnPct: number;
  /** Exposure held each day — the sizing output, and the only thing this strategy decides. */
  exposures: number[];
}

function stdev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
}

/**
 * Runs the equal-weighted basket with volatility-targeted exposure.
 *
 * The volatility used to size bar i is measured over bars strictly BEFORE i. Including bar i would
 * let the book shrink on exactly the day the crash lands — dodging losses it could not have seen
 * coming. That is the same class of one-bar leak that produced a fake Sharpe of 7 in this project's
 * earlier ensemble work, and `portfolioStrategy.test.ts` pins it by asserting the strategy takes
 * the full hit on the first bar of a crash.
 */
export function runVolManagedPortfolio(
  priceSeries: Record<string, Candle[]>,
  config: VolManagedConfig,
): PortfolioResult {
  const symbols = Object.keys(priceSeries);
  const empty: PortfolioResult = {
    dailyReturns: [], annualizedPct: 0, sharpe: 0, maxDrawdownPct: 0, totalReturnPct: 0, exposures: [],
  };
  if (symbols.length === 0) return empty;

  const length = Math.min(...symbols.map((s) => priceSeries[s].length));
  if (length < config.volWindow + 2) return empty;

  // Equal-weighted basket return per bar.
  const basket = new Array(length).fill(0);
  for (let i = 1; i < length; i++) {
    let sum = 0, n = 0;
    for (const s of symbols) {
      const today = priceSeries[s][i], yesterday = priceSeries[s][i - 1];
      if (!today || !yesterday || yesterday.close === 0) continue;
      sum += (today.close - yesterday.close) / yesterday.close;
      n++;
    }
    if (n > 0) basket[i] = sum / n;
  }

  const dailyReturns: number[] = [];
  const exposures: number[] = [];
  let previousExposure = 0;

  for (let i = config.volWindow + 1; i < length; i++) {
    const trailing = basket.slice(i - config.volWindow, i); // strictly before i — see the note above
    const annualizedVol = stdev(trailing) * Math.sqrt(config.periodsPerYear);

    const exposure = annualizedVol > 0
      ? Math.min(config.targetVol / annualizedVol, config.maxExposure)
      : 0;

    const cost = Math.abs(exposure - previousExposure) * config.costPerSide;
    previousExposure = exposure;

    dailyReturns.push(basket[i] * exposure - cost);
    exposures.push(exposure);
  }

  return { ...summarize(dailyReturns, config.periodsPerYear), exposures };
}

export function summarize(dailyReturns: number[], periodsPerYear: number): Omit<PortfolioResult, "exposures"> {
  if (dailyReturns.length === 0) {
    return { dailyReturns, annualizedPct: 0, sharpe: 0, maxDrawdownPct: 0, totalReturnPct: 0 };
  }

  const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const sd = stdev(dailyReturns);

  let equity = 1, peak = 1, maxDrawdown = 0;
  for (const r of dailyReturns) {
    equity *= 1 + r;
    peak = Math.max(peak, equity);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
  }

  return {
    dailyReturns,
    annualizedPct: equity > 0 ? (Math.pow(equity, periodsPerYear / dailyReturns.length) - 1) * 100 : -100,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(periodsPerYear) : 0,
    maxDrawdownPct: maxDrawdown * 100,
    totalReturnPct: (equity - 1) * 100,
  };
}
