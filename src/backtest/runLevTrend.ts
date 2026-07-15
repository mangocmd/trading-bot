/**
 * Leveraged trend-timing: hold the index levered while it trends up, go to cash when it breaks down.
 *
 * `npm run levtrend`
 *
 * This is a specific, popular retail strategy — "hold 3x above the 200-day MA, cash below" — and it
 * is the one leverage idea with a real thesis behind it, so it gets a real test instead of a dismissal.
 *
 * The thesis is not stupid. Leverage's fatal flaw is that drawdown scales to ruin (runLeverage.ts).
 * A trend filter's whole job is to CAP drawdown by exiting before the worst of a crash. If the filter
 * works, the two flaws might cancel: leverage on a drawdown-controlled book is survivable in a way
 * leverage on buy-and-hold is not.
 *
 * The three things that decide whether the thesis survives contact with reality, each measured below:
 *   1. WHIPSAW. Price crosses the MA repeatedly in choppy markets; each false exit/re-entry is a
 *      round-trip cost and a missed bounce, amplified by leverage.
 *   2. GAP RISK. The filter exits on a close below the MA, but crashes gap DOWN (2020: -34% in 33
 *      days, much of it overnight). You eat the gap at full leverage before you can act.
 *   3. VOLATILITY DECAY. Constant leverage compounds the DAILY return; in a volatile-but-flat market
 *      that bleeds even with no trend, and the filter keeps you in during exactly those chops.
 *
 * Leverage is modelled as CONSTANT leverage (daily-rebalanced, the LETF/disciplined-margin case):
 * return_t = L * r_t - costs. That is more survivable than fixed-notional (which rings the register
 * at a -1/L single day) and it is what disciplined retail actually holds. Decay is not added by hand;
 * it emerges from compounding L*daily, which is exactly what it does in reality.
 *
 * The null (same discipline as the kill-switch test): does the 200-MA signal beat RANDOM timing at
 * the same market-exposure fraction? SPY has positive drift, so being in more captures more drift —
 * the MA only earns its keep if it avoids the DOWNSIDE better than a coin flip at the same duty cycle.
 */

import { fetchStockCandles } from "./fetchStocks.js";
import { mulberry32 } from "./tsmom.js";

const SEED = 20260720;
const FIN = 0.05;       // annual financing on the borrowed (L-1), ~2026 rates
const COST = 0.0002;    // 2bp per entry/exit round trip on the traded fraction

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function sma(x: number[], w: number): number[] {
  const out = new Array(x.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < x.length; i++) { s += x[i]; if (i >= w) s -= x[i - w]; if (i >= w - 1) out[i] = s / w; }
  return out;
}

interface Result { cagr: number; sharpe: number; maxDD: number; worstDay: number; timeIn: number; equity: number[] }

function evalStream(daily: number[]): Result {
  const n = daily.length;
  let eq = 1, peak = 1, mdd = 0, worst = 0;
  const curve = [1];
  for (const r of daily) { eq *= 1 + r; peak = Math.max(peak, eq); mdd = Math.max(mdd, (peak - eq) / peak); worst = Math.min(worst, r); curve.push(eq); }
  const m = mean(daily), sd = Math.sqrt(mean(daily.map((x) => (x - m) ** 2)));
  return { cagr: eq ** (252 / n) - 1, sharpe: sd > 0 ? (m * 252) / (sd * Math.sqrt(252)) : 0, maxDD: mdd, worstDay: worst, timeIn: 1, equity: curve };
}

/**
 * Constant-leverage trend book. `inMarket[i]` (already lagged) decides whether day i earns L*r or 0;
 * financing is charged on the borrowed portion only while in; cost on the fraction traded at a switch.
 */
function trendBook(spyDaily: number[], inMarket: boolean[], L: number): { res: Result; switches: number } {
  const out: number[] = [];
  let switches = 0;
  for (let i = 0; i < spyDaily.length; i++) {
    const on = inMarket[i];
    if (i > 0 && inMarket[i] !== inMarket[i - 1]) switches++;
    let r = 0;
    if (on) r = L * spyDaily[i] - (FIN * (L - 1)) / 252;
    if (i > 0 && inMarket[i] !== inMarket[i - 1]) r -= COST * L; // round-trip on the levered notional
    out.push(r);
  }
  const res = evalStream(out);
  res.timeIn = inMarket.filter(Boolean).length / inMarket.length;
  return { res, switches };
}

