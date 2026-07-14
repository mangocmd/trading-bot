/**
 * The gauntlet for cross-sectional momentum.
 *
 * `npm run xsmom`
 *
 * XSMOM came out of `runTsmom.ts` as the strongest thing this project has found: solo Sharpe 0.55,
 * p = 0.025 against a 200-draw synchronized null, and blended with SPY it lifts the portfolio Sharpe
 * from 0.55 to 0.77 — well past the 0.63 a book that forecasts *nothing* achieves. It is also
 * dollar-neutral by construction, so unlike every long-biased survivor in this repository it cannot
 * be sitting in the drift.
 *
 * That is exactly the profile of a result I have been fooled by before. So before it goes anywhere
 * near the README:
 *
 *   1. MULTIPLE TESTING. Four signal families were tried. A p of 0.025 among four tests is not a p
 *      of 0.025. Bonferroni puts it at ~0.10. Stated up front, not buried.
 *   2. PARAMETER ROBUSTNESS. The 12-month lookback and the top/bottom third were chosen, not
 *      derived. If the result lives on one cell of the grid, it is fitted.
 *   3. SUB-PERIODS. An edge that only exists in one third of the sample is a regime, not an edge.
 *   4. COSTS. XSMOM turns over more than TSMOM. If it dies at 5bp it was a rebate.
 *   5. THE NULL, at every grid cell — not just the one that won.
 */

import { fetchStockCandles } from "./fetchStocks.js";
import {
  runBook, shufflePanel, alignPanel, cleanSeries, score, correlation, mulberry32,
  DEFAULT_CONFIG, type Series, type TsmomConfig, type Perf,
} from "./tsmom.js";
import { readFileSync, existsSync } from "node:fs";

const SEED = 20260715;
const PERMUTATIONS = 200;
const CACHE = "data/futures.json";

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const blend = (a: number[], b: number[], w: number) => a.map((x, i) => (1 - w) * x + w * (b[i] ?? 0));

function nullP(panel: Series[], cfg: TsmomConfig, realSharpe: number, perms = PERMUTATIONS): number {
  const nulls = Array.from({ length: perms }, (_, i) =>
    runBook(shufflePanel(panel, mulberry32(SEED + i * 7919), true), "xsmom", cfg).sharpe);
  return (nulls.filter((s) => s >= realSharpe).length + 1) / (perms + 1);
}

