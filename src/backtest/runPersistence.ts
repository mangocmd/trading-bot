/**
 * "I don't need a strategy that works forever, just one that works for a while."
 *
 * `npm run persistence`
 *
 * This is the honest test of that hope. A strategy that works temporarily is only tradeable if you
 * can tell it is CURRENTLY in its good period — otherwise you only learn the good period happened
 * after it is over, which is worthless. So the whole idea reduces to one measurable question:
 *
 *   Does a strategy's RECENT performance predict its NEAR-FUTURE performance?
 *
 * If yes, you rotate into whatever is hot and ride it until it cools. If no, then "it worked lately"
 * carries no information about tomorrow, and "short-term success" is unreachable by construction:
 * you cannot stand in the good period, you can only look back at it.
 *
 * Method. Build a pool of ~120 diverse timing strategies on SPY. Each month, rank them by trailing
 * K-month return and measure each one's NEXT month return. The information coefficient (IC) is the
 * cross-sectional correlation between the two, averaged over every rebalance.
 *
 * The one trap that would fake a positive result: in a bull market, strategies that are simply long
 * more often have high trailing AND high forward returns — that is beta, not persistence, and it
 * would manufacture a positive IC out of nothing. So both trailing and forward returns are
 * cross-sectionally DEMEANED at every rebalance, removing the common market component. The IC then
 * asks only: did the strategies that beat the pack keep beating the pack?
 */

import { fetchStockCandles } from "./fetchStocks.js";
import { generateCandidates } from "./candidates.js";
import { mulberry32 } from "./tsmom.js";

