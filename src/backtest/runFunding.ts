/**
 * Funding rate as a signal — the first data axis in this repo that is not derivable from price.
 *
 * `npm run funding`
 *
 * Perpetual futures charge funding every 8h: longs pay shorts when the rate is positive, shorts pay
 * longs when negative. The rate embeds POSITIONING — crowded longs push it up — which candles do not
 * contain. Two pre-registered hypotheses, stated before the data was fetched:
 *
 *   H1 (carry, mechanical): a book long the lowest-funding coins and short the highest-funding coins
 *      RECEIVES funding on both legs by construction. The carry component must be positive; the open
 *      question is whether it survives costs and adverse price drift.
 *
 *   H2 (contrarian price alpha): extreme positive funding = crowded longs = poor forward returns.
 *      If true, the book's PRICE component is also positive. Prediction: weak or negative during
 *      2020-2023 (this book is roughly the anti-momentum trade, and momentum was alive then),
 *      possibly better after 2024 when momentum died.
 *
 * The components are reported SEPARATELY. Carry is arithmetic and needs no null; price alpha gets a
 * 200-draw synchronized-shuffle null (returns shuffled, funding kept on real dates, so the signal
 * knows nothing about the shuffled future by construction).
 *
 * Funding data: Binance perp funding history (public API, 8h, from Sep 2019; most alts from H1
 * 2020). Prices: the cached MEXC daily closes. Mixing venues adds basis noise but funding rates
 * across major venues track each other closely; flagged, not hidden.
 */

import {
  alignPanel, cleanSeries, score, correlation, shufflePanel, mulberry32,
  type Series, type Perf,
} from "./tsmom.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const PRICE_CACHE = "data/crypto.json";
const FUND_CACHE = "data/funding.json";
const SEED = 20260717;
const PPY = 365;
const PERMUTATIONS = 200;
const TARGET_VOL = 0.40;
const VOL_COM = 60;
const COST = 0.0005; // 5bp/side perp taker

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const weekIndex = (ms: number) => Math.floor((ms / 86_400_000 + 4) / 7);
const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

async function fetchFundingDaily(symbol: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  let cursor = Date.UTC(2019, 8, 1);
  const end = Date.now();
  while (cursor < end) {
    const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&startTime=${cursor}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`binance funding ${symbol}: ${res.status}`);
    const rows = (await res.json()) as Array<{ fundingTime: number; fundingRate: string }>;
    if (rows.length === 0) break;
    for (const r of rows) {
      const k = dayKey(r.fundingTime);
      out[k] = (out[k] ?? 0) + Number(r.fundingRate); // sum the day's (usually 3) settlements
    }
    const last = rows[rows.length - 1].fundingTime;
    if (last <= cursor) break;
    cursor = last + 1;
    await new Promise((r) => setTimeout(r, 150));
  }
  return out;
}

interface BookResult {
  total: Perf;
  price: number[];   // daily price-only P&L
  carry: number[];   // daily funding receipts
  turnover: number;
}

/**
 * Weekly-rebalanced book ranked by `signalAt` (lower = long). Accounting mirrors runWeekly in
 * runCryptoMom: one-bar lag, ex-ante EWMA vol, cost and turnover per unit of book. Carry accrues on
 * the position actually held that day: a long pays the day's funding when it is positive.
 */
