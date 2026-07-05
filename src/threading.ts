/**
 * Threading adapter for the Cliq channel.
 *
 * Cliq has no first-class "thread" concept exposed through the bot message
 * API (no `parent_message_id` / `reply_to` field on the bot-message or
 * channelsbyname send endpoints), so the adapter's job is NOT to render
 * reply quotes in Cliq — it can't. Instead it:
 *
 *  - **`resolveReplyToMode`** fixes the previous broken default
 *    (`topLevelReplyToMode: "reply"`, which the SDK's
 *    `createTopLevelChannelReplyToModeResolver` treated as a *channel id*
 *    and therefore resolved to `"off"` via a non-existent
 *    `cfg.channels["reply"]` lookup). The resolver now reads
 *    `channels.cliq.replyToMode` and `channels.cliq.replyToModeByChatType`
 *    (the same keys every bundled channel honors) and defaults to `"off"`,
 *    honestly reflecting that Cliq cannot render a reply-quote relationship.
 *    Operators who want the inbound `MessageSid` carried on the delivery
 *    payload (for telemetry / correlation) can set `replyToMode: "all"` or
 *    `replyToModeByChatType: { group: "first" }`.
 *
 *  - **`allowExplicitReplyTagsWhenOff: true`** lets an agent's explicit
 *    `reply_to` directive still attach the inbound message id even when the
 *    configured mode is `"off"` (matches the bundled-channel default for
 *    plugin channels).
 *
 *  - **`resolveReplyTransport`** passes the (mode-filtered) `replyToId`
 *    through to the outbound delivery context so `ctx.replyToId` is
 *    available for logging / correlation, and forces `threadId: null`
 *    (Cliq has no threads — never let an upstream thread id leak onto a
 *    Cliq send where it would be a no-op at best and a confusing log line
 *    at worst).
 *
 *  - **`buildToolContext`** populates the shared `message` tool's
 *    threading context (`currentChannelId`, `currentMessagingTarget`,
 *    `currentThreadTs`) from the inbound `To` / `ReplyToId` so the agent's
 *    message tool targets the right conversation when it composes a
 *    follow-up. Mirrors the MS Teams / Slack pattern.
 *
 *  - **`resolveCurrentChannelId`** returns the routable `to` as-is when no
 *    thread is present (Cliq encodes the destination in `to` already:
 *    `cliq:channel:<uniqueName>` / `cliq:user:<id>`); there is no
 *    thread-derived channel id to compute.
 */
import type {
  ChannelThreadingAdapter,
  ChannelThreadingContext,
  ChannelThreadingToolContext,
  ChannelReplyTransport,
} from "openclaw/plugin-sdk/channel-runtime";
import type { ReplyToMode } from "openclaw/plugin-sdk/config-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

const CHANNEL_ID = "cliq" as const;

/** Valid reply-to mode values (mirrors the SDK's `ReplyToMode` union). */
const VALID_REPLY_TO_MODES: readonly ReplyToMode[] = [
  "off",
  "first",
  "all",
  "batched",
];

interface CliqThreadingChannelConfig {
  replyToMode?: string;
  replyToModeByChatType?: Record<string, string>;
}

function readCliqChannelConfig(
  cfg: OpenClawConfig,
): CliqThreadingChannelConfig | null {
  const channels = (cfg as unknown as {
    channels?: Record<string, CliqThreadingChannelConfig | undefined>;
  }).channels;
  const section = channels?.[CHANNEL_ID];
  if (!section || typeof section !== "object") return null;
  return section;
}

function normalizeReplyToMode(value: unknown): ReplyToMode | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase() as ReplyToMode;
  return VALID_REPLY_TO_MODES.includes(v) ? v : undefined;
}

function normalizeChatTypeKey(chatType: unknown): string | undefined {
  if (typeof chatType !== "string") return undefined;
  const v = chatType.trim().toLowerCase();
  if (v === "direct" || v === "group" || v === "channel") return v;
  return undefined;
}

/**
 * Resolve the effective reply-to mode for a Cliq turn. Honors
 * `channels.cliq.replyToModeByChatType.<chatType>` first (per-chat-type
 * override), then `channels.cliq.replyToMode` (channel-wide), then defaults
 * to `"off"` (Cliq cannot render a reply-quote, so carrying `replyToId`
 * has no visible effect — `"off"` is the honest default).
 */
export function resolveCliqReplyToMode(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  chatType?: string | null;
}): ReplyToMode {
  const section = readCliqChannelConfig(params.cfg);
  if (section) {
    const chatKey = normalizeChatTypeKey(params.chatType);
    if (chatKey) {
      const scoped = normalizeReplyToMode(
        section.replyToModeByChatType?.[chatKey],
      );
      if (scoped) return scoped;
    }
    const channelWide = normalizeReplyToMode(section.replyToMode);
    if (channelWide) return channelWide;
  }
  return "off";
}

/**
 * Build the threading tool context for the shared `message` tool. The agent
 * uses `currentChannelId` / `currentMessagingTarget` to address follow-up
 * sends to the originating conversation, and `currentThreadTs` to reference
 * the inbound message when composing a reply. Cliq has no thread id, so
 * `currentThreadTs` carries the inbound `ReplyToId` (the parent message id)
 * for correlation only — the outbound send ignores it.
 */
export function buildCliqThreadingToolContext(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  context: ChannelThreadingContext;
  hasRepliedRef?: { value: boolean };
}): ChannelThreadingToolContext | undefined {
  const to = params.context.To?.trim() || undefined;
  const replyToId = params.context.ReplyToId?.trim() || undefined;
  return {
    currentChannelId: to,
    currentMessagingTarget: to,
    currentThreadTs: replyToId,
    hasRepliedRef: params.hasRepliedRef,
  };
}

/**
 * Resolve the reply transport for an outbound delivery. Passes the
 * mode-filtered `replyToId` through (so `ctx.replyToId` is available on
 * the outbound context for logging / correlation) and forces `threadId` to
 * `null` — Cliq has no threads, and an upstream thread id must never reach
 * a Cliq send.
 */
export function resolveCliqReplyTransport(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  threadId?: string | number | null;
  replyToId?: string | null;
  replyToIsExplicit?: boolean;
}): ChannelReplyTransport | null {
  return {
    replyToId: params.replyToId ?? null,
    threadId: null,
  };
}

/**
 * Resolve the platform-native channel id for a delivery address. Cliq
 * encodes the destination in `to` (`cliq:channel:<uniqueName>` /
 * `cliq:user:<id>`); there is no thread-derived channel id to compute, so
 * the routable `to` is returned as-is when no thread is present. A
 * non-null `threadId` (which Cliq never produces inbound) is ignored
 * rather than appended, since Cliq would not understand a
 * `:topic:`-style suffix.
 */
export function resolveCliqCurrentChannelId(params: {
  to: string;
  threadId?: string | number | null;
}): string | undefined {
  return params.to || undefined;
}

export const cliqThreadingAdapter: ChannelThreadingAdapter = {
  resolveReplyToMode: resolveCliqReplyToMode,
  allowExplicitReplyTagsWhenOff: true,
  buildToolContext: buildCliqThreadingToolContext,
  resolveReplyTransport: resolveCliqReplyTransport,
  resolveCurrentChannelId: resolveCliqCurrentChannelId,
};
