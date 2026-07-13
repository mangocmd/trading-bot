import { test } from "node:test";
import assert from "node:assert/strict";
import { checkTradeAllowed, DailyTradeCounter, type RiskConfig } from "./risk/guardrails.js";
import { MockExchangeAdapter } from "./exchange/mockAdapter.js";
import type { StrategyDecision } from "./strategy/evaluate.js";

// Simulates the webhook handler's decision -> risk check -> order pipeline
// without hitting the real Anthropic API, to verify the wiring end-to-end.
async function runPipeline(
  decision: StrategyDecision,
  riskConfig: RiskConfig,
  counter: DailyTradeCounter,
  exchange: MockExchangeAdapter,
) {
  if (decision.action === "hold") {
    return { status: "hold" as const };
  }

  const tradeSizeUsd = riskConfig.maxTradeSizeUsd;
  const riskCheck = checkTradeAllowed(tradeSizeUsd, riskConfig, counter);
  if (!riskCheck.allowed) {
    return { status: "blocked" as const, reason: riskCheck.reason };
  }

  const order = await exchange.placeOrder({
    symbol: "BTCUSDT",
    side: decision.action,
    sizeUsd: tradeSizeUsd,
  });

  if (order.status === "filled") {
    counter.record(tradeSizeUsd);
  }

  return { status: "executed" as const, order };
}

const riskConfig: RiskConfig = {
  portfolioValueUsd: 1000,
  maxTradeSizeUsd: 50,
  maxTradesPerDay: 3,
};

test("end-to-end: buy decision places a mock order", async () => {
  const counter = new DailyTradeCounter();
  const exchange = new MockExchangeAdapter();
  const result = await runPipeline(
    { action: "buy", confidence: 0.8, reasoning: "test" },
    riskConfig,
    counter,
    exchange,
  );
  assert.equal(result.status, "executed");
  assert.equal(counter.countToday(), 1);
});

test("end-to-end: hold decision places no order", async () => {
  const counter = new DailyTradeCounter();
  const exchange = new MockExchangeAdapter();
  const result = await runPipeline(
    { action: "hold", confidence: 0.5, reasoning: "test" },
    riskConfig,
    counter,
    exchange,
  );
  assert.equal(result.status, "hold");
  assert.equal(counter.countToday(), 0);
});

test("end-to-end: 4th trade in a day is blocked by risk guardrail", async () => {
  const counter = new DailyTradeCounter();
  const exchange = new MockExchangeAdapter();
  for (let i = 0; i < 3; i++) {
    await runPipeline({ action: "buy", confidence: 0.8, reasoning: "t" }, riskConfig, counter, exchange);
  }
  const result = await runPipeline(
    { action: "buy", confidence: 0.8, reasoning: "t" },
    riskConfig,
    counter,
    exchange,
  );
  assert.equal(result.status, "blocked");
  assert.equal(counter.countToday(), 3);
});
