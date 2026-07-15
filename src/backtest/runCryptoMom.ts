/**
 * Crypto momentum at crypto's OWN horizons.
 *
 * `npm run cryptomom`
 *
 * When XSMOM was carried from futures to crypto (`runCrypto.ts`), it kept the futures canon: a
 * 12-month lookback. It died (Sharpe ~-0.35). But that test imported another asset class's map.
 * The crypto-native literature — Liu, Tsyvinski & Wu, "Common Risk Factors in Cryptocurrency",
 * Journal of Finance 2022 (cited from memory; verify before publishing) — finds cross-sectional
 * momentum in crypto at ONE-TO-FOUR WEEK horizons, not twelve months. That horizon has never been
 * tested in this project. This file tests it, with a null distribution per cell.
 *
 * Two corrections to the previous crypto run, found while building this:
 *   - Crypto trades 365 days/year; `runCrypto.ts` annualised with 252. Every Sharpe there is
 *     understated by sqrt(252/365) ≈ 17%, and "12-month lookback" was actually 252 bars = 8.3
 *     months. Orderings were unaffected; the numbers were not.
 *
 * Honesty box, before any table:
 *   - Universe is 13 coins that survived to 2026 with full history. LUNA/FTT are not here. A
 *     dollar-neutral book is less exposed to that than a long book, but not immune.
 *   - 13 coins → legs of 4. Tiny breadth; single-coin luck moves the whole factor.
 *   - Five lookbacks are swept. The LTW canon (1-4w) is the pre-stated hypothesis; 8w and 12w are
 *     where the literature says it fades. Any p must be read against 5 tests (Bonferroni ×5).
 */

import {
  alignPanel, cleanSeries, score, correlation, shufflePanel, mulberry32,
  type Series, type Perf,
} from "./tsmom.js";
import { readFileSync, existsSync } from "node:fs";

const CACHE = "data/crypto.json";
const SEED = 20260716;
const PPY = 365;                 // crypto has no weekends
const PERMUTATIONS = 200;
const TARGET_VOL = 0.40;
const VOL_COM = 60;

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const blend = (a: number[], b: number[], w: number) => a.map((x, i) => (1 - w) * x + w * (b[i] ?? 0));

/** ISO-ish week bucket: days since epoch shifted so weeks split on Monday boundaries. */
const weekIndex = (ms: number) => Math.floor((ms / 86_400_000 + 4) / 7);

type Mode = "xs" | "long" | "random";

/**
 * Weekly-rebalanced rank book. Accounting mirrors `runBook`: positions set at a week's last close
 * earn from the next bar, cost and turnover are per unit of portfolio, vol is ex-ante EWMA.
 * The always-long mode doubles as a built-in sanity check — it must land near a vol-scaled hold.
 */
function runWeekly(panel: Series[], lookback: number, costPerSide: number, mode: Mode, rand: () => number = Math.random): Perf {
  const n = panel[0].close.length, N = panel.length;
  const rets = panel.map((s) => {
    const r = new Array(s.close.length).fill(0);
    for (let i = 1; i < s.close.length; i++) r[i] = s.close[i] / s.close[i - 1] - 1;
    return r;
  });
  const lambda = VOL_COM / (VOL_COM + 1);
  const vols = rets.map((r) => {
    const out = new Array(r.length).fill(NaN);
    let v = NaN, m = 0;
    for (let i = 1; i < r.length; i++) {
      const x = r[i - 1];
      if (Number.isNaN(v)) { v = x * x; m = x; }
      else { m = lambda * m + (1 - lambda) * x; const d = x - m; v = lambda * v + (1 - lambda) * d * d; }
      out[i] = Math.sqrt(v * PPY);
    }
    return out;
  });

  const positions = new Array(N).fill(0);
  const daily: number[] = [];
  let turnover = 0;

  for (let i = lookback + 1; i < n; i++) {
    let r = 0;
    for (let k = 0; k < N; k++) r += positions[k] * rets[k][i];
    daily.push(r / N);

    const weekRolls = i + 1 < n && weekIndex(panel[0].dates[i + 1]) !== weekIndex(panel[0].dates[i]);
    if (!weekRolls) continue;

    let signs: number[];
    if (mode === "long") signs = new Array(N).fill(1);
    else if (mode === "random") signs = panel.map(() => (rand() < 0.5 ? -1 : 1));
    else {
      const ranked = panel.map((s, k) => ({ k, r: s.close[i] / s.close[i - lookback] - 1 })).sort((a, b) => b.r - a.r);
      const cut = Math.max(1, Math.floor(N / 3));
      signs = new Array(N).fill(0);
      for (let j = 0; j < cut; j++) signs[ranked[j].k] = 1;
      for (let j = N - cut; j < N; j++) signs[ranked[j].k] = -1;
    }

    for (let k = 0; k < N; k++) {
      const sigma = vols[k][i];
      if (!Number.isFinite(sigma) || sigma <= 0) { positions[k] = 0; continue; }
      const target = signs[k] * (TARGET_VOL / sigma);
      const d = Math.abs(target - positions[k]);
      turnover += d / N;
      daily[daily.length - 1] -= (d * costPerSide) / N;
      positions[k] = target;
    }
  }
  const p = score(daily, PPY);
  return { ...p, turnover: turnover / (daily.length / PPY) };
}