function fundingBook(
  panel: Series[],
  fund: number[][],           // per coin, aligned daily funding sums (NaN before listing)
  mode: "funding" | "momentum" | "long",
  cost: number,
): BookResult {
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
  const price: number[] = [], carry: number[] = [];
  let turnover = 0;
  const start = 29; // longest trailing window (28d momentum) + 1

  for (let i = start; i < n; i++) {
    let p = 0, c = 0;
    for (let k = 0; k < N; k++) {
      p += positions[k] * rets[k][i];
      const f = fund[k][i];
      if (Number.isFinite(f)) c += -positions[k] * f; // long pays positive funding
    }
    price.push(p / N);
    carry.push(c / N);

    const weekRolls = i + 1 < n && weekIndex(panel[0].dates[i + 1]) !== weekIndex(panel[0].dates[i]);
    if (!weekRolls) continue;

    // trailing 7d mean funding, needs >=5 finite days; momentum needs the 7d return
    const scores: Array<{ k: number; s: number }> = [];
    for (let k = 0; k < N; k++) {
      if (!Number.isFinite(vols[k][i]) || vols[k][i] <= 0) continue;
      if (mode === "long") { scores.push({ k, s: 0 }); continue; }
      if (mode === "momentum") { scores.push({ k, s: panel[k].close[i] / panel[k].close[i - 7] - 1 }); continue; }
      const w = fund[k].slice(i - 6, i + 1).filter(Number.isFinite);
      if (w.length >= 5) scores.push({ k, s: mean(w) });
    }

    const signs = new Array(N).fill(0);
    if (mode === "long") for (const { k } of scores) signs[k] = 1;
    else if (scores.length >= 6) {
      scores.sort((a, b) => a.s - b.s); // ascending: lowest funding (or weakest momentum) first
      const cut = Math.max(1, Math.floor(scores.length / 3));
      // funding book: long the LOWEST funding, short the HIGHEST. momentum book: long the HIGHEST
      // trailing return — so momentum longs come from the other end of the same sort.
      for (let j = 0; j < cut; j++) signs[scores[j].k] = mode === "funding" ? 1 : -1;
      for (let j = scores.length - cut; j < scores.length; j++) signs[scores[j].k] = mode === "funding" ? -1 : 1;
    }

    for (let k = 0; k < N; k++) {
      const sigma = vols[k][i];
      if (!Number.isFinite(sigma) || sigma <= 0) { positions[k] = 0; continue; }
      const target = signs[k] * (TARGET_VOL / sigma);
      const d = Math.abs(target - positions[k]);
      turnover += d / N;
      price[price.length - 1] -= (d * cost) / N;
      positions[k] = target;
    }
  }

  const total = score(price.map((x, j) => x + carry[j]), PPY);
  return { total, price, carry, turnover: turnover / (price.length / PPY) };
}

