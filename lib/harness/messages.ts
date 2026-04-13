import { formatCurrency } from "@/lib/utils/money";
import { bold, escapeMarkdownV2 } from "@/lib/telegram/format";
import { roundMoney, sumMoney } from "@/lib/harness/calculations";

export interface CheckinUpcomingSubItem {
  merchant: string;
  amount: number;
  daysUntil: number;
}

export interface CheckinDebtProgressItem {
  accountName: string;
  currentBalance: number;
  previousBalance: number;
}

export interface CheckinMessagePayload {
  freeCashRemaining: number;
  spendingPaceNote: string;
  upcomingSubs: CheckinUpcomingSubItem[];
  debtProgress: CheckinDebtProgressItem[];
}

export function buildSpendingPaceNote(
  freeCashRemaining: number,
  monthlyGap: number | null,
): string {
  if (freeCashRemaining < 0) {
    return "Tough week.";
  }

  if (monthlyGap != null && monthlyGap > 0) {
    const weeklyBaseline = roundMoney(monthlyGap / 4);
    const delta = roundMoney(freeCashRemaining - weeklyBaseline);
    if (delta >= 150) {
      return `You're ahead of your weekly pace by ${formatCurrency(delta)}.`;
    }
    if (delta <= -150) {
      return `You're behind pace by ${formatCurrency(Math.abs(delta))}.`;
    }
    return "You're on pace this week.";
  }

  if (freeCashRemaining <= 200) {
    return "Tight week.";
  }
  return "You're on pace this week.";
}

function formatDaysUntil(daysUntil: number): string {
  if (daysUntil <= 0) return "today";
  if (daysUntil === 1) return "in 1 day";
  return `in ${daysUntil} days`;
}

function buildUpcomingLine(upcomingSubs: CheckinUpcomingSubItem[]): string | null {
  if (upcomingSubs.length === 0) return null;
  const sorted = [...upcomingSubs].sort(
    (a, b) => a.daysUntil - b.daysUntil || b.amount - a.amount,
  );
  const total = sumMoney(sorted.map((sub) => sub.amount));

  if (sorted.length === 1) {
    const only = sorted[0];
    return `${only.merchant} renews ${formatDaysUntil(only.daysUntil)} (${formatCurrency(only.amount)}).`;
  }

  const next = sorted[0];
  return `${sorted.length} subs renew in the next 5 days (${formatCurrency(total)} total). ${next.merchant} is next ${formatDaysUntil(next.daysUntil)} (${formatCurrency(next.amount)}).`;
}

function buildDebtLine(debtProgress: CheckinDebtProgressItem[]): string | null {
  if (debtProgress.length === 0) return null;
  const sorted = [...debtProgress].sort((a, b) => b.currentBalance - a.currentBalance);
  const primary = sorted[0];
  const change = roundMoney(primary.previousBalance - primary.currentBalance);

  if (change > 0) {
    return `${primary.accountName} is ${formatCurrency(primary.currentBalance)} (down ${formatCurrency(change)} since last check-in).`;
  }
  if (change < 0) {
    return `${primary.accountName} is ${formatCurrency(primary.currentBalance)} (up ${formatCurrency(Math.abs(change))} since last check-in).`;
  }
  return `${primary.accountName} is ${formatCurrency(primary.currentBalance)} (flat since last check-in).`;
}

export function renderCheckinMessage(payload: CheckinMessagePayload): string {
  const topLineSuffix = payload.freeCashRemaining >= 0 ? "left this week." : "over this week.";
  const lines: string[] = [bold(`${formatCurrency(payload.freeCashRemaining)} ${topLineSuffix}`)];

  if (payload.spendingPaceNote) {
    lines.push(escapeMarkdownV2(payload.spendingPaceNote));
  }

  const upcomingLine = buildUpcomingLine(payload.upcomingSubs);
  if (upcomingLine) {
    lines.push(escapeMarkdownV2(upcomingLine));
  }

  const debtLine = buildDebtLine(payload.debtProgress);
  if (debtLine) {
    lines.push(escapeMarkdownV2(debtLine));
  }

  return lines.join("\n");
}
