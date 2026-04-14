import { formatCurrency } from "@/lib/utils/money";
import { loadVoiceContracts } from "./voice-contract";

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
  type: string;
  source: string;
  updatedAt: Date;
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

function buildIdentitySoulSection(): string {
  const { identityText: identity, soulText: soul } = loadVoiceContracts();
  return `Agent identity contract:\n${identity}\n\nAgent soul contract:\n${soul}`;
}

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
- If you use the word "cushion", explain it as "emergency cash buffer (cushion)" in plain language.
- Never expose internal system markers or bracketed trigger text to the user.
- Never force a response. If the user doesn't reply, carry on.`;

// ── Phase Instructions ────────────────────────────────────────────────

const PHASE_INSTRUCTIONS: Record<string, string> = {
  know_number: `Current phase: KNOW THE NUMBER
The user is learning their financial picture for the first time.

When this is the FIRST interaction after bank connection (internal onboarding trigger):
1. Call get_obligations to pull their recurring charges.
2. Call get_account_balances to get current balances.
3. Present the BIG items first (the 4-5 largest obligations with amounts). Example:
   "Got your accounts linked. You've got [N] recurring charges pulling from your checking.

   The big ones:
   Rent — $2,100
   Car payment — $487
   Student loans — $312
   Insurance — $195

   Those four alone are $3,094/month. Want to see the rest?"
4. When the user says yes, show the FULL list of remaining charges, then the total:
   "All together, your monthly obligations are $[total]."
5. IMMEDIATELY after showing the total, ask for income:
   "What's your monthly take-home? After taxes, the number that actually hits your account."
   This is the ONE question you need from the user. Don't skip it, don't guess it.
6. When the user gives their income, call update_allocation with monthly_income set to their number. Then compute the gap yourself: income minus obligations total. Deliver it:
   "You bring in $[income], obligations are $[total], that leaves you *$[income - total]/month*."
   Do NOT read the gap from stored data — always compute it fresh from what the user just told you.

Rules:
- Do NOT dump all charges in one message. Pace the reveal.
- Do NOT shame or preach. You can call out financially bad moves clearly when relevant.
- Do NOT try to infer income from bank balances. Ask for it directly.
- Do NOT use a stored gap value when the user just gave you their income. Compute it: income minus obligations total.
- When showing subscriptions, use inline keyboard buttons for "Keep" / "Dead" flagging.
- When the user has seen their number and flagged any dead subscriptions, transition to asking what they want to do with the gap.`,

  allocate: `Current phase: DECIDE WHAT THE GAP DOES
The user knows their number. Now help them make one allocation decision:
- Ask what they want to do with the gap money: attack debt, build a cushion, both, or just know the number.
- Use inline keyboard buttons for the choice.
- If the user says "you decide", "you're the expert", or similar, make the call yourself. Default to a practical hybrid split with a short why.
- Include a simple simulation snapshot when useful using clear horizons (30, 90, 180, 365 days) so the user sees where consistency leads.
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
  const sections: string[] = [buildIdentitySoulSection(), MESSAGE_RULES];

  // Phase
  sections.push(PHASE_INSTRUCTIONS[ctx.phase] || PHASE_INSTRUCTIONS.know_number);

  // Financial context
  const financials: string[] = [];

  if (ctx.obligationsTotal > 0) {
    financials.push(`Total monthly obligations: ${formatCurrency(ctx.obligationsTotal)}`);
  }

  const hasDebtLikeObligation = ctx.obligations.some((o) =>
    /(credit card|card payment|loan|student loan|mortgage)/i.test(o.merchantName),
  );
  if (ctx.debts.length === 0 && hasDebtLikeObligation) {
    financials.push(
      "Debt-like recurring payments detected in obligations but actual debt account balances have not been synced yet. " +
      "When the user asks about their total debt, call get_debt_summary first — it will attempt to pull balances from their linked accounts. " +
      "If it still returns empty, tell the user you can see they have debt payments but don't have the actual balances yet, and ask them to link their credit card or loan accounts so you can pull the numbers.",
    );
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

  // Memories — grouped by type for clarity
  if (ctx.memories.length > 0) {
    const grouped: Record<string, MemoryEntry[]> = {};
    for (const m of ctx.memories) {
      const t = m.type || "other";
      if (!grouped[t]) grouped[t] = [];
      grouped[t].push(m);
    }

    const typeLabels: Record<string, string> = {
      life_event: "Life events",
      financial: "Financial context",
      behavioral: "Preferences & behavior",
      goal: "Goals",
      other: "Other",
    };

    const memoryParts: string[] = [];
    for (const [type, entries] of Object.entries(grouped)) {
      const label = typeLabels[type] || type;
      const lines = entries.map((m) => `- ${m.key}: ${m.value}`);
      memoryParts.push(`${label}:\n${lines.join("\n")}`);
    }

    sections.push(`Things you remember about this user:\n\n${memoryParts.join("\n\n")}`);
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
