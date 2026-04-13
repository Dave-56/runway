import { escapeMarkdownV2 } from "./format";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

interface SendMessageOptions {
  parseMode?: "MarkdownV2" | "HTML";
  disableLinkPreview?: boolean;
}

export type InlineButton = {
  text: string;
  callback_data: string;
};

async function telegramFetch(method: string, body: Record<string, unknown>) {
  const res = await fetch(`${API_BASE}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const error = await res.text();
    console.error(`Telegram API error (${method}):`, error);
    throw new Error(`Telegram ${method} failed: ${res.status}`);
  }

  return res.json();
}

/**
 * Send a plain text message (auto-escaped for MarkdownV2).
 * Returns the sent message's message_id.
 */
export async function sendMessage(
  chatId: string,
  text: string,
  options: SendMessageOptions = {},
): Promise<number> {
  const parseMode = options.parseMode ?? "MarkdownV2";
  // If using MarkdownV2 and the caller hasn't pre-formatted, escape the text
  const finalText =
    parseMode === "MarkdownV2" ? escapeMarkdownV2(text) : text;

  const result = await telegramFetch("sendMessage", {
    chat_id: chatId,
    text: finalText,
    parse_mode: parseMode,
    disable_web_page_preview: options.disableLinkPreview ?? true,
  });

  return result.result.message_id;
}

/**
 * Send a pre-formatted MarkdownV2 message (caller handles escaping).
 * Use this for agent-generated messages where bold formatting is already applied.
 * Returns the sent message's message_id.
 */
export async function sendFormattedMessage(
  chatId: string,
  markdownV2Text: string,
): Promise<number> {
  const result = await telegramFetch("sendMessage", {
    chat_id: chatId,
    text: markdownV2Text,
    parse_mode: "MarkdownV2",
    disable_web_page_preview: true,
  });

  return result.result.message_id;
}

/**
 * Send a message with inline keyboard buttons.
 * `buttons` is a 2D array — each inner array is a row of buttons.
 * The message text should be pre-escaped MarkdownV2.
 * Returns the sent message's message_id.
 */
export async function sendMessageWithKeyboard(
  chatId: string,
  markdownV2Text: string,
  buttons: InlineButton[][],
): Promise<number> {
  const result = await telegramFetch("sendMessage", {
    chat_id: chatId,
    text: markdownV2Text,
    parse_mode: "MarkdownV2",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: buttons,
    },
  });

  return result.result.message_id;
}

/**
 * Send a message with an inline URL button.
 * Unlike callback buttons, URL buttons open the link in Telegram's in-app browser.
 * The message text should be pre-escaped MarkdownV2.
 * Returns the sent message's message_id.
 */
export async function sendMessageWithUrlButton(
  chatId: string,
  markdownV2Text: string,
  buttonText: string,
  url: string,
): Promise<number> {
  const result = await telegramFetch("sendMessage", {
    chat_id: chatId,
    text: markdownV2Text,
    parse_mode: "MarkdownV2",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [[{ text: buttonText, url }]],
    },
  });

  return result.result.message_id;
}

/**
 * Acknowledge an inline button tap.
 * Call this immediately when receiving a callback_query to remove the loading spinner.
 */
export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  await telegramFetch("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text && { text }),
  });
}
