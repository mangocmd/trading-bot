/**
 * Is cross-sectional momentum an edge, or a bet on dispersion?
 *
 * `npm run dispersion`
 *
 * XSMOM's Sharpe rises monotonically across the sample: 0.21, 0.65, 1.21. Every factor-decay study
 * ever written says the opposite should happen — an edge that is published gets arbitraged, it does
 * not get stronger. So the far more likely explanation is that the last third of the sample (COVID,
 * the 2020 melt-up, the 2022 inflation shock, the rate cycle) simply had enormous cross-sectional
 * DISPERSION, and any book that goes long the winners and short the losers makes money when the
 * winners and losers are far apart, regardless of whether it can pick them.
 *
 * If that is what is happening, then XSMOM is not a forecast. It is a long position in dispersion,
 * and its future depends on dispersion staying high — which is a bet nobody told you you were making.
 *
 * The discriminating tests:
 *
 *   1. Has dispersion actually risen? (If not, the hypothesis is dead and XSMOM survives.)
 *   2. Does XSMOM only pay in high-dispersion months? A signal with real ranking skill should pay in
 *      calm months too, just less.
 *   3. Does XSMOM still beat its null AFTER conditioning on dispersion — i.e. within the high-
 *      dispersion months alone, is the ranking doing work, or is being spread out enough?
 */

import {
  runBook, shufflePanel, alignPanel, cleanSeries, score, mulberry32,
  DEFAULT_CONFIG, type Series,
} from "./tsmom.js";
import { readFileSync, existsSync } from "node:fs";

const SEED = 20260715;
const CACHE = "data/futures.json";
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function stdev(xs: number[]): number {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
}

