/**
 * "Grow the account fast, then turn conservative." — what that plan actually produces.
 *
 * `npm run growthensafe`
 *
 * This is the most seductive plan in retail: bet aggressively to multiply a small account, then
 * de-risk once it is big. It sounds like a plan. It is a bet-sizing schedule laid on top of whatever
 * edge you have — and this repo has established the edge is ~0. On a zero-edge process, "grow fast
 * then get safe" has a fully determined outcome distribution, and it is computed here rather than
 * hoped at.
 *
 * Three things are measured, and the third is the one worth keeping:
 *
 *   1. THE OUTCOME DISTRIBUTION. Start at 1. Bet L-levered, zero-edge, crypto-scale vol, until you
 *      either hit a target multiple M or are wiped out; then hold the index. Run 20,000 accounts.
 *      Report the odds you actually face.
 *
 *   2. BOLD vs TIMID (Dubins-Savage). If you INSIST on reaching a target with a negative-edge bet,
 *      the math is counterintuitive and firm: bet as BIG as possible, as FEW times as possible.
 *      Timid play (many small bets) hands the house its edge on every one and drives P(target) down.
 *      Grinding a small account with frequent trades is the worst possible way to try to multiply it.
 *
 *   3. THE VERSION THAT IS ACTUALLY RATIONAL. "Aggressive early, conservative later" is a real,
 *      defensible plan — but only when the aggression is on BETA (the one positive-EV bet), not on a
 *      nonexistent trading edge. Lever the INDEX while your account is small relative to your future
 *      savings, de-risk as it grows. That is lifecycle investing, and it is simulated last.
 */

import { mulberry32 } from "./tsmom.js";

const SEED = 20260722;
const PATHS = 20_000;
const DAYS = 730;         // two years to hit the target or blow up
const DAILY_VOL = 0.04;   // crypto-scale
const COST = 0.0010;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const gauss = (rng: () => number) => Math.sqrt(-2 * Math.log(rng() || 1e-12)) * Math.cos(2 * Math.PI * rng());

/** Aggressive zero-edge phase until wealth hits M or floor, then hold the index (positive drift). */
function growThenSafe(L: number, M: number, rng: () => number): { terminal: number; hitTarget: boolean; ruined: boolean } {
  let cap = 1; let safe = false;
  const idxDrift = 0.08 / 252, idxVol = 0.18 / Math.sqrt(252);
  for (let d = 0; d < DAYS; d++) {
    if (!safe) {
      const z = (rng() < 0.5 ? -1 : 1) * DAILY_VOL * (0.5 + rng()); // zero edge
      cap *= 1 + L * z - L * COST;
      if (cap <= 0.05) return { terminal: 0, hitTarget: false, ruined: true };
      if (cap >= M) safe = true; // reached target -> switch to conservative index hold
    } else {
      cap *= 1 + idxDrift + idxVol * gauss(rng);
    }
  }
  return { terminal: cap, hitTarget: safe, ruined: cap < 0.5 };
}

/** Reach 2x from 1x with a negative-edge even-money bet, in `nBets` equal stakes. Bold = 1 bet. */
function toTargetInNBets(winProb: number, nBets: number, rng: () => number): boolean {
  let cap = 1; const stake = 1 / nBets; // stake a fixed fraction of the ORIGINAL bankroll
  for (let i = 0; i < nBets * 4 && cap > 1e-9; i++) {
    if (cap >= 2) return true;
    const bet = Math.min(stake, cap);
    cap += rng() < winProb ? bet : -bet;
  }
  return cap >= 2;
}

