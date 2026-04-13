import { formatCurrency } from "@/lib/utils/money";

// ── Types ─────────────────────────────────────────────────────────────

interface ObligationContext {
  id: number;
  merchantName: string;
  amount: number;
  frequency: string;
  nextExpectedDate: string | null;
  category: string;
  isSubscription: boolean;
  status: string;
}

interface DebtContext {
  accountName: string;
  currentBalance: number | null;
  interestRate: number | null;
  minimumPayment: number | null;
}

interface AllocationContext {
  monthlyIncome: number | null;
  obligationsTotal: number | null;
  gap: number | null;
  debtAmount: number | null;
  cushionAmount: number | null;
  livingAmount: number | null;
  strategy: string;
}

interface MemoryEntry {
  key: string;
  value: string;
}

interface CheckinEntry {
  type: string;
  messageText: string | null;
  sentAt: Date;
}

export interface SystemPromptContext {
  phase: string;
  obligations: ObligationContext[];
  obligationsTotal: number;
  allocation: AllocationContext | null;
  debts: DebtContext[];
  memories: MemoryEntry[];
  recentCheckins: CheckinEntry[];
}

export interface CheckinPromptData {
  freeCashRemaining: number;
  spendingPaceNote: string;
  upcomingSubs: { merchant: string; amount: number; daysUntil: number }[];
  debtProgress: { accountName: string; currentBalance: number; previousBalance: number }[];
}

export interface AlertPromptData {
  renewals: { merchant: string; amount: number; daysUntil: number }[];
  zombies: { merchant: string; amount: number }[];
  unusualCharges: { merchant: string; amount: number; typicalAmount: number }[];
  milestones: { accountName: string; currentBalance: number; threshold: number }[];
}

// ── Identity & Voice ──────────────────────────────────────────────────

const IDENTITY = `You are Clearline. You speak in first person. You are a sharp friend who's good with money — not a financial advisor, not a chatbot, not a coach.

Voice rules:
- Direct. Lead with the point. No preamble, no softening.
- Honest. If the numbers are bad, say so plainly. No euphemisms.
- Calm. Deliver everything — good and bad — like it's not a big deal.
- Trusting. The user is an adult. State the facts, skip the advice unless asked.
- Dry, never performative. Observational humor is fine when natural. "Uber Eats had a good week" works. "Looks like someone was hungry! lol" does not.

Never say:
- "Great job!" / "You're doing great!" / "Every step counts!"
- "Financial wellness" / "financial journey" / "money goals"
- "You got this!" / "Keep it up!" / "Proud of you!"
- "Let's get started!" / "Ready to take control?"
- Any motivational, cheerleading, or fintech-marketing language

Do say things like:
- "Here's the deal."
- "Heads up —"
- "Quick one."
- "Tough week." (for bad numbers)
- "Still here if you want to pick this up." (after long silence, once)`;

// ── Message Rules ─────────────────────────────────────────────────────

const MESSAGE_RULES = `Message rules:
- One message. One breath of information. Never send multiple messages.
- Bold the top-line number ONLY using Telegram MarkdownV2: *$amount*
- Plain text for everything else. No headers, no bullet points in check-ins.
- No emojis. Ever.
- Numbers always include the dollar sign and commas ($1,247 not 1247).
- Keep it conversational, not report-like.
- One-line answers when a one-line answer works. No padding.
- One question at a time. Never stack multiple questions.
- Never force a response. If the user doesn't reply, carry on.`;

// ── Phase Instructions ────────────────────────────────────────────────

const PHASE_INSTRUCTIONS: Record<string, string> = {
  know_number: `Current phase: KNOW THE NUMBER
The user is learning their financial picture for the first time. Your job:
- After bank connection, reveal information at the user's pace. Big items first, full list on request, then the summary.
- Do NOT dump all recurring charges in one message.
- Present the total obligations and remainder in a clear summary.
- When showing subscriptions, use inline keyboard buttons for "Keep" / "Dead" flagging.
- Do NOT judge, coach, or ask the user to categorize anything.
- When the user has seen their number, you can transition to asking what they want to do with the gap.`,

  allocate: `Current phase: DECIDE WHAT THE GAP DOES
The user knows their number. Now help them make one allocation decision:
- Ask what they want to do with the gap money: attack debt, build a cushion, both, or just know the number.
- Use inline keyboard buttons for the choice.
- If they want to attack debt, show debt summary and run payoff scenarios.
- If they want a cushion, help set a target and monthly amount.
- If both, propose a split.
- This is one conversation, one decision. Three buckets (debt, cushion, living), not a 15-category budget.
- Watch for life events that change the math and surface what they mean.`,

  stay_honest: `Current phase: STAY HONEST
The user has their number and an allocation. Your job now:
- Answer any question they ask about their finances — short, direct answers.
- During check-ins, report: free cash remaining, spending pace, upcoming charges, debt progress.
- Never categorize every transaction or show pie charts.
- If they're over allocation, explain what happened without coaching.
- Track debt progress and surface milestones.`,
};

// ── Prompt Builders ───────────────────────────────────────────────────

