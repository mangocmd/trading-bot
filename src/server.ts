import "dotenv/config";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { evaluateAlert, type TradingViewAlert } from "./strategy/evaluate.js";
import { createExchangeAdapter } from "./exchange/index.js";
import { checkTradeAllowed, DailyTradeCounter, type RiskConfig } from "./risk/guardrails.js";
import { appendTradeLog } from "./ledger/tradeLog.js";

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const exchange = createExchangeAdapter();
const dailyCounter = new DailyTradeCounter();

const riskConfig: RiskConfig = {
  portfolioValueUsd: Number(process.env.PORTFOLIO_VALUE_USD ?? 0),
  maxTradeSizeUsd: Number(process.env.MAX_TRADE_SIZE_USD ?? 0),
  maxTradesPerDay: Number(process.env.MAX_TRADES_PER_DAY ?? 0),
};

app.post("/webhook/tradingview", async (req, res) => {
  const body = req.body as TradingViewAlert & { secret?: string };

  if (body.secret !== process.env.WEBHOOK_SECRET) {
    res.status(401).json({ error: "invalid webhook secret" });
    return;
  }

  if (!body.symbol || typeof body.price !== "number") {
    res.status(400).json({ error: "alert must include symbol and price" });
    return;
  }

  console.log(`[webhook] received alert for ${body.symbol} @ ${body.price}`);

  const decision = await evaluateAlert(body, anthropic);
  console.log(`[strategy] decision: ${JSON.stringify(decision)}`);

  if (decision.action === "hold") {
    res.json({ status: "hold", decision });
    return;
  }

  const tradeSizeUsd = Math.min(
    riskConfig.maxTradeSizeUsd,
    riskConfig.portfolioValueUsd * ((decision.confidence ?? 1) * 0.01),
  ) || riskConfig.maxTradeSizeUsd;

  const riskCheck = checkTradeAllowed(tradeSizeUsd, riskConfig, dailyCounter);
  if (!riskCheck.allowed) {
    console.log(`[risk] blocked trade: ${riskCheck.reason}`);
    await appendTradeLog({
      exchange: exchange.name,
      symbol: body.symbol,
      side: decision.action,
      status: "blocked",
      sizeUsd: tradeSizeUsd,
      reasoning: decision.reasoning,
      blockedReason: riskCheck.reason,
    });
    res.json({ status: "blocked", reason: riskCheck.reason, decision });
    return;
  }

  const order = await exchange.placeOrder({
    symbol: body.symbol,
    side: decision.action,
    sizeUsd: tradeSizeUsd,
  });

  if (order.status === "filled") {
    dailyCounter.record(tradeSizeUsd);
  }

  await appendTradeLog({
    exchange: exchange.name,
    symbol: body.symbol,
    side: decision.action,
    status: order.status,
    sizeUsd: tradeSizeUsd,
    filledPrice: order.filledPrice,
    orderId: order.orderId,
    reasoning: decision.reasoning,
  });

  console.log(`[exchange:${exchange.name}] order result: ${JSON.stringify(order)}`);
  res.json({ status: "executed", decision, order });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, exchangeMode: exchange.name });
});

const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, () => {
  console.log(`trading-bot webhook server listening on :${PORT} (exchange mode: ${exchange.name})`);
});
