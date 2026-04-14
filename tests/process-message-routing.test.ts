import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildRoutedAction } from "../lib/agent/routing-plan.ts";
import { extractMoneyAmount } from "../lib/agent/router.ts";
import { computeGap } from "../lib/harness/calculations.ts";
import { formatCurrency, normalizeToMonthly } from "../lib/utils/money.ts";

type FixtureStream = {
  average_amount?: { amount?: number };
  frequency?: string;
  is_active?: boolean;
};

type RecurringFixture = {
  outflow_streams: FixtureStream[];
  inflow_streams: FixtureStream[];
};

async function run(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

function toAppFrequency(raw: string): string {
  const value = raw.toLowerCase();
  if (value === "semi_monthly" || value === "semimonthly") return "biweekly";
  if (value === "yearly") return "annually";
  return value;
}

function getMonthlyTotal(streams: FixtureStream[]): number {
  return Math.round(
    streams
      .filter((s) => s.is_active !== false)
      .reduce((sum, stream) => {
        const amount = stream.average_amount?.amount ?? 0;
        const frequency = toAppFrequency(stream.frequency || "monthly");
        return sum + normalizeToMonthly(amount, frequency);
      }, 0) * 100,
  ) / 100;
}

function loadRecurringFixture(): RecurringFixture {
  const path = new URL(
    "./fixtures/plaid/transactions-recurring-get.sandbox.json",
    import.meta.url,
  );
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as RecurringFixture;
}

async function main() {
  const fixture = loadRecurringFixture();
  const obligationsTotal = getMonthlyTotal(fixture.outflow_streams);
  const monthlyIncome = getMonthlyTotal(fixture.inflow_streams);

  await run("plaid sandbox fixture monthly totals stay deterministic", () => {
    assert.equal(obligationsTotal, 2825.98);
    assert.equal(monthlyIncome, 6893);
  });

  await run("onboarding_bank_linked route sends deterministic top-obligations reveal", () => {
    const obligations = [
      { merchantName: "Rent", amount: 2100 },
      { merchantName: "Car payment", amount: 487 },
      { merchantName: "Student loans", amount: 312 },
      { merchantName: "Insurance", amount: 195 },
      { merchantName: "Spotify", amount: 12.99 },
    ];

    const action = buildRoutedAction(
      {
        userId: 99,
        phase: "know_number",
        intent: "onboarding_bank_linked",
        text: "",
        obligationsTotal: 3106.99,
        obligations,
        debtCount: 2,
        allocation: null,
      },
      { extractMoneyAmount, formatCurrency, computeGap },
    );

    assert.ok(action);
    assert.match(action.finalText, /Got your accounts linked/i);
    assert.match(action.finalText, /The big ones:/i);
    assert.match(action.finalText, /Rent — \$2,100/);
    assert.match(action.finalText, /Want to see the rest\?/i);
  });

  await run("show_remaining_obligations route sends full list and asks for income", () => {
    const obligations = [
      { merchantName: "Rent", amount: 2100 },
      { merchantName: "Car payment", amount: 487 },
      { merchantName: "Student loans", amount: 312 },
    ];

    const action = buildRoutedAction(
      {
        userId: 99,
        phase: "know_number",
        intent: "show_remaining_obligations",
        text: "yes",
        obligationsTotal: 2899,
        obligations,
        debtCount: 2,
        allocation: null,
      },
      { extractMoneyAmount, formatCurrency, computeGap },
    );

    assert.ok(action);
    assert.match(action.finalText, /Here's the full list:/i);
    assert.match(action.finalText, /All together, your monthly obligations are \$2,899/i);
    assert.match(action.finalText, /What's your monthly take-home/i);
  });

  await run("income_report route builds deterministic allocation update", () => {
    const action = buildRoutedAction(
      {
        userId: 99,
        phase: "know_number",
        intent: "income_report",
        text: "$6,893",
        obligationsTotal,
        obligations: [],
        debtCount: 2,
        allocation: null,
      },
      { extractMoneyAmount, formatCurrency, computeGap },
    );

    assert.ok(action);
    assert.equal(action.userUpdate?.phase, "allocate");
    assert.equal(action.allocationUpdate?.monthlyIncome, monthlyIncome);
    assert.equal(action.allocationUpdate?.obligationsTotal, obligationsTotal);
    assert.equal(action.allocationUpdate?.gap, 4067.02);
    assert.match(action.finalText, /\$6,893/);
    assert.match(action.finalText, /\$2,825\.98/);
    assert.match(action.finalText, /\$4,067\.02/);
    assert.match(action.finalText, /My call: run both/i);
    assert.match(action.finalText, /emergency cash buffer \(cushion\)/i);
    assert.match(action.finalText, /Simulation snapshot if you stay consistent:/i);
    assert.match(action.finalText, /30 days/i);
    assert.match(action.finalText, /365 days/i);
    assert.match(action.finalText, /recommended both split/i);
  });

  await run("allocation_choice_debt route sets full spendable gap to debt", () => {
    const action = buildRoutedAction(
      {
        userId: 99,
        phase: "allocate",
        intent: "allocation_choice_debt",
        text: "debt",
        obligationsTotal,
        obligations: [],
        debtCount: 2,
        allocation: {
          monthlyIncome,
          gap: computeGap(monthlyIncome, obligationsTotal),
        },
      },
      { extractMoneyAmount, formatCurrency, computeGap },
    );

    assert.ok(action?.allocationUpdate);
    assert.equal(action?.userUpdate?.phase, "stay_honest");
    assert.equal(action?.allocationUpdate?.debtAmount, 4067.02);
    assert.equal(action?.allocationUpdate?.cushionAmount, 0);
    assert.equal(action?.allocationUpdate?.livingAmount, 0);
    assert.equal(action?.allocationUpdate?.strategy, "avalanche");
    assert.match(action?.finalText || "", /Simulation snapshot if you stay consistent:/i);
    assert.match(action?.finalText || "", /90 days/i);
  });

  await run("allocation_choice_both route applies deterministic 70/30 split", () => {
    const action = buildRoutedAction(
      {
        userId: 99,
        phase: "allocate",
        intent: "allocation_choice_both",
        text: "both",
        obligationsTotal,
        obligations: [],
        debtCount: 2,
        allocation: {
          monthlyIncome,
          gap: computeGap(monthlyIncome, obligationsTotal),
        },
      },
      { extractMoneyAmount, formatCurrency, computeGap },
    );

    assert.ok(action?.allocationUpdate);
    assert.equal(action?.allocationUpdate?.debtAmount, 2846.91);
    assert.equal(action?.allocationUpdate?.cushionAmount, 1220.11);
    assert.equal(action?.allocationUpdate?.livingAmount, 0);
    assert.equal(action?.allocationUpdate?.strategy, "hybrid");
    assert.match(action?.finalText || "", /emergency cash buffer \(cushion\)/i);
    assert.match(action?.finalText || "", /Simulation snapshot if you stay consistent:/i);
    assert.match(action?.finalText || "", /180 days/i);
  });

  await run("allocation intent without income returns deterministic prompt", () => {
    const action = buildRoutedAction(
      {
        userId: 99,
        phase: "allocate",
        intent: "allocation_choice_cushion",
        text: "cushion",
        obligationsTotal,
        obligations: [],
        debtCount: 0,
        allocation: null,
      },
      { extractMoneyAmount, formatCurrency, computeGap },
    );

    assert.ok(action);
    assert.equal(action.userUpdate, undefined);
    assert.equal(action.allocationUpdate, undefined);
    assert.match(action.finalText, /need your monthly take-home/i);
  });

  await run("checkin_quiet route remains deterministic and non-reactivating", () => {
    const action = buildRoutedAction(
      {
        userId: 99,
        phase: "stay_honest",
        intent: "checkin_quiet",
        text: "",
        obligationsTotal,
        obligations: [],
        debtCount: 0,
        allocation: null,
      },
      { extractMoneyAmount, formatCurrency, computeGap },
    );

    assert.ok(action);
    assert.equal(action.userUpdate?.active, false);
    assert.equal(action.userUpdate?.ignoredCheckins, 0);
    assert.equal(action.reactivateIfSilent, false);
  });

  await run("non-routed intents return null action", () => {
    const action = buildRoutedAction(
      {
        userId: 99,
        phase: "stay_honest",
        intent: "general_question",
        text: "what is my balance?",
        obligationsTotal,
        obligations: [],
        debtCount: 0,
        allocation: null,
      },
      { extractMoneyAmount, formatCurrency, computeGap },
    );
    assert.equal(action, null);
  });

  await run("income_report without linked debt accounts defaults to cushion-first guidance", () => {
    const action = buildRoutedAction(
      {
        userId: 99,
        phase: "know_number",
        intent: "income_report",
        text: "$500",
        obligationsTotal: 114.4,
        obligations: [{ merchantName: "CREDIT CARD 3333 PAYMENT *//", amount: 25 }],
        debtCount: 0,
        allocation: null,
      },
      { extractMoneyAmount, formatCurrency, computeGap },
    );

    assert.ok(action);
    assert.match(action.finalText, /debt-like payment flows/i);
    assert.match(action.finalText, /can't build a true payoff order yet/i);
    assert.match(action.finalText, /cushion-only until balances sync/i);
  });

  console.log("All process-message routing regression tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
