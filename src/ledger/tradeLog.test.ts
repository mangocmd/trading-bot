import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { appendTradeLog, TRADE_LOG_PATH } from "./tradeLog.js";

test("writes a header and a filled trade row", async () => {
  await rm(TRADE_LOG_PATH, { force: true });

  await appendTradeLog({
    exchange: "mock",
    symbol: "BTCUSDT",
    side: "buy",
    status: "filled",
    sizeUsd: 50,
    filledPrice: 100,
    orderId: "mock-1",
    reasoning: "test entry",
  });

  const content = await readFile(TRADE_LOG_PATH, "utf-8");
  const lines = content.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^timestamp,exchange,symbol/);
  assert.match(lines[1], /mock,BTCUSDT,buy,filled,50\.00,100\.00,0\.50,49\.50,mock-1/);

  await rm(TRADE_LOG_PATH, { force: true });
});

test("logs a blocked trade with the risk reason", async () => {
  await rm(TRADE_LOG_PATH, { force: true });

  await appendTradeLog({
    exchange: "mock",
    symbol: "ETHUSDT",
    side: "sell",
    status: "blocked",
    sizeUsd: 999,
    blockedReason: "daily trade limit reached (3/3)",
  });

  const content = await readFile(TRADE_LOG_PATH, "utf-8");
  assert.match(content, /blocked/);
  assert.match(content, /daily trade limit reached/);

  await rm(TRADE_LOG_PATH, { force: true });
});
