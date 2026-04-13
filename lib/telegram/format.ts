// Characters that must be escaped in Telegram MarkdownV2
const MARKDOWN_V2_SPECIAL = /([_*\[\]()~`>#+\-=|{}.!\\])/g;

export function escapeMarkdownV2(text: string): string {
  return text.replace(MARKDOWN_V2_SPECIAL, "\\$1");
}

export function bold(text: string): string {
  return `*${escapeMarkdownV2(text)}*`;
}

export function formatCurrencyBold(amount: number): string {
  const abs = Math.abs(amount);
  const isWhole = abs === Math.floor(abs);
  const formatted = isWhole
    ? abs.toLocaleString("en-US", { maximumFractionDigits: 0 })
    : abs.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
  const str = amount < 0 ? `-$${formatted}` : `$${formatted}`;
  return bold(str);
}
