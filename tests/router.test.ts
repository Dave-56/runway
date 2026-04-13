import assert from "node:assert/strict";
import type { ModelMessage } from "ai";
import {
  classifyIntent,
  extractMoneyAmount,
  BANK_LINKED_SIGNAL,
} from "../lib/agent/router.ts";

function assistantHistory(text: string): ModelMessage[] {
  return [{ role: "assistant", content: text }];
}

async function run(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function main() {
  await run("maps check-in callback intents deterministically", async () => {
    const keep = await classifyIntent({
      text: "",
      phase: "stay_honest",
      callbackData: "checkin_keep",
      conversationHistory: [],
      hasMonthlyIncome: true,
      allowLLMFallback: false,
    });

    const quiet = await classifyIntent({
      text: "",
      phase: "stay_honest",
      callbackData: "checkin_quiet",
      conversationHistory: [],
      hasMonthlyIncome: true,
      allowLLMFallback: false,
    });

    assert.equal(keep.intent, "checkin_keep");
    assert.equal(keep.source, "deterministic");
    assert.equal(quiet.intent, "checkin_quiet");
    assert.equal(quiet.source, "deterministic");
  });

  await run("maps bank-linked signal to onboarding intent deterministically", async () => {
    const result = await classifyIntent({
      text: BANK_LINKED_SIGNAL,
      phase: "know_number",
      conversationHistory: [],
      hasMonthlyIncome: false,
      allowLLMFallback: false,
    });

    assert.equal(result.intent, "onboarding_bank_linked");
    assert.equal(result.source, "deterministic");
  });

  await run("classifies short income reply when pending state is awaiting income", async () => {
    const result = await classifyIntent({
      text: "$5,200",
      phase: "know_number",
      conversationHistory: assistantHistory(
        "What's your monthly take-home? After taxes, what actually hits your account?",
      ),
      hasMonthlyIncome: false,
      allowLLMFallback: false,
    });

    assert.equal(result.intent, "income_report");
    assert.equal(result.source, "deterministic");
    assert.equal(result.pendingState, "awaiting_income");
  });

  await run("classifies income when explicit income cue is present", async () => {
    const result = await classifyIntent({
      text: "I make 5200 a month",
      phase: "know_number",
      conversationHistory: [],
      hasMonthlyIncome: false,
      allowLLMFallback: false,
    });

    assert.equal(result.intent, "income_report");
    assert.equal(result.source, "deterministic");
  });

  await run("classifies allocation intents while waiting for allocation choice", async () => {
    const pending = assistantHistory(
      "Do you want that gap going to attack debt, build a cushion, or both?",
    );

    const both = await classifyIntent({
      text: "both",
      phase: "allocate",
      conversationHistory: pending,
      hasMonthlyIncome: true,
      allowLLMFallback: false,
    });
    const debt = await classifyIntent({
      text: "debt first",
      phase: "allocate",
      conversationHistory: pending,
      hasMonthlyIncome: true,
      allowLLMFallback: false,
    });
    const cushion = await classifyIntent({
      text: "build my emergency cushion",
      phase: "allocate",
      conversationHistory: pending,
      hasMonthlyIncome: true,
      allowLLMFallback: false,
    });

    assert.equal(both.intent, "allocation_choice_both");
    assert.equal(debt.intent, "allocation_choice_debt");
    assert.equal(cushion.intent, "allocation_choice_cushion");
  });

  await run("classifies check-in preference replies from pending prompt", async () => {
    const pending = assistantHistory(
      "Been a couple weeks. Want me to keep these coming or go quiet for a bit?",
    );

    const keep = await classifyIntent({
      text: "yes keep them coming",
      phase: "stay_honest",
      conversationHistory: pending,
      hasMonthlyIncome: true,
      allowLLMFallback: false,
    });
    const quiet = await classifyIntent({
      text: "go quiet for now",
      phase: "stay_honest",
      conversationHistory: pending,
      hasMonthlyIncome: true,
      allowLLMFallback: false,
    });

    assert.equal(keep.intent, "checkin_keep");
    assert.equal(quiet.intent, "checkin_quiet");
  });

  await run("defaults empty non-callback messages to unknown", async () => {
    const result = await classifyIntent({
      text: "   ",
      phase: "stay_honest",
      conversationHistory: [],
      hasMonthlyIncome: true,
      allowLLMFallback: false,
    });

    assert.equal(result.intent, "unknown");
    assert.equal(result.source, "default");
  });

  await run("classifies direct questions as general questions", async () => {
    const result = await classifyIntent({
      text: "What is my checking balance?",
      phase: "stay_honest",
      conversationHistory: [],
      hasMonthlyIncome: true,
      allowLLMFallback: false,
    });

    assert.equal(result.intent, "general_question");
    assert.equal(result.source, "deterministic");
  });

  await run("extractMoneyAmount parses dollars and plain numeric values", () => {
    assert.equal(extractMoneyAmount("$4,750.50"), 4750.5);
    assert.equal(extractMoneyAmount("my income is 5200"), 5200);
    assert.equal(extractMoneyAmount("no amount here"), null);
  });

  console.log("All router tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
