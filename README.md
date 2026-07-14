# There are no profitable strategies in this repository

That is not modesty. It is the finding.

This is the record of about three months spent trying to make retail algorithmic trading work — 18
classic "master" systems, academic replications, machine-learning models, LLMs reading charts, LLMs
choosing between strategies, market making, funding-rate arbitrage, variance risk premium, martingale
and grid bots, and an exhaustive sweep of every candlestick pattern that eleven features can express.
Almost all of it failed. The parts that did not fail turned out, on inspection, to be measuring
something other than what they appeared to measure.

The code is here so you can check that. Every number below is reproducible from this repository.

If you came looking for a strategy to run, close the tab.

**What's actually here, in descending order of how much it is worth your time:**

1. **The experiment that refuted me, and then unrefuted itself when I checked the data.** I tested
   diversified futures trend-following (24 markets, four asset classes, 22 years) and got **p =
   0.020** — real timing skill, contradicting a claim this README led with. I wrote it up and
   published it. Then I went looking for impossible numbers in the price series and found **three bad
   bars out of 134,000**. Removing them moved the result to **p = 0.075**, and flipped the strategy
   from beating a no-forecast control to losing to it. The refutation *was the bad data.* Both
   versions are printed side by side by `npm run tsmom`. This is the most useful thing in the
   repository and it is not a finding about markets.
2. **A false-positive measurement for a strategy-validation gauntlet**, with runnable code. On
   *shuffled* SPY returns — no exploitable structure by construction — **4.7% of long-only candidates
   still cleared** walk-forward, Monte-Carlo, doubled costs and parameter jitter. Letting the same
   candidates short took survival to **0.0%**. The statistics here are **not novel** — Timothy Masters
   wrote a book about it. What's on offer is the measurement, done, in code you can run.
3. **Two LLM experiments I have not seen run anywhere else.** An LLM reading 240 anonymized charts got
   **43.3%** directional accuracy — worse than a coin flip — and **0%** on the nine calls it made at
   high confidence. An LLM choosing which strategy to run each month, over 107 live decisions, landed
   in the **36th percentile of 200 random pickers**. Buy-and-hold beat it 3x.
4. **A permutation sweep of every candlestick pattern eleven features can express** (753 of them).
   Direction: 3.0% "significant" on real data vs 3.2% on shuffled — indistinguishable. Volatility:
   69.4% vs 5.4% — overwhelming. *Volatility clusters; direction doesn't*, measured directly. Item 1
   is the closest anything came to overturning this, and on clean data it does not (p = 0.075).

---

## The thing worth stealing: your gauntlet has a false-positive rate, and you probably haven't measured it

### First, credit where it belongs

**None of the statistics here is new, and I want that stated before anything else.** Permutation
testing for trading systems is a solved problem with a literature:

- **Timothy Masters, *Permutation and Randomization Tests for Trading System Development* (2020)** —
  an entire book, with C++ implementations. It covers testing for overfitting, separating luck from
  skill, removing selection bias when screening indicators, and — precisely the thing measured below —
  **testing the reliability of a "trading system factory."** If you only read one thing on this, read
  that instead of this README.
- **Halbert White, *A Reality Check for Data Snooping* (2000)** — the foundational multiple-testing
  correction for exactly this problem.
- **Bailey & López de Prado, *The Deflated Sharpe Ratio* (2014)**, and their work on the **Probability
  of Backtest Overfitting** — the standard analytic corrections for selection bias across N trials.

So this repository does not present a discovery. It presents a **measurement** — the standard test,
run against a modern, realistic gauntlet, with runnable code — plus one demonstration (the long/short
diagonal below) that made the beta problem visceral for me in a way the theory did not.

### The gap between knowing and doing

Serious quant projects put candidate strategies through a gauntlet designed to kill them: walk-forward
out-of-sample folds, doubled fees and slippage, Monte-Carlo bootstrap on the trade sequence, regime
splits, parameter jitter. That discipline is real, and it kills most candidates.

It does not solve multiple testing. A gauntlet raises the bar noise has to clear. It does not stop
noise from clearing it — and a generator proposing unlimited candidates (an LLM, a grid search, a
bored human) will clear any fixed bar eventually. **Without a null distribution, a gauntlet cannot
distinguish a survivor from a lucky fraud.**

