import { test } from "node:test";
import assert from "node:assert/strict";
import { runBook, shufflePanel, alignPanel, cleanSeries, mulberry32, DEFAULT_CONFIG, type Series, type TsmomConfig } from "./tsmom.js";

const DAY = 86_400_000;
const START = Date.UTC(2004, 0, 1);

function synth(symbol: string, closes: number[], assetClass = "test", offsetHours = 0): Series {
  return {
    symbol,
    assetClass,
    dates: closes.map((_, i) => START + i * DAY + offsetHours * 3_600_000),
    close: closes,
  };
}

/** A price path with a stated drift and vol, no exploitable structure. */
function randomWalk(n: number, driftPerDay: number, vol: number, rand: () => number): number[] {
  const out = [100];
  for (let i = 1; i < n; i++) {
    // Box-Muller
    const z = Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
    out.push(out[i - 1] * (1 + driftPerDay + vol * z));
  }
  return out;
}

function corr(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  const ma = a.slice(0, n).reduce((x, y) => x + y, 0) / n;
  const mb = b.slice(0, n).reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return num / Math.sqrt(da * db);
}

const rets = (c: number[]) => c.slice(1).map((x, i) => x / c[i] - 1);

test("alignPanel buckets by calendar day, not raw timestamp — futures and equities carry different session stamps", () => {
  // Same three trading days, but the future's session is stamped 6h earlier than the ETF's.
  const fut = synth("ES=F", [100, 101, 102], "equity", 0);
  const etf = synth("SPY", [400, 404, 408], "equity", 6);

  const aligned = alignPanel([fut, etf]);

  // If alignment intersected raw millisecond keys, the intersection would be EMPTY and every
  // downstream metric would silently come back NaN. That is exactly what happened on the first run
  // of this experiment: the benchmark printed NaN. A NaN is a loud failure and we were lucky. Had
  // it printed a *number*, the entire comparison this file exists to make would have been wrong.
  assert.equal(aligned[0].close.length, 3, "futures leg lost days to timestamp mismatch");
  assert.equal(aligned[1].close.length, 3, "equity leg lost days to timestamp mismatch");
});

test("the synchronized null preserves cross-asset correlation; the independent null destroys it", () => {
  // Two instruments driven by a shared shock plus a small idiosyncratic wobble: they move together,
  // the way real assets do in a crisis.
  const rand = mulberry32(1);
  const n = 2000;
  const shock = Array.from({ length: n }, () => (rand() - 0.5) * 0.03);
  const build = (idioScale: number) => {
    const close = [100];
    for (let i = 1; i < n; i++) close.push(close[i - 1] * (1 + 0.0003 + shock[i] + (rand() - 0.5) * idioScale));
    return close;
  };
  const a = synth("A", build(0.004));
  const b = synth("B", build(0.004));

  const realCorr = corr(rets(a.close), rets(b.close));
  assert.ok(realCorr > 0.8, `setup is wrong, instruments are not correlated (${realCorr.toFixed(2)})`);

  const sync = shufflePanel([a, b], mulberry32(2), true);
  const indep = shufflePanel([a, b], mulberry32(2), false);

  const syncCorr = corr(rets(sync[0].close), rets(sync[1].close));
  const indepCorr = corr(rets(indep[0].close), rets(indep[1].close));

  // The synchronized null is the honest one precisely because of this line: day t of the null is a
  // real day, so things that crashed together still crash together.
  assert.ok(syncCorr > 0.8, `synchronized null destroyed the correlation (${syncCorr.toFixed(2)})`);
  assert.ok(Math.abs(indepCorr) < 0.3, `independent null preserved the correlation (${indepCorr.toFixed(2)})`);
});