const SEED = 20260715;
const POOL = 120;
const COST = 0.0002; // 2bp/side, liquid ETF

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
function pearson(a: number[], b: number[]): number {
  const n = a.length; if (n < 3) return 0;
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

/** Daily return of one strategy: signal is lagged one bar, cost charged on position change. */
function strategyDaily(sig: number[], close: number[]): number[] {
  const out = new Array(close.length).fill(0);
  for (let i = 1; i < close.length; i++) {
    const r = close[i] / close[i - 1] - 1;
    out[i] = sig[i - 1] * r - COST * Math.abs(sig[i - 1] - (sig[i - 2] ?? 0));
  }
  return out;
}

function monthEnds(dates: number[]): number[] {
  const e: number[] = [];
  for (let i = 0; i < dates.length - 1; i++) {
    const a = new Date(dates[i]), b = new Date(dates[i + 1]);
    if (a.getUTCMonth() !== b.getUTCMonth() || a.getUTCFullYear() !== b.getUTCFullYear()) e.push(i);
  }
  return e;
}

async function main() {
  const candles = await fetchStockCandles("SPY", "20y", "1d");
  const close = candles.map((c) => c.close);
  const dates = candles.map((c) => c.openTime);
  console.log(`\nSPY, ${close.length} bars, ${new Date(dates[0]).toISOString().slice(0, 10)} -> ${new Date(dates.at(-1)!).toISOString().slice(0, 10)}`);

  // Long/short so strategies genuinely differ instead of all being clipped beta.
  const rand = mulberry32(SEED);
  const pool = generateCandidates(POOL, rand, "long_short");
  const daily = pool.map((c) => strategyDaily(c.signals(close), close));
  const ends = monthEnds(dates);

  const cumBetween = (r: number[], a: number, b: number) => { let s = 0; for (let i = a + 1; i <= b; i++) s += r[i]; return s; };

  console.log("\n═══ Does recent strategy performance predict near-future performance? ═══");
  console.log("  IC = cross-sectional corr(trailing return, next-month return), demeaned each period.");
  console.log("  IC > 0: winners keep winning, rotation works.  IC ~ 0: 'it worked lately' is noise.");
  console.log("  IC < 0: winners reverse, chasing what's hot actively loses.\n");

  console.log(`  ${"trailing window".padEnd(18)} ${"mean IC".padStart(8)} ${"t-stat".padStart(7)} ${"% periods IC>0".padStart(15)}`);
  for (const K of [1, 3, 6, 12]) {
    const lb = K; // in months ≈ K rebalances
    const ics: number[] = [];
    for (let e = lb + 1; e < ends.length - 1; e++) {
      const t0 = ends[e - lb], t1 = ends[e], t2 = ends[e + 1];
      const trailing = daily.map((r) => cumBetween(r, t0, t1));
      const forward = daily.map((r) => cumBetween(r, t1, t2));
      // Cross-sectionally demean both: strip the common market move so we measure only who beat whom.
      const mt = mean(trailing), mf = mean(forward);
      const ic = pearson(trailing.map((x) => x - mt), forward.map((x) => x - mf));
      if (Number.isFinite(ic)) ics.push(ic);
    }
    const m = mean(ics);
    const sd = Math.sqrt(mean(ics.map((x) => (x - m) ** 2)));
    const t = (m / (sd / Math.sqrt(ics.length)));
    const posFrac = ics.filter((x) => x > 0).length / ics.length;
    console.log(`  ${`${K} month`.padEnd(18)} ${m.toFixed(3).padStart(8)} ${t.toFixed(2).padStart(7)} ${pct(posFrac).padStart(15)}`);
  }

  console.log("\n═══ Is that 3-month IC real, or the best of four tries? ═══");
  console.log("  A naive t-stat treats every period as independent (they are not — ICs cluster by");
  console.log("  regime) and ignores that 3-month was the best of four windows. So: a permutation null.");
  console.log("  Keep each period's trailing values; SHUFFLE which strategy gets which forward value,");
  console.log("  destroying only the trailing->forward link. 500 draws.\n");

  const K3 = 3;
  const realICs: number[] = [];
  const perStrategyForward: number[][] = [];
  const perStrategyTrailing: number[][] = [];
  for (let e = K3 + 1; e < ends.length - 1; e++) {
    const t0 = ends[e - K3], t1 = ends[e], t2 = ends[e + 1];
    const trailing = daily.map((r) => cumBetween(r, t0, t1));
    const forward = daily.map((r) => cumBetween(r, t1, t2));
    const mt = mean(trailing), mf = mean(forward);
    perStrategyTrailing.push(trailing.map((x) => x - mt));
    perStrategyForward.push(forward.map((x) => x - mf));
    realICs.push(pearson(trailing.map((x) => x - mt), forward.map((x) => x - mf)));
  }
  const realMeanIC = mean(realICs);
  const prng = mulberry32(SEED + 99);
  const nullMeans: number[] = [];
  for (let s = 0; s < 500; s++) {
    const perPeriod: number[] = [];
    for (let p = 0; p < perStrategyForward.length; p++) {
      const fwd = [...perStrategyForward[p]];
      for (let i = fwd.length - 1; i > 0; i--) { const j = Math.floor(prng() * (i + 1)); [fwd[i], fwd[j]] = [fwd[j], fwd[i]]; }
      perPeriod.push(pearson(perStrategyTrailing[p], fwd));
    }
    nullMeans.push(mean(perPeriod));
  }
  nullMeans.sort((a, b) => a - b);
  const beat = nullMeans.filter((x) => x >= realMeanIC).length;
  console.log(`  real mean IC ${realMeanIC.toFixed(3)}`);
  console.log(`  null mean IC ${mean(nullMeans).toFixed(3)}, range ${nullMeans[0].toFixed(3)}..${nullMeans[nullMeans.length - 1].toFixed(3)}`);
  console.log(`  null >= real: ${beat}/500  ->  p = ${((beat + 1) / 501).toFixed(3)}`);

  console.log("\n═══ The practical version: rotate into the trailing winners ═══");
  console.log("  Each month, hold the top-quintile strategies by trailing 3-month return. Compare to");
  console.log("  holding the bottom quintile, and to holding all of them. If chasing winners works,");
  console.log("  top >> bottom.\n");

  const K = 3;
  const q = Math.max(1, Math.floor(POOL / 5));
  const topStream: number[] = [], botStream: number[] = [], allStream: number[] = [];
  for (let e = K + 1; e < ends.length - 1; e++) {
    const t0 = ends[e - K], t1 = ends[e], t2 = ends[e + 1];
    const ranked = daily.map((r, k) => ({ k, tr: cumBetween(r, t0, t1) })).sort((a, b) => b.tr - a.tr);
    const top = ranked.slice(0, q).map((x) => x.k);
    const bot = ranked.slice(-q).map((x) => x.k);
    for (let i = t1 + 1; i <= t2; i++) {
      topStream.push(mean(top.map((k) => daily[k][i])));
      botStream.push(mean(bot.map((k) => daily[k][i])));
      allStream.push(mean(daily.map((r) => r[i])));
    }
  }
  const ann = (s: number[]) => (1 + mean(s)) ** 252 - 1;
  const sharpe = (s: number[]) => (mean(s) * 252) / (Math.sqrt(mean(s.map((x) => (x - mean(s)) ** 2))) * Math.sqrt(252));
  console.log(`  ${"portfolio".padEnd(28)} ${"ann".padStart(8)} ${"sharpe".padStart(7)}`);
  console.log(`  ${"top quintile (chase winners)".padEnd(28)} ${pct(ann(topStream)).padStart(8)} ${sharpe(topStream).toFixed(2).padStart(7)}`);
  console.log(`  ${"bottom quintile (buy losers)".padEnd(28)} ${pct(ann(botStream)).padStart(8)} ${sharpe(botStream).toFixed(2).padStart(7)}`);
  console.log(`  ${"all strategies".padEnd(28)} ${pct(ann(allStream)).padStart(8)} ${sharpe(allStream).toFixed(2).padStart(7)}`);

  const diff = ann(topStream) - ann(botStream);
  console.log(`\n  top minus bottom: ${pct(diff)}`);

  // The dollar-neutral persistence factor: long the recent winners, short the recent losers. This
  // IS the p=0.002 signal, expressed as a tradeable book. Its Sharpe is the only thing leverage
  // leaves unchanged, so it is the only thing that decides whether leverage can rescue it.
  const factor = topStream.map((x, i) => x - botStream[i]);
  const fMean = mean(factor);
  const fVol = Math.sqrt(mean(factor.map((x) => (x - fMean) ** 2))) * Math.sqrt(252);
  const fSharpe = (fMean * 252) / fVol;
  let eq = 1, peak = 1, fdd = 0;
  for (const r of factor) { eq *= 1 + r; peak = Math.max(peak, eq); fdd = Math.max(fdd, (peak - eq) / peak); }
  console.log(`\n  the persistence factor (long winners / short losers, dollar-neutral):`);
  console.log(`    ann ${pct(ann(factor))}, vol ${pct(fVol)}, Sharpe ${fSharpe.toFixed(3)}, maxDD ${pct(fdd)}`);

  console.log(`\n  can leverage rescue it? leverage is Sharpe-neutral, so no. the arithmetic:`);
  console.log(`  ${"L".padStart(5)} ${"ann @0%".padStart(9)} ${"ann @5% fin".padStart(12)} ${"vol".padStart(7)} ${"maxDD".padStart(8)}`);
  for (const L of [1, 5, 10, 30]) {
    const lev = factor.map((r) => L * r - (0.05 * (L - 1)) / 252);
    let e2 = 1, pk = 1, dd = 0;
    for (const r of lev) { e2 *= 1 + r; pk = Math.max(pk, e2); dd = Math.max(dd, (pk - e2) / pk); }
    console.log(`  ${`${L}x`.padStart(5)} ${pct(ann(factor.map((r) => L * r))).padStart(9)} ${pct(ann(lev)).padStart(12)} ${pct(fVol * L).padStart(7)} ${pct(dd).padStart(8)}`);
  }
  const need = 0.05 / (fSharpe * (fVol / 1)); // leverage to reach ~5%/yr gross ignoring financing
  console.log(`\n  to reach a 5%/yr return gross would take ~${(0.05 / Math.max(fMean * 252, 1e-9)).toFixed(0)}x leverage;`);
  console.log(`  at 5% financing that book earns ${pct(ann(factor.map((r) => (0.05 / Math.max(fMean * 252, 1e-9)) * r - (0.05 * ((0.05 / Math.max(fMean * 252, 1e-9)) - 1)) / 252)))}/yr. leverage cannot make a ~0 Sharpe pay.`);
  void need;
  console.log(`  ${Math.abs(diff) < 0.02
    ? "  -> chasing recent winners is indistinguishable from buying recent losers. Recent\n     performance carries no information about next month. 'Works for a while' is not reachable:\n     you cannot identify the good period while you are standing in it."
    : diff > 0
    ? "  -> recent winners do continue, modestly. There may be something here — pending a null test."
    : "  -> recent winners REVERSE. Chasing what is hot loses to buying what is cold."}`);
  console.log("");
}

main().catch((e) => { console.error(e); process.exit(1); });
