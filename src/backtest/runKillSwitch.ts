/**
 * "I only need to profit in the short term" — the kill-switch test.
 *
 * `npm run killswitch`
 *
 * The steel-man of short-term trading: you do not need an edge that lasts forever, you need to trade
 * a signal WHILE it works and stop WHEN it dies. This is different from the persistence test in
 * runPersistence.ts — that asked whether recent winners keep winning across a cross-section. This
 * asks whether, for ONE signal with a known alive->dead history, a rolling-performance filter can
 * harvest the alive regime and sit out the dead one.
 *
 * The perfect subject is crypto 1-week cross-sectional momentum: Sharpe 1.68 in 2019-2021, then
 * -0.16 in 2024-2026 (runCryptoMom.ts). If regime changes are detectable in time to trade, a kill
 * switch that goes flat when trailing performance turns negative should beat always-on. If they are
 * not — if by the time the trailing window says "dead" the death is already priced — the switch will
 * whipsaw: exit after the good runs end, re-enter after they restart, and do no better than a coin.
 *
 * The control that stops us fooling ourselves: a RANDOM on/off schedule with the SAME duty cycle. A
 * kill switch that only helps by being flat more often (lower exposure) is not timing anything, and
 * the random-duty control will match it. The switch has to beat THAT, not just always-on.
 */

import {
  alignPanel, cleanSeries, score, shufflePanel, mulberry32, type Series, type Perf,
} from "./tsmom.js";
import { readFileSync } from "node:fs";

const CACHE = "data/crypto.json";
const SEED = 20260718;
const PPY = 365;
const TARGET_VOL = 0.40;
const VOL_COM = 60;
const COST = 0.0005;

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const weekIndex = (ms: number) => Math.floor((ms / 86_400_000 + 4) / 7);

/** Daily return stream of the crypto 1-week cross-sectional momentum book. */
function momentumStream(panel: Series[], lookback: number): number[] {
  const n = panel[0].close.length, N = panel.length;
  const rets = panel.map((s) => { const r = new Array(n).fill(0); for (let i = 1; i < n; i++) r[i] = s.close[i] / s.close[i - 1] - 1; return r; });
  const lambda = VOL_COM / (VOL_COM + 1);
  const vols = rets.map((r) => { const out = new Array(n).fill(NaN); let v = NaN, m = 0; for (let i = 1; i < n; i++) { const x = r[i - 1]; if (Number.isNaN(v)) { v = x * x; m = x; } else { m = lambda * m + (1 - lambda) * x; const d = x - m; v = lambda * v + (1 - lambda) * d * d; } out[i] = Math.sqrt(v * PPY); } return out; });
  const pos = new Array(N).fill(0);
  const daily: number[] = [];
  for (let i = lookback + 1; i < n; i++) {
    let r = 0; for (let k = 0; k < N; k++) r += pos[k] * rets[k][i]; daily.push(r / N);
    if (!(i + 1 < n && weekIndex(panel[0].dates[i + 1]) !== weekIndex(panel[0].dates[i]))) continue;
    const ranked = panel.map((s, k) => ({ k, r: s.close[i] / s.close[i - lookback] - 1 })).sort((a, b) => b.r - a.r);
    const cut = Math.max(1, Math.floor(N / 3));
    const signs = new Array(N).fill(0);
    for (let j = 0; j < cut; j++) signs[ranked[j].k] = 1;
    for (let j = N - cut; j < N; j++) signs[ranked[j].k] = -1;
    for (let k = 0; k < N; k++) { const sg = vols[k][i]; if (!Number.isFinite(sg) || sg <= 0) { pos[k] = 0; continue; } const t = signs[k] * (TARGET_VOL / sg); daily[daily.length - 1] -= (Math.abs(t - pos[k]) * COST) / N; pos[k] = t; }
  }
  return daily;
}

/** Apply a kill switch: trade tomorrow only if the trailing `win` days were net positive. */
function killSwitch(r: number[], win: number): { stream: number[]; dutyCycle: number } {
  const out = new Array(r.length).fill(0);
  let on = 0;
  for (let i = win; i < r.length; i++) {
    let trail = 0; for (let j = i - win; j < i; j++) trail += r[j];
    if (trail > 0) { out[i] = r[i]; on++; }
  }
  return { stream: out, dutyCycle: on / (r.length - win) };
}

