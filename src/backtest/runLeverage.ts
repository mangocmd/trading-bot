/**
 * What leverage actually does to the one strategy that survived.
 *
 * `npm run leverage`
 *
 * XSMOM has Sharpe 0.55, zero beta, and earns 5.4%/yr — less than an index fund. The obvious next
 * question is "so lever it up." This is the honest answer, and it has three parts, only one of which
 * is the one people want to hear.
 *
 *   1. Leverage does NOT change the Sharpe ratio. At zero financing cost, 1x and 5x sit on the same
 *      line: return and volatility scale together, exactly. Leverage cannot manufacture return per
 *      unit of risk. It only chooses where on the line you stand. This is not an opinion, it is
 *      arithmetic, and the 0%-financing column below is dead flat in Sharpe to prove it.
 *
 *   2. Financing is not free, and it bends the line DOWN. Every turn of leverage past 1x borrows
 *      money (or ties up collateral that would otherwise earn the cash rate). At the ~5% rates of
 *      2026 that is a direct, linear haircut to the levered return, so realised Sharpe FALLS as you
 *      lever. You pay more to stand further up a line that is now sloping against you.
 *
 *   3. Drawdown scales with leverage, and the historical path understates it. Max drawdown grows
 *      roughly linearly with L, so a tolerable 22% becomes a career-ending 65% at 3x. Worse, the one
 *      historical path is a single sample; a block bootstrap of the same returns shows the realistic
 *      bad case is materially deeper than what happened to occur. Leverage multiplies that gap.
 *
 * The legitimate use, which survives all three: a ZERO-BETA book levered to a chosen volatility and
 * held ALONGSIDE equities. That is what a market-neutral sleeve is. It is real, and it is the last
 * section here — but it buys diversification, not a higher Sharpe.
 */

import {
  runBook, alignPanel, cleanSeries, score, correlation, mulberry32,
  DEFAULT_CONFIG, type Series,
} from "./tsmom.js";
import { readFileSync, existsSync } from "node:fs";

const SEED = 20260715;
const CACHE = "data/futures.json";
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Levers a daily excess-return stream by L, charging `financing` per year on the borrowed (L-1).
 *
 * A subtlety worth stating: a futures strategy's returns are already excess-of-cash, because the
 * collateral earns the cash rate while the notional does the work. So the honest financing cost of
 * levering futures is the SPREAD over cash you pay, not the whole rate — for an institution, near
 * zero; for a retail account, a few percent. The 0% column is the institutional/idealised bound; the
 * 5% column is closer to what a retail margin account actually pays. Reality is between them.
 */
function lever(daily: number[], L: number, financing: number): number[] {
  const perDay = (financing * (L - 1)) / 252;
  return daily.map((r) => L * r - perDay);
}

function maxDrawdown(daily: number[]): number {
  let eq = 1, peak = 1, mdd = 0;
  for (const r of daily) { eq *= 1 + r; peak = Math.max(peak, eq); mdd = Math.max(mdd, (peak - eq) / peak); }
  return mdd;
}

/** Block bootstrap: resample 21-day blocks to preserve short-run autocorrelation, 500 paths. */
function bootstrapMDD(daily: number[], L: number, financing: number, rand: () => number): { p50: number; p95: number; worst: number } {
  const block = 21;
  const levered = lever(daily, L, financing);
  const mdds: number[] = [];
  for (let s = 0; s < 500; s++) {
    const path: number[] = [];
    while (path.length < levered.length) {
      const start = Math.floor(rand() * (levered.length - block));
      for (let j = 0; j < block; j++) path.push(levered[start + j]);
    }
    mdds.push(maxDrawdown(path));
  }
  mdds.sort((a, b) => a - b);
  return { p50: mdds[250], p95: mdds[475], worst: mdds[mdds.length - 1] };
}

