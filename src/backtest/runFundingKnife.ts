/**
 * The funding book, with the falling knives put back in.
 *
 * `npm run funding-knife`
 *
 * `runFunding.ts` found a funding-carry book with Sharpe 0.78 and an 11.5% max drawdown — on a
 * universe of 13 coins that SURVIVED to 2026. Its long leg buys the most-negative-funding coins,
 * which are the ones shorts are crowding, which are the ones collapsing. The survivors' universe
 * removes exactly the assets that leg is built to catch as they die. So the 11.5% is a fiction, and
 * this file measures the real number by putting the two most infamous knives back:
 *
 *   LUNA  — $17.46 -> $0.00005 over three days in May 2022. Funding on the perp went deeply negative
 *           as shorts piled in, so a funding-carry book goes LONG into the collapse.
 *   FTT   — ~$25 -> $1.43 in November 2022 as FTX failed. Same shape.
 *
 * Both are fetched capped at collapse (the LUNA ticker was later reused for Luna 2.0; splicing that
 * in would fake a +10,000,000% bar). Coins enter at listing and EXIT at death: once a held coin's
 * data ends, its loss is already booked in the prior bars and the position closes. This is the honest
 * version of the universe — the one that existed in real time, knives included.
 *
 * The comparison is survivors-only vs survivors+knives, same book, same window.
 */

import { fetchKlines } from "./fetchKlines.js";
import { cleanSeries, score, mulberry32, type Series, type Perf } from "./tsmom.js";
import { readFileSync, existsSync, writeFileSync } from "node:fs";

const PRICE_CACHE = "data/crypto.json";
const FUND_CACHE = "data/funding.json";
const DEAD_CACHE = "data/dead_coins.json";
const PPY = 365;
const TARGET_VOL = 0.40;
const VOL_COM = 60;
const COST = 0.0005;

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const weekIndex = (ms: number) => Math.floor((ms / 86_400_000 + 4) / 7);
const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * NaN-aware funding-carry book on a UNION panel: each coin's close is NaN before listing and after
 * death. A coin can be held only while its data is live; when it dies the position closes (the loss
 * is already in the prior bars). This is what lets a knife actually cut.
 */
function knifeBook(panel: Series[], fund: number[][], dates: number[]): { total: Perf; worstWeeks: Array<{ date: string; ret: number }> } {
  const n = dates.length, N = panel.length;
  const rets = panel.map((s) => {
    const r = new Array(n).fill(NaN);
    for (let i = 1; i < n; i++) {
      if (Number.isFinite(s.close[i]) && Number.isFinite(s.close[i - 1]) && s.close[i - 1] > 0) r[i] = s.close[i] / s.close[i - 1] - 1;
    }
    return r;
  });
  const lambda = VOL_COM / (VOL_COM + 1);
  const vols = rets.map((r) => {
    const out = new Array(n).fill(NaN);
    let v = NaN, m = 0;
    for (let i = 1; i < n; i++) {
      const x = r[i - 1];
      if (!Number.isFinite(x)) continue;
      if (Number.isNaN(v)) { v = x * x; m = x; }
      else { m = lambda * m + (1 - lambda) * x; const d = x - m; v = lambda * v + (1 - lambda) * d * d; }
      out[i] = Math.sqrt(v * PPY);
    }
    return out;
  });

  const positions = new Array(N).fill(0);
  const daily: number[] = [];
  const dayDates: number[] = [];

  for (let i = 30; i < n; i++) {
    let p = 0;
    for (let k = 0; k < N; k++) {
      if (positions[k] === 0) continue;
      if (Number.isFinite(rets[k][i])) {
        p += positions[k] * rets[k][i];
        const f = fund[k][i];
        if (Number.isFinite(f)) p += -positions[k] * f;
      } else {
        positions[k] = 0; // coin died while held; loss already booked, close it out
      }
    }
    daily.push(p / N);
    dayDates.push(dates[i]);

    const weekRolls = i + 1 < n && weekIndex(dates[i + 1]) !== weekIndex(dates[i]);
    if (!weekRolls) continue;

    const scores: Array<{ k: number; s: number }> = [];
    for (let k = 0; k < N; k++) {
      if (!Number.isFinite(vols[k][i]) || vols[k][i] <= 0 || !Number.isFinite(rets[k][i])) continue;
      const w = fund[k].slice(i - 6, i + 1).filter(Number.isFinite);
      if (w.length >= 5) scores.push({ k, s: mean(w) });
    }
    const signs = new Array(N).fill(0);
    if (scores.length >= 6) {
      scores.sort((a, b) => a.s - b.s);
      const cut = Math.max(1, Math.floor(scores.length / 3));
      for (let j = 0; j < cut; j++) signs[scores[j].k] = 1;                        // long lowest funding
      for (let j = scores.length - cut; j < scores.length; j++) signs[scores[j].k] = -1; // short highest
    }
    for (let k = 0; k < N; k++) {
      const sigma = vols[k][i];
      if (!Number.isFinite(sigma) || sigma <= 0 || !Number.isFinite(rets[k][i])) { positions[k] = 0; continue; }
      const target = signs[k] * (TARGET_VOL / sigma);
      daily[daily.length - 1] -= (Math.abs(target - positions[k]) * COST) / N;
      positions[k] = target;
    }
  }

  // worst weekly windows, to surface exactly when the knives cut
  const weekly: Array<{ date: string; ret: number }> = [];
  for (let i = 0; i + 7 < daily.length; i += 7) {
    let r = 1; for (let j = i; j < i + 7; j++) r *= 1 + daily[j];
    weekly.push({ date: dayKey(dayDates[i]), ret: r - 1 });
  }
  weekly.sort((a, b) => a.ret - b.ret);
  return { total: score(daily, PPY), worstWeeks: weekly.slice(0, 5) };
}

