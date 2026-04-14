/**
 * Quote/reply context formatting for Signal messages.
 * Masks phone numbers and truncates text for agent prompts.
 */

const MAX_QUOTE_TEXT_LENGTH = 200;

function maskAuthor(author: string | undefined | null): string {
  if (!author || author.length <= 4) return author ?? "unknown";
  return "***" + author.slice(-4);
}

function formatTimestamp(id: number | undefined | null): string {
  if (!id) return "";
  const date = new Date(id);
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export interface SignalQuote {
  id?: number;
  author?: string;
  text?: string;
}

export function formatQuoteContext(
  quote: SignalQuote | undefined | null,
): string {
  if (!quote || !quote.text) return "";

  const masked = maskAuthor(quote.author);
  const truncated =
    quote.text.length > MAX_QUOTE_TEXT_LENGTH
      ? quote.text.slice(0, MAX_QUOTE_TEXT_LENGTH) + "..."
      : quote.text;
  const time = formatTimestamp(quote.id);
  const timeSuffix = time ? `, ${time}` : "";

  return `[Replying to: "${truncated}" \u2014 ${masked}${timeSuffix}]\n`;
}