async function main() {
  const candles = await fetchStockCandles("SPY", "25y", "1d");
  const close = candles.map((c) => c.close);
  const dates = candles.map((c) => c.openTime);
  const daily = close.map((c, i) => (i === 0 ? 0 : c / close[i - 1] - 1)).slice(1);
  const d = dates.slice(1);
  console.log(`\nSPY, ${daily.length} days, ${new Date(d[0]).toISOString().slice(0, 10)} -> ${new Date(d.at(-1)!).toISOString().slice(0, 10)}`);

  const row = (label: string, r: Result, extra = "") => console.log(
    `  ${label.padEnd(30)} ${pct(r.cagr).padStart(8)} ${r.sharpe.toFixed(2).padStart(7)} ${pct(r.maxDD).padStart(8)} ${pct(r.worstDay).padStart(8)}  ${extra}`);
  console.log(`\n  ${"".padEnd(30)} ${"CAGR".padStart(8)} ${"Sharpe".padStart(7)} ${"maxDD".padStart(8)} ${"worstday".padStart(8)}`);

  const hold1 = evalStream(daily);
  row("1x buy & hold", hold1, "the benchmark");

  // Naive leverage, no timing — the ruin case.
  for (const L of [2, 3]) {
    const lev = daily.map((r) => L * r - (FIN * (L - 1)) / 252);
    row(`${L}x buy & hold (no timing)`, evalStream(lev), L === 3 ? "<- the seductive backtest" : "");
  }

  console.log("");
  // Trend-timed leverage. Signal: close > 200MA, lagged one day (act on next open).
  for (const maW of [200, 100]) {
    const ma = sma(close, maW);
    const inMkt = close.map((c, i) => (i === 0 ? false : close[i - 1] > ma[i - 1])); // lagged
    const inMktD = inMkt.slice(1);
    for (const L of [2, 3]) {
      const { res, switches } = trendBook(daily, inMktD, L);
      row(`${L}x, >${maW}MA -> cash`, res, `${(switches / (daily.length / 252)).toFixed(1)} switches/yr, in ${pct(res.timeIn)}`);
    }
  }

  console.log("\n═══ The crashes — where leverage lives or dies ═══");
  console.log("  did the 200MA filter cap the drawdown, or did the gap get eaten at leverage first?\n");
  const ma200 = sma(close, 200);
  const inMkt200 = close.map((c, i) => (i === 0 ? false : close[i - 1] > ma200[i - 1])).slice(1);
  const episodes: Array<[string, string, string]> = [
    ["2008 crash", "2008-09-01", "2009-03-31"],
    ["2020 COVID", "2020-02-15", "2020-04-15"],
    ["2022 bear", "2022-01-01", "2022-10-31"],
  ];
  console.log(`  ${"episode".padEnd(14)} ${"1x hold".padStart(9)} ${"3x hold".padStart(9)} ${"3x >200MA".padStart(11)}`);
  for (const [label, s, e] of episodes) {
    const a = d.findIndex((x) => x >= Date.parse(s + "T00:00:00Z"));
    const b = d.findIndex((x) => x >= Date.parse(e + "T00:00:00Z"));
    const seg = (arr: number[]) => arr.slice(a, b);
    const cum = (rs: number[]) => rs.reduce((acc, r) => acc * (1 + r), 1) - 1;
    const h1 = cum(seg(daily));
    const h3 = cum(seg(daily.map((r) => 3 * r - (FIN * 2) / 252)));
    const t3seg = seg(daily).map((r, i) => (inMkt200[a + i] ? 3 * r - (FIN * 2) / 252 : 0));
    console.log(`  ${label.padEnd(14)} ${pct(h1).padStart(9)} ${pct(h3).padStart(9)} ${pct(cum(t3seg)).padStart(11)}`);
  }

  console.log("\n═══ Out of sample: does it hold in both halves? ═══\n");
  const half = Math.floor(daily.length / 2);
  console.log(`  ${"period".padEnd(14)} ${"3x >200MA CAGR".padStart(15)} ${"Sharpe".padStart(7)} ${"maxDD".padStart(8)}`);
  for (const [label, a, b] of [["first half", 0, half], ["second half", half, daily.length]] as Array<[string, number, number]>) {
    const { res } = trendBook(daily.slice(a, b), inMkt200.slice(a, b), 3);
    console.log(`  ${label.padEnd(14)} ${pct(res.cagr).padStart(15)} ${res.sharpe.toFixed(2).padStart(7)} ${pct(res.maxDD).padStart(8)}`);
  }

  console.log("\n═══ The null: does 200MA beat RANDOM timing at the same exposure? ═══");
  console.log("  SPY drifts up, so being in more earns more. The MA only adds value if it avoids the");
  console.log("  DOWNSIDE better than a coin flip that is in the market the same fraction of days.\n");
  const { res: real } = trendBook(daily, inMkt200, 3);
  const duty = real.timeIn;
  const nulls: number[] = [];
  const nullDDs: number[] = [];
  for (let s = 0; s < 500; s++) {
    const rng = mulberry32(SEED + s * 131);
    const rnd = daily.map(() => rng() < duty);
    const { res } = trendBook(daily, rnd, 3);
    nulls.push(res.cagr); nullDDs.push(res.maxDD);
  }
  nulls.sort((a, b) => a - b); nullDDs.sort((a, b) => a - b);
  const beat = nulls.filter((x) => x >= real.cagr).length;
  console.log(`  3x >200MA:   CAGR ${pct(real.cagr)}, maxDD ${pct(real.maxDD)}`);
  console.log(`  random @${pct(duty)}: median CAGR ${pct(nulls[250])}, median maxDD ${pct(nullDDs[250])}`);
  console.log(`  random CAGR >= real: ${beat}/500  (p = ${((beat + 1) / 501).toFixed(3)})`);
  console.log(`  real maxDD vs random median maxDD: ${pct(real.maxDD)} vs ${pct(nullDDs[250])}  <- the MA's real job is here`);
  console.log("");
}

main().catch((e) => { console.error(e); process.exit(1); });