async function main() {
  const raw = JSON.parse(readFileSync(PRICE_CACHE, "utf8")) as Series[];
  const { cleaned } = cleanSeries(raw);
  const panel = alignPanel(cleaned);
  const n = panel[0].dates.length;

  let funding: Record<string, Record<string, number>>;
  if (existsSync(FUND_CACHE)) funding = JSON.parse(readFileSync(FUND_CACHE, "utf8"));
  else {
    funding = {};
    process.stdout.write("fetching Binance funding history ");
    for (const s of panel) {
      funding[s.symbol] = await fetchFundingDaily(s.symbol);
      process.stdout.write(".");
    }
    console.log("");
    writeFileSync(FUND_CACHE, JSON.stringify(funding));
  }

  // Align funding to the price panel by calendar day. NaN before a coin's perp listing.
  const fund = panel.map((s) => panel[0].dates.map((d) => {
    const v = funding[s.symbol]?.[dayKey(d)];
    return v === undefined ? NaN : v;
  }));

  console.log(`\n${panel.length} coins, ${n} daily bars, funding coverage per coin:`);
  for (let k = 0; k < panel.length; k++) {
    const first = fund[k].findIndex(Number.isFinite);
    console.log(`  ${panel[k].symbol.replace("USDT", "").padEnd(5)} from ${first >= 0 ? dayKey(panel[0].dates[first]) : "never"}` +
      `   mean ${pct(mean(fund[k].filter(Number.isFinite)) * 365)} /yr`);
  }

  console.log("\n═══ 1. The funding book: long lowest-funding third, short highest, weekly ═══\n");
  const book = fundingBook(panel, fund, "funding", COST);
  const priceP = score(book.price, PPY);
  const carryP = score(book.carry, PPY);
  console.log(`  ${"component".padEnd(16)} ${"ann".padStart(7)} ${"sharpe".padStart(7)}`);
  console.log(`  ${"price".padEnd(16)} ${pct(priceP.annReturn).padStart(7)} ${priceP.sharpe.toFixed(2).padStart(7)}`);
  console.log(`  ${"carry (H1)".padEnd(16)} ${pct(carryP.annReturn).padStart(7)} ${carryP.sharpe.toFixed(2).padStart(7)}   <- mechanical, receives on both legs`);
  console.log(`  ${"TOTAL".padEnd(16)} ${pct(book.total.annReturn).padStart(7)} ${book.total.sharpe.toFixed(2).padStart(7)}   maxDD ${pct(book.total.maxDrawdown)}, turnover ${book.turnover.toFixed(0)}x/yr`);

  const btc = panel.find((s) => s.symbol === "BTCUSDT")!;
  const btcDaily = btc.close.slice(30).map((c, i) => c / btc.close[29 + i] - 1);
  console.log(`  corr(total, BTC) = ${correlation(book.total.daily, btcDaily).toFixed(2)}`);

  const momo = fundingBook(panel, fund, "momentum", COST);
  console.log(`  corr(total, 1w momentum book) = ${correlation(book.total.daily, momo.total.daily).toFixed(2)}   <- is this just anti-momentum?`);

  console.log("\n═══ 2. The null for the PRICE component (H2) ═══");
  console.log("  returns shuffled (synchronized), funding kept on real dates: the signal cannot know");
  console.log("  anything about the shuffled future. carry is mechanical and needs no null.\n");
  const nulls: number[] = [];
  for (let i = 0; i < PERMUTATIONS; i++) {
    const shuffled = shufflePanel(panel, mulberry32(SEED + i * 7919), true);
    nulls.push(score(fundingBook(shuffled, fund, "funding", COST).price, PPY).sharpe);
  }
  nulls.sort((a, b) => a - b);
  const beat = nulls.filter((s) => s >= priceP.sharpe).length;
  console.log(`  real price Sharpe ${priceP.sharpe.toFixed(2)}   null mean ${mean(nulls).toFixed(2)}, range ${nulls[0].toFixed(2)}..${nulls[nulls.length - 1].toFixed(2)}`);
  console.log(`  null >= real: ${beat}/${PERMUTATIONS}  ->  p = ${((beat + 1) / (PERMUTATIONS + 1)).toFixed(3)}`);

  console.log("\n═══ 3. Sub-periods — the knife ═══\n");
  console.log(`  ${"period".padStart(12)} ${"total".padStart(7)} ${"price".padStart(7)} ${"carry".padStart(7)}   (ann)`);
  const third = Math.floor(n / 3);
  for (const [a, b] of [[0, third], [third, 2 * third], [2 * third, n]] as Array<[number, number]>) {
    const sub = panel.map((s) => ({ ...s, dates: s.dates.slice(a, b), close: s.close.slice(a, b) }));
    const subFund = fund.map((f) => f.slice(a, b));
    const r = fundingBook(sub, subFund, "funding", COST);
    const label = `${new Date(panel[0].dates[a]).getUTCFullYear()}-${new Date(panel[0].dates[b - 1]).getUTCFullYear()}`;
    console.log(`  ${label.padStart(12)} ${pct(r.total.annReturn).padStart(7)} ${pct(score(r.price, PPY).annReturn).padStart(7)} ${pct(score(r.carry, PPY).annReturn).padStart(7)}`);
  }

  console.log("\n═══ 4. BTC alone: does its own extreme funding predict its next week? ═══\n");
  const kBtc = panel.indexOf(btc);
  const rows: Array<{ f: number; fwd: number }> = [];
  for (let i = 36; i + 7 < n; i += 7) {
    const w = fund[kBtc].slice(i - 6, i + 1).filter(Number.isFinite);
    if (w.length < 5) continue;
    rows.push({ f: mean(w), fwd: btc.close[i + 7] / btc.close[i] - 1 });
  }
  const sorted = [...rows].sort((a, b) => a.f - b.f);
  const t3 = Math.floor(sorted.length / 3);
  console.log(`  ${"funding tercile".padEnd(18)} ${"mean next-week BTC return".padStart(26)}`);
  console.log(`  ${"lowest".padEnd(18)} ${pct(mean(sorted.slice(0, t3).map((r) => r.fwd))).padStart(26)}`);
  console.log(`  ${"middle".padEnd(18)} ${pct(mean(sorted.slice(t3, 2 * t3).map((r) => r.fwd))).padStart(26)}`);
  console.log(`  ${"highest".padEnd(18)} ${pct(mean(sorted.slice(2 * t3).map((r) => r.fwd))).padStart(26)}   (${rows.length} weeks)`);
  console.log("");
}

main().catch((e) => { console.error(e); process.exit(1); });
