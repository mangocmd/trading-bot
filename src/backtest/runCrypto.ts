/**
 * Does the one surviving strategy survive crypto's cost structure?
 *
 * `npm run crypto`
 *
 * XSMOM is the only thing in this repository that beat its own controls. It did it on 24 traditional
 * futures, where costs are 1-3bp/side. Crypto is where every OTHER strategy in this repo went to die:
 * a 0.16% round-trip taker fee that is an order of magnitude larger, on a book that already turns
 * over ~18x a year. So this is the real test of whether XSMOM is a fact about markets or a fact about
 * cheap execution.
 *
 * Two things crypto has that traditional futures do not, and they cut opposite ways:
 *
 *   - FEES cut against it, hard. 5-16bp/side vs 1-3. On 18x turnover that is a 1.8%-5.8% annual drag.
 *   - FUNDING roughly cancels for a dollar-neutral book. Perps charge funding ~3x/day; in a bull
 *     market longs pay it and shorts receive it, so a book that is long as much as it is short is
 *     approximately funding-neutral. That is a genuine structural advantage of running crypto
 *     momentum market-neutral rather than long-only, and it is why funding is not modelled as a drag
 *     here — for THIS book it nets out. (Long-only crypto momentum would eat the funding; this does
 *     not.)
 *
 * Survivorship warning, stated before the numbers: this universe is 13 coins that still trade and
 * still have history in 2026. LUNA, FTT and the rest of the graveyard are not here. That flatters a
 * long-momentum book. It flatters a dollar-neutral one LESS, because the bias hits both legs, but it
 * does not vanish. Read every long-biased number here as an optimistic bound.
 */

import { fetchKlines } from "./fetchKlines.js";
import {
  runBook, shufflePanel, alignPanel, score, correlation, mulberry32,
  DEFAULT_CONFIG, type Series, type TsmomConfig, type Perf,
} from "./tsmom.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

const SEED = 20260715;
const PERMUTATIONS = 200;
const CACHE = "data/crypto.json";

// 13 coins with >2500 daily bars on MEXC. SOL/DOT/AVAX/MATIC/FIL lack the history and are excluded,
// which is itself a survivorship note: several of them would have been strong momentum names.
const COINS = ["BTCUSDT","ETHUSDT","BNBUSDT","XRPUSDT","ADAUSDT","DOGEUSDT","LTCUSDT","LINKUSDT","TRXUSDT","ATOMUSDT","XLMUSDT","ETCUSDT","BCHUSDT"];

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const blend = (a: number[], b: number[], w: number) => a.map((x, i) => (1 - w) * x + w * (b[i] ?? 0));

async function load(): Promise<Series[]> {
  if (existsSync(CACHE)) return JSON.parse(readFileSync(CACHE, "utf8"));
  mkdirSync("data", { recursive: true });
  const start = Date.UTC(2019, 0, 1), end = Date.now();
  const out: Series[] = [];
  for (const symbol of COINS) {
    const c = await fetchKlines(symbol, start, end, "1d");
    if (c.length < 2000) { console.log(`  skip ${symbol} (${c.length})`); continue; }
    out.push({ symbol, assetClass: "crypto", dates: c.map((k) => k.openTime), close: c.map((k) => k.close) });
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 150));
  }
  console.log("");
  writeFileSync(CACHE, JSON.stringify(out));
  return out;
}

function buyHold(s: Series, from: number): Perf {
  const daily: number[] = [];
  for (let i = from + 1; i < s.close.length; i++) daily.push(s.close[i] / s.close[i - 1] - 1);
  return score(daily, 365);
}

function nullP(panel: Series[], control: "xsmom" | "tsmom", cfg: TsmomConfig, realSharpe: number, perms = PERMUTATIONS): number {
  const nulls = Array.from({ length: perms }, (_, i) =>
    runBook(shufflePanel(panel, mulberry32(SEED + i * 7919), true), control, cfg).sharpe);
  return (nulls.filter((s) => s >= realSharpe).length + 1) / (perms + 1);
}

