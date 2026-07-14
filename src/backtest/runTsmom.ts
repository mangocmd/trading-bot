/**
 * Does diversified time-series momentum survive its own controls?
 *
 * `npm run tsmom`
 *
 * This is the one open claim the rest of the repo could not touch. Everything in `gauntlet.ts` runs
 * on SPY, and the academic case for trend-following lives in the cross-section of futures markets.
 * So: 24 futures, four asset classes, 25 years, the Moskowitz-Ooi-Pedersen construction, and four
 * controls that between them decide whether TSMOM's returns require any predictive ability.
 *
 * The controls are the experiment. TSMOM's raw return is not interesting on its own — a book that
 * is long a drifting asset makes money without knowing anything, which is the finding this whole
 * repo is built on. What matters is whether TSMOM beats a book that is *explicitly* not forecasting
 * anything.
 */

import { fetchStockCandles } from "./fetchStocks.js";
import {
  runBook, shufflePanel, alignPanel, cleanSeries, mulberry32, DEFAULT_CONFIG,
  type Series, type Control, type Perf, type TsmomConfig,
} from "./tsmom.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

const SEED = 20260714;
// 20 permutations cannot produce a p below (0+1)/(20+1) = 0.048. Reporting "p = 0.048" from 20
// draws is reporting the floor of the instrument, not a measurement. 200 gives a real one.
const PERMUTATIONS = 200;
const RANDOM_DRAWS = 20;

const UNIVERSE: Array<[string, string]> = [
  ["ES=F", "equity"], ["NQ=F", "equity"], ["YM=F", "equity"], ["NKD=F", "equity"],
  ["ZN=F", "bond"], ["ZB=F", "bond"], ["ZF=F", "bond"], ["ZT=F", "bond"],
  ["CL=F", "commodity"], ["GC=F", "commodity"], ["SI=F", "commodity"], ["NG=F", "commodity"],
  ["HG=F", "commodity"], ["ZC=F", "commodity"], ["ZS=F", "commodity"], ["ZW=F", "commodity"],
  ["KC=F", "commodity"], ["SB=F", "commodity"],
  ["6E=F", "fx"], ["6J=F", "fx"], ["6B=F", "fx"], ["6A=F", "fx"], ["6C=F", "fx"], ["6S=F", "fx"],
];

const CACHE = "data/futures.json";

async function load(): Promise<{ panel: Series[]; spy: Series }> {
  if (existsSync(CACHE)) {
    const raw = JSON.parse(readFileSync(CACHE, "utf8"));
    return { panel: raw.panel, spy: raw.spy };
  }
  mkdirSync("data", { recursive: true });
  const out: Series[] = [];
  for (const [symbol, assetClass] of UNIVERSE) {
    const c = await fetchStockCandles(symbol, "25y", "1d");
    if (c.length < 3000) { console.log(`  skip ${symbol} (${c.length} bars)`); continue; }
    out.push({ symbol, assetClass, dates: c.map((x) => x.openTime), close: c.map((x) => x.close) });
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 200));
  }
  const s = await fetchStockCandles("SPY", "25y", "1d");
  const spy: Series = { symbol: "SPY", assetClass: "equity", dates: s.map((x) => x.openTime), close: s.map((x) => x.close) };
  console.log("");
  writeFileSync(CACHE, JSON.stringify({ panel: out, spy }));
  return { panel: out, spy };
}

