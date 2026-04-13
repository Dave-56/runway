import assert from "node:assert/strict";
import { renderCheckinMessage } from "../lib/harness/messages.ts";

function run(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

run("deterministic check-in renderer applies strict conversational voice profile", () => {
  const text = renderCheckinMessage(
    {
      freeCashRemaining: 420,
      spendingPaceNote: "You're behind pace by $180.",
      upcomingSubs: [
        { merchant: "Netflix", amount: 19.99, daysUntil: 2 },
        { merchant: "Apple", amount: 9.99, daysUntil: 1 },
      ],
      debtProgress: [
        { accountName: "Chase", currentBalance: 6940, previousBalance: 7100 },
      ],
    },
    {
      userName: "David",
      conversational: true,
      allowSlang: true,
      slightlyJudgmental: true,
      realistic: true,
      strictCoach: true,
    },
  );

  assert.match(text, /That's a leak we need to shut down/);
  assert.match(text, /subs hit in the next 5 days/);
  assert.match(text, /sits at/);
  assert.ok(text.startsWith("*$420 left this week\\.*"));
});

console.log("All harness message tests passed.");
