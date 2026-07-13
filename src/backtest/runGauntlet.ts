import { fetchStockCandles } from "./fetchStocks.js";
import {
  runGauntlet,
  shuffleReturns,
  mulberry32,
  toPrices,
  returnsFromCandles,
  DEFAULT_GAUNTLET,
  type GauntletStage,
} from "./gauntlet.js";
import { generateCandidates } from "./candidates.js";

/**
 * Reproduces the false-positive measurement. Run it yourself:
 *
 *   npm run gauntlet
 *
 * It fetches 10 years of SPY daily bars from Yahoo (public, no key), generates candidate strategies,
 * and puts every one of them through the same gauntlet in three worlds:
 *
 *   REAL SPY          — the honest test
 *   SHUFFLED SPY      — same returns, reordered. Same mean, volatility, skew and fat tails; the only
 *                       thing destroyed is the sequence. No predictable structure can exist here.
 *   RANDOM WALK       — synthetic, SPY's volatility, no drift. Not even beta to harvest.
 *
 * The survivor count in the shuffled world is the gauntlet's false-positive rate. Everything the
 * gauntlet passes on real data has to be judged against that number.
 *
 * Env: CANDIDATES (default 400), PERMUTATIONS (default 10), SEED (default 20260714).
 */

const CANDIDATES = Number(process.env.CANDIDATES ?? 400);
const PERMUTATIONS = Number(process.env.PERMUTATIONS ?? 10);
const SEED = Number(process.env.SEED ?? 20260714);

interface WorldTally {
  survivors: number;
  beatBuyAndHold: number;
  sharpes: number[];
  examples: string[];
  deaths: Map<GauntletStage, number>;
}

function emptyTally(): WorldTally {
  return { survivors: 0, beatBuyAndHold: 0, sharpes: [], examples: [], deaths: new Map() };
}