Almost everyone in this field can recite that. Very few have run the number for their own pipeline.
This is the number, for a gauntlet close to what people actually run.

```bash
npm install
npm run gauntlet
```

400 candidate strategies (moving-average crossovers, RSI reversion, channel breakouts, Bollinger
dips, momentum, trend+dip combos), one gauntlet, three worlds, two books, 10 years of SPY daily bars.

**If you read one thing, read this:** on the *same* data with *no exploitable structure in it*, and
the *same* gauntlet, allowing candidates to short takes the survival rate from **4.7% to 0.0%**. The
survivors weren't finding an edge. They were sitting in the drift.

| book | real SPY | **shuffled SPY**<br>(drift kept, structure destroyed) | **zero-drift walk**<br>(drift removed too) | beat buy & hold |
|---|---|---|---|---|
| **long-only** | 4.0% | **4.7%** | **0.0%** | **0 of 16** |
| **long/short** | 0.5% | **0.0%** | 0.1% | **0 of 2** |

**The shuffled column is the control.** Shuffling preserves the mean, the volatility, the skew and
the fat tails — it is literally the same returns in a different order. The only thing destroyed is
the *sequence*, which is the only thing a strategy could possibly exploit. No pattern can exist there,
by construction.

The gauntlet passed candidates there anyway, and they look like real edges:

```
MA cross 5/45  — OOS Sharpe 1.12, +88.6%     ← found in data with no structure
momentum 65d   — OOS Sharpe 1.01, +74.5%     ← found in data with no structure
```

Both cleared walk-forward validation, Monte-Carlo bootstrap, doubled costs and ±10% parameter jitter,
in a world where there was nothing to find.

### The diagonal is the proof

Look at the shuffled column across the two books. **Same data. Same gauntlet. One difference: whether
shorting is allowed.**

- long-only: **4.7% survive**
- long/short: **0.0% survive**

There is nothing to find in that data. So the only thing the long-only survivors can be doing is
**sitting in the drift** — and the moment you let them short, the drift cancels and they vanish.

The zero-drift column confirms it from the other side: remove the drift from the world entirely and
long-only survivors go to **0.0%**. Not lower. Zero, out of four thousand.

> **A gauntlet cannot tell "found an edge" from "was long during an uptrend."** Every stage in it —
> the folds, the bootstrap, the jitter — tests whether a result is *stable*. Passive exposure to a
> drifting market is extremely stable. It sails through.

So there are two different ways to contain no edge, and this gauntlet passes both:

- **Long-only survivors are beta.** They die the instant the drift is removed.
- **Long/short survivors are noise.** They clear the gauntlet on real data (0.5%) at the same rate
  they clear it on a pure random walk (0.1%). Both numbers are the floor.

And **not one survivor in either book beat buy-and-hold** (+60.6% over the same stretch). Of course
not — the long-only ones are partial-exposure buy-and-hold that also paid fees. **The gauntlet only
ever asks "is it profitable" — never "is it better than doing nothing."**

*On the numbers:* the survivor **rates** carry seed noise — the shuffled long-only rate moved between
roughly 2% and 6% across seeds while this was being built. Don't quote them to one decimal place.
What is stable, and what the argument rests on, is the **shape**: shuffled ≈ real for long-only, zero
once the drift is gone, long/short at the noise floor everywhere, and nothing anywhere beating
buy-and-hold.

### Do this to your own pipeline

```ts
import { nullTest, shuffleReturns, mulberry32 } from "./src/backtest/gauntlet.js";

// Your candidates, your gauntlet, your data — but with the structure destroyed.
const result = nullTest(yourCandidates, yourReturns, 10, mulberry32(1));
console.log(result.falsePositiveRate);   // ← the number that makes your gauntlet mean something
```

Two checks, in order of how much they will hurt:

1. **Run the null.** If your real-data survivor rate is not far above your shuffled-data rate, your
   survivors are noise. Tighten the gauntlet until the false-positive rate is near zero, then see
   what's left.
2. **Then let them short.** If your long-only survivors disappear when shorting is allowed, they were
   never strategies. They were exposure.

