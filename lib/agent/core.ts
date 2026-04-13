import type { ModelMessage } from "ai";
import { callLLM } from "./provider";
import { buildTools } from "./tools";
import { buildSystemPrompt, SystemPromptContext } from "./prompts";
import { classifyIntent, extractMoneyAmount } from "./router";
import { buildRoutedAction } from "./routing-plan";
import { extractToolNumbers, validateNumbers } from "./validate";
import {
  getActiveObligations,
  getObligationsTotal,
  getAllocation,
  getDebts,
  getRecentCheckins,
  upsertAllocation,
  updateUser,
  markCheckinReplied,
  getPlaidConnection,
  recallMemoryByPattern,
  getRecentConversation,
  saveConversationMessage,
} from "@/lib/db/queries";
import { sendMessage, sendMessageWithUrlButton } from "@/lib/telegram/client";
import { createLinkToken } from "@/lib/plaid/client";
import { escapeMarkdownV2 } from "@/lib/telegram/format";
import { computeGap } from "@/lib/harness/calculations";
import { formatCurrency } from "@/lib/utils/money";
import type { user } from "@/lib/db/schema";

type User = typeof user.$inferSelect;

function formatVerifiedAmounts(toolResults: unknown[]): string {
  const values = extractToolNumbers(toolResults)
    .map((value) => Math.round(value * 100) / 100)
    .filter((value) => Number.isFinite(value));
  const unique = Array.from(new Set(values));
  return unique
    .slice(0, 30)
    .map((value) => formatCurrency(value))
    .join(", ");
}

interface FinalizeInteractionInput {
  dbUser: User;
  userContent: string;
  finalText: string;
  recentCheckins: Array<{
    userReplied: boolean;
    telegramMessageId: number | null;
  }>;
  reactivateIfSilent?: boolean;
}

async function finalizeInteraction({
  dbUser,
  userContent,
  finalText,
  recentCheckins,
  reactivateIfSilent = true,
}: FinalizeInteractionInput): Promise<void> {
  if (finalText) {
    await sendMessage(dbUser.telegramChatId, finalText);
  }

  await saveConversationMessage(dbUser.id, "user", userContent);
  if (finalText) {
    await saveConversationMessage(dbUser.id, "assistant", finalText);
  }

  if (recentCheckins.length > 0) {
    const lastCheckin = recentCheckins[0];
    if (!lastCheckin.userReplied && lastCheckin.telegramMessageId) {
      await markCheckinReplied(lastCheckin.telegramMessageId);
    }
  }

  if (dbUser.ignoredCheckins > 0) {
    await updateUser(dbUser.id, { ignoredCheckins: 0 });
  }

  if (reactivateIfSilent && !dbUser.active) {
    await updateUser(dbUser.id, { active: true, ignoredCheckins: 0 });
  }
}

/**
 * Process an incoming user message (text or callback button tap).
 * This is the main agent loop:
 *   1. Load context from DB
 *   2. Build system prompt
 *   3. Call LLM with tools
 *   4. Send response via Telegram
 *   5. Handle check-in reply tracking
 */
