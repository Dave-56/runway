import type { Intent } from "./router";

type UserPhase = "know_number" | "allocate" | "stay_honest";

interface AllocationSnapshot {
  monthlyIncome: number | null;
  gap: number | null;
}

interface ObligationSnapshot {
  merchantName: string;
  amount: number;
}

export interface BuildRoutedActionInput {
  userId: number;
  phase: UserPhase;
  intent: Intent;
  text: string;
  obligationsTotal: number;
  obligations: ObligationSnapshot[];
  allocation: AllocationSnapshot | null;
  debtCount?: number;
}

export interface BuildRoutedActionDeps {
  extractMoneyAmount: (text: string) => number | null;
  formatCurrency: (value: number) => string;
  computeGap: (monthlyIncome: number, obligationsTotal: number) => number;
}

type Strategy = "avalanche" | "snowball" | "hybrid" | "none";

export interface RoutedAction {
  finalText: string;
  reactivateIfSilent?: boolean;
  userUpdate?: {
    active?: boolean;
    ignoredCheckins?: number;
    phase?: UserPhase;
  };
  allocationUpdate?: {
    userId: number;
    monthlyIncome?: number;
    obligationsTotal: number;
    gap: number;
    debtAmount?: number;
    cushionAmount?: number;
    livingAmount?: number;
    strategy?: Strategy;
  };
}

function roundToCents(value: number): number {
  return Math.round(value * 100) / 100;
}

function sumAmounts(values: number[]): number {
  return roundToCents(values.reduce((sum, value) => sum + value, 0));
}

function projectAmount(monthlyAmount: number, months: number): number {
  return roundToCents(Math.max(0, monthlyAmount) * months);
}

const SIMULATION_STEPS = [
  { days: 30, months: 1 },
  { days: 90, months: 3 },
  { days: 180, months: 6 },
  { days: 365, months: 12 },
] as const;

function monthLabel(months: number): string {
  return months === 1 ? "month" : "months";
}

function buildSingleTrackProjection(
  monthlyAmount: number,
  formatCurrency: (value: number) => string,
  label: string,
): string {
  if (monthlyAmount <= 0) return "";
  const lines = SIMULATION_STEPS.map((step) => {
    const projected = formatCurrency(projectAmount(monthlyAmount, step.months));
    return `${step.days} days (~${step.months} ${monthLabel(step.months)}): ${projected} ${label}`;
  });
  return ["Simulation snapshot if you stay consistent:", ...lines].join("\n");
}

function buildHybridProjection(
  debtAmount: number,
  cushionAmount: number,
  formatCurrency: (value: number) => string,
): string {
  const lines = SIMULATION_STEPS.map((step) => {
    const projectedCushion = formatCurrency(projectAmount(cushionAmount, step.months));
    const projectedDebt = formatCurrency(projectAmount(debtAmount, step.months));
    return `${step.days} days (~${step.months} ${monthLabel(step.months)}): ${projectedCushion} in emergency cash buffer and ${projectedDebt} toward debt`;
  });
  return ["Simulation snapshot if you stay consistent:", ...lines].join("\n");
}

function getHybridSplit(gap: number): { debtAmount: number; cushionAmount: number; livingAmount: number } {
  const spendableGap = Math.max(0, gap);
  const debtAmount = roundToCents(spendableGap * 0.7);
  const cushionAmount = roundToCents(spendableGap * 0.3);
  const livingAmount = roundToCents(spendableGap - debtAmount - cushionAmount);
  return { debtAmount, cushionAmount, livingAmount };
}

function sortObligations(obligations: ObligationSnapshot[]): ObligationSnapshot[] {
  return [...obligations].sort((a, b) => b.amount - a.amount);
}

function hasDebtLikeObligation(obligations: ObligationSnapshot[]): boolean {
  return obligations.some((item) =>
    /(credit card|card payment|loan|student loan|mortgage)/i.test(item.merchantName),
  );
}

function buildOnboardingTopMessage(
  obligations: ObligationSnapshot[],
  obligationsTotal: number,
  formatCurrency: (value: number) => string,
): string {
  const sorted = sortObligations(obligations);
  const count = sorted.length;

  if (count === 0) {
    return "Got your accounts linked, but I could not find recurring charges yet. What's your monthly take-home? After taxes, the number that actually hits your account.";
  }

  if (count <= 4) {
    const lines = sorted.map((item) => `${item.merchantName} — ${formatCurrency(item.amount)}`);
    return [
      `Got your accounts linked. You've got ${count} recurring ${count === 1 ? "charge" : "charges"} pulling from your checking.`,
      "",
      "Here's what I found:",
      ...lines,
      "",
      `All together, your monthly obligations are ${formatCurrency(obligationsTotal)}.`,
      "",
      "What's your monthly take-home? After taxes, the number that actually hits your account.",
    ].join("\n");
  }

  const top = sorted.slice(0, 4);
  const topTotal = sumAmounts(top.map((item) => item.amount));
  const lines = top.map((item) => `${item.merchantName} — ${formatCurrency(item.amount)}`);
  return [
    `Got your accounts linked. You've got ${count} recurring charges pulling from your checking.`,
    "",
    "The big ones:",
    ...lines,
    "",
    `Those 4 alone are ${formatCurrency(topTotal)}/month. Want to see the rest?`,
  ].join("\n");
}