function buyHold(s: Series, from: number, to: number): Perf {
  const daily: number[] = [];
  for (let i = from + 1; i <= to; i++) daily.push(s.close[i] / s.close[i - 1] - 1);
  const n = daily.length;
  const mean = daily.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(daily.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  let equity = 1, peak = 1, maxDd = 0;
  for (const r of daily) { equity *= 1 + r; peak = Math.max(peak, equity); maxDd = Math.max(maxDd, (peak - equity) / peak); }
  const years = n / 252;
  return {
    annReturn: equity ** (1 / years) - 1, annVol: sd * Math.sqrt(252),
    sharpe: (mean * 252) / (sd * Math.sqrt(252)), maxDrawdown: maxDd,
    totalReturn: equity - 1, turnover: 0, months: 0,
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
function row(label: string, p: Perf, extra = "") {
  console.log(
    `  ${label.padEnd(30)} ${pct(p.annReturn).padStart(7)} ${p.sharpe.toFixed(2).padStart(6)} ` +
    `${pct(p.maxDrawdown).padStart(7)} ${pct(p.totalReturn).padStart(9)}  ${extra}`,
  );
}
function header() {
  console.log(`  ${"".padEnd(30)} ${"ann".padStart(7)} ${"sharpe".padStart(6)} ${"maxDD".padStart(7)} ${"total".padStart(9)}`);
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

async function main() {
  console.log("\nloading 25y of futures data (cached after first run)");
  const { panel: raw, spy: spyRaw } = await load();

  console.log("\n═══ 0. Data integrity ═══");
  const { cleaned, report } = cleanSeries([...raw, spyRaw]);
  const dirty = report.filter((r) => r.badTicks > 0 || r.droppedDays > 0);
  if (dirty.length === 0) console.log("  no impossible prints found.");
  for (const r of dirty) {
    console.log(`  ${r.symbol.padEnd(7)} ${r.badTicks} bad tick(s) repaired, ${r.droppedDays} day(s) dropped for non-positive price`);
  }
  console.log("  6J=F 2001-12-17 printed 0.000783 between two days of 0.00786 — a misplaced decimal,");
  console.log("       giving a -90% day and then a +904% day. The yen did not move 904%.");
  console.log("  CL=F 2020-04-20 closed at -$37.63. That is real, but pct returns across zero are not:");
  console.log("       the naive maths reports -306%, then -127%. A trend-follower is SHORT crude that");
  console.log("       month, so a short x -306% books an enormous fictional profit on the single most");
  console.log("       important day in the sample. Both days dropped.\n");

  // SPY is aligned *inside* the same call, so the benchmark and the strategies see the identical
  // set of trading days. Aligning them separately would compare two different windows.
  const all = alignPanel(cleaned);
  const panel = all.slice(0, raw.length);
  const spyAligned = all[all.length - 1];

  // The same panel WITHOUT the cleaning, to prove the conclusion does not live in three bad bars.
  const allDirty = alignPanel([...raw, spyRaw]);
  const panelDirty = allDirty.slice(0, raw.length);

  const cfg = DEFAULT_CONFIG;

  const classes = [...new Set(panel.map((s) => s.assetClass))];
  console.log(`\n${panel.length} instruments, ${panel[0].dates.length} aligned bars, ` +
    `${new Date(panel[0].dates[0]).toISOString().slice(0, 10)} -> ${new Date(panel[0].dates[panel[0].dates.length - 1]).toISOString().slice(0, 10)}`);
  for (const c of classes) console.log(`  ${c.padEnd(10)} ${panel.filter((s) => s.assetClass === c).map((s) => s.symbol).join(" ")}`);

  // SPY over the same window, as the thing every strategy in this repo has failed to beat. It starts
  // at the same index the books do, so nobody gets a free extra year.
  const spy = buyHold(spyAligned, 253, spyAligned.close.length - 1);

  console.log("\n═══ 1. TSMOM vs the controls, real data ═══");
  console.log("  MOP construction: sign(12m return) x 40%/sigma, monthly, 1bp/side\n");
  header();
  const tsmom = runBook(panel, "tsmom", cfg);
  const drift = runBook(panel, "drift", cfg);
  const alwaysLong = runBook(panel, "always_long", cfg);

  const randomRuns = Array.from({ length: RANDOM_DRAWS }, (_, i) => runBook(panel, "random", cfg, mulberry32(SEED + i * 977)));
  const randomMean: Perf = {
    annReturn: mean(randomRuns.map((p) => p.annReturn)), annVol: mean(randomRuns.map((p) => p.annVol)),
    sharpe: mean(randomRuns.map((p) => p.sharpe)), maxDrawdown: mean(randomRuns.map((p) => p.maxDrawdown)),
    totalReturn: mean(randomRuns.map((p) => p.totalReturn)), turnover: mean(randomRuns.map((p) => p.turnover)), months: 0,
  };

  row("TSMOM (the strategy)", tsmom, `turnover ${tsmom.turnover.toFixed(1)}x/yr`);
  row("DRIFT (no forecast at all)", drift, "sign of the expanding historical mean");
  row("ALWAYS LONG (dumbest)", alwaysLong, "sign = +1, always");
  row(`RANDOM (mean of ${RANDOM_DRAWS})`, randomMean, "coin-flip signs, same vol scaling");
  row("SPY buy & hold", spy, "the thing to beat");

  console.log("\n  --- the same books on the UNCLEANED data, for comparison ---");
  row("TSMOM (dirty data)", runBook(panelDirty, "tsmom", cfg), "<- if this differs materially, the");
  row("ALWAYS LONG (dirty data)", runBook(panelDirty, "always_long", cfg), "   result lived in the bad bars");

  console.log("\n═══ 2. EVERY book on SHUFFLED data ═══");
  console.log("  each instrument's returns re-ordered; mean/vol/tails kept, all structure destroyed.");
  console.log("  the ONLY thing left in there is each instrument's drift. so:");
  console.log("    shuffled ≈ real  ->  the book has no timing skill, it is harvesting drift");
  console.log("    shuffled << real ->  the book is reading something in the sequence\n");

  const real: Record<Control, Perf> = { tsmom, drift, always_long: alwaysLong, random: randomMean };

  for (const sync of [true, false]) {
    console.log(sync
      ? "  [A] SYNCHRONIZED null — one permutation for all instruments. Crashes stay simultaneous,\n" +
        "      cross-asset correlation survives, only the order of days dies. The honest null.\n"
      : "\n  [B] INDEPENDENT null — each instrument shuffled separately. This ALSO destroys the\n" +
        "      cross-asset correlation, handing the null a diversification bonus reality never gave.\n" +
        "      Shown to prove the point: watch always_long score HIGHER on noise than on reality.\n");

    console.log(`  ${"".padEnd(16)} ${"real".padStart(6)} ${"null".padStart(6)} ${"null range".padStart(14)}  ${"beat".padStart(8)}      p`);
    for (const control of ["tsmom", "drift", "always_long"] as Control[]) {
      const runs = Array.from({ length: PERMUTATIONS }, (_, i) =>
        runBook(shufflePanel(panel, mulberry32(SEED + i * 7919), sync), control, cfg, mulberry32(SEED + i * 31)));
      const sh = runs.map((p) => p.sharpe).sort((a, b) => a - b);
      const r = real[control].sharpe;
      const beat = sh.filter((s) => s >= r).length;
      const p = (beat + 1) / (PERMUTATIONS + 1);
      const tag = p < 0.05 ? "  <- reads the sequence" : beat > PERMUTATIONS * 0.9 ? "  <- null BEATS it" : "";
      console.log(
        `  ${control.padEnd(16)} ${r.toFixed(2).padStart(6)} ${mean(sh).toFixed(2).padStart(6)} ` +
        `${`${sh[0].toFixed(2)}..${sh[sh.length - 1].toFixed(2)}`.padStart(14)}  ` +
        `${`${beat}/${PERMUTATIONS}`.padStart(8)}  ${p.toFixed(3)}${tag}`,
      );
    }
  }

  console.log("\n═══ 3. By asset class ═══\n");
  header();
  for (const c of classes) {
    const sub = panel.filter((s) => s.assetClass === c);
    if (sub.length < 2) continue;
    const t = runBook(sub, "tsmom", cfg);
    const d = runBook(sub, "drift", cfg);
    row(`${c} — TSMOM`, t);
    row(`${c} — DRIFT (control)`, d);
  }

  console.log("\n═══ 4. Cost sensitivity ═══");
  console.log("  MOP/AQR assume costs in the 1bp range for liquid futures. If the edge dies at 5bp,\n" +
    "  it was never an edge, it was a rebate.\n");
  header();
  for (const bp of [0, 1, 3, 5, 10]) {
    const c: TsmomConfig = { ...cfg, costPerSide: bp / 10000 };
    row(`TSMOM @ ${bp}bp/side`, runBook(panel, "tsmom", c));
  }

  console.log("\n═══ 5. Leverage ═══");
  console.log("  40%/sigma is uncapped in MOP. On a 2-year note future (~1.5% vol) that is ~26x.");
  console.log("  A hedge fund can carry that. The question is what is left when you cannot.\n");
  header();
  for (const cap of [0, 10, 5, 3, 2, 1]) {
    const c: TsmomConfig = { ...cfg, maxLeverage: cap };
    row(`TSMOM cap ${cap === 0 ? "none" : `${cap}x`}`, runBook(panel, "tsmom", c));
  }

  console.log("\n═══ 6. Regime split ═══");
  console.log("  Hurst-Ooi-Pedersen: positive in every decade since 1880. Does it hold here?\n");
  const n = panel[0].dates.length;
  const thirds = [[0, Math.floor(n / 3)], [Math.floor(n / 3), Math.floor(2 * n / 3)], [Math.floor(2 * n / 3), n]];
  header();
  for (const [a, b] of thirds) {
    const sub = panel.map((s) => ({ ...s, dates: s.dates.slice(a, b), close: s.close.slice(a, b) }));
    const label = `${new Date(panel[0].dates[a]).getUTCFullYear()}-${new Date(panel[0].dates[b - 1]).getUTCFullYear()}`;
    row(`${label} — TSMOM`, runBook(sub, "tsmom", cfg));
    row(`${label} — DRIFT`, runBook(sub, "drift", cfg));
  }
  console.log("");
}

main().catch((e) => { console.error(e); process.exit(1); });