/** Build a union panel over a common date axis; each coin NaN-padded outside its life. */
function unionPanel(coins: Series[], funding: Record<string, Record<string, number>>): { panel: Series[]; fund: number[][]; dates: number[] } {
  const daySet = new Map<string, number>();
  for (const c of coins) for (const d of c.dates) daySet.set(dayKey(d), d);
  const dates = [...daySet.values()].sort((a, b) => a - b);
  const idx = new Map(dates.map((d, i) => [dayKey(d), i]));

  const panel = coins.map((c) => {
    const close = new Array(dates.length).fill(NaN);
    for (let j = 0; j < c.dates.length; j++) { const p = idx.get(dayKey(c.dates[j])); if (p !== undefined) close[p] = c.close[j]; }
    return { ...c, dates, close };
  });
  const fund = coins.map((c) => dates.map((d) => {
    const v = funding[c.symbol]?.[dayKey(d)];
    return v === undefined ? NaN : v;
  }));
  return { panel, fund, dates };
}

async function main() {
  const survivors = (JSON.parse(readFileSync(PRICE_CACHE, "utf8")) as Series[]);
  const funding = JSON.parse(readFileSync(FUND_CACHE, "utf8")) as Record<string, Record<string, number>>;

  if (!existsSync(DEAD_CACHE)) { console.error("run the fetch step first (data/dead_coins.json missing)"); process.exit(1); }
  const dead = JSON.parse(readFileSync(DEAD_CACHE, "utf8")) as { prices: Record<string, { dates: number[]; close: number[] }>; funding: Record<string, Record<string, number>> };

  const deadSeries: Series[] = Object.entries(dead.prices).map(([symbol, p]) => ({ symbol, assetClass: "crypto", dates: p.dates, close: p.close }));
  const deadFunding: Record<string, Record<string, number>> = dead.funding;

  // Survivors-only, on the union machinery (so the comparison isolates the coins, not the code).
  const sClean = cleanSeries(survivors).cleaned;
  const withoutKnives = unionPanel(sClean, funding);
  const a = knifeBook(withoutKnives.panel, withoutKnives.fund, withoutKnives.dates);

  const allSeries = cleanSeries([...survivors, ...deadSeries]).cleaned;
  const allFunding = { ...funding, ...deadFunding };
  const withKnives = unionPanel(allSeries, allFunding);
  const b = knifeBook(withKnives.panel, withKnives.fund, withKnives.dates);

  console.log("\n═══ Funding-carry book: survivors only vs survivors + LUNA + FTT ═══");
  console.log("  same book, same window; the only difference is whether the coins that DIED are present.\n");
  console.log(`  ${"universe".padEnd(26)} ${"ann".padStart(7)} ${"sharpe".padStart(7)} ${"maxDD".padStart(7)} ${"worst wk".padStart(9)}`);
  console.log(`  ${`13 survivors`.padEnd(26)} ${pct(a.total.annReturn).padStart(7)} ${a.total.sharpe.toFixed(2).padStart(7)} ${pct(a.total.maxDrawdown).padStart(7)} ${pct(a.worstWeeks[0].ret).padStart(9)}`);
  console.log(`  ${`15 (+LUNA +FTT)`.padEnd(26)} ${pct(b.total.annReturn).padStart(7)} ${b.total.sharpe.toFixed(2).padStart(7)} ${pct(b.total.maxDrawdown).padStart(7)} ${pct(b.worstWeeks[0].ret).padStart(9)}`);

  console.log("\n  worst 5 weeks WITH the knives in:");
  for (const w of b.worstWeeks) console.log(`    ${w.date}  ${pct(w.ret)}`);

  console.log(`\n  survivorship inflation: maxDD ${pct(a.total.maxDrawdown)} -> ${pct(b.total.maxDrawdown)}, ` +
    `Sharpe ${a.total.sharpe.toFixed(2)} -> ${b.total.sharpe.toFixed(2)}.`);
  console.log("");
  void mulberry32; void writeFileSync;
}

main().catch((e) => { console.error(e); process.exit(1); });
