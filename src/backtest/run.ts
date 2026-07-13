import { fetchKlines } from "./fetchKlines.js";
import {
  runBacktest,
  runBollingerMeanReversionBacktest,
  type BacktestConfig,
  type BollingerBacktestConfig,
  type BacktestResult,
} from "./engine.js";
import { runRegimeSwitchingBacktest, type RegimeSwitchingConfig } from "./regimeSwitchingEngine.js";
import { runTurtleBacktest, TURTLE_SYSTEM_1 } from "./turtle.js";

const SYMBOL = process.env.BACKTEST_SYMBOL ?? "BTCUSDT";
const DAYS = Number(process.env.BACKTEST_DAYS ?? 30);
const STRATEGY = process.env.BACKTEST_STRATEGY ?? "vwap-rsi-ema";
// Turtle is a daily-bar system; the others were built against 1m bars.
const INTERVAL = process.env.BACKTEST_INTERVAL ?? (STRATEGY === "turtle" ? "1d" : "1m");

// Mirrors config/rules.json (demo-vwap-rsi-ema-scalp): RSI(3), EMA(8), 0.5% stop / 1.0% take profit.
const vwapRsiEmaConfig: BacktestConfig = {
  rsiPeriod: 3,
  emaPeriod: 8,
  stopLossPct: 0.5,
  takeProfitPct: 1.0,
  feePct: 0.0016, // MEXC API trading uses its own fee schedule (independent of web/app rates): 0.08% taker per side, round trip = 0.16%
};

// Mirrors config/rules-bollinger-mean-reversion.json: 20-period bands, 2 std dev, 0.5% stop.
const bollingerConfig: BollingerBacktestConfig = {
  bollingerPeriod: 20,
  bollingerStdDev: 2,
  stopLossPct: 0.2,
  takeProfitPct: 0.32, // fixed target instead of the drifting middle band; matches minTargetDistancePct so entries are only taken when this is realistically reachable
  feePct: 0.0016, // MEXC API taker fee, round trip — see vwapRsiEmaConfig comment above
  minTargetDistancePct: 0.32, // require the middle band to be at least this far away at entry time as a signal-quality filter
};

const regimeSwitchingConfig: RegimeSwitchingConfig = {
  regime: { lookback: 20, trendingThreshold: 0.6 },
  trending: vwapRsiEmaConfig,
  ranging: bollingerConfig,
};

function printResult(name: string, symbol: string, days: number, candleCount: number, feePct: number, result: BacktestResult) {
  console.log(`\n=== Backtest Result: ${name} ===`);
  console.log(`Symbol:            ${symbol}`);
  console.log(`Period:            ${days} days (${candleCount} 1m candles)`);
  console.log(`Fee assumption:    ${(feePct * 100).toFixed(2)}% round trip`);
  console.log(`Total trades:      ${result.totalTrades}`);
  console.log(`Win rate:          ${(result.winRate * 100).toFixed(1)}%`);
  console.log(`Avg win:           ${result.avgWinPct.toFixed(3)}%`);
  console.log(`Avg loss:          ${result.avgLossPct.toFixed(3)}%`);
  console.log(`Profit factor:     ${result.profitFactor === Infinity ? "inf (no losses)" : result.profitFactor.toFixed(2)}`);
  console.log(`Total return:      ${result.totalReturnPct.toFixed(2)}% (sum of per-trade % — not compounded)`);
  console.log(`Max drawdown:      ${result.maxDrawdownPct.toFixed(2)}%`);

  if (result.totalTrades < 30) {
    console.log(`\n⚠️  Only ${result.totalTrades} trades in this window — too few for statistical significance. Treat this result as directional, not conclusive.`);
  }
}

async function main() {
  const endTime = Date.now();
  const startTime = endTime - DAYS * 24 * 60 * 60 * 1000;

  console.log(`Fetching ${DAYS}d of ${INTERVAL} klines for ${SYMBOL} from MEXC...`);
  const candles = await fetchKlines(SYMBOL, startTime, endTime, INTERVAL);
  console.log(
    `Fetched ${candles.length} candles (${candles.length > 0 ? new Date(candles[0].openTime).toISOString() : "n/a"} to ${candles.length > 0 ? new Date(candles[candles.length - 1].openTime).toISOString() : "n/a"})`,
  );

  if (candles.length === 0) {
    console.error("No candle data returned — aborting.");
    process.exit(1);
  }

  if (STRATEGY === "turtle") {
    const result = runTurtleBacktest(candles, TURTLE_SYSTEM_1);
    printResult("turtle-20/10-long-only", SYMBOL, DAYS, candles.length, TURTLE_SYSTEM_1.feePct, result);
    console.log(
      `Slippage assumption: ${(TURTLE_SYSTEM_1.slippagePctPerSide * 100).toFixed(2)}% per side (breakout entries chase price)`,
    );
    console.log(`Note: total return above is COMPOUNDED, unlike the other strategies' summed-% figure.`);
  } else if (STRATEGY === "bollinger") {
    const result = runBollingerMeanReversionBacktest(candles, bollingerConfig);
    printResult("bollinger-mean-reversion", SYMBOL, DAYS, candles.length, bollingerConfig.feePct, result);
  } else if (STRATEGY === "vwap-rsi-ema") {
    const result = runBacktest(candles, vwapRsiEmaConfig);
    printResult("demo-vwap-rsi-ema-scalp", SYMBOL, DAYS, candles.length, vwapRsiEmaConfig.feePct, result);
  } else if (STRATEGY === "regime-switching") {
    const result = runRegimeSwitchingBacktest(candles, regimeSwitchingConfig);
    printResult("regime-switching (trend->vwap-rsi-ema, range->bollinger)", SYMBOL, DAYS, candles.length, 0.002, result);
    console.log(`\nRegime breakdown: trending=${result.regimeBreakdown.trending} candles, ranging=${result.regimeBreakdown.ranging} candles`);
  } else {
    console.error(`Unknown BACKTEST_STRATEGY: ${STRATEGY}. Use "vwap-rsi-ema", "bollinger", or "regime-switching".`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Backtest failed:", err);
  process.exit(1);
});
