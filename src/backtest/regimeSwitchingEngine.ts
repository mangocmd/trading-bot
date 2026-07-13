import {
  computeVwapSeries,
  computeRsiSeries,
  computeEmaSeries,
  computeBollingerBands,
  type Candle,
} from "./indicators.js";
import { classifyRegimeSeries, type RegimeConfig, type MarketRegime } from "./regime.js";
import type { BacktestConfig, BollingerBacktestConfig, Trade, BacktestResult } from "./engine.js";

export interface RegimeSwitchingConfig {
  regime: RegimeConfig;
  trending: BacktestConfig; // used when regime === "trending"
  ranging: BollingerBacktestConfig; // used when regime === "ranging"
}

interface OpenPosition {
  strategy: "trending" | "ranging";
  side: "long" | "short";
  entryIndex: number;
  entryPrice: number;
}

type PendingReversal = { side: "long" | "short"; triggeredAtIndex: number };

/**
 * At each candle, classifies the market regime (see regime.ts) and only evaluates
 * entry signals from the strategy assigned to that regime: VWAP/RSI/EMA while
 * "trending", Bollinger mean-reversion while "ranging". A position, once opened,
 * is managed to exit using its own strategy's exit rule regardless of any regime
 * change while it's open (an open trade isn't abandoned mid-flight on a regime flip).
 */
export function runRegimeSwitchingBacktest(candles: Candle[], config: RegimeSwitchingConfig): BacktestResult & {
  regimeBreakdown: Record<MarketRegime, number>;
} {
  const regimes = classifyRegimeSeries(candles, config.regime);

  const vwap = computeVwapSeries(candles);
  const rsi = computeRsiSeries(candles, config.trending.rsiPeriod);
  const ema = computeEmaSeries(candles, config.trending.emaPeriod);
  const bb = computeBollingerBands(candles, config.ranging.bollingerPeriod, config.ranging.bollingerStdDev);

  const trades: Trade[] = [];
  let openPosition: OpenPosition | null = null;
  let pending: PendingReversal | null = null;
  const regimeBreakdown: Record<MarketRegime, number> = { trending: 0, ranging: 0 };

  const warmup = Math.max(
    config.regime.lookback,
    Math.max(config.trending.rsiPeriod, config.trending.emaPeriod) + 1,
    config.ranging.bollingerPeriod,
  );

  for (let i = warmup; i < candles.length; i++) {
    const c = candles[i];
    regimeBreakdown[regimes[i]]++;

    if (openPosition) {
      const strategyConfig = openPosition.strategy === "trending" ? config.trending : config.ranging;
      const stopPrice =
        openPosition.side === "long"
          ? openPosition.entryPrice * (1 - strategyConfig.stopLossPct / 100)
          : openPosition.entryPrice * (1 + strategyConfig.stopLossPct / 100);

      const targetPrice =
        openPosition.side === "long"
          ? openPosition.entryPrice * (1 + strategyConfig.takeProfitPct / 100)
          : openPosition.entryPrice * (1 - strategyConfig.takeProfitPct / 100);

      let exitPrice: number | null = null;
      let exitReason: Trade["exitReason"] | null = null;

      if (openPosition.side === "long") {
        if (c.low <= stopPrice) {
          exitPrice = stopPrice;
          exitReason = "stop_loss";
        } else if (targetPrice !== null && c.high >= targetPrice) {
          exitPrice = targetPrice;
          exitReason = "take_profit";
        }
      } else {
        if (c.high >= stopPrice) {
          exitPrice = stopPrice;
          exitReason = "stop_loss";
        } else if (targetPrice !== null && c.low <= targetPrice) {
          exitPrice = targetPrice;
          exitReason = "take_profit";
        }
      }

      if (exitPrice !== null && exitReason !== null) {
        const rawPct =
          openPosition.side === "long"
            ? ((exitPrice - openPosition.entryPrice) / openPosition.entryPrice) * 100
            : ((openPosition.entryPrice - exitPrice) / openPosition.entryPrice) * 100;
        const netPct = rawPct - strategyConfig.feePct * 100;

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

    const regime = regimes[i];

    if (regime === "trending") {
      pending = null; // pending mean-reversion confirmations don't carry across a regime flip
      const prevRsi = rsi[i - 1];
      const currRsi = rsi[i];
      if (Number.isNaN(prevRsi) || Number.isNaN(currRsi) || Number.isNaN(vwap[i]) || Number.isNaN(ema[i])) {
        continue;
      }
      const longSignal = c.close > vwap[i] && prevRsi < 20 && currRsi >= 20 && c.close > ema[i];
      const shortSignal = c.close < vwap[i] && prevRsi > 80 && currRsi <= 80 && c.close < ema[i];

      if (longSignal) {
        openPosition = { strategy: "trending", side: "long", entryIndex: i, entryPrice: c.close };
      } else if (shortSignal) {
        openPosition = { strategy: "trending", side: "short", entryIndex: i, entryPrice: c.close };
      }
    } else {
      const lowerBand = bb.lower[i];
      const upperBand = bb.upper[i];
      if (Number.isNaN(lowerBand) || Number.isNaN(upperBand) || upperBand <= lowerBand) {
        pending = null;
        continue;
      }

      if (pending && pending.triggeredAtIndex === i - 1) {
        const confirmed = pending.side === "long" ? c.close > lowerBand : c.close < upperBand;
        if (confirmed) {
          const middleBand = bb.middle[i];
          const distancePct = Number.isNaN(middleBand)
            ? 0
            : Math.abs((middleBand - c.close) / c.close) * 100;
          if (distancePct >= config.ranging.minTargetDistancePct) {
            openPosition = { strategy: "ranging", side: pending.side, entryIndex: i, entryPrice: c.close };
          }
          pending = null;
          continue;
        }
        pending = null;
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
  }

  return { ...summarize(trades), regimeBreakdown };
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
