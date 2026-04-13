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

function buildSingleTrackProjection(
  monthlyAmount: number,
  formatCurrency: (value: number) => string,
  label: string,
): string {
  if (monthlyAmount <= 0) return "";
  const month3 = formatCurrency(projectAmount(monthlyAmount, 3));
  const month6 = formatCurrency(projectAmount(monthlyAmount, 6));
  const month12 = formatCurrency(projectAmount(monthlyAmount, 12));
  return `Straight-line projection: 3 months = ${month3} ${label}, 6 months = ${month6}, 12 months = ${month12}.`;
}

function buildHybridProjection(
  debtAmount: number,
  cushionAmount: number,
  formatCurrency: (value: number) => string,
): string {
  const month3 = `3 months = ${formatCurrency(projectAmount(cushionAmount, 3))} cushion and ${formatCurrency(projectAmount(debtAmount, 3))} to debt`;
  const month6 = `6 months = ${formatCurrency(projectAmount(cushionAmount, 6))} cushion and ${formatCurrency(projectAmount(debtAmount, 6))} to debt`;
  const month12 = `12 months = ${formatCurrency(projectAmount(cushionAmount, 12))} cushion and ${formatCurrency(projectAmount(debtAmount, 12))} to debt`;
  return `Straight-line projection: ${month3}; ${month6}; ${month12}.`;
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
    const finalText = [
      `${deps.formatCurrency(monthlyIncome)} in and ${deps.formatCurrency(input.obligationsTotal)} out leaves ${deps.formatCurrency(gap)}/month.`,
      `My call: run both so we build safety and still push debt down — ${deps.formatCurrency(debtAmount)}/month to debt and ${deps.formatCurrency(cushionAmount)}/month to your emergency cash buffer (cushion).`,
      cushionRunwayLine,
      projectionLine,
      "What do you want to do with the gap: my recommended both split, debt-only, or cushion-only?",
    ]
      .filter(Boolean)
      .join(" ");

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
      return {
        finalText: `Done. ${deps.formatCurrency(spendableGap)}/month is now set to debt payoff. ${projectionLine} I’ll track it with you in check-ins.`,
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
        finalText: `Done. ${deps.formatCurrency(spendableGap)}/month is now set to your emergency cash buffer (cushion). ${projectionLine}`,
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
      finalText: `Done. I set a hybrid split: ${deps.formatCurrency(debtAmount)}/month to debt and ${deps.formatCurrency(cushionAmount)}/month to your emergency cash buffer (cushion).${cushionRunwayLine} ${projectionLine}`,
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