function main() {
  console.log(`\n${PATHS.toLocaleString()} accounts, aggressive phase = zero-edge, ${pct(DAILY_VOL)} daily vol, ` +
    `${pct(COST)} cost/bet, then hold the index once the target is hit.\n`);

  console.log("═══ 1. 'Grow to M then get safe' — the odds you actually face ═══\n");
  console.log(`  ${"leverage".padEnd(10)} ${"target".padStart(7)} ${"hit target".padStart(11)} ${"ruined".padStart(8)} ${"median end".padStart(11)} ${"mean end".padStart(9)}`);
  for (const L of [1, 3, 5]) {
    for (const M of [3, 10]) {
      const rng = mulberry32(SEED + L * 100 + M);
      const runs = Array.from({ length: PATHS }, () => growThenSafe(L, M, rng));
      console.log(
        `  ${`${L}x`.padEnd(10)} ${`${M}x`.padStart(7)} ${pct(runs.filter((r) => r.hitTarget).length / PATHS).padStart(11)} ` +
        `${pct(runs.filter((r) => r.ruined).length / PATHS).padStart(8)} ${pct(median(runs.map((r) => r.terminal)) - 1).padStart(11)} ` +
        `${pct(mean(runs.map((r) => r.terminal)) - 1).padStart(9)}`);
    }
  }
  console.log("\n  the higher the target and the leverage, the more of the population is wiped out reaching");
  console.log("  for it. mean end is dragged down by ruin; median end shows the typical account bleeds.");

  console.log("\n  for contrast, the same money just held in the index for two years:");
  const rng = mulberry32(SEED + 999);
  const hold = Array.from({ length: PATHS }, () => { let c = 1; for (let d = 0; d < DAYS; d++) c *= 1 + 0.08 / 252 + (0.18 / Math.sqrt(252)) * gauss(rng); return c; });
  console.log(`    index hold: median ${pct(median(hold) - 1)}, mean ${pct(mean(hold) - 1)}, ruined ${pct(hold.filter((x) => x < 0.5).length / PATHS)}`);

  console.log("\n═══ 2. If you insist: bold beats timid to a target (Dubins-Savage) ═══");
  console.log("  reach 2x from 1x with an even-money bet that wins 49% (the house edge = costs).");
  console.log("  bold play = one big bet. timid = many small ones. counterintuitive but firm:\n");
  console.log(`  ${"# of bets".padStart(10)} ${"P(reach 2x)".padStart(12)}`);
  for (const nBets of [1, 2, 5, 20, 100]) {
    const r = mulberry32(SEED + nBets * 17);
    const hits = Array.from({ length: PATHS }, () => toTargetInNBets(0.49, nBets, r)).filter(Boolean).length;
    console.log(`  ${String(nBets).padStart(10)} ${pct(hits / PATHS).padStart(12)}`);
  }
  console.log("\n  every extra bet pays the edge again. grinding a small account with frequent trades is");
  console.log("  the WORST way to multiply it. if the goal is truly 'reach the target,' bet it once.");
  console.log("  (this is not advice to gamble — it is what the math says the least-bad gamble is.)");

  console.log("\n═══ 3. The rational version: aggression on BETA, not on a trading edge ═══");
  console.log("  'aggressive early, conservative later' is real — as lifecycle investing. lever the");
  console.log("  INDEX (positive EV) while the account is small vs your future savings; de-risk as it");
  console.log("  grows. simulated: 2x index for the first year, 1x after, vs 1x throughout.\n");
  const rLife = mulberry32(SEED + 4242); // one stream across all paths, or every path is identical
  const lifecycle = Array.from({ length: PATHS }, () => {
    let c = 1;
    for (let d = 0; d < DAYS; d++) { const L = d < 365 ? 2 : 1; c *= 1 + L * (0.08 / 252) - (L - 1) * (0.05 / 252) + L * (0.18 / Math.sqrt(252)) * gauss(rLife); }
    return c;
  });
  const r2 = mulberry32(SEED + 4243);
  const flat = Array.from({ length: PATHS }, () => { let c = 1; for (let d = 0; d < DAYS; d++) c *= 1 + 0.08 / 252 + (0.18 / Math.sqrt(252)) * gauss(r2); return c; });
  console.log(`  2x-index year 1 then 1x: median ${pct(median(lifecycle) - 1)}, mean ${pct(mean(lifecycle) - 1)}, worst 5% ${pct([...lifecycle].sort((a, b) => a - b)[Math.floor(PATHS * 0.05)] - 1)}`);
  console.log(`  1x index throughout:     median ${pct(median(flat) - 1)}, mean ${pct(mean(flat) - 1)}, worst 5% ${pct([...flat].sort((a, b) => a - b)[Math.floor(PATHS * 0.05)] - 1)}`);
  console.log("\n  note what leverage does even to the POSITIVE-EV bet: HIGHER mean (the edge is real) but");
  console.log("  LOWER median and a much fatter left tail (vol drag eats the typical outcome). over two");
  console.log("  years it is not a clean win. its real justification is decades-long time diversification");
  console.log("  plus income to fund the tail — but it is still the ONLY 'grow fast then get safe' whose");
  console.log("  aggression is pointed at a coin weighted your way instead of against you.\n");
}

main();
