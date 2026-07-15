/**
 * "Can I just gamble?" — quantifying what gambling actually buys you.
 *
 * `npm run gamble`
 *
 * After the search for edge comes up empty, the honest last question is: fine, no edge — can I just
 * bet anyway? Yes. Nobody can stop you. But two things are already proven elsewhere in this repo and
 * are not up for debate:
 *
 *   - Position sizing cannot change the SIGN of expected value (martingale study: 80.5% ruin on a
 *     fair game; doubling down is Kelly in reverse). It only reshapes HOW you lose.
 *   - Zero/negative EV + repeated betting -> ruin probability approaches 1 the longer you play.
 *
 * What this file adds is the thing that explains why people gamble on trading anyway: a zero-edge,
 * high-variance process manufactures winning streaks that FEEL exactly like skill. This is the
 * mechanism that fooled hermes, the AI dispatcher, and every master strategy in this project. Here it
 * is as a number.
 *
 * 10,000 gamblers. 50% win rate (ZERO edge, by construction). Crypto-scale daily volatility. Real
 * round-trip cost per bet. One year of daily bets. Swept across bet size. Contrasted with the ONE
 * positive-EV bet a retail participant actually has: holding the index.
 */

import { mulberry32 } from "./tsmom.js";

const SEED = 20260719;
const PATHS = 10_000;
const DAYS = 365;
const DAILY_VOL = 0.04;   // ~4%/day, crypto-scale
const COST = 0.0010;      // 10bp round-trip per daily bet — active trading is not free
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** One gambler: each day, stake fraction f of capital on a zero-edge bet, pay cost on the stake. */
function gamble(f: number, rand: () => number): { terminal: number; peak: number; ruined: boolean } {
  let cap = 1, peak = 1;
  for (let d = 0; d < DAYS; d++) {
    // zero-edge: symmetric outcome, magnitude ~ daily vol; cost charged on the staked notional
    const z = (rand() < 0.5 ? -1 : 1) * DAILY_VOL * (0.5 + rand()); // random magnitude, mean ~DAILY_VOL
    cap *= 1 + f * z - f * COST;
    if (cap <= 0.01) return { terminal: 0, peak, ruined: true };
    peak = Math.max(peak, cap);
  }
  return { terminal: cap, peak, ruined: cap < 0.5 };
}

/** Buy-and-hold the index: positive drift (the equity risk premium is real), no per-bet cost. */
function hold(rand: () => number): number {
  let cap = 1;
  const driftPerDay = 0.08 / 252, vol = 0.18 / Math.sqrt(252);
  for (let d = 0; d < 252; d++) {
    const z = Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
    cap *= 1 + driftPerDay + vol * z;
  }
  return cap;
}

function pctile(xs: number[], p: number): number { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(p * s.length)]; }
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function main() {
  console.log(`\n${PATHS.toLocaleString()} gamblers, ${DAYS} daily bets, 50% win rate (ZERO edge), ` +
    `${pct(DAILY_VOL)} daily vol, ${pct(COST)} cost/bet\n`);

  console.log(`  ${"bet size".padEnd(12)} ${"median end".padStart(11)} ${"mean end".padStart(9)} ${"ruined".padStart(8)} ${"ended up".padStart(9)} ${"peaked +20%".padStart(12)}`);
  for (const f of [0.05, 0.1, 0.25, 0.5, 1.0]) {
    const rng = mulberry32(SEED + Math.round(f * 1000));
    const runs = Array.from({ length: PATHS }, () => gamble(f, rng));
    const term = runs.map((r) => r.terminal);
    const ruined = runs.filter((r) => r.ruined).length / PATHS;
    const up = runs.filter((r) => r.terminal > 1).length / PATHS;
    const feltRich = runs.filter((r) => r.peak >= 1.2).length / PATHS;
    console.log(
      `  ${`${(f * 100).toFixed(0)}% / bet`.padEnd(12)} ${pct(pctile(term, 0.5) - 1).padStart(11)} ${pct(mean(term) - 1).padStart(9)} ` +
      `${pct(ruined).padStart(8)} ${pct(up).padStart(9)} ${pct(feltRich).padStart(12)}`,
    );
  }

  console.log("\n  read the last two columns together: with ZERO edge, a large share of gamblers are");
  console.log("  UP at some point (peaked +20%) and a meaningful share END up — pure luck, and every");
  console.log("  one of them will feel like it was skill and size up right before the mean reverts.");

  console.log("\n═══ The one positive-EV bet a retail participant actually has ═══\n");
  const rng = mulberry32(SEED + 7);
  const holds = Array.from({ length: PATHS }, () => hold(rng));
  console.log(`  buy & hold the index (1 year, +8%/yr drift, 18% vol, no per-bet cost):`);
  console.log(`    median end ${pct(pctile(holds, 0.5) - 1)}, mean end ${pct(mean(holds) - 1)}, ` +
    `ended up ${pct(holds.filter((x) => x > 1).length / PATHS)}, ruined ${pct(holds.filter((x) => x < 0.5).length / PATHS)}`);

  console.log("\n  this is the whole answer: the ONLY bet with positive expected value is owning the drift.");
  console.log("  it is 'gambling' too — you can lose a third of it in a year — but the coin is weighted");
  console.log("  in your favour instead of against it. everything clever this repo tested was a way of");
  console.log("  paying costs to move OFF that weighted coin onto a fair or unfair one.\n");
}

main();
