import assert from "node:assert/strict";
import type { ModelMessage } from "ai";
import { classifyIntent } from "../lib/agent/router.ts";
import { buildRoutedAction } from "../lib/agent/routing-plan.ts";
import { extractMoneyAmount } from "../lib/agent/router.ts";
import { computeGap } from "../lib/harness/calculations.ts";
import { formatCurrency } from "../lib/utils/money.ts";

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

const deps = { extractMoneyAmount, formatCurrency, computeGap };

async function main() {
  // ── Check-in loop regressions ──────────────────────────────────────

  await run("'hey' after bot answered 'keep these coming' does NOT route to checkin_keep", async () => {
    // The bot's OWN answer "Sounds good. I will keep these coming." should
    // NOT set pendingState to awaiting_checkin_preference on the next turn.
    const history = assistantHistory("Sounds good. I will keep these coming.");

    const result = await classifyIntent({
      text: "hey",
      phase: "stay_honest",
      conversationHistory: history,
      hasMonthlyIncome: true,
      allowLLMFallback: false,
    });

    assert.notEqual(result.intent, "checkin_keep");
    assert.notEqual(result.pendingState, "awaiting_checkin_preference");
  });

  await run("'huh?' after bot answered 'keep these coming' does NOT route to checkin_keep", async () => {
    const history = assistantHistory("Sounds good. I will keep these coming.");

    const result = await classifyIntent({
      text: "huh?",
      phase: "stay_honest",
      conversationHistory: history,
      hasMonthlyIncome: true,
      allowLLMFallback: false,
    });

    assert.notEqual(result.intent, "checkin_keep");
    assert.notEqual(result.pendingState, "awaiting_checkin_preference");
  });

  await run("'ok' after bot answered 'I will go quiet' does NOT route to checkin_quiet", async () => {
    const history = assistantHistory(
      "Got it. I will go quiet for now. Message me anytime to start back up.",
    );

    const result = await classifyIntent({
      text: "ok",
      phase: "stay_honest",
      conversationHistory: history,
      hasMonthlyIncome: true,
      allowLLMFallback: false,
    });

    assert.notEqual(result.intent, "checkin_quiet");
    assert.notEqual(result.pendingState, "awaiting_checkin_preference");
  });

  // ── Actual check-in questions still work ───────────────────────────

  await run("check-in question with '?' still triggers awaiting_checkin_preference", async () => {
    const history = assistantHistory(
      "You have $385.60 free. $269.92 to debt, $115.68 to cushion. Want me to keep these coming?",
    );

    const result = await classifyIntent({
      text: "yes",
      phase: "stay_honest",
      conversationHistory: history,
      hasMonthlyIncome: true,
      allowLLMFallback: false,
    });

    assert.equal(result.intent, "checkin_keep");
    assert.equal(result.pendingState, "awaiting_checkin_preference");
  });

  // ── Ambiguous short messages in income state ───────────────────────

  await run("'hey' during awaiting_income does NOT classify as income_report", async () => {
    const history = assistantHistory(
      "What's your monthly take-home? After taxes, what actually hits your account?",
    );

    const result = await classifyIntent({
      text: "hey",
      phase: "know_number",
      conversationHistory: history,
      hasMonthlyIncome: false,
      allowLLMFallback: false,
    });

    assert.notEqual(result.intent, "income_report");
  });

  await run("'what do you mean' during awaiting_income falls through to general_question", async () => {
    const history = assistantHistory(
      "What's your monthly take-home? After taxes, what actually hits your account?",
    );

    const result = await classifyIntent({
      text: "what do you mean",
      phase: "know_number",
      conversationHistory: history,
      hasMonthlyIncome: false,
      allowLLMFallback: false,
    });

    assert.equal(result.intent, "general_question");
  });

  // ── Ambiguous short messages in allocation state ───────────────────

  await run("'hmm' during awaiting_allocation does NOT classify as an allocation choice", async () => {
    const history = assistantHistory(
      "What do you want to do with the gap: my recommended both split, debt-only, or cushion-only?",
    );

    const result = await classifyIntent({
      text: "hmm",
      phase: "allocate",
      conversationHistory: history,
      hasMonthlyIncome: true,
      allowLLMFallback: false,
    });

    const allocationIntents = [
      "allocation_choice_debt",
      "allocation_choice_cushion",
      "allocation_choice_both",
    ];
    assert.ok(
      !allocationIntents.includes(result.intent),
      `Expected non-allocation intent, got ${result.intent}`,
    );
  });

  // ── Follow-up question after budget response ───────────────────────

  await run("question after allocation confirmation is classified as general_question", async () => {
    const history = assistantHistory(
      "Done. $350/month is now set to debt payoff. I'll track it with you in check-ins.",
    );

    const result = await classifyIntent({
      text: "how much total debt do I have?",
      phase: "stay_honest",
      conversationHistory: history,
      hasMonthlyIncome: true,
      allowLLMFallback: false,
    });

    assert.equal(result.intent, "general_question");
  });

  // ── Safety valve: low-confidence LLM intent skips routing ──────────

  await run("buildRoutedAction with checkin_keep returns canned text", () => {
    const action = buildRoutedAction(
      {
        userId: 1,
        phase: "stay_honest",
        intent: "checkin_keep",
        text: "",
        obligationsTotal: 2000,
        obligations: [],
        allocation: null,
      },
      deps,
    );

    assert.ok(action != null);
    assert.equal(action!.finalText, "Sounds good. I will keep these coming.");
  });

  await run("general_question intent does NOT produce a routed action", () => {
    const action = buildRoutedAction(
      {
        userId: 1,
        phase: "stay_honest",
        intent: "general_question",
        text: "how much debt do I have?",
        obligationsTotal: 2000,
        obligations: [],
        allocation: null,
      },
      deps,
    );

    assert.equal(action, null);
  });

  // ── Bot answer without '?' does not set any pending state ──────────

  await run("declarative bot answer does not trigger any pending state", async () => {
    const declarativeAnswers = [
      "Sounds good. I will keep these coming.",
      "Got it. I will go quiet for now. Message me anytime to start back up.",
      "Done. $350/month is now set to debt payoff.",
      "Done. I set a hybrid split: $245/month to debt and $105/month to your emergency cash buffer.",
    ];

    for (const answer of declarativeAnswers) {
      const result = await classifyIntent({
        text: "thanks",
        phase: "stay_honest",
        conversationHistory: assistantHistory(answer),
        hasMonthlyIncome: true,
        allowLLMFallback: false,
      });

      assert.equal(
        result.pendingState,
        "none",
        `Expected pendingState 'none' after "${answer.slice(0, 40)}...", got '${result.pendingState}'`,
      );
    }
  });

  console.log("All routing regression tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