async function main() {
  if (!existsSync(CACHE)) { console.error("run `npm run tsmom` first to populate the data cache"); process.exit(1); }
  const { panel: raw, spy: spyRaw } = JSON.parse(readFileSync(CACHE, "utf8")) as { panel: Series[]; spy: Series };
  const { cleaned } = cleanSeries([...raw, spyRaw]);
  const all = alignPanel(cleaned);
  const panel = all.slice(0, raw.length);
  const spyAligned = all[all.length - 1];

  const cfg = DEFAULT_CONFIG;
  const lookbackDays = Math.round(cfg.lookbackMonths * 252 / 12);
  const spyDaily: number[] = [];
  for (let i = lookbackDays + 1; i < spyAligned.close.length; i++) {
    spyDaily.push(spyAligned.close[i] / spyAligned.close[i - 1] - 1);
  }
  const spy = score(spyDaily);

  console.log(`\n${panel.length} futures, ${panel[0].dates.length} bars, ` +
    `${new Date(panel[0].dates[0]).toISOString().slice(0, 10)} -> ${new Date(panel[0].dates.at(-1)!).toISOString().slice(0, 10)}`);

  console.log("\n═══ THE HONEST HEADLINE, BEFORE ANYTHING ELSE ═══\n");
  console.log("  Four signal families were tried before this one came up significant.");
  console.log("  p = 0.025 among four tests is NOT p = 0.025. Bonferroni: ~0.10.");
  console.log("  Everything below is an attempt to kill it. Read the failures, not the wins.\n");

  const base = runBook(panel, "xsmom", cfg);
  const baseP = nullP(panel, cfg, base.sharpe);
  console.log(`  baseline (12m lookback, top/bottom third, 1bp/side)`);
  console.log(`    solo Sharpe ${base.sharpe.toFixed(2)}   ann ${pct(base.annReturn)}   maxDD ${pct(base.maxDrawdown)}` +
    `   corr to SPY ${correlation(base.daily, spyDaily).toFixed(2)}   p = ${baseP.toFixed(3)}`);

  console.log("\n═══ 1. Parameter grid — is it a plateau or a spike? ═══");
  console.log("  Every cell gets its own null. A grid where only the chosen cell survives is fitted.\n");
  console.log(`  ${"lookback".padStart(9)} ${"fraction".padStart(9)} ${"Sharpe".padStart(7)} ${"ann".padStart(7)} ${"p".padStart(6)}`);
  let cells = 0, significant = 0, positive = 0;
  for (const months of [3, 6, 9, 12, 18]) {
    for (const frac of [2, 3, 4]) {   // top/bottom half, third, quarter
      const c: TsmomConfig = { ...cfg, lookbackMonths: months };
      // The fraction lives in signalsAt via N/3; approximate by re-running with a scaled panel is
      // not possible, so the fraction sweep is done by re-implementing the rank cut here.
      const p = runBookXs(panel, c, frac);
      const pv = nullPXs(panel, c, frac, p.sharpe, 50);
      cells++;
      if (p.sharpe > 0) positive++;
      if (pv < 0.05) significant++;
      console.log(
        `  ${`${months}m`.padStart(9)} ${`1/${frac}`.padStart(9)} ${p.sharpe.toFixed(2).padStart(7)} ` +
        `${pct(p.annReturn).padStart(7)} ${pv.toFixed(3).padStart(6)}${pv < 0.05 ? "  *" : ""}`,
      );
    }
  }
  console.log(`\n  ${positive}/${cells} cells positive.  ${significant}/${cells} significant at p<0.05 (50 perms each).`);
  console.log(`  ${significant >= cells * 0.6 ? "  -> a plateau. not fitted to one cell." : "  -> NOT a plateau. the result lives in a corner of the grid."}`);

  console.log("\n═══ 2. Sub-periods — an edge, or a regime? ═══\n");
  const n = panel[0].dates.length;
  const thirds: Array<[number, number]> = [[0, Math.floor(n / 3)], [Math.floor(n / 3), Math.floor(2 * n / 3)], [Math.floor(2 * n / 3), n]];
  console.log(`  ${"period".padStart(12)} ${"Sharpe".padStart(7)} ${"ann".padStart(7)} ${"p".padStart(6)}`);
  let winners = 0;
  for (const [a, b] of thirds) {
    const sub = panel.map((s) => ({ ...s, dates: s.dates.slice(a, b), close: s.close.slice(a, b) }));
    const p = runBook(sub, "xsmom", cfg);
    const pv = nullP(sub, cfg, p.sharpe, 50);
    if (p.sharpe > 0) winners++;
    const label = `${new Date(panel[0].dates[a]).getUTCFullYear()}-${new Date(panel[0].dates[b - 1]).getUTCFullYear()}`;
    console.log(`  ${label.padStart(12)} ${p.sharpe.toFixed(2).padStart(7)} ${pct(p.annReturn).padStart(7)} ${pv.toFixed(3).padStart(6)}${pv < 0.05 ? "  *" : ""}`);
  }
  console.log(`\n  ${winners}/3 sub-periods positive.`);

  console.log("\n═══ 3. Costs — XSMOM turns over more than TSMOM ═══\n");
  console.log(`  ${"bp/side".padStart(8)} ${"Sharpe".padStart(7)} ${"ann".padStart(7)}   turnover`);
  for (const bp of [0, 1, 3, 5, 10, 20]) {
    const p = runBook(panel, "xsmom", { ...cfg, costPerSide: bp / 10000 });
    console.log(`  ${String(bp).padStart(8)} ${p.sharpe.toFixed(2).padStart(7)} ${pct(p.annReturn).padStart(7)}   ${p.turnover.toFixed(1)}x/yr`);
  }

  console.log("\n═══ 4. As a portfolio component ═══\n");
  console.log(`  ${"SPY / XSMOM".padEnd(14)} ${"ann".padStart(7)} ${"Sharpe".padStart(7)} ${"maxDD".padStart(7)}`);
  for (const w of [0, 0.2, 0.4, 0.6, 0.8, 1.0]) {
    const p = score(blend(spyDaily, base.daily, w));
    console.log(`  ${`${((1 - w) * 100).toFixed(0)}% / ${(w * 100).toFixed(0)}%`.padEnd(14)} ` +
      `${pct(p.annReturn).padStart(7)} ${p.sharpe.toFixed(2).padStart(7)} ${pct(p.maxDrawdown).padStart(7)}` +
      `${w === 0 ? "   <- SPY alone" : ""}`);
  }

  console.log("\n═══ 5. The question that decides it ═══\n");
  const bestBlend = Math.max(...[0.2, 0.4, 0.6, 0.8].map((w) => score(blend(spyDaily, base.daily, w)).sharpe));
  const ctl = runBook(panel, "always_long", cfg);
  const ctlBest = Math.max(...[0.2, 0.4, 0.6, 0.8].map((w) => score(blend(spyDaily, ctl.daily, w)).sharpe));
  console.log(`  SPY alone                            Sharpe ${spy.sharpe.toFixed(2)}   ann ${pct(spy.annReturn)}   maxDD ${pct(spy.maxDrawdown)}`);
  console.log(`  SPY + a book that forecasts NOTHING  Sharpe ${ctlBest.toFixed(2)}`);
  console.log(`  SPY + XSMOM                          Sharpe ${bestBlend.toFixed(2)}`);
  console.log(`\n  Does XSMOM beat the no-forecast control? ${bestBlend > ctlBest + 0.03 ? "YES" : "NO"}`);
  console.log(`  Does the blend earn more MONEY than SPY? ` +
    `${Math.max(...[0.2, 0.4, 0.6].map((w) => score(blend(spyDaily, base.daily, w)).annReturn)) > spy.annReturn ? "YES" : "NO"}`);
  console.log("");
}