function main() {
  const raw = JSON.parse(readFileSync(CACHE, "utf8")) as Series[];
  const panel = alignPanel(cleanSeries(raw).cleaned);
  const stream = momentumStream(panel, 7);
  const always = score(stream, PPY);

  console.log(`\ncrypto 1-week momentum, ${panel.length} coins, ${stream.length} days`);
  console.log(`  always-on: ann ${pct(always.annReturn)}, Sharpe ${always.sharpe.toFixed(2)}, maxDD ${pct(always.maxDrawdown)}`);

  console.log("\n═══ Can a kill switch harvest the alive regime and skip the dead one? ═══");
  console.log("  trade tomorrow only if the trailing window was net positive. compare to always-on,");
  console.log("  to the ANTI-switch (trade only when recently losing), and — the real bar — to a");
  console.log("  RANDOM on/off schedule with the same duty cycle (200 draws). beating always-on is easy");
  console.log("  by just being flat more; beating random-at-same-duty is what timing would look like.\n");

  console.log(`  ${"trailing win".padEnd(14)} ${"duty".padStart(6)} ${"ann".padStart(7)} ${"sharpe".padStart(7)} ${"vs always".padStart(10)} ${"random p".padStart(9)}`);
  for (const winWeeks of [4, 8, 13, 26]) {
    const win = winWeeks * 7;
    const { stream: ks, dutyCycle } = killSwitch(stream, win);
    const p = score(ks, PPY);

    // random-duty null: flip each day on with prob = dutyCycle, independent, 200 draws
    const nullSharpes: number[] = [];
    for (let s = 0; s < 200; s++) {
      const rng = mulberry32(SEED + s * 131);
      const rand = stream.map((x, i) => (i >= win && rng() < dutyCycle ? x : 0));
      nullSharpes.push(score(rand, PPY).sharpe);
    }
    nullSharpes.sort((a, b) => a - b);
    const beat = nullSharpes.filter((s) => s >= p.sharpe).length;
    const pv = (beat + 1) / 201;

    console.log(
      `  ${`${winWeeks}w`.padEnd(14)} ${pct(dutyCycle).padStart(6)} ${pct(p.annReturn).padStart(7)} ` +
      `${p.sharpe.toFixed(2).padStart(7)} ${(p.sharpe - always.sharpe >= 0 ? "+" : "") + (p.sharpe - always.sharpe).toFixed(2).padStart(9)} ` +
      `${pv.toFixed(3).padStart(9)}${pv < 0.05 ? "  *" : ""}`,
    );
  }

  console.log("\n═══ The tell: WHERE does the switch put you? ═══");
  console.log("  split the timeline into the three regimes. a working switch is ON in the alive era and");
  console.log("  OFF in the dead one. if it is on/off at the wrong times, it detects regimes too late.\n");

  const n = stream.length;
  const win = 13 * 7;
  const { stream: ks } = killSwitch(stream, win);
  const thirds: Array<[number, number, string]> = [[0, Math.floor(n / 3), "2019-2021 (alive)"], [Math.floor(n / 3), Math.floor(2 * n / 3), "2021-2024 (fading)"], [Math.floor(2 * n / 3), n, "2024-2026 (dead)"]];
  console.log(`  ${"regime".padEnd(22)} ${"always-on ann".padStart(14)} ${"switch ann".padStart(12)} ${"switch on%".padStart(11)}`);
  for (const [a, b, label] of thirds) {
    const seg = stream.slice(a, b), ksSeg = ks.slice(a, b);
    const onFrac = ksSeg.filter((x) => x !== 0).length / ksSeg.length;
    console.log(`  ${label.padEnd(22)} ${pct(score(seg, PPY).annReturn).padStart(14)} ${pct(score(ksSeg, PPY).annReturn).padStart(12)} ${pct(onFrac).padStart(11)}`);
  }
  console.log("");
}

main();