function main() {
  if (!existsSync(CACHE)) { console.error("run `npm run tsmom` first"); process.exit(1); }
  const { panel: raw, spy: spyRaw } = JSON.parse(readFileSync(CACHE, "utf8")) as { panel: Series[]; spy: Series };
  const { cleaned } = cleanSeries([...raw, spyRaw]);
  const all = alignPanel(cleaned);
  const panel = all.slice(0, raw.length);
  const spyAligned = all[all.length - 1];
  const cfg = DEFAULT_CONFIG;

  const start = Math.round(cfg.lookbackMonths * 252 / 12) + 1;
  const spyDaily: number[] = [];
  for (let i = start; i < spyAligned.close.length; i++) spyDaily.push(spyAligned.close[i] / spyAligned.close[i - 1] - 1);
  const spy = score(spyDaily);

  const xsmom = runBook(panel, "xsmom", cfg);
  const x = xsmom.daily;

  console.log(`\nXSMOM: Sharpe ${xsmom.sharpe.toFixed(2)}, ${pct(xsmom.annReturn)}/yr, vol ${pct(xsmom.annVol)}, ` +
    `beta to SPY ${correlation(x, spyDaily).toFixed(2)}`);
  console.log(`SPY:   Sharpe ${spy.sharpe.toFixed(2)}, ${pct(spy.annReturn)}/yr, vol ${pct(spy.annVol)}`);

  console.log("\n═══ 1. Leverage is Sharpe-neutral until financing bends the line ═══\n");
  console.log(`  ${"L".padStart(4)} ${"vol".padStart(6)} | ${"ann @0%".padStart(8)} ${"Sharpe".padStart(7)} | ${"ann @5%".padStart(8)} ${"Sharpe".padStart(7)} | ${"maxDD".padStart(7)}`);
  for (const L of [1, 1.5, 2, 3, 4, 5]) {
    const free = score(lever(x, L, 0));
    const paid = score(lever(x, L, 0.05));
    console.log(
      `  ${`${L}x`.padStart(4)} ${pct(free.annVol).padStart(6)} | ` +
      `${pct(free.annReturn).padStart(8)} ${free.sharpe.toFixed(2).padStart(7)} | ` +
      `${pct(paid.annReturn).padStart(8)} ${paid.sharpe.toFixed(2).padStart(7)} | ` +
      `${pct(maxDrawdown(lever(x, L, 0.05))).padStart(7)}`,
    );
  }
  console.log("\n  the @0% Sharpe column is FLAT: leverage adds no risk-adjusted return, it never can.");
  console.log("  the @5% Sharpe column FALLS: every turn of leverage past 1x pays financing.");
  console.log("  the maxDD column EXPLODES: this is the real cost, and it is not on the Sharpe.");

  console.log("\n═══ 2. Lever XSMOM to SPY's volatility — the fair comparison ═══\n");
  const Lmatch = spy.annVol / xsmom.annVol;
  const matched0 = score(lever(x, Lmatch, 0));
  const matched5 = score(lever(x, Lmatch, 0.05));
  console.log(`  to match SPY's ${pct(spy.annVol)} vol takes ${Lmatch.toFixed(1)}x leverage.`);
  console.log(`    XSMOM @ ${Lmatch.toFixed(1)}x, 0% financing: ${pct(matched0.annReturn)}/yr, Sharpe ${matched0.sharpe.toFixed(2)}, maxDD ${pct(maxDrawdown(lever(x, Lmatch, 0)))}`);
  console.log(`    XSMOM @ ${Lmatch.toFixed(1)}x, 5% financing: ${pct(matched5.annReturn)}/yr, Sharpe ${matched5.sharpe.toFixed(2)}, maxDD ${pct(maxDrawdown(lever(x, Lmatch, 0.05)))}`);
  console.log(`    SPY:                        ${pct(spy.annReturn)}/yr, Sharpe ${spy.sharpe.toFixed(2)}, maxDD ${pct(spy.maxDrawdown)}`);
  console.log(`\n  ${matched5.annReturn > spy.annReturn * 0.8
    ? "  -> roughly SPY's money, at zero correlation to SPY. THAT is the point of a zero-beta book."
    : "  -> even levered to SPY's vol it earns less, because financing eats the difference."}`);

  console.log("\n═══ 3. The drawdown you would actually have to survive ═══");
  console.log("  the historical max drawdown is ONE sample. a 21-day block bootstrap (500 paths) shows");
  console.log("  the drawdown you should plan for. leverage multiplies the gap between them.\n");
  console.log(`  ${"L".padStart(4)} ${"historical".padStart(11)} ${"bootstrap p50".padStart(14)} ${"p95".padStart(7)} ${"worst".padStart(7)}`);
  const rand = mulberry32(SEED);
  for (const L of [1, 2, 3]) {
    const hist = maxDrawdown(lever(x, L, 0.05));
    const bs = bootstrapMDD(x, L, 0.05, rand);
    console.log(`  ${`${L}x`.padStart(4)} ${pct(hist).padStart(11)} ${pct(bs.p50).padStart(14)} ${pct(bs.p95).padStart(7)} ${pct(bs.worst).padStart(7)}`);
  }
  console.log("\n  at 3x the p95 bootstrap drawdown is the number that ends the account, not the p50.");

  console.log("\n═══ 4. The honest recommendation ═══\n");
  console.log("  Leverage does not fix a Sharpe of 0.55. It moves you along a line that financing tilts");
  console.log("  against you and that drawdown makes dangerous. The ONE defensible use is modest");
  console.log("  leverage on a zero-beta sleeve held next to equities, sized so the WHOLE portfolio's");
  console.log("  drawdown stays inside what you can actually sit through — which for most people is the");
  console.log("  1x-2x range, not the 3x-5x where the arithmetic looks seductive.\n");

  // The actual product: SPY + a modestly-levered zero-beta sleeve, vs SPY alone.
  for (const [wS, L] of [[1.0, 0], [0.85, 1], [0.7, 1.5], [0.6, 2]] as Array<[number, number]>) {
    if (L === 0) { console.log(`  100% SPY                       ${pct(spy.annReturn)}/yr  Sharpe ${spy.sharpe.toFixed(2)}  maxDD ${pct(spy.maxDrawdown)}`); continue; }
    const sleeve = lever(x, L, 0.05);
    const combo = spyDaily.map((r, i) => wS * r + (1 - wS) * sleeve[i]);
    const p = score(combo);
    console.log(`  ${`${(wS * 100).toFixed(0)}% SPY + ${((1 - wS) * 100).toFixed(0)}% XSMOM@${L}x`.padEnd(28)} ${pct(p.annReturn)}/yr  Sharpe ${p.sharpe.toFixed(2)}  maxDD ${pct(p.maxDrawdown)}`);
  }
  console.log("");
}

main();