Both are cheap to run and neither is optional. `shuffleReturns()` is six lines — the whole idea is
six lines. That's what makes it worth adding.

---

## What else was tested, and what happened

| direction | result |
|---|---|
| 18 classic master systems (Turtle, Elder, Donchian, Keltner, Connors RSI2, MACD, golden cross, Faber, …) | out-of-sample median Sharpe **−0.82**; 2 of 17 positive |
| in-sample rank as a predictor of out-of-sample rank | **inverted.** The in-sample winner (SMA20, Sharpe 1.18) finished 8th of 10 out-of-sample. The out-of-sample winner finished 8th in-sample. |
| an LLM reading 240 anonymized charts (prices normalized, tickers and dates hidden) | **43.3%** directional accuracy — worse than a coin flip (z = −2.07). At self-reported high confidence: **0%** (n=9). |
| an LLM choosing which strategy to run each month (107 live decisions) | landed in the **36th percentile** of 200 random pickers. Buy-and-hold beat it by 3x. |
| a cross-sectional ML model (ridge, 90 stocks, 10 years) | apparent +30.7%/yr. Removing the hindsight mega-winners from the universe collapsed the edge from +16.5 points to **−0.1**. It had no selection skill; it had my survivorship bias. |
| every candlestick pattern 11 features can express (753 patterns, permutation-controlled) | direction: **3.0%** "significant" on real data vs **3.2%** on shuffled data — indistinguishable. Volatility: **69.4%** vs **5.4%** — real, and strongly so. |
| market making | MEXC real spreads (BTC 0.00002%, DOGE 0.0139%) vs 0.12% round-trip maker fee. **The fee is 9x the spread.** |
| funding-rate arbitrage | **2.6%/yr** on BTC after honest costs and margin capital. Worse than T-bills. |
| variance risk premium | real and persistent (seller wins 84% of months) but 12.0%/yr with a **30.5%** max drawdown. Worse risk-adjusted than owning the index. |
| martingale, and every reform of it | fair game, zero cost: **80.5% ruin**. With a genuine 52% edge: flat betting is 96.3% profitable with zero ruin; martingale is **66.9% ruin**. Doubling down when losing is Kelly in reverse. |
| grid / DCA bots | same bot, three worlds: mean-reverting **+41%**, random walk **−1%**, downtrend **−85%**. On real BTC 2021–2025: buy-and-hold +172.6%, equal grid +6.6%, martingale grid **−5.6%**. It is a short-volatility insurance policy, not a strategy. |
| diversified futures trend-following (24 markets, 4 asset classes, 22 years) | **it has genuine timing skill — and it still loses.** See below. This one refuted me. |
| volatility-targeted position sizing | **the one thing that worked.** See below. |

### The experiment that proved me wrong, and the three bad bars that unproved it

`src/backtest/tsmom.ts` — `npm run tsmom`.

Everything else in this repo ran on SPY. The academic case for trend-following lives in the
*cross-section*: 67 markets, four asset classes, a positive return in every decade since 1880 (Hurst,
Ooi & Pedersen 2017). A single-asset test has no power against that, so the strongest argument
against this repository went untested for the whole project.

I tested it on its own terms — 24 futures, 2004–2026, the Moskowitz-Ooi-Pedersen construction — and
**it refuted me.** TSMOM showed real timing skill at **p = 0.020** against a 200-draw null. I wrote
that up, promoted it to the top of this README, committed it, and pushed.

Then I went looking for impossible numbers in the input data.

**Two of them, in 134,000 bars:**

- **6J=F, 2001-12-17.** The yen future prints `0.000783` between two days of `0.00786`. A misplaced
  decimal. It is recorded as a −90% day followed by a **+904%** day. The yen did not move 904%.
- **CL=F, 2020-04-20.** Crude closed at **−$37.63**. That is not an error — it happened. But
  `close[i]/close[i-1] − 1` across zero is not a return, it is a division artefact: the naive maths
  reports **−306%**, then **−127%** the next day when the price returns to +$10. **A trend-follower is
  short crude that month.** A short position times a −306% "return" books an enormous fictional profit
  on the single most consequential day in the sample.

Drop those days. Repair the tick. Re-run:

