/**
 * Every popular retail strategy, through one honest gauntlet.
 *
 * `npm run retail`
 *
 * The strategies retail actually reaches for — MA timing, golden cross, RSI bounces, MACD, Bollinger
 * mean reversion, buy-the-dip, dual momentum, seasonals — each run on the same index, the same cost
 * model, the same out-of-sample split, and judged against the two bars that matter:
 *
 *   1. Does it beat 1x buy-and-hold? (Almost the whole game. If not, it is a worse product.)
 *   2. For a TIMING strategy, does it beat RANDOM timing at the same market-exposure fraction? A
 *      strategy that is only in the market 60% of the time will have a smaller drawdown than
 *      buy-and-hold for free — that is not skill, it is just less exposure. The random-duty null
 *      strips that out: the signal has to place its in/out days better than a coin flip does.
 *
 * Costs: 2bp per switch. Signals are lagged one bar (decide on today's close, act tomorrow) — the
 * single most common way retail backtests lie to themselves is acting on the bar that generated the
 * signal. Long/flat only (the retail default); shorting is a separate, worse story told elsewhere.
 */

import { fetchStockCandles } from "./fetchStocks.js";
import { mulberry32 } from "./tsmom.js";

const SEED = 20260721;
const COST = 0.0002;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

const sma = (x: number[], w: number) => { const o = new Array(x.length).fill(NaN); let s = 0; for (let i = 0; i < x.length; i++) { s += x[i]; if (i >= w) s -= x[i - w]; if (i >= w - 1) o[i] = s / w; } return o; };
function rsi(x: number[], w: number) {
  const o = new Array(x.length).fill(NaN); let ag = 0, al = 0;
  for (let i = 1; i < x.length; i++) { const ch = x[i] - x[i - 1]; const g = Math.max(ch, 0), l = Math.max(-ch, 0); if (i <= w) { ag += g; al += l; if (i === w) { ag /= w; al /= w; o[i] = 100 - 100 / (1 + ag / (al || 1e-9)); } } else { ag = (ag * (w - 1) + g) / w; al = (al * (w - 1) + l) / w; o[i] = 100 - 100 / (1 + ag / (al || 1e-9)); } }
  return o;
}
function ema(x: number[], w: number) { const o = new Array(x.length).fill(NaN); const k = 2 / (w + 1); let e = x[0]; for (let i = 0; i < x.length; i++) { e = i === 0 ? x[0] : x[i] * k + e * (1 - k); o[i] = e; } return o; }

interface Res { cagr: number; sharpe: number; maxDD: number; timeIn: number; switches: number }
function evalTiming(spyDaily: number[], inMkt: boolean[]): Res {
  const out: number[] = []; let sw = 0;
  for (let i = 0; i < spyDaily.length; i++) { const on = inMkt[i]; if (i > 0 && inMkt[i] !== inMkt[i - 1]) sw++; out.push((on ? spyDaily[i] : 0) - (i > 0 && inMkt[i] !== inMkt[i - 1] ? COST : 0)); }
  let eq = 1, peak = 1, mdd = 0; for (const r of out) { eq *= 1 + r; peak = Math.max(peak, eq); mdd = Math.max(mdd, (peak - eq) / peak); }
  const m = mean(out), sd = Math.sqrt(mean(out.map((v) => (v - m) ** 2)));
  return { cagr: eq ** (252 / out.length) - 1, sharpe: sd > 0 ? (m * 252) / (sd * Math.sqrt(252)) : 0, maxDD: mdd, timeIn: inMkt.filter(Boolean).length / inMkt.length, switches: sw / (out.length / 252) };
}