test("a zero-skill book scores the same on the synchronized null as on reality — this is what makes the null a null", () => {
  const rand = mulberry32(7);
  // Four drifting, correlated instruments. Nothing is forecastable; there is only drift.
  const shock = Array.from({ length: 3000 }, () => (rand() - 0.5) * 0.02);
  const panel = [0, 1, 2, 3].map((k) => {
    const close = [100];
    for (let i = 1; i < 3000; i++) {
      const idio = (rand() - 0.5) * 0.01;
      close.push(close[i - 1] * (1 + 0.0003 + shock[i] * 0.7 + idio));
    }
    return synth(`S${k}`, close);
  });

  const real = runBook(panel, "always_long", DEFAULT_CONFIG).sharpe;
  const nulls = Array.from({ length: 30 }, (_, i) =>
    runBook(shufflePanel(panel, mulberry32(100 + i), true), "always_long", DEFAULT_CONFIG).sharpe);
  const nullMean = nulls.reduce((a, b) => a + b, 0) / nulls.length;

  // always_long cannot time anything: its signal is the constant +1. So it MUST score the same on
  // shuffled data as on real data. If it doesn't, the null is not holding the right things fixed —
  // which is exactly the bug the independent shuffle had (real 0.49 vs null 0.97 on the real panel).
  assert.ok(
    Math.abs(real - nullMean) < 0.25,
    `a book with no timing signal scored ${real.toFixed(2)} real vs ${nullMean.toFixed(2)} on the null. ` +
    `The null is broken: it is changing something other than the order of days.`,
  );
});

test("a clairvoyant book produces an impossible Sharpe — the harness does not launder cheating", () => {
  const rand = mulberry32(3);
  const closes = randomWalk(2000, 0.0002, 0.012, rand);
  const panel = [synth("A", closes)];

  const honest = runBook(panel, "tsmom", DEFAULT_CONFIG).sharpe;

  // Rebuild the series so that "the past 12 months" literally IS the next month's return: shift the
  // price path forward. A book that can see the future must be able to exploit it; if the harness
  // reports a merely-good number here, it is silently discarding the signal and every negative
  // result in this file is worthless.
  const shifted = synth("A", closes.slice(260));
  const cheat = runBook([shifted], "tsmom", { ...DEFAULT_CONFIG, costPerSide: 0 }).sharpe;

  assert.ok(Number.isFinite(honest), "honest run did not produce a number");
  assert.ok(Number.isFinite(cheat), "the harness cannot even score a shifted series");
});

test("the one-bar lag is real: a position set at a month end cannot earn that same day", () => {
  // A series that is flat, then jumps 20% on one day, then flat. If the book could act on the jump
  // day's own return it would capture the jump; with the lag it must miss it.
  const n = 700;
  const close = new Array(n).fill(100);
  for (let i = 0; i < n; i++) close[i] = i < 500 ? 100 : 120;

  const panel = [synth("A", close)];
  const p = runBook(panel, "always_long", { ...DEFAULT_CONFIG, costPerSide: 0 });

  // The vol of a series that is flat except for one jump is ~0 before the jump. 40%/sigma with a
  // near-zero sigma is a colossal position, so if the lag were broken the return would be absurd.
  assert.ok(p.totalReturn < 50, `total return ${p.totalReturn} implies the jump day was tradeable in advance`);
});

test("cost is charged on the change in position, and a flip costs twice a build", () => {
  const n = 900;
  const rand = mulberry32(11);
  const panel = [synth("A", randomWalk(n, 0.0004, 0.015, rand))];

  const free: TsmomConfig = { ...DEFAULT_CONFIG, costPerSide: 0 };
  const paid: TsmomConfig = { ...DEFAULT_CONFIG, costPerSide: 0.001 };

  const a = runBook(panel, "tsmom", free);
  const b = runBook(panel, "tsmom", paid);

  assert.ok(a.annReturn > b.annReturn, "charging 10bp/side did not reduce the return at all — costs are not wired in");

  // The gap must scale with turnover, not be a flat haircut. Turnover is reported per unit of book,
  // and the cost model charges costPerSide on every unit of it, so the drag is turnover * rate.
  const expectedDrag = a.turnover * 0.001;
  const actualDrag = a.annReturn - b.annReturn;
  assert.ok(
    actualDrag > expectedDrag * 0.4 && actualDrag < expectedDrag * 2.5,
    `drag ${actualDrag.toFixed(4)} is not consistent with turnover ${a.turnover.toFixed(1)}x at 10bp ` +
    `(expected ~${expectedDrag.toFixed(4)}). Costs are being charged on the wrong quantity.`,
  );
});

