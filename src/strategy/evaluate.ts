import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface TradingViewAlert {
  symbol: string;
  price: number;
  indicators?: Record<string, number>;
  message?: string;
}

export type StrategyDecision =
  | { action: "buy" | "sell"; confidence: number; reasoning: string }
  | { action: "hold"; confidence: number; reasoning: string };

const RULES_PATH = path.resolve(process.cwd(), "config/rules.json");

async function loadRules(): Promise<string> {
  return readFile(RULES_PATH, "utf-8");
}

export async function evaluateAlert(
  alert: TradingViewAlert,
  anthropic: Anthropic,
): Promise<StrategyDecision> {
  const rules = await loadRules();

  const message = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 512,
    system:
      "You are a trading signal evaluator. You are given a strategy rule set and an incoming " +
      "market alert. Decide whether the alert satisfies the strategy's entry conditions. " +
      "Respond ONLY with JSON matching: " +
      '{"action": "buy" | "sell" | "hold", "confidence": 0-1, "reasoning": "short explanation"}. ' +
      "If the alert data is insufficient to confirm entry conditions, respond with hold.",
    messages: [
      {
        role: "user",
        content: `Strategy rules:\n${rules}\n\nIncoming alert:\n${JSON.stringify(alert, null, 2)}`,
      },
    ],
  });

  const textBlock = message.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    return { action: "hold", confidence: 0, reasoning: "no text response from model" };
  }

  try {
    const parsed = JSON.parse(textBlock.text);
    if (parsed.action !== "buy" && parsed.action !== "sell" && parsed.action !== "hold") {
      return { action: "hold", confidence: 0, reasoning: "model returned invalid action" };
    }
    return parsed;
  } catch {
    return { action: "hold", confidence: 0, reasoning: "failed to parse model response as JSON" };
  }
}
