import type { ModelMessage } from "ai";

export const BANK_LINKED_SIGNAL = "[Bank accounts just linked — deliver the numbers]";

export type PendingState =
  | "none"
  | "awaiting_income"
  | "awaiting_allocation_choice"
  | "awaiting_checkin_preference"
  | "awaiting_obligation_list_confirmation";

export type Intent =
  | "onboarding_bank_linked"
  | "checkin_keep"
  | "checkin_quiet"
  | "income_report"
  | "allocation_choice_debt"
  | "allocation_choice_cushion"
  | "allocation_choice_both"
  | "show_remaining_obligations"
  | "general_question"
  | "unknown";

export interface IntentDecision {
  intent: Intent;
  confidence: number;
  source: "deterministic" | "llm" | "default";
  pendingState: PendingState;
}

interface IntentInput {
  text: string;
  phase: string;
  callbackData?: string;
  conversationHistory: ModelMessage[];
  hasMonthlyIncome: boolean;
  allowLLMFallback?: boolean;
}

const DOLLAR_RE = /-?\$[\d,]+(?:\.\d{1,2})?/g;
const RAW_NUMBER_RE = /(^|[^\d])(\d{3,6}(?:\.\d{1,2})?)(?![\d])/;
const POSITIVE_SIGNAL_RE = /\b(yes|yeah|yep|show|sure|ok|okay|do it)\b/i;
const NEGATIVE_SIGNAL_RE = /\b(no|nah|stop|skip|nope)\b/i;

const CHECKIN_KEEP_RE = /\b(keep|continue|resume|keep them coming)\b/i;
const CHECKIN_QUIET_RE = /\b(quiet|pause|stop|go quiet)\b/i;

const DEBT_RE = /\b(debt|card|cards|pay off|paydown|avalanche|snowball)\b/i;
const CUSHION_RE = /\b(cushion|emergency|safety net|savings)\b/i;
const BOTH_RE = /\b(both|split)\b/i;
const EXPERT_DECIDE_RE =
  /\b(you decide|your call|you pick|pick for me|you.?re the expert|you are the expert|expert call|whatever you think|up to you)\b/i;
const INCOME_CUE_RE =
  /\b(income|take[- ]?home|salary|paycheck|pay cheque|i make|i earn|bring in)\b/i;

function parseJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeIntent(value: unknown): Intent | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();

  const supported: Intent[] = [
    "onboarding_bank_linked",
    "checkin_keep",
    "checkin_quiet",
    "income_report",
    "allocation_choice_debt",
    "allocation_choice_cushion",
    "allocation_choice_both",
    "show_remaining_obligations",
    "general_question",
    "unknown",
  ];

  return supported.includes(normalized as Intent)
    ? (normalized as Intent)
    : null;
}

function normalizeConfidence(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0.4;
  return Math.max(0, Math.min(1, n));
}

function getLastAssistantMessage(history: ModelMessage[]): string {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const msg = history[i];
    if (msg.role !== "assistant") continue;
    if (typeof msg.content === "string") return msg.content;
  }
  return "";
}

function inferPendingState(
  history: ModelMessage[],
  phase: string,
  hasMonthlyIncome: boolean,
): PendingState {
  const lastAssistant = getLastAssistantMessage(history).toLowerCase();
  if (!lastAssistant) {
    if (phase === "know_number" && !hasMonthlyIncome) return "awaiting_income";
    return "none";
  }

  if (
    lastAssistant.includes("keep these coming") ||
    lastAssistant.includes("go quiet")
  ) {
    return "awaiting_checkin_preference";
  }

  if (
    lastAssistant.includes("monthly take-home") ||
    lastAssistant.includes("take-home") ||
    lastAssistant.includes("what's your monthly") ||
    lastAssistant.includes("what is your monthly")
  ) {
    return "awaiting_income";
  }

  if (
    lastAssistant.includes("attack debt") ||
    lastAssistant.includes("build a cushion") ||
    lastAssistant.includes("what do you want to do with the gap")
  ) {
    return "awaiting_allocation_choice";
  }

  if (
    lastAssistant.includes("want to see the rest") ||
    lastAssistant.includes("show the rest")
  ) {
    return "awaiting_obligation_list_confirmation";
  }

  if (phase === "know_number" && !hasMonthlyIncome) return "awaiting_income";

  return "none";
}