export async function processMessage(
  dbUser: User,
  text: string,
  callbackData?: string,
): Promise<void> {
  // 0. Check if user has a bank connected — if not, send Plaid Link flow
  const plaidConn = await getPlaidConnection(dbUser.id);
  if (!plaidConn) {
    try {
      const linkToken = await createLinkToken(dbUser.id);
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://clearline.vercel.app";
      const linkUrl = `${appUrl}/link?token=${linkToken}&user_id=${dbUser.id}`;

      await sendMessageWithUrlButton(
        dbUser.telegramChatId,
        escapeMarkdownV2("No bank linked yet. Tap below to connect your accounts."),
        "Connect bank",
        linkUrl,
      );
    } catch (err) {
      console.error("Failed to generate Plaid Link for user:", err);
      await sendMessage(
        dbUser.telegramChatId,
        "Having trouble setting up bank linking right now. Try again in a bit.",
      );
    }
    return;
  }

  // 1. Load full context in parallel
  const [obligations, obligationsTotal, allocation, debts, memories, recentCheckins, conversationHistory] =
    await Promise.all([
      getActiveObligations(dbUser.id),
      getObligationsTotal(dbUser.id),
      getAllocation(dbUser.id),
      getDebts(dbUser.id),
      recallMemoryByPattern(dbUser.id, "%"),
      getRecentCheckins(dbUser.id, 5),
      getRecentConversation(dbUser.id, 10),
    ]);

  // 2. Build messages with conversation history for multi-turn context
  const userContent = callbackData
    ? `[User tapped button: "${callbackData}"]`
    : text;

  const historyMessages: ModelMessage[] = conversationHistory.map((msg) => ({
    role: msg.role as "user" | "assistant",
    content: msg.content,
  }));
  const messages: ModelMessage[] = [
    ...historyMessages,
    { role: "user", content: userContent },
  ];

  // 3. Hybrid router: deterministic intent checks first, lightweight classifier second
  const intentDecision = await classifyIntent({
    text,
    phase: dbUser.phase,
    callbackData,
    conversationHistory: historyMessages,
    hasMonthlyIncome: allocation?.monthlyIncome != null,
  });

  const routedAction = buildRoutedAction(
    {
      userId: dbUser.id,
      phase: dbUser.phase,
      intent: intentDecision.intent,
      text,
      obligationsTotal,
      obligations: obligations.map((o) => ({
        merchantName: o.merchantName,
        amount: o.amount,
      })),
      allocation: allocation
        ? { monthlyIncome: allocation.monthlyIncome, gap: allocation.gap }
        : null,
    },
    { extractMoneyAmount, formatCurrency, computeGap },
  );

  if (routedAction) {
    if (routedAction.allocationUpdate) {
      await upsertAllocation(routedAction.allocationUpdate);
    }
    if (routedAction.userUpdate) {
      await updateUser(dbUser.id, routedAction.userUpdate);
    }

    await finalizeInteraction({
      dbUser,
      userContent,
      finalText: routedAction.finalText,
      recentCheckins,
      reactivateIfSilent: routedAction.reactivateIfSilent,
    });
    return;
  }

  // 4. Build system prompt
  const promptContext: SystemPromptContext = {
    phase: dbUser.phase,
    obligations: obligations.map((o) => ({
      id: o.id,
      merchantName: o.merchantName,
      amount: o.amount,
      frequency: o.frequency,
      nextExpectedDate: o.nextExpectedDate,
      category: o.category,
      isSubscription: o.isSubscription,
      status: o.status,
    })),
    obligationsTotal,
    allocation: allocation
      ? {
          monthlyIncome: allocation.monthlyIncome,
          obligationsTotal: allocation.obligationsTotal,
          gap: allocation.gap,
          debtAmount: allocation.debtAmount,
          cushionAmount: allocation.cushionAmount,
          livingAmount: allocation.livingAmount,
          strategy: allocation.strategy,
        }
      : null,
    debts: debts.map((d) => ({
      accountName: d.accountName,
      currentBalance: d.currentBalance,
      interestRate: d.interestRate,
      minimumPayment: d.minimumPayment,
    })),
    memories: memories.map((m) => ({
      key: m.key,
      value: m.value,
      type: m.type,
      source: m.source,
      updatedAt: m.updatedAt,
    })),
    recentCheckins: recentCheckins.map((c) => ({
      type: c.type,
      messageText: c.messageText,
      sentAt: c.sentAt,
    })),
  };

  const systemPrompt = buildSystemPrompt(promptContext);

  // 5. Call LLM with tools — allow up to 5 steps for tool calling loops
  const tools = buildTools(dbUser.id, dbUser.phase);
  const result = await callLLM({
    systemPrompt,
    messages,
    tools,
    maxSteps: 5,
  });

  // 6. Validate dollar amounts against tool results before sending (fail closed)
  let finalText = result.text;
  if (finalText && result.toolResults.length) {
    let validation = validateNumbers(finalText, result.toolResults);
    if (!validation.valid) {
      console.warn(
        `[validateNumbers] Blocking mismatched amounts for user ${dbUser.id}:`,
        validation.mismatches.map((n) => `$${n}`),
      );

      const verifiedAmounts = formatVerifiedAmounts(result.toolResults);
      const retry = await callLLM({
        systemPrompt,
        messages: [
          ...messages,
          { role: "assistant", content: finalText },
          {
            role: "user",
            content: [
              "Rewrite your previous response.",
              "Use only verified dollar amounts from this list:",
              verifiedAmounts || "(none)",
              "If you are not certain about an amount, do not include a dollar amount.",
              "Keep the same tone and answer the user's request directly.",
            ].join("\n"),
          },
        ],
        maxSteps: 1,
      });

      finalText = retry.text;
      validation = validateNumbers(finalText, result.toolResults);

      if (!validation.valid) {
        console.warn(
          `[validateNumbers] Retry failed for user ${dbUser.id}; sending safe fallback.`,
        );
        finalText =
          "I pulled your data, but I’m double-checking the exact numbers so I don’t send you a wrong amount. Ask me again in a moment.";
      }
    }
  }

  await finalizeInteraction({
    dbUser,
    userContent,
    finalText,
    recentCheckins,
  });
}