// The fraction cut is a parameter of the ranking, which `signalsAt` fixes at a third. These two
// helpers re-implement XSMOM with the cut exposed, purely so the grid above can sweep it.
function runBookXs(panel: Series[], cfg: TsmomConfig, frac: number): Perf {
  const patched = panel.map((s) => s);
  return runBookWithFraction(patched, cfg, frac, () => 0);
}
function nullPXs(panel: Series[], cfg: TsmomConfig, frac: number, real: number, perms: number): number {
  const nulls = Array.from({ length: perms }, (_, i) =>
    runBookWithFraction(shufflePanel(panel, mulberry32(SEED + i * 7919), true), cfg, frac, () => 0).sharpe);
  return (nulls.filter((s) => s >= real).length + 1) / (perms + 1);
}

/** XSMOM with the rank cut as a parameter. Mirrors `runBook`'s accounting exactly. */
function runBookWithFraction(panel: Series[], config: TsmomConfig, frac: number, _r: () => number): Perf {
  const n = panel[0].dates.length;
  const N = panel.length;
  const ppy = config.periodsPerYear;
  const lookbackDays = Math.round(config.lookbackMonths * ppy / 12);

  const rets = panel.map((s) => {
    const r = new Array(s.close.length).fill(0);
    for (let i = 1; i < s.close.length; i++) r[i] = s.close[i] / s.close[i - 1] - 1;
    return r;
  });
  const lambda = config.volCom / (config.volCom + 1);
  const vols = rets.map((r) => {
    const out = new Array(r.length).fill(NaN);
    let v = NaN, m = 0;
    for (let i = 1; i < r.length; i++) {
      const x = r[i - 1];
      if (Number.isNaN(v)) { v = x * x; m = x; }
      else { m = lambda * m + (1 - lambda) * x; const d = x - m; v = lambda * v + (1 - lambda) * d * d; }
      out[i] = Math.sqrt(v * ppy);
    }
    return out;
  });

  const ends: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = new Date(panel[0].dates[i]), b = new Date(panel[0].dates[i + 1]);
    if (a.getUTCMonth() !== b.getUTCMonth() || a.getUTCFullYear() !== b.getUTCFullYear()) ends.push(i);
  }

  const positions = new Array(N).fill(0);
  const daily: number[] = [];
  let turnover = 0, nextEnd = 0;

  for (let i = lookbackDays + 1; i < n; i++) {
    let r = 0;
    for (let k = 0; k < N; k++) r += positions[k] * rets[k][i];
    daily.push(r / N);

    while (nextEnd < ends.length && ends[nextEnd] < i) nextEnd++;
    if (nextEnd < ends.length && ends[nextEnd] === i) {
      const scores = panel.map((s, k) => ({ k, r: s.close[i] / s.close[i - lookbackDays] - 1 }));
      scores.sort((a, b) => b.r - a.r);
      const cut = Math.max(1, Math.floor(N / frac));
      const signs = new Array(N).fill(0);
      for (let j = 0; j < cut; j++) signs[scores[j].k] = 1;
      for (let j = N - cut; j < N; j++) signs[scores[j].k] = -1;

      for (let k = 0; k < N; k++) {
        const sigma = vols[k][i];
        if (!Number.isFinite(sigma) || sigma <= 0) { positions[k] = 0; continue; }
        let target = signs[k] * (config.targetVol / sigma);
        if (config.maxLeverage > 0) target = Math.max(-config.maxLeverage, Math.min(config.maxLeverage, target));
        const d = Math.abs(target - positions[k]);
        turnover += d / N;
        daily[daily.length - 1] -= (d * config.costPerSide) / N;
        positions[k] = target;
      }
    }
  }
  const p = score(daily, ppy);
  return { ...p, turnover: turnover / (daily.length / ppy) };
}

main().catch((e) => { console.error(e); process.exit(1); });
