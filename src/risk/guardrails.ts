export interface RiskConfig {
  portfolioValueUsd: number;
  maxTradeSizeUsd: number;
  maxTradesPerDay: number;
}

export interface TradeAttempt {
  sizeUsd: number;
  timestamp: number;
}

export class DailyTradeCounter {
  private trades: TradeAttempt[] = [];

  record(sizeUsd: number, timestamp = Date.now()): void {
    this.trades.push({ sizeUsd, timestamp });
  }

  countToday(now = Date.now()): number {
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    return this.trades.filter((t) => t.timestamp >= dayStart.getTime()).length;
  }
}

export type RiskCheckResult =
  | { allowed: true }
  | { allowed: false; reason: string };

export function checkTradeAllowed(
  requestedSizeUsd: number,
  config: RiskConfig,
  counter: DailyTradeCounter,
  now = Date.now(),
): RiskCheckResult {
  if (requestedSizeUsd <= 0) {
    return { allowed: false, reason: "trade size must be positive" };
  }

  if (requestedSizeUsd > config.maxTradeSizeUsd) {
    return {
      allowed: false,
      reason: `requested size $${requestedSizeUsd} exceeds MAX_TRADE_SIZE_USD $${config.maxTradeSizeUsd}`,
    };
  }

  const tradesToday = counter.countToday(now);
  if (tradesToday >= config.maxTradesPerDay) {
    return {
      allowed: false,
      reason: `daily trade limit reached (${tradesToday}/${config.maxTradesPerDay})`,
    };
  }

  return { allowed: true };
}
