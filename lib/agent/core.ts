import { ModelMessage } from "ai";
import { callLLM } from "./provider";
import { buildTools } from "./tools";
import { buildSystemPrompt, SystemPromptContext } from "./prompts";
import {
  getActiveObligations,
  getObligationsTotal,
  getAllocation,
  getDebts,
  getRecentCheckins,
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
import type { user } from "@/lib/db/schema";

type User = typeof user.$inferSelect;

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

  // 2. Build system prompt
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

  // 3. Build messages with conversation history for multi-turn context
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

  // 4. Call LLM with tools — allow up to 5 steps for tool calling loops
  const tools = buildTools(dbUser.id);
  const result = await callLLM({
    systemPrompt,
    messages,
    tools,
    maxSteps: 5,
  });

  // 5. Send response via Telegram
  if (result.text) {
    await sendMessage(dbUser.telegramChatId, result.text);
  }

  // 5b. Persist both sides of the conversation
  await saveConversationMessage(dbUser.id, "user", userContent);
  if (result.text) {
    await saveConversationMessage(dbUser.id, "assistant", result.text);
  }

  // 6. Mark previous check-in as replied (if the user is responding to one)
  if (recentCheckins.length > 0) {
    const lastCheckin = recentCheckins[0];
    if (!lastCheckin.userReplied && lastCheckin.telegramMessageId) {
      await markCheckinReplied(lastCheckin.telegramMessageId);
    }
  }

  // 7. Reset ignored check-ins counter on any user interaction
  if (dbUser.ignoredCheckins > 0) {
    await updateUser(dbUser.id, { ignoredCheckins: 0 });
  }

  // 8. Reactivate if the user was silenced and is now messaging back
  if (!dbUser.active) {
    await updateUser(dbUser.id, { active: true, ignoredCheckins: 0 });
  }
}