| book | | real | null | p |
|---|---|---|---|---|
| **TSMOM** | with the bad bars | 0.46 | 0.08 | **0.020** |
| | **cleaned** | **0.44** | **0.11** | **0.075** |
| DRIFT — sign of the historical mean, no forecast at all | with the bad bars | 0.42 | 0.30 | 0.075 |
| | **cleaned** | **0.47** | **0.36** | **0.085** |
| ALWAYS LONG — sign is always +1 | with the bad bars | 0.49 | 0.48 | 0.468 |
| | **cleaned** | **0.52** | **0.53** | **0.602** |

**Three bad bars carried the p-value from 0.075 to 0.020, and flipped TSMOM from *losing* to a
control that forecasts nothing (0.44 vs 0.47) to *beating* it (0.46 vs 0.42).** The refutation was the
bad data.

Read `always_long` to see the null is working: its signal is the constant +1, it cannot time anything,
and the null reproduces its Sharpe almost exactly (0.52 vs 0.53). **That is what a functioning control
group looks like**, and it is what licenses reading the rows above it.

**Where that leaves the claim.** On clean data, p = 0.075. Not nothing — 14 of 200 — and the sign is
consistent. But not significant, and the honest reading is *suggestive of weak timing skill, not
evidence of it.* Whatever is there earns less than doing nothing:

```
TSMOM        (p = 0.075, so: maybe)   5.8%/yr   Sharpe 0.44
DRIFT        (forecasts nothing)      6.1%/yr   Sharpe 0.47   <- beats it
ALWAYS LONG  (provably zero skill)    8.0%/yr   Sharpe 0.52   <- beats it
SPY buy & hold (doing nothing)        9.0%/yr   Sharpe 0.55   <- beats all
```

TSMOM loses to DRIFT in **all three** of the regime splits. This is **Huang, Li, Wang & Zhou (2020)**,
*Time-Series Momentum: Is It There?*, Journal of Financial Economics, reproduced: TSMOM is profitable,
but indistinguishable from a strategy based on the historical sample mean that requires no
predictability whatsoever.

**One finding survives the cleaning, and it is the AQR one.** Bonds. The no-forecast control stays
long through 2020–22 and is annihilated: **−95.3%**, a 97.3% drawdown. TSMOM flips short and makes
**+342%**. That is crisis alpha, it is real, and cleaning the data does not touch it. **It is
insurance, and the premium is paid in return** — the same shape as the volatility-managed sizing
below, which is the only other survivor here.

Two things the headline still hides. That 5.8% needs **~26x notional leverage** on the low-vol legs
(40%/σ on a 1.5%-vol two-year note); cap leverage at 1x and TSMOM pays **1.8%/yr**. And the first
version of the null was broken in a different way — see entries 11 and 12 below.

### The one thing that worked, and its honest size

`src/backtest/portfolioStrategy.ts`. Hold the index; vary only *how much* you hold, sized so the
book's forecast volatility stays near a target. It rests on the thing this project found to be most
strongly predictable: **volatility clusters far harder than direction does.**

Note the shape it shares with the TSMOM result above. **Both survivors are insurance, and neither is
alpha.** That is the closest thing to a positive finding in this repository.

- Same average exposure as a constant-0.93 control: Sharpe **0.77 vs 0.68**, max drawdown **18.0% vs
  35.0%**. Same amount of stock held; half the drawdown. The timing does the work.
- Robust, not fitted: across a 6×6 grid of lookback window and volatility target, **36 of 36**
  combinations beat buy-and-hold on Sharpe and **36 of 36** cut the drawdown. The defaults sit in the
  middle of that plateau, not on its best cell.
- It corresponds to Moreira & Muir (2017), *Volatility-Managed Portfolios*, Journal of Finance —
  peer-reviewed, not something mined out of this data.