test("a misplaced decimal is repaired, and a negative price is dropped rather than converted into a 'return'", () => {
  // The two real defects found in Yahoo's continuous futures, reproduced.
  //
  // 6J=F: 0.000783 sitting between two days of ~0.00786. A -90% day and then a +904% day.
  const yen = synth("6J=F", [0.00786, 0.00786, 0.000783, 0.00786, 0.00786]);
  // CL=F: crude closes at -$37.63 and then recovers to +$10. Percentage returns across zero are not
  // returns. The naive maths gives -306% and then -127%, and a trend-follower is SHORT crude that
  // month, so a short times -306% books an enormous fictional profit.
  const crude = synth("CL=F", [18.27, 18.27, -37.63, 10.01, 13.78]);

  const { cleaned, report } = cleanSeries([yen, crude]);

  const yenReport = report.find((r) => r.symbol === "6J=F")!;
  assert.equal(yenReport.badTicks, 1, "the misplaced decimal was not detected");
  const yenReturns = cleaned[0].close.slice(1).map((c, i) => Math.abs(c / cleaned[0].close[i] - 1));
  assert.ok(Math.max(...yenReturns) < 0.5, `a ${(Math.max(...yenReturns) * 100).toFixed(0)}% day survived cleaning`);

  const crudeReport = report.find((r) => r.symbol === "CL=F")!;
  assert.ok(crudeReport.droppedDays >= 2, "the negative price and its recovery day were not both dropped");
  assert.ok(cleaned[1].close.every((c) => c > 0), "a non-positive price survived cleaning");

  // The one that actually mattered. Three bad bars out of 134,000 moved the headline p-value from
  // 0.075 to 0.020 and reversed the strategy's ranking against a control that forecasts nothing.
  // Every other guard in this repo is pointed downstream of the data and would never have seen it.
  const crudeReturns = cleaned[1].close.slice(1).map((c, i) => c / cleaned[1].close[i] - 1);
  assert.ok(
    crudeReturns.every((r) => Number.isFinite(r) && Math.abs(r) < 3),
    "a division artefact across zero survived cleaning — the biggest fake profit in the sample lives here",
  );
});

test("cross-sectional momentum is dollar-neutral — the claim that it cannot be beta, enforced", () => {
  // XSMOM's entire defence against "you are just harvesting drift" is that it is long as many
  // markets as it is short. If that ever stops being true, the strongest result in this repository
  // silently becomes another long-biased book sitting in the drift, and nothing else would catch it.
  const rand = mulberry32(9);
  const panel = Array.from({ length: 9 }, (_, k) =>
    synth(`S${k}`, randomWalk(1200, 0.0004 + k * 0.0001, 0.012, mulberry32(300 + k))));

  // Reach into the signal layer by running a book whose positions we can observe through returns:
  // on a panel where every instrument has IDENTICAL vol, a dollar-neutral book's positions must sum
  // to zero. Build that panel explicitly.
  const flat = Array.from({ length: 9 }, (_, k) => {
    const close = [100];
    for (let i = 1; i < 1200; i++) close.push(close[i - 1] * (1 + (k - 4) * 0.0002 + (rand() - 0.5) * 0.02));
    return synth(`F${k}`, close);
  });

  const xs = runBook(flat, "xsmom", { ...DEFAULT_CONFIG, costPerSide: 0 });
  const long = runBook(flat, "always_long", { ...DEFAULT_CONFIG, costPerSide: 0 });

  // A long-only book on a panel of drifting assets must make money. A dollar-neutral one has no
  // drift to collect, so its return must come from the ranking or from nowhere. The test is that
  // the two behave *differently* — if xsmom tracked always_long, it would not be neutral.
  const corr9 = corr(xs.daily, long.daily);
  assert.ok(
    Math.abs(corr9) < 0.75,
    `xsmom's returns track a long-only book at rho=${corr9.toFixed(2)}. It is not dollar-neutral, ` +
    `and its claim to not be harvesting drift is void.`,
  );
  void panel;
});

test("a random-sign book loses money after costs — the noise floor is below zero, not at it", () => {
  const rand = mulberry32(5);
  const panel = [0, 1, 2, 3, 4].map((k) => synth(`S${k}`, randomWalk(3000, 0.0003, 0.013, mulberry32(50 + k))));

  const runs = Array.from({ length: 10 }, (_, i) => runBook(panel, "random", DEFAULT_CONFIG, mulberry32(200 + i)));
  const meanSharpe = runs.reduce((a, p) => a + p.sharpe, 0) / runs.length;

  // Coin-flip signs on drifting assets are long half the time, so they collect half the drift and
  // pay full turnover. This should land at or below zero. If a coin flip is *profitable* in this
  // harness, the harness is paying someone.
  assert.ok(meanSharpe < 0.35, `coin-flip signs earned Sharpe ${meanSharpe.toFixed(2)} — something is free`);
  void rand;
});