function main() {
  if (!existsSync(CACHE)) { console.error("run `npm run tsmom` first"); process.exit(1); }
  const { panel: raw, spy: spyRaw } = JSON.parse(readFileSync(CACHE, "utf8")) as { panel: Series[]; spy: Series };
  const { cleaned } = cleanSeries([...raw, spyRaw]);
  const panel = alignPanel(cleaned).slice(0, raw.length);
  const cfg = DEFAULT_CONFIG;
  const n = panel[0].dates.length;

  const rets = panel.map((s) => {
    const r = new Array(s.close.length).fill(0);
    for (let i = 1; i < s.close.length; i++) r[i] = s.close[i] / s.close[i - 1] - 1;
    return r;
  });

  // Cross-sectional dispersion on day i: the spread of that day's returns ACROSS the 24 markets,
  // normalised by each market's own vol so a gas future does not dominate a bond future.
  const dispersion = new Array(n).fill(NaN);
  for (let i = 252; i < n; i++) {
    const z: number[] = [];
    for (let k = 0; k < panel.length; k++) {
      const w = rets[k].slice(i - 60, i);
      const sd = stdev(w);
      if (sd > 0) z.push(rets[k][i] / sd);
    }
    if (z.length > 2) dispersion[i] = stdev(z);
  }

  console.log("\n═══ 1. Has cross-sectional dispersion actually risen? ═══\n");
  const thirds: Array<[number, number]> = [[253, Math.floor(n / 3)], [Math.floor(n / 3), Math.floor(2 * n / 3)], [Math.floor(2 * n / 3), n]];
  const dispByThird: number[] = [];
  for (const [a, b] of thirds) {
    const d = dispersion.slice(a, b).filter((x) => Number.isFinite(x));
    dispByThird.push(mean(d));
    const label = `${new Date(panel[0].dates[a]).getUTCFullYear()}-${new Date(panel[0].dates[b - 1]).getUTCFullYear()}`;
    console.log(`  ${label}   mean dispersion ${mean(d).toFixed(3)}`);
  }
  const rose = dispByThird[2] > dispByThird[0] * 1.05;
  console.log(`\n  ${rose
    ? "  -> dispersion IS higher in the last third. The hypothesis is live."
    : "  -> dispersion did NOT rise. XSMOM's improvement is not explained by this. It survives."}`);

  console.log("\n═══ 2. Does XSMOM only pay when markets are spread apart? ═══");
  console.log("  Split every day into dispersion terciles (using a TRAILING estimate, so the split is");
  console.log("  causal), and measure XSMOM's return inside each. A book with real ranking skill should");
  console.log("  earn something in calm markets too. A book that is merely long dispersion should not.\n");

  const xsmom = runBook(panel, "xsmom", cfg);
  // xsmom.daily starts at index 253. Align the dispersion series to it, using a TRAILING median so
  // the classification of day i cannot use day i's own dispersion.
  const start = Math.round(cfg.lookbackMonths * 252 / 12) + 1;
  const trailing = new Array(n).fill(NaN);
  for (let i = start; i < n; i++) {
    const w = dispersion.slice(Math.max(253, i - 252), i).filter((x) => Number.isFinite(x));
    if (w.length > 30) trailing[i] = mean(w);
  }

  const buckets: Record<string, number[]> = { low: [], mid: [], high: [] };
  const finite = trailing.slice(start).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const q1 = finite[Math.floor(finite.length / 3)];
  const q2 = finite[Math.floor((2 * finite.length) / 3)];
  for (let j = 0; j < xsmom.daily.length; j++) {
    const i = start + j;
    const t = trailing[i];
    if (!Number.isFinite(t)) continue;
    (t < q1 ? buckets.low : t < q2 ? buckets.mid : buckets.high).push(xsmom.daily[j]);
  }

  console.log(`  ${"regime".padEnd(24)} ${"days".padStart(5)} ${"ann".padStart(7)} ${"Sharpe".padStart(7)}`);
  for (const [k, v] of Object.entries(buckets)) {
    if (v.length < 50) continue;
    const p = score(v);
    console.log(`  ${`${k} dispersion`.padEnd(24)} ${String(v.length).padStart(5)} ${pct(p.annReturn).padStart(7)} ${p.sharpe.toFixed(2).padStart(7)}`);
  }
  const lowP = score(buckets.low), highP = score(buckets.high);
  console.log(`\n  ${lowP.sharpe > 0.2
    ? "  -> XSMOM pays in calm markets too. The ranking is doing work, not just the spread."
    : "  -> XSMOM pays ONLY when markets are spread apart. It is a long position in dispersion,\n     dressed as a forecast. Its future depends on dispersion staying high."}`);

  console.log("\n═══ 3. The decisive one: is it the RANKING, or just being dollar-neutral? ═══");
  console.log("  A book that goes long half the markets and short the other half AT RANDOM is also");
  console.log("  dollar-neutral, also vol-scaled, also pays the same costs. The only thing it lacks is");
  console.log("  the ranking. If it earns what XSMOM earns, the ranking is decoration.\n");

  const randomRuns = Array.from({ length: 50 }, (_, i) => runBook(panel, "random", cfg, mulberry32(SEED + i * 977)));
  const rSharpe = randomRuns.map((p) => p.sharpe).sort((a, b) => a - b);
  console.log(`  XSMOM                       Sharpe ${xsmom.sharpe.toFixed(2)}   ann ${pct(xsmom.annReturn)}`);
  console.log(`  random long/short (50 draws) Sharpe ${mean(rSharpe).toFixed(2)}   range ${rSharpe[0].toFixed(2)}..${rSharpe[rSharpe.length - 1].toFixed(2)}`);
  const beat = rSharpe.filter((s) => s >= xsmom.sharpe).length;
  console.log(`  random draws beating XSMOM:  ${beat}/50`);
  console.log(`\n  ${beat <= 2
    ? "  -> the ranking carries information a coin flip does not."
    : "  -> a coin flip does what the ranking does. The ranking is decoration."}`);

  console.log("\n═══ 4. And the null, restricted to the recent third ═══");
  console.log("  If the edge is real it should survive its own null inside the window where it is");
  console.log("  strongest. If it does not, that window is just a lucky stretch.\n");
  const [a3, b3] = thirds[2];
  const sub = panel.map((s) => ({ ...s, dates: s.dates.slice(a3, b3), close: s.close.slice(a3, b3) }));
  const real = runBook(sub, "xsmom", cfg);
  const nulls = Array.from({ length: 200 }, (_, i) =>
    runBook(shufflePanel(sub, mulberry32(SEED + i * 7919), true), "xsmom", cfg).sharpe).sort((a, b) => a - b);
  const nb = nulls.filter((s) => s >= real.sharpe).length;
  console.log(`  2019-2026 real Sharpe ${real.sharpe.toFixed(2)}`);
  console.log(`  null mean ${mean(nulls).toFixed(2)}, range ${nulls[0].toFixed(2)}..${nulls[nulls.length - 1].toFixed(2)}`);
  console.log(`  null beats real: ${nb}/200   ->  p = ${((nb + 1) / 201).toFixed(3)}`);
  console.log("");
}

main();