**It still returns less than the index** (9.2%/yr vs SPY's 13.4%). It buys a halved drawdown *with*
return. That is a trade, not a free lunch.

**It does not work on crypto.** On an 8-coin basket it collapses to a Sharpe of 0.40 against a
constant-exposure control's 0.39 — 0.16% round-trip costs and 7.9x/year turnover eat the entire
effect, leaving nothing but "hold half as much."

An earlier version of this module ran two signal engines with a contrarian rotation on top. An
ablation over 9 sector ETFs, 10 years, four non-overlapping blocks found the engines cost more than
half the return (4.3%/yr vs 9.6%) and bought no extra protection (17.0% vs 18.0% drawdown) — in every
block. So they were deleted. **Everything that worked was the sizing; the signals on top were
decoration.**

---

## Twelve times I fooled myself, and how each one was caught

These are the useful part. Every one of them produced a result that looked good, and every one was
caught by being suspicious of a number that was too pretty.

1. **Lookahead, one bar.** Used bar *i*'s signal to earn bar *i*'s return. Produced an apparent Sharpe
   of **7** and 4% drawdowns. The fix is `signals[i - 1]`. Pinned by a test: 200 calm bars, then a
   −25% crash. Correct code must eat the crash almost in full. With the bug, the worst day is −3.2% —
   the book "saw it coming." (`portfolioStrategy.test.ts`)

2. **A test that could not fail.** The first no-lookahead test mutated bars ≥200 and checked that bars
   <188 were unchanged. A one-bar leak never reaches back that far, so it passed against deliberately
   broken code. **Verified by injecting the bug: it stayed green.** Rewritten, then re-verified — bug
   in, test red; bug out, test green. A test that cannot fail is decoration.

3. **Survivorship bias.** An ML model showing +30.7%/yr was buying NVDA in 36 of 59 rebalances. I had
   built its universe in 2026 out of stocks that were winners in 2026. Remove them and the edge is
   −0.1 points. The model had zero skill; it had my hindsight.

4. **Overlapping windows.** Sampled daily to predict 21-day forward returns, counting each move ~21
   times. Produced a "stable out-of-sample" IC of 0.128. Redone with non-overlapping windows: n=85
   independent observations, nothing significant.

5. **Linear payoff on a convex product.** Modelled a variance swap with a linear volatility
   difference. Corrected to the actual (IV² − RV²) payoff: annualized return 16.4% → 12.0%, max
   drawdown 13.7% → **30.5%**, worst month −13.1% → **−28.6%**. The uncorrected version would have
   been dangerously reassuring.

6. **Free-lunch fills.** Stops assumed to fill *at* the stop price, and breakout bars that reversed
   through the stop intraday silently dropped. Both fixes made the results worse — bull half 82.6% →
   71.4%, bear half −22.9% → −29.5% — which is how you know they were right. (`turtle.ts`)

7. **The random number generator was the bug.** A martingale simulation returned an 88.7% win rate on
   a fair coin. The LCG's serial correlation was strong enough to corrupt the simulation. Replaced
   with mulberry32. **Your PRNG can be a lookahead bug.**

8. **The null wasn't null.** While building the experiment that catches other people's false
   positives, I labelled a series "zero-structure random walk" — and left SPY's drift in it. It was
   not a null at all, and the wrong number supported a wrong conclusion ("noise survives at a
   *higher* rate than signal"). The corrected zero-drift control gives 0.0% and tells a stronger
   story. **Check that your control group is actually controlled.**

9. **Shorts priced as free.** Extending the harness to long/short, `evaluate()` still only counted
   `exposure === 1` as an open position, and charged turnover on the wrong side of a flip. Every
   short trade was free, and a long→short flip cost one unit instead of two. **This bug flattered
   precisely the book the strongest claim in this repo rests on** — and it flattered it in my favour.
   Caught by a test that measures the exact number of turnover units charged.

10. **A second test that could not fail.** The first version of *that* test drove a deliberately
    terrible strategy through `runGauntlet` and compared returns — but the gauntlet reports 0% for
    anything that fails a gate, so a bad strategy scores 0 with or without the bug. It passed
    vacuously. **The same mistake as #2, made again, eleven weeks later.** Rewritten against
    `evaluate()` directly, then verified: inject the bug, test goes red with a message naming the
    defect. Verify that your test can fail. Then verify it again the next time.

11. **The null wasn't null. Again.** Building the futures test, I shuffled each of the 24 instruments
    *independently*. That destroys the time-ordering — which is what I wanted — but it also destroys
    the **cross-asset correlation**, which I hadn't thought about. In the real world everything
    crashes at once; in my null the crashes were scattered, so an equal-weighted long book collected
    a diversification bonus reality had never offered it. The tell was loud: a book that is **always
    long, and therefore cannot possibly time anything**, scored Sharpe 0.49 on real data and **0.97
    on the null, beating reality in 200 of 200 draws.** A strategy with no signal cannot beat itself.
    The null was broken. Fixed by applying **one shared permutation** to every instrument, so a day in
    the null is a real day. **This is #8 again — the third time a control group turned out not to be
    controlled**, and the second time it happened in the tool I built to catch other people doing it.

12. **I published a refutation of myself, and the refutation was three bad bars.** The futures result
    above came out at p = 0.020, contradicting a claim this README opened with. It is a *good* result
    — it makes me look rigorous, it makes the project look honest, it is exactly the kind of finding
    you want to lead with. **So I led with it, committed it, and pushed it.** Only afterwards did I
    audit the input data for impossible prints, and find a yen future that had "moved 904%" and a
    crude future whose −$37 close was being converted into a −306% "return" against a book that was
    short crude that month. Cleaning three bars out of 134,000 took p to 0.075 and reversed the
    strategy's ranking against a control that forecasts nothing.

    **The lesson is not "check your data."** Everybody says that. The lesson is that I ran the
    permutation test, the synchronized null, the leverage sensitivity, the cost sensitivity, the
    regime splits and seven tests verified to fail against injected bugs — **and shipped it without
    once asking whether the numbers going in were physically possible.** Every guard I had was aimed
    downstream of the data. A price of −$37 and a 904% day were sitting there in plain sight, and no
    amount of methodological rigour applied *after* them would ever have found them.

    I only looked because I had been asked to red-team myself for the second time and had run out of
    clever things to check.

The pattern in most of these: *the result was too good, so I went looking for the bug instead of the
champagne.* That habit is most of the methodology.

But look at what it missed. #2 and #10 are the same error. #8 and #11 are the same error. #8, #9 and
#11 were all found while building the tools that find other people's errors. And #12 got past every
one of those tools, because they were all pointed the wrong way. Rigour is not a state you reach.

**Two things caught what the tests could not:**

- **A control group that is supposed to score zero.** #11 was found because a book that is always
  long — and therefore cannot time anything — beat reality in 200 of 200 null draws. Every test I had
  written passed. Keep a group in the experiment that should score zero, and look at it every single
  time. If it wins, you have learned about your instrument, not about the market.
- **Asking whether the inputs are physically possible.** #12 was found by scanning for returns larger
  than 8σ and asking "could that have happened?" Two could not. That check is four lines long and it
  outranked every sophisticated thing in this repository.

---

## What's in here

```
src/backtest/gauntlet.ts        the gauntlet + nullTest() + shuffleReturns()  ← the reusable part
src/backtest/candidates.ts      the strategy space a generator actually proposes
src/backtest/runGauntlet.ts     `npm run gauntlet` — reproduces the table above
src/backtest/portfolioStrategy.ts   volatility-targeted sizing (the one thing that worked)
src/backtest/turtle.ts          Donchian breakout, with the three bugs fixed and documented
src/backtest/fetchStocks.ts     Yahoo daily bars (public, no key)
src/backtest/fetchKlines.ts     MEXC crypto klines
src/risk/guardrails.ts          max trade size / max trades per day, enforced before any order
src/exchange/mockAdapter.ts     the default. No real orders.
```

```bash
npm install
npm test          # 61 tests
npm run typecheck
npm run gauntlet  # reproduces the false-positive table
```

Node 20+. No API key needed for any of the backtests — Yahoo and MEXC public endpoints only.

## The bot

There is a webhook-driven trading bot in here too (`src/server.ts`), with a MEXC adapter, a trade
ledger, and hard risk caps. **`EXCHANGE_MODE` defaults to `mock` and it has never been changed.** No
real money has gone through this, and on the evidence above, none should.

If you fork this and point it at a live exchange, you are trading a system whose author spent three
months proving it has no edge. Please read the table again first.

## Licence

MIT. Take the gauntlet; leave the strategies.

---

*Not financial advice. This repository is a record of negative results and a set of tools for
detecting false positives. It does not recommend any trade, asset, or allocation, and its author does
not manage money for anyone.*
