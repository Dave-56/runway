import { formatCurrency } from "../utils/money.ts";
import { bold, escapeMarkdownV2 } from "../telegram/format.ts";
import { roundMoney, sumMoney } from "./calculations.ts";

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

export interface CheckinVoiceProfile {
  userName?: string;
  conversational: boolean;
  allowSlang: boolean;
  slightlyJudgmental: boolean;
  realistic: boolean;
  strictCoach: boolean;
}

function defaultVoiceProfile(): CheckinVoiceProfile {
  return {
    conversational: false,
    allowSlang: false,
    slightlyJudgmental: false,
    realistic: true,
    strictCoach: false,
  };
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

function buildUpcomingLine(
  upcomingSubs: CheckinUpcomingSubItem[],
  voice: CheckinVoiceProfile,
): string | null {
  if (upcomingSubs.length === 0) return null;
  const sorted = [...upcomingSubs].sort(
    (a, b) => a.daysUntil - b.daysUntil || b.amount - a.amount,
  );
  const total = sumMoney(sorted.map((sub) => sub.amount));
  const singularVerb = voice.allowSlang || voice.conversational ? "hits" : "renews";
  const pluralVerb = voice.allowSlang || voice.conversational ? "hit" : "renew";

  if (sorted.length === 1) {
    const only = sorted[0];
    return `${only.merchant} ${singularVerb} ${formatDaysUntil(only.daysUntil)} (${formatCurrency(only.amount)}).`;
  }

  const next = sorted[0];
  return `${sorted.length} subs ${pluralVerb} in the next 5 days (${formatCurrency(total)} total). ${next.merchant} is next ${formatDaysUntil(next.daysUntil)} (${formatCurrency(next.amount)}).`;
}

function buildDebtLine(
  debtProgress: CheckinDebtProgressItem[],
  voice: CheckinVoiceProfile,
): string | null {
  if (debtProgress.length === 0) return null;
  const sorted = [...debtProgress].sort((a, b) => b.currentBalance - a.currentBalance);
  const primary = sorted[0];
  const change = roundMoney(primary.previousBalance - primary.currentBalance);
  const isConversational = voice.conversational || voice.allowSlang;

  if (change > 0) {
    return isConversational
      ? `${primary.accountName} sits at ${formatCurrency(primary.currentBalance)} (down ${formatCurrency(change)} since last check-in).`
      : `${primary.accountName} is ${formatCurrency(primary.currentBalance)} (down ${formatCurrency(change)} since last check-in).`;
  }
  if (change < 0) {
    return isConversational
      ? `${primary.accountName} sits at ${formatCurrency(primary.currentBalance)} (up ${formatCurrency(Math.abs(change))} since last check-in).`
      : `${primary.accountName} is ${formatCurrency(primary.currentBalance)} (up ${formatCurrency(Math.abs(change))} since last check-in).`;
  }
  return isConversational
    ? `${primary.accountName} sits at ${formatCurrency(primary.currentBalance)} (flat since last check-in).`
    : `${primary.accountName} is ${formatCurrency(primary.currentBalance)} (flat since last check-in).`;
}

function styleSpendingPaceLine(
  rawNote: string,
  payload: CheckinMessagePayload,
  voice: CheckinVoiceProfile,
): string {
  if (!rawNote) return rawNote;

  if (payload.freeCashRemaining < 0) {
    if (voice.strictCoach || voice.slightlyJudgmental) {
      return "Tough week. We leaked cash this week, so tighten it up next round.";
    }
    return "Tough week.";
  }

  if (rawNote.startsWith("You're behind pace by")) {
    if (voice.strictCoach || voice.slightlyJudgmental) {
      return `${rawNote} That's a leak we need to shut down.`;
    }
    return rawNote;
  }

  if (rawNote === "Tight week." && (voice.strictCoach || voice.realistic)) {
    return "Tight week. Keep spending sharp.";
  }

  if (rawNote.startsWith("You're ahead of your weekly pace") && voice.conversational) {
    return `${rawNote} Keep that discipline.`;
  }

  if (rawNote === "You're on pace this week." && (voice.allowSlang || voice.conversational)) {
    return "You're on pace this week. Keep it clean.";
  }

  return rawNote;
}

export function renderCheckinMessage(
  payload: CheckinMessagePayload,
  voiceOverride?: CheckinVoiceProfile,
): string {
  const voice = voiceOverride ?? defaultVoiceProfile();
  const topLineSuffix = payload.freeCashRemaining >= 0 ? "left this week." : "over this week.";
  const lines: string[] = [bold(`${formatCurrency(payload.freeCashRemaining)} ${topLineSuffix}`)];

  const paceLine = styleSpendingPaceLine(payload.spendingPaceNote, payload, voice);
  if (paceLine) {
    lines.push(escapeMarkdownV2(paceLine));
  }

  const upcomingLine = buildUpcomingLine(payload.upcomingSubs, voice);
  if (upcomingLine) {
    lines.push(escapeMarkdownV2(upcomingLine));
  }

  const debtLine = buildDebtLine(payload.debtProgress, voice);
  if (debtLine) {
    lines.push(escapeMarkdownV2(debtLine));
  }

  return lines.join("\n");
}
