import { computeAtrSeries, type Candle } from "./indicators.js";
import type { Trade, BacktestResult } from "./engine.js";

/**
 * The Turtle Trading System (Dennis / Eckhardt), the classic public breakout system.
 *
 * DO NOT TRADE THIS ON ITS OWN. An earlier version of this comment called it the one strategy
 * that survived the cost gauntlet. That claim was wrong, and it was wrong for an instructive
 * reason: it was measured over a window that included a bull market. Splitting the same history
 * in half tells the real story — first half (bull) +82.6%, second half (bear) -29.5%. It makes
 * money when the market rises and loses money when it falls; it is not an edge, it is exposure.
 * Its only durable value is defensive: it loses less than buy-and-hold in a downturn
 * (-29.5% vs -45.8%, beating buy-and-hold on 12 of 16 coins).
 *
 * Rules:
 *   entry: price breaks above the highest high of the prior `entryChannel` bars
 *   exit:  price breaks below the lowest low of the prior `exitChannel` bars (exitChannel < entryChannel)
 *   stop:  `atrStopMultiple` * ATR below the entry price
 *
 * Long-only by default: crypto trends up over the long run, and backtests showed the
 * short side dragged returns down (PF 1.15 long+short vs 1.56 long-only).
 */
export interface TurtleConfig {
  entryChannel: number;
  exitChannel: number;
  atrPeriod: number;
  atrStopMultiple: number;
  feePct: number; // round-trip fee as a fraction, e.g. 0.0016
  slippagePctPerSide: number; // per-side slippage as a fraction, e.g. 0.001 for 0.1%
  longOnly: boolean;
}

export const TURTLE_SYSTEM_1: TurtleConfig = {
  entryChannel: 20,
  exitChannel: 10,
  atrPeriod: 20,
  atrStopMultiple: 2,
  feePct: 0.0016,
  slippagePctPerSide: 0.001,
  longOnly: true,
};

interface OpenPosition {
  side: "long" | "short";
  entryIndex: number;
  entryPrice: number; // slippage-adjusted fill
  atrAtEntry: number;
}

function highestHigh(candles: Candle[], from: number, to: number): number {
  let hh = -Infinity;
  for (let i = from; i < to; i++) hh = Math.max(hh, candles[i].high);
  return hh;
}

function lowestLow(candles: Candle[], from: number, to: number): number {
  let ll = Infinity;
  for (let i = from; i < to; i++) ll = Math.min(ll, candles[i].low);
  return ll;
}

