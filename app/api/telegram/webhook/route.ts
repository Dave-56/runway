import { NextRequest, NextResponse } from "next/server";
import { parseUpdate } from "@/lib/telegram/parse";
import { answerCallbackQuery } from "@/lib/telegram/client";
import { getUser, createUser } from "@/lib/db/queries";
import { processMessage } from "@/lib/agent/core";

export async function POST(req: NextRequest) {
  // 1. Verify webhook secret
  const secret = req.headers.get("x-telegram-bot-api-secret-token");
  if (secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Parse the update
  const body = await req.json();
  const update = parseUpdate(body);

  if (!update) {
    // Unrecognized update type (photo, sticker, etc.) — acknowledge and ignore
    return NextResponse.json({ ok: true });
  }

  try {
    // 3. Acknowledge button tap immediately (removes loading spinner)
    if (update.type === "callback") {
      await answerCallbackQuery(update.callbackQueryId);
    }

    // 4. Find or create user
    let dbUser = await getUser(update.chatId);
    if (!dbUser) {
      dbUser = await createUser(update.chatId);
    }

    // 5. Process through agent core
    const text = update.type === "message" ? update.text : "";
    const callbackData =
      update.type === "callback" ? update.callbackData : undefined;

    await processMessage(dbUser, text, callbackData);
  } catch (err) {
    // Log but don't throw — always return 200 to prevent Telegram retries
    console.error("[webhook] Error processing update:", err);
  }

  // 6. Always return 200
  return NextResponse.json({ ok: true });
}