function nullP(panel: Series[], lookback: number, cost: number, real: number, perms: number): number {
  const nulls = Array.from({ length: perms }, (_, i) =>
    runWeekly(shufflePanel(panel, mulberry32(SEED + i * 7919), true), lookback, cost, "xs").sharpe);
  return (nulls.filter((s) => s >= real).length + 1) / (perms + 1);
}

function main() {
  if (!existsSync(CACHE)) { console.error("run `npm run crypto` first to populate the cache"); process.exit(1); }
  const raw = JSON.parse(readFileSync(CACHE, "utf8")) as Series[];
  const { cleaned, report } = cleanSeries(raw);
  const bad = report.filter((r) => r.badTicks > 0 || r.droppedDays > 0);
  const panel = alignPanel(cleaned);
  const n = panel[0].dates.length;

  console.log(`\n${panel.length} coins, ${n} daily bars (365/yr), ` +
    `${new Date(panel[0].dates[0]).toISOString().slice(0, 10)} -> ${new Date(panel[0].dates[n - 1]).toISOString().slice(0, 10)}`);
  console.log(`  ${panel.map((s) => s.symbol.replace("USDT", "")).join(" ")}`);
  if (bad.length) for (const r of bad) console.log(`  data: ${r.symbol} ${r.badTicks} tick(s) repaired, ${r.droppedDays} day(s) dropped`);

  const btc = panel.find((s) => s.symbol === "BTCUSDT")!;
  const startIdx = 85; // longest lookback (84d) + 1, so every row sees the same evaluation window
  const btcDaily = btc.close.slice(startIdx + 1).map((c, i) => c / btc.close[startIdx + i] - 1);
  const btcHold = score(btcDaily, PPY);

  console.log("\n═══ 1. The sweep: crypto-native horizons, weekly rebalance, 5bp/side ═══");
  console.log("  pre-stated hypothesis (LTW 2022): momentum lives at 1-4 weeks. 8w/12w are the fade");
  console.log("  controls. p per cell vs 200 synchronized shuffles; Bonferroni x5 applies.\n");
  console.log(`  ${"lookback".padStart(9)} ${"sharpe".padStart(7)} ${"ann".padStart(7)} ${"maxDD".padStart(7)} ${"turnover".padStart(9)} ${"corr BTC".padStart(9)} ${"p".padStart(6)}`);

  const results: Array<{ lb: number; perf: Perf; p: number }> = [];
  for (const weeks of [1, 2, 4, 8, 12]) {
    const lb = weeks * 7;
    const perf = runWeekly(panel, lb, 0.0005, "xs");
    const p = nullP(panel, lb, 0.0005, perf.sharpe, PERMUTATIONS);
    results.push({ lb, perf, p });
    console.log(
      `  ${`${weeks}w`.padStart(9)} ${perf.sharpe.toFixed(2).padStart(7)} ${pct(perf.annReturn).padStart(7)} ` +
      `${pct(perf.maxDrawdown).padStart(7)} ${`${perf.turnover.toFixed(0)}x/yr`.padStart(9)} ` +
      `${correlation(perf.daily, btcDaily).toFixed(2).padStart(9)} ${p.toFixed(3).padStart(6)}${p < 0.01 ? "  **" : p < 0.05 ? "  *" : ""}`,
    );
  }

  console.log("\n═══ 2. Controls, same window, same accounting ═══\n");
  const alwaysLong = runWeekly(panel, 28, 0.0005, "long");
  const randoms = Array.from({ length: 50 }, (_, i) => runWeekly(panel, 28, 0.0005, "random", mulberry32(SEED + i * 977)));
  const rS = randoms.map((p) => p.sharpe).sort((a, b) => a - b);
  console.log(`  ALWAYS LONG (vol-scaled basket)   sharpe ${alwaysLong.sharpe.toFixed(2)}   ann ${pct(alwaysLong.annReturn)}   maxDD ${pct(alwaysLong.maxDrawdown)}`);
  console.log(`  RANDOM L/S (50 draws)             sharpe ${mean(rS).toFixed(2)}   range ${rS[0].toFixed(2)}..${rS[rS.length - 1].toFixed(2)}`);
  console.log(`  BTC buy & hold                    sharpe ${btcHold.sharpe.toFixed(2)}   ann ${pct(btcHold.annReturn)}   maxDD ${pct(btcHold.maxDrawdown)}`);

  const best = results.reduce((a, b) => (b.perf.sharpe > a.perf.sharpe ? b : a));
  const beatRandom = rS.filter((s) => s >= best.perf.sharpe).length;
  console.log(`\n  best cell (${best.lb / 7}w): random L/S beats it ${beatRandom}/50 times.`);

  console.log("\n═══ 3. Fee sweep on the best cell — where crypto usually kills things ═══\n");
  console.log(`  ${"bp/side".padStart(8)} ${"sharpe".padStart(7)} ${"ann".padStart(7)}`);
  for (const bp of [0, 2, 5, 8, 16]) {
    const p = runWeekly(panel, best.lb, bp / 10000, "xs");
    console.log(`  ${String(bp).padStart(8)} ${p.sharpe.toFixed(2).padStart(7)} ${pct(p.annReturn).padStart(7)}`);
  }

  console.log("\n═══ 4. For a BTC holder, does the best cell diversify? ═══\n");
  console.log(`  corr(best cell, BTC) = ${correlation(best.perf.daily, btcDaily).toFixed(2)}`);
  for (const w of [0, 0.3, 0.5]) {
    const b = score(blend(btcDaily, best.perf.daily, w), PPY);
    console.log(`  ${`${((1 - w) * 100).toFixed(0)}% BTC + ${(w * 100).toFixed(0)}% factor`.padEnd(24)} sharpe ${b.sharpe.toFixed(2)}   ann ${pct(b.annReturn)}   maxDD ${pct(b.maxDrawdown)}`);
  }

  console.log("\n═══ 5. Sub-periods of the best cell — the check that killed the last candidate ═══\n");
  console.log(`  ${"period".padStart(12)} ${"sharpe".padStart(7)} ${"ann".padStart(7)} ${"p".padStart(6)}`);
  const third = Math.floor(n / 3);
  for (const [a, b] of [[0, third], [third, 2 * third], [2 * third, n]] as Array<[number, number]>) {
    const sub = panel.map((s) => ({ ...s, dates: s.dates.slice(a, b), close: s.close.slice(a, b) }));
    const perf = runWeekly(sub, best.lb, 0.0005, "xs");
    const nulls = Array.from({ length: 100 }, (_, i) =>
      runWeekly(shufflePanel(sub, mulberry32(SEED + i * 7919), true), best.lb, 0.0005, "xs").sharpe);
    const p = (nulls.filter((s) => s >= perf.sharpe).length + 1) / 101;
    const label = `${new Date(panel[0].dates[a]).getUTCFullYear()}-${new Date(panel[0].dates[b - 1]).getUTCFullYear()}`;
    console.log(`  ${label.padStart(12)} ${perf.sharpe.toFixed(2).padStart(7)} ${pct(perf.annReturn).padStart(7)} ${p.toFixed(3).padStart(6)}${p < 0.05 ? "  *" : ""}`);
  }

  console.log("\n═══ verdict ═══");
  const sig = results.filter((r) => r.p < 0.01); // survives Bonferroni x5 at the 0.05 level
  console.log(sig.length
    ? `  ${sig.length} of 5 horizons survive Bonferroni (p<0.01 raw). Crypto-native momentum is live at: ${sig.map((r) => `${r.lb / 7}w`).join(", ")}.`
    : `  No horizon survives Bonferroni x5. The crypto-native canon does not replicate on 13 majors, 2019-2026.`);
  console.log("");
}

main();