async function main() {
  console.log("\nloading crypto daily bars (cached after first run)");
  const rawPanel = await load();
  const panel = alignPanel(rawPanel);
  const cfg: TsmomConfig = { ...DEFAULT_CONFIG, periodsPerYear: 365 }; // crypto has no weekends; 252 here understated every Sharpe by ~17% and made "12m" mean 8.3 months

  const n = panel[0].dates.length;
  console.log(`\n${panel.length} coins, ${n} aligned bars, ` +
    `${new Date(panel[0].dates[0]).toISOString().slice(0, 10)} -> ${new Date(panel[0].dates[n - 1]).toISOString().slice(0, 10)}`);
  console.log(`  ${panel.map((s) => s.symbol.replace("USDT", "")).join(" ")}`);

  const btc = panel.find((s) => s.symbol === "BTCUSDT")!;
  const start = Math.round(cfg.lookbackMonths * cfg.periodsPerYear / 12) + 1; // same first earning bar as the books
  const btcHold = buyHold(btc, start);
  const btcDaily = btc.close.slice(start + 1).map((c, i) => c / btc.close[start + i] - 1);

  console.log("\n═══ 1. XSMOM on crypto, at 5bp/side (perp taker) ═══\n");
  const cCfg: TsmomConfig = { ...cfg, costPerSide: 0.0005 };
  const xsmom = runBook(panel, "xsmom", cCfg);
  const tsmom = runBook(panel, "tsmom", cCfg);
  const alwaysLong = runBook(panel, "always_long", cCfg);

  const betaToBtc = correlation(xsmom.daily, btcDaily);
  console.log(`  ${"book".padEnd(28)} ${"ann".padStart(7)} ${"sharpe".padStart(7)} ${"maxDD".padStart(7)} ${"corr BTC".padStart(9)}`);
  const row = (label: string, p: Perf, ref = p.daily) => console.log(
    `  ${label.padEnd(28)} ${pct(p.annReturn).padStart(7)} ${p.sharpe.toFixed(2).padStart(7)} ` +
    `${pct(p.maxDrawdown).padStart(7)} ${correlation(ref, btcDaily).toFixed(2).padStart(9)}`);
  row("XSMOM (long/short)", xsmom);
  row("TSMOM (long-biased)", tsmom);
  row("ALWAYS LONG (control)", alwaysLong);
  row("BTC buy & hold", btcHold, btcDaily);
  console.log(`\n  XSMOM turnover ${xsmom.turnover.toFixed(1)}x/yr, beta to BTC ${betaToBtc.toFixed(2)}`);

  console.log("\n═══ 2. The fee sweep — this is where crypto kills things ═══");
  console.log("  MEXC perp taker ~5bp/side; spot round-trip 16bp = 8bp/side. Traditional futures 1-3.\n");
  console.log(`  ${"bp/side".padStart(8)} ${"ann".padStart(7)} ${"sharpe".padStart(7)} ${"p vs null".padStart(10)}`);
  for (const bp of [0, 2, 5, 8, 16]) {
    const p = runBook(panel, "xsmom", { ...cfg, costPerSide: bp / 10000 });
    const pv = nullP(panel, "xsmom", { ...cfg, costPerSide: bp / 10000 }, p.sharpe, 100);
    console.log(`  ${String(bp).padStart(8)} ${pct(p.annReturn).padStart(7)} ${p.sharpe.toFixed(2).padStart(7)} ${pv.toFixed(3).padStart(10)}${pv < 0.05 ? "  *" : ""}`);
  }

  console.log("\n═══ 3. Is the ranking real, or is it beta to BTC in disguise? ═══");
  console.log("  In crypto everything correlates to BTC, so a long/short book can be dollar-neutral yet");
  console.log("  still carry BTC beta if the ranking tracks it. Two checks: the beta above, and whether");
  console.log("  a RANDOM dollar-neutral crypto book earns what XSMOM earns.\n");
  const randoms = Array.from({ length: 50 }, (_, i) => runBook(panel, "random", cCfg, mulberry32(SEED + i * 977)));
  const rSharpe = randoms.map((p) => p.sharpe).sort((a, b) => a - b);
  const beat = rSharpe.filter((s) => s >= xsmom.sharpe).length;
  console.log(`  XSMOM Sharpe ${xsmom.sharpe.toFixed(2)}`);
  console.log(`  random long/short: mean ${mean(rSharpe).toFixed(2)}, range ${rSharpe[0].toFixed(2)}..${rSharpe[rSharpe.length - 1].toFixed(2)}, beat XSMOM ${beat}/50`);
  console.log(`  ${beat <= 3 && Math.abs(betaToBtc) < 0.3
    ? "  -> dollar-neutral in risk too, and the ranking beats a coin flip."
    : beat > 3
    ? "  -> a coin flip does what the ranking does. The ranking is decoration."
    : "  -> ranking beats random, but beta to BTC is not negligible — part of the return is just BTC."}`);

  console.log("\n═══ 4. As a diversifier for a BTC holder ═══\n");
  console.log(`  ${"BTC / XSMOM".padEnd(16)} ${"ann".padStart(7)} ${"sharpe".padStart(7)} ${"maxDD".padStart(7)}`);
  for (const w of [0, 0.2, 0.4, 0.6, 1.0]) {
    const p = score(blend(btcDaily, xsmom.daily, w));
    console.log(`  ${`${((1 - w) * 100).toFixed(0)}% / ${(w * 100).toFixed(0)}%`.padEnd(16)} ${pct(p.annReturn).padStart(7)} ${p.sharpe.toFixed(2).padStart(7)} ${pct(p.maxDrawdown).padStart(7)}${w === 0 ? "  <- BTC alone" : ""}`);
  }

  console.log("\n═══ verdict ═══");
  const at5 = runBook(panel, "xsmom", { ...cfg, costPerSide: 0.0005 });
  const at5p = nullP(panel, "xsmom", { ...cfg, costPerSide: 0.0005 }, at5.sharpe, 200);
  console.log(`  At a realistic 5bp/side perp fee: Sharpe ${at5.sharpe.toFixed(2)}, ${pct(at5.annReturn)}/yr, p=${at5p.toFixed(3)}.`);
  console.log("");
}

main().catch((e) => { console.error(e); process.exit(1); });
