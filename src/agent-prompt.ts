/**
 * Agent-prompt adapter for the Cliq channel.
 *
 * Surfaces Cliq-specific guidance to the agent's system prompt so the model
 * writes output that converts cleanly to Cliq's native formatting and knows
 * which message-tool actions / targeting / reactions are available. This is
 * the SDK's `ChannelAgentPromptAdapter` surface (forwarded by
 * `createChatChannelPlugin` from `base`), consumed by the runtime's system
 * prompt assembly:
 *
 * - `messageToolHints` → appended as bullet lines under the shared `message`
 *   tool section (the cross-channel `action=send` / `action=edit` / … tool).
 * - `messageToolCapabilities` → capability strings gating prompt blocks.
 *   Cliq does NOT advertise `inlineButtons` (a Telegram-specific Bot-API
 *   inline-keyboard scope) nor `richText` (a Telegram-specific Bot-API 10.1
 *   rich-text term); we return an empty list so no misleading prompt block is
 *   emitted. Interactive buttons are surfaced through the portable
 *   `presentation` capability on the `message` tool (the `buttons` /
 *   `presentation` params of `action=send`) — see the message-tool hints.
 * - `inboundFormattingHints` → `response_format` object in the trusted
 *   inbound-metadata block, telling the model what markup inbound uses and
 *   what markup to emit for reply.
 * - `reactionGuidance` → `## Reactions` system-prompt section. Cliq supports
 *   outbound reactions (the `react` message-action), so we advertise
 *   `"minimal"` by default; operators can opt into `"extensive"` or `"off"`
 *   via `channels.cliq.reactions.agentGuidance`.
 */
import type { ChannelAgentPromptAdapter } from "openclaw/plugin-sdk/channel-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { CliqReactionGuidanceConfig } from "./client.js";

const CHANNEL_LABEL = "Zoho Cliq";

function resolveReactionConfig(
  cfg: OpenClawConfig,
): CliqReactionGuidanceConfig {
  const section = (
    cfg as unknown as {
      channels?: { cliq?: { reactions?: CliqReactionGuidanceConfig } };
    }
  ).channels?.cliq?.reactions;
  return section ?? {};
}

/**
 * Build the message-tool hint lines for the agent. These are appended to the
 * shared `message` tool section of the system prompt, so they should be
 * concise, actionable, and Cliq-specific (not repeat the cross-channel
 * guidance the runtime already emits).
 */
export function resolveCliqMessageToolHints(): string[] {
  return [
    "- Cliq reply formatting: write standard Markdown; OpenClaw converts it to Cliq's native delimiters (`*bold*`, `_italic_`, `~strike~`, `` `code` ``, fenced blocks, `#` headings, `[text](url)`, `---` rule). Avoid mixing overlapping `**bold**` and `*italic*` spans; prefer one emphasis style per run.",
    "- Cliq targeting for `action=send`: `user:<zohoUserId>` for DMs, `channel:<channelUniqueName>` for channel posts. The bot must already be a participant of the target channel. Bare ids without a `cliq:`/kind prefix default to channel posts.",
    "- Cliq message actions: `edit` / `delete` / `read` are available. Channel edits/deletes/reads key off a `chat_id` (`CT_xxx`) — pass `chatId` for channel actions; DM edits/deletes/reads also require `chatId` (Cliq DM chat ids cannot be resolved from a bare user id without a prior send).",
    "- Cliq reactions: `action=react` with `emojiCode` accepts Zomoji shortcodes (`:smile:`) or unicode (`😄`) verbatim. Reactions need a user-context refresh token (channel/message scopes); without one, react will fail with `oauthtoken_scope_invalid`.",
    "- Cliq message limit: 5000 chars per message; long replies are auto-chunked on whitespace boundaries. Keep individual `action=send` payloads under the cap where possible.",
    "- Cliq interactive buttons (presentation capability): `action=send` accepts a `buttons` param (array of `{ label, url?, value? }`) — up to 10 buttons per message, labels ≤ 30 chars. A `url` button opens the link; a `value` (or `command`) button invokes the bot handler with that string as the inbound message. Use `buttons` for quick-reply choices, link cards, and confirmations. A full portable `presentation` object (`{ title?, blocks: [...] }`) is also accepted.",
    "- Cliq polls (v3 opt-in only, `apiVersion: \"v3\"`): `action=send` accepts `theme: \"poll\"` + `pollOptions` (array of 2–10 plain-text strings, ≤100 chars each) to post a voting card. Cliq counts votes natively — no callback to the bot, so poll options are NOT action buttons. The `message` text is the poll question (first line = card title). On v2 / unconfigured v3 the poll degrades to plain text.",
  ];
}

/**
 * Declare the inbound text markup + reply rules. Emitted as the trusted
 * `response_format` metadata block so the model knows what format to reply in.
 */
export function resolveCliqInboundFormattingHints(): {
  text_markup: string;
  rules: string[];
} {
  return {
    text_markup: "markdown",
    rules: [
      "Inbound messages are plain text from Zoho Cliq (Deluge webhook).",
      "Reply with standard Markdown; OpenClaw converts it to Cliq's native formatting (`*bold*`, `_italic_`, `~strike~`, `__underline__`, `` `inline` ``, fenced code, `#`/`###` headings, `[text](url)`, `---` divider, `!blockquote` line prefix).",
      "Cliq per-message limit is 5000 characters; long replies are auto-chunked.",
    ],
  };
}

/**
 * Resolve the reaction guidance for the agent. Defaults to `"minimal"` (we
 * support outbound reactions via the `react` message-action). Operators opt
 * into `"extensive"` or `"off"` via `channels.cliq.reactions.agentGuidance`.
 */
export function resolveCliqReactionGuidance(
  cfg: OpenClawConfig,
  accountId?: string | null,
): { level: "minimal" | "extensive"; channelLabel?: string } | undefined {
  const config = resolveReactionConfig(cfg);
  const raw = config.agentGuidance;
  const level: "minimal" | "extensive" | "off" =
    raw === "extensive" || raw === "off" ? raw : "minimal";
  if (level === "off") return undefined;
  // Reference accountId for symmetry with the SDK signature; the config is
  // account-scoped today but keyed only on the top-level cliq section.
  void accountId;
  return { level, channelLabel: CHANNEL_LABEL };
}

export const cliqAgentPromptAdapter: ChannelAgentPromptAdapter = {
  messageToolHints: () => resolveCliqMessageToolHints(),
  messageToolCapabilities: () => [],
  inboundFormattingHints: () => resolveCliqInboundFormattingHints(),
  reactionGuidance: ({ cfg, accountId }) =>
    resolveCliqReactionGuidance(cfg, accountId),
};
