export type TelegramUpdate =
  | {
      type: "message";
      chatId: string;
      text: string;
      messageId: number;
    }
  | {
      type: "callback";
      chatId: string;
      callbackData: string;
      callbackQueryId: string;
      messageId: number;
    };

interface TelegramUpdateBody {
  message?: {
    chat: { id: number };
    text?: string;
    message_id: number;
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: {
      chat: { id: number };
      message_id: number;
    };
  };
}

export function parseUpdate(body: unknown): TelegramUpdate | null {
  const update = body as TelegramUpdateBody;

  if (update.callback_query) {
    const cq = update.callback_query;
    if (!cq.message || !cq.data) return null;
    return {
      type: "callback",
      chatId: String(cq.message.chat.id),
      callbackData: cq.data,
      callbackQueryId: cq.id,
      messageId: cq.message.message_id,
    };
  }

  if (update.message?.text) {
    return {
      type: "message",
      chatId: String(update.message.chat.id),
      text: update.message.text,
      messageId: update.message.message_id,
    };
  }

  return null;
}