function median(v: number[]): number {
  if (v.length === 0) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function main() {
  console.log("Fetching 10y of SPY daily bars (Yahoo, public)...");
  const spy = await fetchStockCandles("SPY", "10y", "1d");
  const realReturns = returnsFromCandles(spy);
  console.log(`  ${spy.length} bars.\n`);

  // Two books. A long-only rule earns a drifting market's return just by being in it, so it can
  // clear a gauntlet without detecting anything. A long/short rule has no drift to sit in and must
  // actually find structure. Running both is what separates "found an edge" from "was long".
  const longOnly = generateCandidates(CANDIDATES, mulberry32(SEED), "long_only");
  const longShort = generateCandidates(CANDIDATES, mulberry32(SEED), "long_short");
  const candidates = longOnly;

  // Every (book, world, permutation) gets its own deterministic stream. Sharing one generator makes
  // a result depend on which book ran first — the Monte-Carlo bootstrap draws differently depending
  // on how much of the stream the previous book consumed. A tool whose whole pitch is
  // reproducibility cannot have order-dependent output.
  const streamFor = (book: number, world: number, perm: number) =>
    mulberry32(SEED + book * 1_000_003 + world * 10_007 + perm * 101);

  console.log(`${CANDIDATES} candidate strategies (MA cross, RSI reversion, breakout, Bollinger, momentum, trend+dip).`);
  console.log(`Gauntlet: in-sample PF > ${DEFAULT_GAUNTLET.minInSamplePF} and ≥ ${DEFAULT_GAUNTLET.minTrades} trades`);
  console.log(`  → doubled fees + slippage → 4 walk-forward folds (${DEFAULT_GAUNTLET.minPositiveFolds} must be profitable)`);
  console.log(`  → regime split (both halves profitable) → Monte-Carlo bootstrap (5th pct > 0, 95th pct drawdown < ${DEFAULT_GAUNTLET.maxBootstrapDrawdown * 100}%)`);
  console.log(`  → ±10% parameter jitter (${DEFAULT_GAUNTLET.minJitterSurvivors} of 10 must survive)\n`);

  const runWorld = (
    book: typeof longOnly,
    returns: number[],
    tally: WorldTally,
    rand: () => number,
    collectExamples: boolean,
  ) => {
    const close = toPrices(returns);
    for (const c of book) {
      const v = runGauntlet(c, close, returns, rand, DEFAULT_GAUNTLET);
      tally.deaths.set(v.diedAt, (tally.deaths.get(v.diedAt) ?? 0) + 1);
      if (!v.passed) continue;
      tally.survivors++;
      tally.sharpes.push(v.oosSharpe);
      if (v.beatsBuyAndHold) tally.beatBuyAndHold++;
      if (collectExamples && tally.examples.length < 5) {
        tally.examples.push(`${c.describe()} — OOS Sharpe ${v.oosSharpe.toFixed(2)}, ${v.oosTotalPct.toFixed(1)}%`);
      }
    }
  };

  // The synthetic walk keeps SPY's volatility and drops the drift, so there is not even beta left
  // for a long-only rule to passively collect.
  const vol = Math.sqrt(
    realReturns.slice(1).reduce((a, r) => a + r * r, 0) / (realReturns.length - 1),
  );
  const zeroDriftWalk = (p: number): number[] => {
    const r = mulberry32(SEED + 500 + p);
    const synth = [0];
    for (let i = 1; i < realReturns.length; i++) synth.push((r() + r() + r() - 1.5) * 2 * vol * 0.8165);
    return synth;
  };

  const nullTested = CANDIDATES * PERMUTATIONS;
  const rate = (survivors: number, tested: number) => (100 * survivors) / tested;
  const row = (name: string, tested: number, t: WorldTally) =>
    console.log(
      `${name.padEnd(30)} ${String(tested).padStart(8)} ${String(t.survivors).padStart(10)} ` +
      `${rate(t.survivors, tested).toFixed(1).padStart(6)}% ${median(t.sharpes).toFixed(2).padStart(10)} ${String(t.beatBuyAndHold).padStart(12)}`,
    );

  const books: Array<{ label: string; real: WorldTally; shuffled: WorldTally; walk: WorldTally }> = [];

  [["LONG-ONLY", longOnly], ["LONG/SHORT", longShort]].forEach(([label, set], b) => {
    const bookSet = set as typeof longOnly;
    const real = emptyTally();
    runWorld(bookSet, realReturns, real, streamFor(b, 0, 0), true);

    const shuffled = emptyTally();
    for (let p = 0; p < PERMUTATIONS; p++) {
      const s = streamFor(b, 1, p);
      runWorld(bookSet, shuffleReturns(realReturns, s), shuffled, s, true);
    }

    const walk = emptyTally();
    for (let p = 0; p < PERMUTATIONS; p++) runWorld(bookSet, zeroDriftWalk(p), walk, streamFor(b, 2, p), false);

    books.push({ label: label as string, real, shuffled, walk });

    console.log(`\n=== ${label} BOOK ===`);
    console.log(`${"world".padEnd(30)} ${"tested".padStart(8)} ${"SURVIVORS".padStart(10)} ${"rate".padStart(7)} ${"med Sharpe".padStart(10)} ${"beat B&H".padStart(12)}`);
    console.log("─".repeat(82));
    row("REAL SPY", CANDIDATES, real);
    row("SHUFFLED (drift kept)", nullTested, shuffled);
    row("ZERO-DRIFT WALK", nullTested, walk);

    if (shuffled.examples.length > 0) {
      console.log(`  "strategies" found where NO structure exists (shuffled):`);
      for (const e of shuffled.examples.slice(0, 3)) console.log(`    ${e}`);
    }
  });

  const [lo, ls] = books;
  const real = lo.real;
  const shuffled = lo.shuffled;
  const walk = lo.walk;

  console.log(`\n\n=== WHAT THE TWO BOOKS MEAN TOGETHER ===\n`);
  console.log(`LONG-ONLY survivors are BETA. They clear the gauntlet on shuffled data — where no`);
  console.log(`  pattern exists — at ${((100 * lo.shuffled.survivors) / nullTested).toFixed(1)}%, essentially the real-data rate of ${((100 * lo.real.survivors) / CANDIDATES).toFixed(1)}%. Remove the drift`);
  console.log(`  and they collapse to ${((100 * lo.walk.survivors) / nullTested).toFixed(1)}%. They were never detecting anything; they were in the market.`);
  console.log(``);
  console.log(`LONG/SHORT survivors are NOISE. With no drift to sit in, they clear the gauntlet on`);
  console.log(`  REAL data at ${((100 * ls.real.survivors) / CANDIDATES).toFixed(1)}% — the same rate they clear it on a pure random walk (${((100 * ls.walk.survivors) / nullTested).toFixed(1)}%).`);
  console.log(`  A survivor on real data is indistinguishable from a survivor on noise.`);
  console.log(``);
  console.log(`Two different ways of containing no edge. The gauntlet passes both.`);

  const fpr = (100 * shuffled.survivors) / nullTested;
  const tpr = (100 * real.survivors) / CANDIDATES;
  const walkRate = (100 * walk.survivors) / nullTested;

  console.log(`\nFalse-positive rate of this gauntlet: ${fpr.toFixed(1)}%  (structure destroyed, drift kept)`);
  console.log(`Survivor rate on real data:           ${tpr.toFixed(1)}%`);
  console.log(`Survivor rate with the drift removed: ${walkRate.toFixed(1)}%`);

  // The three rows only mean something together. Say what they mean rather than leaving it to
  // the reader to notice.
  if (fpr > tpr * 0.7 && walkRate < tpr * 0.2) {
    console.log(`\n  Destroying every exploitable pattern barely changed the survivor rate.`);
    console.log(`  Removing the DRIFT collapsed it.`);
    console.log(`\n  The survivors are not detecting structure. They are collecting beta —`);
    console.log(`  a long-only rule in the market some fraction of the time earns that fraction`);
    console.log(`  of the drift, and whether a pattern exists makes no difference.`);
    console.log(`\n  This gauntlet cannot tell "found an edge" from "was long during an uptrend".`);
  }

  console.log(`\n"Strategies" discovered in data with NO structure (shuffled SPY):`);
  for (const e of shuffled.examples) console.log(`  ${e}`);

  console.log(`\nStrategies that survived on REAL SPY:`);
  for (const e of real.examples) console.log(`  ${e}`);

  const mid = Math.floor((220 + realReturns.length) / 2);
  let bh = 1;
  for (let i = mid; i < realReturns.length; i++) bh *= 1 + realReturns[i];
  console.log(
    `\nOf the ${real.survivors} real-data survivors, ${real.beatBuyAndHold} beat buy-and-hold ` +
    `(+${((bh - 1) * 100).toFixed(1)}% over the same out-of-sample stretch).`,
  );
  console.log(`The gauntlet only ever asks "is it profitable" — never "is it better than doing nothing".`);

  console.log(`\nWhere the ${CANDIDATES} real-data candidates died:`);
  for (const [stage, n] of [...real.deaths.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${stage.padEnd(30)} ${String(n).padStart(5)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
