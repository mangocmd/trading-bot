import { test } from "node:test";
import assert from "node:assert/strict";
import { checkTradeAllowed, DailyTradeCounter, type RiskConfig } from "./guardrails.js";

const config: RiskConfig = {
  portfolioValueUsd: 1000,
  maxTradeSizeUsd: 50,
  maxTradesPerDay: 3,
};

test("allows a trade within limits", () => {
  const counter = new DailyTradeCounter();
  const result = checkTradeAllowed(30, config, counter);
  assert.equal(result.allowed, true);
});

test("blocks a trade exceeding max size", () => {
  const counter = new DailyTradeCounter();
  const result = checkTradeAllowed(51, config, counter);
  assert.equal(result.allowed, false);
});

test("blocks a trade once daily limit is reached", () => {
  const counter = new DailyTradeCounter();
  counter.record(10);
  counter.record(10);
  counter.record(10);
  const result = checkTradeAllowed(10, config, counter);
  assert.equal(result.allowed, false);
  if (!result.allowed) {
    assert.match(result.reason, /daily trade limit/);
  }
});

test("blocks a non-positive trade size", () => {
  const counter = new DailyTradeCounter();
  const result = checkTradeAllowed(0, config, counter);
  assert.equal(result.allowed, false);
});
