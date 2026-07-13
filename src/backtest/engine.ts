import {
  computeVwapSeries,
  computeRsiSeries,
  computeEmaSeries,
  computeBollingerBands,
  type Candle,
} from "./indicators.js";

export interface BacktestConfig {
  rsiPeriod: number;
  emaPeriod: number;
  stopLossPct: number;
  takeProfitPct: number;
  feePct: number; // round-trip fee assumption, e.g. 0.001 for 0.1% (MEXC spot taker default is ~0.1% per side)
}

export interface BollingerBacktestConfig {
  bollingerPeriod: number;
  bollingerStdDev: number;
  stopLossPct: number;
  /**
   * Fixed take-profit target (in %), used instead of the middle band directly.
   * A moving target (the SMA) can drift against the trade between entry and exit,
   * so a fixed percentage guarantees the measured edge at entry is what gets realized.
   */
  takeProfitPct: number;
  feePct: number;
  /**
   * Minimum required distance (in %) from entry price to the middle-band reversion
   * target at entry time. If the confirmed entry is already within this distance,
   * the setup is judged too weak (little room before fees eat the edge) and skipped.
   */
  minTargetDistancePct: number;
}

export interface Trade {
  entryTime: number;
  exitTime: number;
  side: "long" | "short";
  entryPrice: number;
  exitPrice: number;
  resultPct: number; // net of fees
  exitReason: "stop_loss" | "take_profit";
}

export interface BacktestResult {
  trades: Trade[];
  winRate: number;
  avgWinPct: number;
  avgLossPct: number;
  profitFactor: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  totalTrades: number;
}

/**
 * Deterministic replay of the demo-vwap-rsi-ema-scalp rules from config/rules.json:
 *   long:  price > VWAP AND RSI(period) crosses above 20 from oversold AND price > EMA(period)
 *   short: price < VWAP AND RSI(period) crosses below 80 from overbought AND price < EMA(period)
 * Exit on whichever of stopLossPct / takeProfitPct is hit first, checked candle by candle.
 * Only one open position at a time (no pyramiding), matching how the live server evaluates one alert at a time.
 */
export function runBacktest(candles: Candle[], config: BacktestConfig): BacktestResult {
  const vwap = computeVwapSeries(candles);
  const rsi = computeRsiSeries(candles, config.rsiPeriod);
  const ema = computeEmaSeries(candles, config.emaPeriod);

  const trades: Trade[] = [];
  let openPosition: { side: "long" | "short"; entryIndex: number; entryPrice: number } | null = null;

  const warmup = Math.max(config.rsiPeriod, config.emaPeriod) + 1;

  for (let i = warmup; i < candles.length; i++) {
    const c = candles[i];

    if (openPosition) {
      const stopPrice =
        openPosition.side === "long"
          ? openPosition.entryPrice * (1 - config.stopLossPct / 100)
          : openPosition.entryPrice * (1 + config.stopLossPct / 100);
      const targetPrice =
        openPosition.side === "long"
          ? openPosition.entryPrice * (1 + config.takeProfitPct / 100)
          : openPosition.entryPrice * (1 - config.takeProfitPct / 100);

      let exitPrice: number | null = null;
      let exitReason: Trade["exitReason"] | null = null;

      if (openPosition.side === "long") {
        if (c.low <= stopPrice) {
          exitPrice = stopPrice;
          exitReason = "stop_loss";
        } else if (c.high >= targetPrice) {
          exitPrice = targetPrice;
          exitReason = "take_profit";
        }
      } else {
        if (c.high >= stopPrice) {
          exitPrice = stopPrice;
          exitReason = "stop_loss";
        } else if (c.low <= targetPrice) {
          exitPrice = targetPrice;
          exitReason = "take_profit";
        }
      }

      if (exitPrice !== null && exitReason !== null) {
        const rawPct =
          openPosition.side === "long"
            ? ((exitPrice - openPosition.entryPrice) / openPosition.entryPrice) * 100
            : ((openPosition.entryPrice - exitPrice) / openPosition.entryPrice) * 100;
        const netPct = rawPct - config.feePct * 100;

        trades.push({
          entryTime: candles[openPosition.entryIndex].openTime,
          exitTime: c.openTime,
          side: openPosition.side,
          entryPrice: openPosition.entryPrice,
          exitPrice,
          resultPct: netPct,
          exitReason,
        });
        openPosition = null;
      }
      continue;
    }

    const prevRsi = rsi[i - 1];
    const currRsi = rsi[i];
    if (Number.isNaN(prevRsi) || Number.isNaN(currRsi) || Number.isNaN(vwap[i]) || Number.isNaN(ema[i])) {
      continue;
    }

    const longSignal = c.close > vwap[i] && prevRsi < 20 && currRsi >= 20 && c.close > ema[i];
    const shortSignal = c.close < vwap[i] && prevRsi > 80 && currRsi <= 80 && c.close < ema[i];

    if (longSignal) {
      openPosition = { side: "long", entryIndex: i, entryPrice: c.close };
    } else if (shortSignal) {
      openPosition = { side: "short", entryIndex: i, entryPrice: c.close };
    }
  }

  return summarize(trades);
}