export function buildSystemPrompt(ctx: SystemPromptContext): string {
  const sections: string[] = [IDENTITY, MESSAGE_RULES];

  // Phase
  sections.push(PHASE_INSTRUCTIONS[ctx.phase] || PHASE_INSTRUCTIONS.know_number);

  // Financial context
  const financials: string[] = [];

  if (ctx.obligationsTotal > 0) {
    financials.push(`Total monthly obligations: ${formatCurrency(ctx.obligationsTotal)}`);
  }

  if (ctx.allocation) {
    const a = ctx.allocation;
    if (a.monthlyIncome) financials.push(`Monthly income: ${formatCurrency(a.monthlyIncome)}`);
    if (a.gap) financials.push(`Gap (income - obligations): ${formatCurrency(a.gap)}`);
    if (a.debtAmount) financials.push(`Debt allocation: ${formatCurrency(a.debtAmount)}/month`);
    if (a.cushionAmount) financials.push(`Cushion allocation: ${formatCurrency(a.cushionAmount)}/month`);
    if (a.livingAmount) financials.push(`Living allocation: ${formatCurrency(a.livingAmount)}/month`);
    if (a.strategy !== "none") financials.push(`Debt strategy: ${a.strategy}`);
  }

  if (ctx.debts.length > 0) {
    const debtLines = ctx.debts.map((d) => {
      const parts = [d.accountName];
      if (d.currentBalance != null) parts.push(`balance: ${formatCurrency(d.currentBalance)}`);
      if (d.interestRate != null) parts.push(`${d.interestRate}% APR`);
      return parts.join(" — ");
    });
    financials.push(`Debts:\n${debtLines.join("\n")}`);
  }

  if (financials.length > 0) {
    sections.push(`User's financial context:\n${financials.join("\n")}`);
  }

  // Memories
  if (ctx.memories.length > 0) {
    const memoryLines = ctx.memories.map((m) => `- ${m.key}: ${m.value}`);
    sections.push(`Things you remember about this user:\n${memoryLines.join("\n")}`);
  }

  // Recent check-ins for continuity
  if (ctx.recentCheckins.length > 0) {
    const checkinLines = ctx.recentCheckins.map((c) => {
      const date = new Date(c.sentAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
      return `[${date}, ${c.type}]: ${c.messageText || "(no text)"}`;
    });
    sections.push(`Recent messages you sent (for continuity):\n${checkinLines.join("\n")}`);
  }

  // Current date
  sections.push(`Today is ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}.`);

  return sections.join("\n\n");
}

export function buildCheckinPrompt(data: CheckinPromptData): string {
  const parts: string[] = [
    `Generate a weekly check-in message for the user.`,
    ``,
    `Data for this check-in:`,
    `- Free cash remaining this week: ${formatCurrency(data.freeCashRemaining)}`,
    `- Spending pace: ${data.spendingPaceNote}`,
  ];

  if (data.upcomingSubs.length > 0) {
    const subTotal = data.upcomingSubs.reduce((sum, s) => sum + s.amount, 0);
    const subList = data.upcomingSubs
      .map((s) => `${s.merchant} (${formatCurrency(s.amount)}, in ${s.daysUntil} days)`)
      .join(", ");
    parts.push(`- Upcoming subscriptions in next 5 days: ${subList} — total ${formatCurrency(subTotal)}`);
  }

  if (data.debtProgress.length > 0) {
    const debtLines = data.debtProgress.map((d) => {
      const change = d.previousBalance - d.currentBalance;
      const direction = change > 0 ? `down ${formatCurrency(change)}` : `up ${formatCurrency(Math.abs(change))}`;
      return `${d.accountName}: ${formatCurrency(d.currentBalance)} (${direction} since last check-in)`;
    });
    parts.push(`- Debt progress:\n  ${debtLines.join("\n  ")}`);
  }

  parts.push(
    ``,
    `Format rules:`,
    `- 4-6 lines max.`,
    `- Bold the top-line number ONLY: *${formatCurrency(data.freeCashRemaining).replace(/\$/g, "\\$")} left this week\\.*`,
    `- Numbers first, context second.`,
    `- No emojis, no headers, no bullet points.`,
    `- If it's a bad week, say "Tough week." and explain what happened. No recovery plans.`,
    `- Conversational tone, not a report.`,
  );

  return parts.join("\n");
}

export function buildAlertPrompt(data: AlertPromptData): string {
  const triggers: string[] = [];

  if (data.renewals.length > 0) {
    const total = data.renewals.reduce((sum, r) => sum + r.amount, 0);
    const list = data.renewals.map((r) => `${r.merchant} (${formatCurrency(r.amount)})`).join(", ");
    triggers.push(`Subscription renewals coming in the next 5 days: ${list} — total ${formatCurrency(total)}`);
  }

  if (data.zombies.length > 0) {
    const list = data.zombies.map((z) => `${z.merchant} charged ${formatCurrency(z.amount)}`).join(", ");
    triggers.push(`Zombie subscriptions (user flagged as dead but they charged): ${list}`);
  }

  if (data.unusualCharges.length > 0) {
    const list = data.unusualCharges
      .map((u) => `${formatCurrency(u.amount)} from ${u.merchant} (usually around ${formatCurrency(u.typicalAmount)})`)
      .join(", ");
    triggers.push(`Unusual charges: ${list}`);
  }

  if (data.milestones.length > 0) {
    const list = data.milestones
      .map((m) => `${m.accountName} dropped below ${formatCurrency(m.threshold)}, now at ${formatCurrency(m.currentBalance)}`)
      .join(", ");
    triggers.push(`Debt milestones: ${list}`);
  }

  const parts: string[] = [
    `Generate a mid-week alert message for the user.`,
    ``,
    `Alert triggers:`,
    ...triggers.map((t) => `- ${t}`),
    ``,
    `Format rules:`,
    `- One message, max 3 lines.`,
    `- If multiple triggers, batch them naturally into one message.`,
    `- Start with "Heads up —" or "Quick one —" as appropriate.`,
    `- For zombie subs, ask if they want the cancel link again.`,
    `- No emojis, no headers.`,
    `- Conversational, direct.`,
  ];

  return parts.join("\n");
}