function classifyDeterministic(
  input: IntentInput,
  pendingState: PendingState,
): IntentDecision | null {
  const text = input.text.trim();
  const lower = text.toLowerCase();

  if (input.callbackData) {
    if (input.callbackData === "checkin_keep") {
      return {
        intent: "checkin_keep",
        confidence: 1,
        source: "deterministic",
        pendingState,
      };
    }
    if (input.callbackData === "checkin_quiet") {
      return {
        intent: "checkin_quiet",
        confidence: 1,
        source: "deterministic",
        pendingState,
      };
    }
  }

  if (text === BANK_LINKED_SIGNAL) {
    return {
      intent: "onboarding_bank_linked",
      confidence: 1,
      source: "deterministic",
      pendingState,
    };
  }

  if (pendingState === "awaiting_checkin_preference") {
    if (CHECKIN_KEEP_RE.test(text) || POSITIVE_SIGNAL_RE.test(text)) {
      return {
        intent: "checkin_keep",
        confidence: 0.95,
        source: "deterministic",
        pendingState,
      };
    }
    if (CHECKIN_QUIET_RE.test(text) || NEGATIVE_SIGNAL_RE.test(text)) {
      return {
        intent: "checkin_quiet",
        confidence: 0.95,
        source: "deterministic",
        pendingState,
      };
    }
  }

  if (
    (input.phase === "know_number" && !input.hasMonthlyIncome) ||
    pendingState === "awaiting_income"
  ) {
    const parsedAmount = extractMoneyAmount(text);
    const isShortNumericReply = text.length > 0 && text.length <= 24;
    const hasIncomeCue = INCOME_CUE_RE.test(text);
    const shouldTreatAsIncome =
      parsedAmount != null &&
      (pendingState === "awaiting_income"
        ? isShortNumericReply || hasIncomeCue
        : hasIncomeCue);

    if (shouldTreatAsIncome) {
      return {
        intent: "income_report",
        confidence: 0.96,
        source: "deterministic",
        pendingState,
      };
    }
  }

  if (pendingState === "awaiting_allocation_choice") {
    if (EXPERT_DECIDE_RE.test(text)) {
      return {
        intent: "allocation_choice_both",
        confidence: 0.94,
        source: "deterministic",
        pendingState,
      };
    }
    if (BOTH_RE.test(text)) {
      return {
        intent: "allocation_choice_both",
        confidence: 0.92,
        source: "deterministic",
        pendingState,
      };
    }
    if (DEBT_RE.test(text)) {
      return {
        intent: "allocation_choice_debt",
        confidence: 0.9,
        source: "deterministic",
        pendingState,
      };
    }
    if (CUSHION_RE.test(text)) {
      return {
        intent: "allocation_choice_cushion",
        confidence: 0.9,
        source: "deterministic",
        pendingState,
      };
    }
  }

  if (pendingState === "awaiting_obligation_list_confirmation") {
    if (POSITIVE_SIGNAL_RE.test(lower)) {
      return {
        intent: "show_remaining_obligations",
        confidence: 0.88,
        source: "deterministic",
        pendingState,
      };
    }
  }

  if (/\?$/.test(text) || /\b(what|how|why|when|where|which)\b/i.test(text)) {
    return {
      intent: "general_question",
      confidence: 0.7,
      source: "deterministic",
      pendingState,
    };
  }

  return null;
}

async function classifyWithLLM(
  input: IntentInput,
  pendingState: PendingState,
): Promise<IntentDecision | null> {
  const { callLLM } = await import("./provider");

  const classifierPrompt = [
    "Classify this user message into one intent.",
    "Return ONLY compact JSON: {\"intent\":\"...\",\"confidence\":0-1}",
    "Valid intents:",
    "- onboarding_bank_linked",
    "- checkin_keep",
    "- checkin_quiet",
    "- income_report",
    "- allocation_choice_debt",
    "- allocation_choice_cushion",
    "- allocation_choice_both",
    "- show_remaining_obligations",
    "- general_question",
    "- unknown",
    "",
    "Rules:",
    "- Prefer unknown over guessing.",
    "- If callbackData is present, prioritize callback meaning.",
    "- If phase is know_number and message is mostly a money amount, choose income_report.",
    "",
    `phase: ${input.phase}`,
    `pendingState: ${pendingState}`,
    `hasMonthlyIncome: ${input.hasMonthlyIncome}`,
    `callbackData: ${input.callbackData || "(none)"}`,
    `message: ${input.text || "(empty)"}`,
  ].join("\n");

  const result = await callLLM({
    systemPrompt:
      "You are an intent classifier for a financial assistant. Output JSON only.",
    messages: [{ role: "user", content: classifierPrompt }],
    maxSteps: 1,
  });

  const parsed = parseJsonObject(result.text);
  if (!parsed) return null;

  const intent = normalizeIntent(parsed.intent);
  if (!intent) return null;

  return {
    intent,
    confidence: normalizeConfidence(parsed.confidence),
    source: "llm",
    pendingState,
  };
}

export function extractMoneyAmount(text: string): number | null {
  const dollarMatches = text.match(DOLLAR_RE);
  if (dollarMatches && dollarMatches.length > 0) {
    const candidate = dollarMatches[0];
    const n = Number(candidate.replace(/[$,]/g, ""));
    if (Number.isFinite(n) && n > 0) return n;
  }

  const rawMatch = text.match(RAW_NUMBER_RE);
  if (rawMatch?.[2]) {
    const n = Number(rawMatch[2]);
    if (Number.isFinite(n) && n > 0) return n;
  }

  return null;
}

export async function classifyIntent(input: IntentInput): Promise<IntentDecision> {
  if (!input.callbackData && input.text.trim().length === 0) {
    return {
      intent: "unknown",
      confidence: 1,
      source: "default",
      pendingState: "none",
    };
  }

  const pendingState = inferPendingState(
    input.conversationHistory,
    input.phase,
    input.hasMonthlyIncome,
  );

  const deterministic = classifyDeterministic(input, pendingState);
  if (deterministic) return deterministic;

  if (input.allowLLMFallback === false) {
    return {
      intent: "unknown",
      confidence: 0.4,
      source: "default",
      pendingState,
    };
  }

  const llmDecision = await classifyWithLLM(input, pendingState);
  if (llmDecision) return llmDecision;

  return {
    intent: "unknown",
    confidence: 0.4,
    source: "default",
    pendingState,
  };
}