type PendingReversal = { side: "long" | "short"; triggeredAtIndex: number };

/**
 * Deterministic replay of config/rules-bollinger-mean-reversion.json, with a
 * reversal-confirmation filter to cut down on false-breakout whipsaws:
 *   1. A candle touching/crossing the lower band arms a pending "long" reversal
 *      (touching/crossing the upper band arms "short").
 *   2. The reversal only fires — opening a position — if the very next candle's
 *      CLOSE moves back inside the band (close > lowerBand for long, close < upperBand
 *      for short). If the next candle doesn't confirm, the pending signal is dropped
 *      (a fresh touch on a later candle can re-arm it).
 * Exit on stopLossPct or reversion to the middle band (SMA), whichever comes first.
 * Only one open position at a time, same convention as the VWAP/RSI/EMA engine above.
 */
export function runBollingerMeanReversionBacktest(
  candles: Candle[],
  config: BollingerBacktestConfig,
): BacktestResult {
  const bb = computeBollingerBands(candles, config.bollingerPeriod, config.bollingerStdDev);

  const trades: Trade[] = [];
  let openPosition: { side: "long" | "short"; entryIndex: number; entryPrice: number } | null = null;
  let pending: PendingReversal | null = null;

  const warmup = config.bollingerPeriod;

  for (let i = warmup; i < candles.length; i++) {
    const c = candles[i];

    if (openPosition) {
      const stopPrice =
        openPosition.side === "long"
          ? openPosition.entryPrice * (1 - config.stopLossPct / 100)
          : openPosition.entryPrice * (1 + config.stopLossPct / 100);
      const targetPrice =
        openPosition.side === "long"
          ? openPosition.entryPrice * (1 + config.takeProfitPct / 100)
          : openPosition.entryPrice * (1 - config.takeProfitPct / 100);

      let exitPrice: number | null = null;
      let exitReason: Trade["exitReason"] | null = null;

      if (openPosition.side === "long") {
        if (c.low <= stopPrice) {
          exitPrice = stopPrice;
          exitReason = "stop_loss";
        } else if (c.high >= targetPrice) {
          exitPrice = targetPrice;
          exitReason = "take_profit";
        }
      } else {
        if (c.high >= stopPrice) {
          exitPrice = stopPrice;
          exitReason = "stop_loss";
        } else if (c.low <= targetPrice) {
          exitPrice = targetPrice;
          exitReason = "take_profit";
        }
      }

      if (exitPrice !== null && exitReason !== null) {
        const rawPct =
          openPosition.side === "long"
            ? ((exitPrice - openPosition.entryPrice) / openPosition.entryPrice) * 100
            : ((openPosition.entryPrice - exitPrice) / openPosition.entryPrice) * 100;
        const netPct = rawPct - config.feePct * 100;

        trades.push({
          entryTime: candles[openPosition.entryIndex].openTime,
          exitTime: c.openTime,
          side: openPosition.side,
          entryPrice: openPosition.entryPrice,
          exitPrice,
          resultPct: netPct,
          exitReason,
        });
        openPosition = null;
      }
      continue;
    }

    const lowerBand = bb.lower[i];
    const upperBand = bb.upper[i];
    if (Number.isNaN(lowerBand) || Number.isNaN(upperBand) || upperBand <= lowerBand) {
      pending = null;
      continue;
    }

    if (pending && pending.triggeredAtIndex === i - 1) {
      const confirmed =
        pending.side === "long" ? c.close > lowerBand : c.close < upperBand;
      if (confirmed) {
        const middleBand = bb.middle[i];
        const distancePct = Number.isNaN(middleBand)
          ? 0
          : Math.abs((middleBand - c.close) / c.close) * 100;
        if (distancePct >= config.minTargetDistancePct) {
          openPosition = { side: pending.side, entryIndex: i, entryPrice: c.close };
        }
        // else: reversion target too close to cover fees — skip this trade entirely
        pending = null;
        continue;
      }
      pending = null; // failed to confirm — drop it, don't carry stale state forward
    }

    const touchedLower = c.low <= lowerBand;
    const touchedUpper = c.high >= upperBand;

    if (touchedLower) {
      pending = { side: "long", triggeredAtIndex: i };
    } else if (touchedUpper) {
      pending = { side: "short", triggeredAtIndex: i };
    } else {
      pending = null;
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

  const winRate = wins.length / trades.length;
  const avgWinPct = wins.length > 0 ? wins.reduce((s, t) => s + t.resultPct, 0) / wins.length : 0;
  const avgLossPct = losses.length > 0 ? losses.reduce((s, t) => s + t.resultPct, 0) / losses.length : 0;

  const grossProfit = wins.reduce((s, t) => s + t.resultPct, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.resultPct, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  let equity = 0;
  let peak = 0;
  let maxDrawdownPct = 0;
  for (const t of trades) {
    equity += t.resultPct;
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, peak - equity);
  }

  return {
    trades,
    winRate,
    avgWinPct,
    avgLossPct,
    profitFactor,
    totalReturnPct: equity,
    maxDrawdownPct,
    totalTrades: trades.length,
  };
}
