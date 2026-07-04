/**
 * Mention handling for the Cliq channel.
 *
 * Zoho Cliq surfaces a bot mention in the message text as a literal `@BotName`
 * token (the Deluge bot handler substitutes the user-facing mention with the
 * bot's display name). When the agent sees the inbound text we want that token
 * stripped so the agent doesn't echo the handle back and so command detection
 * treats the remainder as the actual instruction.
 *
 * The same stripping logic is exposed twice:
 *  - As a pure function (`stripCliqMentions`) used by the inbound dispatch
 *    pipeline when assembling the agent-visible envelope.
 *  - As the `ChannelMentionAdapter` on the plugin (`stripRegexes` +
 *    `stripMentions`) so the SDK's shared `stripMentions` helper also removes
 *    the handle during command/mention resolution.
 */

const CLIQ_MENTION_PREFIX = "@";

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the regexes that match the configured bot's mention tokens.
 * Matches `@BotName` (case-insensitive, word-boundary aware) and, when the
 * botId differs from a plain handle, the raw `@botId` form too.
 *
 * Returns an empty array when no bot identity is configured so that callers
 * can always iterate the result.
 */
export function buildCliqMentionRegexes(account: {
  botId?: string;
  botName?: string;
}): RegExp[] {
  const regexes: RegExp[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const name = raw.trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const pattern = `${CLIQ_MENTION_PREFIX}${escapeRegex(name)}\\b`;
    regexes.push(new RegExp(pattern, "giu"));
  };
  add(account.botName ?? "");
  add(account.botId ?? "");
  return regexes;
}

/**
 * Remove bot mention tokens from `text` and normalize whitespace. Pure and
 * side-effect free; safe to call with an account whose bot identity is not
 * configured (returns the trimmed input unchanged).
 */
export function stripCliqMentions(
  text: string,
  account: { botId?: string; botName?: string },
): string {
  if (!text) return "";
  let result = text;
  for (const re of buildCliqMentionRegexes(account)) {
    re.lastIndex = 0;
    result = result.replace(re, " ");
  }
  return result.replace(/\s+/g, " ").trim();
}
