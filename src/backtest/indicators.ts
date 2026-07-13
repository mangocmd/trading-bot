export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Rolling VWAP over the whole supplied window (no session reset).
 * Uses typical price (H+L+C)/3, the common VWAP convention.
 */
export function computeVwapSeries(candles: Candle[]): number[] {
  const vwap: number[] = new Array(candles.length);
  let cumulativePV = 0;
  let cumulativeVolume = 0;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const typicalPrice = (c.high + c.low + c.close) / 3;
    cumulativePV += typicalPrice * c.volume;
    cumulativeVolume += c.volume;
    vwap[i] = cumulativeVolume > 0 ? cumulativePV / cumulativeVolume : c.close;
  }

  return vwap;
}

/**
 * Wilder's RSI, the standard definition (matches TradingView's default RSI).
 */
export function computeRsiSeries(candles: Candle[], period: number): number[] {
  const rsi: number[] = new Array(candles.length).fill(NaN);
  if (candles.length < period + 1) return rsi;

  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const change = candles[i].close - candles[i - 1].close;
    if (change > 0) avgGain += change;
    else avgLoss += -change;
  }
  avgGain /= period;
  avgLoss /= period;

  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < candles.length; i++) {
    const change = candles[i].close - candles[i - 1].close;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return rsi;
}

export interface BollingerBands {
  middle: number[];
  upper: number[];
  lower: number[];
}

/**
 * Standard Bollinger Bands: SMA(period) middle band, +/- (stdDevMultiplier * population stdev).
 */
export function computeBollingerBands(
  candles: Candle[],
  period: number,
  stdDevMultiplier: number,
): BollingerBands {
  const middle: number[] = new Array(candles.length).fill(NaN);
  const upper: number[] = new Array(candles.length).fill(NaN);
  const lower: number[] = new Array(candles.length).fill(NaN);

  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += candles[j].close;
    const mean = sum / period;

    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const diff = candles[j].close - mean;
      variance += diff * diff;
    }
    variance /= period;
    const stdDev = Math.sqrt(variance);

    middle[i] = mean;
    upper[i] = mean + stdDevMultiplier * stdDev;
    lower[i] = mean - stdDevMultiplier * stdDev;
  }

  return { middle, upper, lower };
}

/**
 * Wilder's ATR (Average True Range) — the volatility measure the Turtle system sizes
 * its stops with. True range accounts for gaps by comparing against the prior close.
 */
export function computeAtrSeries(candles: Candle[], period: number): number[] {
  const atr: number[] = new Array(candles.length).fill(NaN);
  if (candles.length < period + 1) return atr;

  const trueRange: number[] = new Array(candles.length).fill(NaN);
  for (let i = 1; i < candles.length; i++) {
    const prevClose = candles[i - 1].close;
    trueRange[i] = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - prevClose),
      Math.abs(candles[i].low - prevClose),
    );
  }

  let seed = 0;
  for (let i = 1; i <= period; i++) seed += trueRange[i];
  atr[period] = seed / period;

  for (let i = period + 1; i < candles.length; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + trueRange[i]) / period;
  }

  return atr;
}

export function computeEmaSeries(candles: Candle[], period: number): number[] {
  const ema: number[] = new Array(candles.length).fill(NaN);
  if (candles.length < period) return ema;

  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += candles[i].close;
  seed /= period;
  ema[period - 1] = seed;

  for (let i = period; i < candles.length; i++) {
    ema[i] = candles[i].close * k + ema[i - 1] * (1 - k);
  }

  return ema;
}