export function runTurtleBacktest(candles: Candle[], config: TurtleConfig): BacktestResult {
  const atr = computeAtrSeries(candles, config.atrPeriod);
  const trades: Trade[] = [];
  let openPosition: OpenPosition | null = null;

  const warmup = Math.max(config.entryChannel, config.exitChannel, config.atrPeriod + 1);

  for (let i = warmup; i < candles.length; i++) {
    const c = candles[i];

    if (openPosition) {
      const exitLow = lowestLow(candles, i - config.exitChannel, i);
      const exitHigh = highestHigh(candles, i - config.exitChannel, i);

      let exitPrice: number | null = null;
      let exitReason: Trade["exitReason"] | null = null;

      if (openPosition.side === "long") {
        const stopPrice = openPosition.entryPrice - config.atrStopMultiple * openPosition.atrAtEntry;
        if (c.low <= stopPrice) {
          // Gap-aware fill: if the bar OPENS below the stop, a resting stop order fills at the
          // open, not at the stop level. Assuming the stop level fills is a free lunch the
          // market does not give — it silently understates every losing trade.
          exitPrice = Math.min(stopPrice, c.open);
          exitReason = "stop_loss";
        } else if (c.low <= exitLow) {
          exitPrice = Math.min(exitLow, c.open);
          exitReason = "take_profit"; // channel exit: the trend ended, bank whatever it gave
        }
      } else {
        const stopPrice = openPosition.entryPrice + config.atrStopMultiple * openPosition.atrAtEntry;
        if (c.high >= stopPrice) {
          exitPrice = Math.max(stopPrice, c.open);
          exitReason = "stop_loss";
        } else if (c.high >= exitHigh) {
          exitPrice = Math.max(exitHigh, c.open);
          exitReason = "take_profit";
        }
      }

      if (exitPrice !== null && exitReason !== null) {
        // Exiting means selling into the move, so slippage works against us on this side too.
        const fill =
          openPosition.side === "long"
            ? exitPrice * (1 - config.slippagePctPerSide)
            : exitPrice * (1 + config.slippagePctPerSide);

        const rawPct =
          openPosition.side === "long"
            ? ((fill - openPosition.entryPrice) / openPosition.entryPrice) * 100
            : ((openPosition.entryPrice - fill) / openPosition.entryPrice) * 100;

        trades.push({
          entryTime: candles[openPosition.entryIndex].openTime,
          exitTime: c.openTime,
          side: openPosition.side,
          entryPrice: openPosition.entryPrice,
          exitPrice: fill,
          resultPct: rawPct - config.feePct * 100,
          exitReason,
        });
        openPosition = null;
      }
      continue;
    }

    if (Number.isNaN(atr[i]) || atr[i] <= 0) continue;

    const breakoutHigh = highestHigh(candles, i - config.entryChannel, i);
    const breakoutLow = lowestLow(candles, i - config.entryChannel, i);
    if (!Number.isFinite(breakoutHigh) || !Number.isFinite(breakoutLow)) continue;

    // Strictly greater: price must EXCEED the prior high, not merely touch it. On a flat
    // or ranging series the current high often equals the channel high, and `>=` turns that
    // non-event into a phantom breakout — the same class of bug as a zero-width band.
    // A breakout entry chases price, so the fill is worse than the trigger level.
    if (c.high > breakoutHigh) {
      const entryPrice = Math.max(breakoutHigh, c.open) * (1 + config.slippagePctPerSide);
      openPosition = { side: "long", entryIndex: i, entryPrice, atrAtEntry: atr[i] };
    } else if (c.low < breakoutLow && !config.longOnly) {
      const entryPrice = Math.min(breakoutLow, c.open) * (1 - config.slippagePctPerSide);
      openPosition = { side: "short", entryIndex: i, entryPrice, atrAtEntry: atr[i] };
    }

    // Same-bar stop-out. A breakout can spike through the channel and collapse through the
    // stop inside the SAME bar. Daily OHLC doesn't reveal the intrabar path, so resolve the
    // ambiguity against ourselves and take the loss — skipping the check would quietly drop
    // every "broke out and immediately reversed" trade from the results.
    if (openPosition) {
      const stopPrice =
        openPosition.side === "long"
          ? openPosition.entryPrice - config.atrStopMultiple * openPosition.atrAtEntry
          : openPosition.entryPrice + config.atrStopMultiple * openPosition.atrAtEntry;

      const stoppedSameBar =
        openPosition.side === "long" ? c.low <= stopPrice : c.high >= stopPrice;

      if (stoppedSameBar) {
        const rawPct =
          openPosition.side === "long"
            ? ((stopPrice * (1 - config.slippagePctPerSide) - openPosition.entryPrice) / openPosition.entryPrice) * 100
            : ((openPosition.entryPrice - stopPrice * (1 + config.slippagePctPerSide)) / openPosition.entryPrice) * 100;

        trades.push({
          entryTime: c.openTime,
          exitTime: c.openTime,
          side: openPosition.side,
          entryPrice: openPosition.entryPrice,
          exitPrice: stopPrice,
          resultPct: rawPct - config.feePct * 100,
          exitReason: "stop_loss",
        });
        openPosition = null;
      }
    }
  }

  return summarize(trades);
}

function summarize(trades: Trade[]): BacktestResult {
  if (trades.length === 0) {
    return {
      trades,
      winRate: 0,
      avgWinPct: 0,
      avgLossPct: 0,
      profitFactor: 0,
      totalReturnPct: 0,
      maxDrawdownPct: 0,
      totalTrades: 0,
    };
  }

  const wins = trades.filter((t) => t.resultPct > 0);
  const losses = trades.filter((t) => t.resultPct <= 0);

  const grossProfit = wins.reduce((s, t) => s + t.resultPct, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.resultPct, 0));

  // Compounded equity, not a naive sum of percentages — a sum overstates what you'd actually
  // have in the account, and the drawdown it implies is the one you'd have to live through.
  let equity = 1;
  let peak = 1;
  let maxDrawdownPct = 0;
  for (const t of trades) {
    equity *= 1 + t.resultPct / 100;
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - equity) / peak) * 100);
  }

  return {
    trades,
    winRate: wins.length / trades.length,
    avgWinPct: wins.length > 0 ? grossProfit / wins.length : 0,
    avgLossPct: losses.length > 0 ? losses.reduce((s, t) => s + t.resultPct, 0) / losses.length : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    totalReturnPct: (equity - 1) * 100,
    maxDrawdownPct,
    totalTrades: trades.length,
  };
}