async function main() {
  const c = await fetchStockCandles("SPY", "25y", "1d");
  const close = c.map((x) => x.close), high = c.map((x) => x.high), low = c.map((x) => x.low);
  const dt = c.map((x) => x.openTime);
  const spyDaily = close.map((x, i) => (i === 0 ? 0 : x / close[i - 1] - 1)).slice(1);
  console.log(`\nSPY, ${spyDaily.length} days, ${new Date(dt[0]).toISOString().slice(0, 10)} -> ${new Date(dt.at(-1)!).toISOString().slice(0, 10)}`);

  // --- build each strategy's in-market boolean, all lagged one bar ---
  const lag = (sig: boolean[]) => sig.map((_, i) => (i === 0 ? false : sig[i - 1])).slice(1);

  const ma200 = sma(close, 200), ma50 = sma(close, 50), ma10mo = sma(close, 210);
  const r2 = rsi(close, 2), r14 = rsi(close, 14);
  const macdLine = ema(close, 12).map((e, i) => e - ema(close, 26)[i]); const macdSig = ema(macdLine.map((v) => (Number.isNaN(v) ? 0 : v)), 9);
  const bbMid = sma(close, 20), bbSd = (() => { const o = new Array(close.length).fill(NaN); for (let i = 19; i < close.length; i++) { const w = close.slice(i - 19, i + 1); const m = mean(w); o[i] = Math.sqrt(mean(w.map((v) => (v - m) ** 2))); } return o; })();
  const roll20High = close.map((_, i) => (i < 20 ? NaN : Math.max(...close.slice(i - 20, i))));
  const mom252 = close.map((v, i) => (i < 252 ? NaN : v / close[i - 252] - 1));

  const strategies: Record<string, boolean[]> = {};
  strategies["200-day MA (Faber)"] = close.map((v, i) => v > ma200[i]);
  strategies["10-month MA (Faber orig)"] = close.map((v, i) => v > ma10mo[i]);
  strategies["golden cross 50/200"] = close.map((_, i) => ma50[i] > ma200[i]);
  strategies["dual momentum (12mo>0)"] = close.map((_, i) => (Number.isFinite(mom252[i]) ? mom252[i] > 0 : false));

  // stateful RSI / Bollinger mean-reversion (long when oversold, exit when recovered)
  const rsiState = (r: number[], buy: number, sell: number) => { const s: boolean[] = []; let on = false; for (let i = 0; i < close.length; i++) { if (!Number.isNaN(r[i])) { if (r[i] < buy) on = true; else if (r[i] > sell) on = false; } s.push(on); } return s; };
  strategies["RSI(2)<10 (Connors)"] = rsiState(r2, 10, 70);
  strategies["RSI(14)<30 bounce"] = rsiState(r14, 30, 70);
  strategies["MACD > signal"] = close.map((_, i) => (Number.isFinite(macdLine[i]) && Number.isFinite(macdSig[i]) ? macdLine[i] > macdSig[i] : false));
  { const s: boolean[] = []; let on = false; for (let i = 0; i < close.length; i++) { if (Number.isFinite(bbMid[i]) && Number.isFinite(bbSd[i])) { if (close[i] < bbMid[i] - 2 * bbSd[i]) on = true; else if (close[i] > bbMid[i]) on = false; } s.push(on); } strategies["Bollinger(20,2) bounce"] = s; }
  { const s: boolean[] = []; let hold = 0; for (let i = 0; i < close.length; i++) { if (i > 0 && Number.isFinite(roll20High[i]) && close[i] < roll20High[i] * 0.95) hold = 10; s.push(hold > 0); if (hold > 0) hold--; } strategies["buy the -5% dip, hold 10d"] = s; }
  strategies["sell in May (Nov-Apr in)"] = dt.map((ms) => { const m = new Date(ms).getUTCMonth(); return m >= 10 || m <= 3; });
  { const s: boolean[] = []; for (const ms of dt) { const d = new Date(ms).getUTCDate(); s.push(d >= 28 || d <= 3); } strategies["turn-of-month only"] = s; }

  // --- benchmark ---
  let eq = 1, peak = 1, mdd = 0; for (const r of spyDaily) { eq *= 1 + r; peak = Math.max(peak, eq); mdd = Math.max(mdd, (peak - eq) / peak); }
  const bhM = mean(spyDaily), bhSd = Math.sqrt(mean(spyDaily.map((v) => (v - bhM) ** 2)));
  const bh = { cagr: eq ** (252 / spyDaily.length) - 1, sharpe: (bhM * 252) / (bhSd * Math.sqrt(252)), maxDD: mdd };

  console.log(`\n  ${"strategy".padEnd(26)} ${"CAGR".padStart(7)} ${"Sharpe".padStart(7)} ${"maxDD".padStart(7)} ${"in%".padStart(6)} ${"beat B&H?".padStart(10)} ${"vs random".padStart(10)}`);
  console.log(`  ${"1x BUY & HOLD".padEnd(26)} ${pct(bh.cagr).padStart(7)} ${bh.sharpe.toFixed(2).padStart(7)} ${pct(bh.maxDD).padStart(7)} ${"100%".padStart(6)} ${"—".padStart(10)} ${"—".padStart(10)}`);

  const rows: Array<{ name: string; res: Res; beatBH: boolean; randP: number }> = [];
  for (const [name, sigRaw] of Object.entries(strategies)) {
    const res = evalTiming(spyDaily, lag(sigRaw));
    // random-duty null: same in-market fraction, 300 draws, does the signal beat coin-flip timing on CAGR?
    const nulls: number[] = [];
    for (let s = 0; s < 300; s++) { const rng = mulberry32(SEED + s * 131 + name.length); nulls.push(evalTiming(spyDaily, spyDaily.map(() => rng() < res.timeIn)).cagr); }
    const randP = (nulls.filter((x) => x >= res.cagr).length + 1) / 301;
    rows.push({ name, res, beatBH: res.cagr > bh.cagr, randP });
  }
  rows.sort((a, b) => b.res.cagr - a.res.cagr);
  for (const { name, res, beatBH, randP } of rows) {
    console.log(
      `  ${name.padEnd(26)} ${pct(res.cagr).padStart(7)} ${res.sharpe.toFixed(2).padStart(7)} ${pct(res.maxDD).padStart(7)} ` +
      `${pct(res.timeIn).padStart(6)} ${(beatBH ? "YES" : "no").padStart(10)} ${(randP < 0.05 ? `${randP.toFixed(3)}*` : randP.toFixed(3)).padStart(10)}`);
  }

  const beat = rows.filter((r) => r.beatBH).length;
  const skill = rows.filter((r) => r.randP < 0.05).length;
  console.log(`\n  ${beat}/${rows.length} beat buy-and-hold on CAGR.  ${skill}/${rows.length} beat random timing at their own exposure (p<0.05).`);
  console.log(`  lower drawdown than B&H is common and cheap: it is mostly just being out of the market ${pct(1 - mean(rows.map((r) => r.res.timeIn)))} of the time.`);

  console.log("\n═══ Out of sample: first half built nothing, does the ranking hold in the second? ═══\n");
  const half = Math.floor(spyDaily.length / 2);
  console.log(`  ${"strategy".padEnd(26)} ${"1st-half CAGR".padStart(13)} ${"2nd-half CAGR".padStart(13)} ${"B&H 2nd half".padStart(13)}`);
  const bh2 = (() => { let e = 1; for (const r of spyDaily.slice(half)) e *= 1 + r; return e ** (252 / (spyDaily.length - half)) - 1; })();
  for (const { name } of rows.slice(0, 6)) {
    const sig = lag(strategies[name]);
    const c1 = evalTiming(spyDaily.slice(0, half), sig.slice(0, half)).cagr;
    const c2 = evalTiming(spyDaily.slice(half), sig.slice(half)).cagr;
    console.log(`  ${name.padEnd(26)} ${pct(c1).padStart(13)} ${pct(c2).padStart(13)} ${pct(bh2).padStart(13)}`);
  }
  console.log("");
}

main().catch((e) => { console.error(e); process.exit(1); });