function buildOnboardingRemainingMessage(
  obligations: ObligationSnapshot[],
  obligationsTotal: number,
  formatCurrency: (value: number) => string,
): string {
  const sorted = sortObligations(obligations);
  if (sorted.length === 0) {
    return "I still don't see recurring charges in your account data. What's your monthly take-home after taxes?";
  }

  const lines = sorted.map((item) => `${item.merchantName} — ${formatCurrency(item.amount)}`);
  return [
    "Here's the full list:",
    "",
    ...lines,
    "",
    `All together, your monthly obligations are ${formatCurrency(obligationsTotal)}.`,
    "",
    "What's your monthly take-home? After taxes, the number that actually hits your account.",
  ].join("\n");
}

export function resolveCurrentGap(
  allocation: AllocationSnapshot | null,
  obligationsTotal: number,
  computeGap: (monthlyIncome: number, obligationsTotal: number) => number,
): number | null {
  if (!allocation) return null;
  if (allocation.gap != null) return allocation.gap;
  if (allocation.monthlyIncome == null) return null;
  return computeGap(allocation.monthlyIncome, obligationsTotal);
}

export function buildRoutedAction(
  input: BuildRoutedActionInput,
  deps: BuildRoutedActionDeps,
): RoutedAction | null {
  if (
    input.intent === "onboarding_bank_linked" &&
    input.phase === "know_number"
  ) {
    return {
      finalText: buildOnboardingTopMessage(
        input.obligations,
        input.obligationsTotal,
        deps.formatCurrency,
      ),
    };
  }

  if (
    input.intent === "show_remaining_obligations" &&
    input.phase === "know_number"
  ) {
    return {
      finalText: buildOnboardingRemainingMessage(
        input.obligations,
        input.obligationsTotal,
        deps.formatCurrency,
      ),
    };
  }

  if (input.intent === "checkin_keep") {
    return {
      finalText: "Sounds good. I will keep these coming.",
      reactivateIfSilent: false,
      userUpdate: { active: true, ignoredCheckins: 0 },
    };
  }

  if (input.intent === "checkin_quiet") {
    return {
      finalText: "Got it. I will go quiet for now. Message me anytime to start back up.",
      reactivateIfSilent: false,
      userUpdate: { active: false, ignoredCheckins: 0 },
    };
  }

  if (input.intent === "income_report" && input.phase === "know_number") {
    const parsedIncome = deps.extractMoneyAmount(input.text);
    if (parsedIncome == null) return null;

    const monthlyIncome = roundToCents(parsedIncome);
    const gap = deps.computeGap(monthlyIncome, input.obligationsTotal);
    const hasDebtAccounts = (input.debtCount ?? 0) > 0;
    const hasDebtLikeFlows = hasDebtLikeObligation(input.obligations);

    if (!hasDebtAccounts) {
      const cushionRunwayMonths = gap > 0 ? Math.ceil(1000 / gap) : null;
      const cushionRunwayLine = cushionRunwayMonths
        ? `At that pace, you stack a $1,000 cushion in about ${cushionRunwayMonths} month${cushionRunwayMonths === 1 ? "" : "s"}.`
        : "";
      const projectionLine = buildSingleTrackProjection(
        gap,
        deps.formatCurrency,
        "in your emergency cash buffer (cushion)",
      );
      const debtContextLine = hasDebtLikeFlows
        ? "I can see debt-like payment flows in recurring charges, but I still don't have linked debt balances/APRs yet."
        : "I still don't have linked debt balances/APRs yet.";

      return {
        finalText: [
          `${deps.formatCurrency(monthlyIncome)} in and ${deps.formatCurrency(input.obligationsTotal)} out leaves ${deps.formatCurrency(gap)}/month.`,
          `${debtContextLine} So I can't build a true payoff order yet.`,
          `My call for now: put ${deps.formatCurrency(Math.max(0, gap))}/month into your emergency cash buffer (cushion) until debt balances sync.`,
          cushionRunwayLine,
          projectionLine,
          "What do you want to do with the gap for now: cushion-only until balances sync, or both as a temporary split?",
        ]
          .filter(Boolean)
          .join("\n"),
        userUpdate: { phase: "allocate" },
        allocationUpdate: {
          userId: input.userId,
          monthlyIncome,
          obligationsTotal: input.obligationsTotal,
          gap,
        },
      };
    }

    const { debtAmount, cushionAmount } = getHybridSplit(gap);
    const monthsToThousand =
      cushionAmount > 0 ? Math.ceil(1000 / cushionAmount) : null;
    const cushionRunwayLine = monthsToThousand
      ? `At that pace, you stack a $1,000 cushion in about ${monthsToThousand} month${monthsToThousand === 1 ? "" : "s"}.`
      : "";
    const projectionLine = buildHybridProjection(
      debtAmount,
      cushionAmount,
      deps.formatCurrency,
    );
    const summaryLines = [
      `${deps.formatCurrency(monthlyIncome)} in and ${deps.formatCurrency(input.obligationsTotal)} out leaves ${deps.formatCurrency(gap)}/month.`,
      `My call: run both so we build safety and still push debt down — ${deps.formatCurrency(debtAmount)}/month to debt and ${deps.formatCurrency(cushionAmount)}/month to your emergency cash buffer (cushion).`,
      cushionRunwayLine,
      "",
      projectionLine,
      "",
      "What do you want to do with the gap: my recommended both split, debt-only, or cushion-only?",
    ].filter((line) => line !== "");
    const finalText = summaryLines.join("\n");

    return {
      finalText,
      userUpdate: { phase: "allocate" },
      allocationUpdate: {
        userId: input.userId,
        monthlyIncome,
        obligationsTotal: input.obligationsTotal,
        gap,
      },
    };
  }

  if (
    input.phase === "allocate" &&
    (input.intent === "allocation_choice_debt" ||
      input.intent === "allocation_choice_cushion" ||
      input.intent === "allocation_choice_both")
  ) {
    const currentGap = resolveCurrentGap(
      input.allocation,
      input.obligationsTotal,
      deps.computeGap,
    );

    if (currentGap == null) {
      return {
        finalText:
          "I need your monthly take-home first so we can set the split. Share the amount that hits your account after taxes.",
      };
    }

    const spendableGap = Math.max(0, currentGap);
    const monthlyIncome = input.allocation?.monthlyIncome ?? null;
    const baseAllocation = {
      userId: input.userId,
      monthlyIncome: monthlyIncome ?? undefined,
      obligationsTotal: input.obligationsTotal,
      gap: currentGap,
    };

    if (input.intent === "allocation_choice_debt") {
      const projectionLine = buildSingleTrackProjection(
        spendableGap,
        deps.formatCurrency,
        "to debt",
      );
      const noDebtContext =
        (input.debtCount ?? 0) > 0
          ? ""
          : "I still don't have linked debt balances/APRs, so this is a temporary generic debt allocation until balances sync.";
      return {
        finalText: [
          noDebtContext,
          `Done. ${deps.formatCurrency(spendableGap)}/month is now set to debt payoff.`,
          projectionLine,
          "I’ll track it with you in check-ins.",
        ]
          .filter(Boolean)
          .join("\n"),
        userUpdate: { phase: "stay_honest" },
        allocationUpdate: {
          ...baseAllocation,
          debtAmount: roundToCents(spendableGap),
          cushionAmount: 0,
          livingAmount: 0,
          strategy: "avalanche",
        },
      };
    }

    if (input.intent === "allocation_choice_cushion") {
      const projectionLine = buildSingleTrackProjection(
        spendableGap,
        deps.formatCurrency,
        "in your emergency cash buffer (cushion)",
      );
      return {
        finalText: [
          `Done. ${deps.formatCurrency(spendableGap)}/month is now set to your emergency cash buffer (cushion).`,
          projectionLine,
        ].join("\n"),
        userUpdate: { phase: "stay_honest" },
        allocationUpdate: {
          ...baseAllocation,
          debtAmount: 0,
          cushionAmount: roundToCents(spendableGap),
          livingAmount: 0,
          strategy: "none",
        },
      };
    }

    const { debtAmount, cushionAmount, livingAmount } = getHybridSplit(spendableGap);
    const monthsToThousand =
      cushionAmount > 0 ? Math.ceil(1000 / cushionAmount) : null;
    const cushionRunwayLine = monthsToThousand
      ? ` At this pace, you stack a $1,000 cushion in about ${monthsToThousand} month${monthsToThousand === 1 ? "" : "s"}.`
      : "";
    const projectionLine = buildHybridProjection(
      debtAmount,
      cushionAmount,
      deps.formatCurrency,
    );

    return {
      finalText: [
        (input.debtCount ?? 0) > 0
          ? ""
          : "I still don't have linked debt balances/APRs, so this is a temporary split until balances sync.",
        `Done. I set a hybrid split: ${deps.formatCurrency(debtAmount)}/month to debt and ${deps.formatCurrency(cushionAmount)}/month to your emergency cash buffer (cushion).`,
        cushionRunwayLine.trim(),
        projectionLine,
      ]
        .filter(Boolean)
        .join("\n"),
      userUpdate: { phase: "stay_honest" },
      allocationUpdate: {
        ...baseAllocation,
        debtAmount,
        cushionAmount,
        livingAmount,
        strategy: "hybrid",
      },
    };
  }

  return null;
}
