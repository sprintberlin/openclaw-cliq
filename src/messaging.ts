/**
 * Messaging / session-binding adapter for the Cliq channel.
 *
 * Cliq has no first-class "thread" or "topic" concept exposed through the bot
 * message API — every conversation is either a one-to-one bot DM or a channel
 * (group) chat. So the session-binding grammar is flat: a conversation is
 * identified by a kind-prefixed id (`user:<senderId>` for DMs,
 * `channel:<uniqueName>` for groups), with no parent/child nesting.
 *
 * The adapter wires the `ChannelMessagingAdapter` surface consumed by the
 * runtime's session-key / conversation-binding pipeline:
 *
 *  - **`targetPrefixes` / `normalizeTarget`** — declare `cliq` as the provider
 *    prefix and canonicalize targets to `cliq:user:<id>` / `cliq:channel:<id>`.
 *  - **`resolveInboundConversation`** — derives a stable, kind-prefixed
 *    `conversationId` (and matching `parentConversationId`) from an inbound
 *    turn's `to` / `from`. The kind prefix makes the conversation id
 *    self-describing so `resolveDeliveryTarget` can rebuild `to` unambiguously
 *    (Cliq user ids and channel unique names share no inherent discriminator,
 *    unlike Telegram's signed chat ids).
 *  - **`resolveDeliveryTarget`** — reverses `resolveInboundConversation`,
 *    rebuilding the canonical `cliq:<kind>:<id>` delivery target from a stored
 *    conversation id. Used by cron / heartbeat / cross-context delivery.
 *  - **`resolveSessionConversation`** — parses a group/channel `rawId` into its
 *    base-conversation identity. Cliq has no topics, so `threadId` is always
 *    `null` and `baseConversationId` equals `id`.
 *  - **`resolveSessionTarget`** — builds the canonical routable target for a
 *    resolved session peer (`cliq:group:<id>` for groups — matching the inbound
 *    `From` convention, `cliq:user:<id>` for DMs).
 *  - **`inferTargetChatType`** — lightweight chat-type inference from a target
 *    string so the runtime can steer peer-vs-group resolution without a
 *    directory round-trip.
 *  - **`resolveOutboundSessionRoute`** — builds the canonical outbound session
 *    route (session key + peer + from/to) for a resolved target, via the SDK's
 *    `buildChannelOutboundSessionRoute` helper so session-key orchestration
 *    stays in core.
 *  - **`formatTargetDisplay`** — renders a target as a human-readable label
 *    (`@<user>` for DMs, `#<channel>` for groups), mirroring the Telegram /
 *    Discord display convention.
 *  - **`targetResolver`** — declares the Cliq target id shape so the runtime's
 *    directory-miss fallback and cross-channel target validation can recognize
 *    native targets.
 */
import type { ChannelMessagingAdapter } from "openclaw/plugin-sdk/channel-runtime";
import type { ChatType } from "openclaw/plugin-sdk/core";
import {
  buildChannelOutboundSessionRoute,
  type ChannelOutboundSessionRoute,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/core";

const CHANNEL_ID = "cliq" as const;

/** DM-target kind prefixes (lowercase). */
const DM_KINDS = new Set(["user", "dm"]);
/** Group/channel-target kind prefixes (lowercase). */
const GROUP_KINDS = new Set(["channel", "chat", "group"]);

/** A parsed Cliq target: the kind (direct vs group) and the raw id. */
export interface ParsedCliqTarget {
  kind: "direct" | "group";
  id: string;
  /**
   * `true` when the kind was explicit in the input (`cliq:user:` / `cliq:channel:`
   * / …); `false` when the kind was inferred from a bare `cliq:<id>` or `<id>`
   * (which defaults to group but is genuinely ambiguous between DM and group).
   */
  explicit: boolean;
}

/**
 * Parse a Cliq target string into its kind + id.
 *
 * Recognized shapes (case-insensitive kind):
 *   - `cliq:user:<id>` / `cliq:dm:<id>`     → direct (explicit)
 *   - `cliq:channel:<name>` / `cliq:chat:<id>` / `cliq:group:<name>` → group (explicit)
 *   - `cliq:<id>` (bare, no kind)            → ambiguous; defaults to group
 *     (matches `normalizeCliqRouteTarget`'s backward-compat default — a bare
 *     id is treated as a channel/group id, since DM targets are always
 *     kind-prefixed by the inbound path).
 *   - a bare `<id>` with no `cliq:` prefix    → group (same default).
 *
 * Returns `null` when the input is empty or malformed.
 */
export function parseCliqTarget(raw: string | undefined | null): ParsedCliqTarget | null {
  const value = raw?.trim();
  if (!value) return null;
  const m = /^cliq:([a-z]+):(.+)$/i.exec(value);
  if (m) {
    const kind = m[1].toLowerCase();
    const id = m[2].trim();
    if (!id) return null;
    if (DM_KINDS.has(kind)) return { kind: "direct", id, explicit: true };
    if (GROUP_KINDS.has(kind)) return { kind: "group", id, explicit: true };
    // Unknown kind prefix — treat as group (forward-compat: an unfamiliar
    // kind is more likely a new group/channel shape than a DM variant).
    return { kind: "group", id, explicit: true };
  }
  // `cliq:<id>` with no kind, or a bare `<id>`. Reject anything that still
  // contains a `:` after stripping the provider prefix — that indicates a
  // malformed kind prefix the regex couldn't match (e.g. `cliq:user:` with
  // an empty id, already handled above, or `cliq:foo:bar:baz`). Also reject a
  // bare token that matches a known kind keyword (`cliq:user`, `cliq:channel`)
  // — those are malformed kind-prefixed targets with a missing id, not bare ids.
  const stripped = /^cliq:/i.test(value) ? value.slice("cliq:".length).trim() : value;
  if (!stripped || stripped.includes(":")) return null;
  if (DM_KINDS.has(stripped.toLowerCase()) || GROUP_KINDS.has(stripped.toLowerCase())) {
    return null;
  }
  return { kind: "group", id: stripped, explicit: false };
}

/** Strip the `cliq:` provider prefix, returning the kind-prefixed body. */
function stripCliqPrefix(raw: string): string {
  return raw.replace(/^cliq:/i, "").trim();
}

/**
 * Canonicalize a raw target to `cliq:user:<id>` / `cliq:channel:<id>`.
 * Returns `undefined` when the input is empty or unparseable.
 */
export function normalizeCliqMessagingTarget(raw: string | undefined | null): string | undefined {
  const parsed = parseCliqTarget(raw);
  if (!parsed) return undefined;
  return parsed.kind === "direct"
    ? `cliq:user:${parsed.id}`
    : `cliq:channel:${parsed.id}`;
}

/**
 * Derive the stable, kind-prefixed conversation id for an inbound turn.
 *
 * The conversation id is `user:<senderId>` for DMs and `channel:<uniqueName>`
 * for groups — the kind prefix makes it self-describing so
 * `resolveDeliveryTarget` can rebuild the delivery target without an external
 * chat-type hint (Cliq user ids and channel unique names are otherwise
 * indistinguishable).
 */
export function resolveCliqInboundConversation(params: {
  from?: string;
  to?: string;
  conversationId?: string;
  threadId?: string | number;
  threadParentId?: string | number;
  isGroup: boolean;
}): { conversationId: string; parentConversationId: string } | null {
  // Prefer `to` (always kind-prefixed from our inbound path), then
  // `conversationId`, then `from`.
  const raw =
    params.to?.trim() ||
    params.conversationId?.trim() ||
    params.from?.trim() ||
    "";
  if (!raw) return null;
  const parsed = parseCliqTarget(raw);
  if (parsed) {
    // For an explicit kind prefix, trust it. For a bare (ambiguous) id,
    // honor the `isGroup` hint so a DM `from: cliq:<senderId>` resolves to
    // a `user:` conversation, not `channel:`.
    const isDirect = parsed.explicit ? parsed.kind === "direct" : !params.isGroup;
    const convId = isDirect ? `user:${parsed.id}` : `channel:${parsed.id}`;
    return { conversationId: convId, parentConversationId: convId };
  }
  // Unparseable — fall back to the bare body with the isGroup hint.
  const bare = stripCliqPrefix(raw);
  if (!bare || bare.includes(":")) return null;
  const convId = params.isGroup ? `channel:${bare}` : `user:${bare}`;
  return { conversationId: convId, parentConversationId: convId };
}

/**
 * Rebuild the canonical delivery target (`cliq:<kind>:<id>`) from a stored
 * conversation id. The conversation id carries a kind prefix
 * (`user:` / `channel:`); a bare conversation id (no prefix) is treated as a
 * group target (backward compat with externally-stored ids).
 */
export function resolveCliqDeliveryTarget(params: {
  conversationId: string;
  parentConversationId?: string;
}): { to: string; threadId?: string } | null {
  const raw = (params.conversationId?.trim() || params.parentConversationId?.trim() || "").trim();
  if (!raw) return null;
  // The stored conversation id is `user:<id>` / `channel:<id>`. Prepend the
  // provider prefix to rebuild the routable target.
  if (raw.startsWith("user:")) {
    return { to: `cliq:${raw}` };
  }
  if (raw.startsWith("channel:")) {
    return { to: `cliq:${raw}` };
  }
  // Bare id — default to a channel (group) target.
  return { to: `cliq:channel:${raw}` };
}

/**
 * Parse a group/channel `rawId` into its base-conversation identity. Cliq has
 * no topics/threads, so `threadId` is always `null` and the base conversation
 * equals the id itself.
 */
export function resolveCliqSessionConversation(params: {
  kind: "group" | "channel";
  rawId: string;
}): {
  id: string;
  threadId: null;
  baseConversationId: string;
  parentConversationCandidates: string[];
} | null {
  const id = params.rawId?.trim();
  if (!id) return null;
  return {
    id,
    threadId: null,
    baseConversationId: id,
    parentConversationCandidates: [id],
  };
}

/**
 * Build the canonical routable target for a resolved session peer. Groups use
 * `cliq:group:<id>` (matching the inbound `From` convention so
 * `extractExplicitGroupId` resolves the channel unique name for the `groups`
 * adapter); DMs use `cliq:user:<id>`.
 */
export function resolveCliqSessionTarget(params: {
  kind: "group" | "channel";
  id: string;
  threadId?: string | null;
}): string | undefined {
  const id = params.id?.trim();
  if (!id) return undefined;
  // Both "group" and "channel" kinds map to the `cliq:group:` from-prefix
  // (Cliq channels ARE group chats; the `group:` prefix is what the runtime's
  // `extractExplicitGroupId` recognizes for per-group config lookup).
  return `cliq:group:${id}`;
}

/**
 * Infer the chat type of a target string without a directory round-trip.
 * `cliq:user:` / `cliq:dm:` → `"direct"`; any other recognizable Cliq target →
 * `"group"`; unparseable → `undefined`.
 */
export function inferCliqTargetChatType(params: { to: string }): ChatType | undefined {
  const parsed = parseCliqTarget(params.to);
  if (!parsed) return undefined;
  return parsed.kind === "direct" ? "direct" : "group";
}

/**
 * Build the outbound session route for a resolved target. Cliq has no threads,
 * so `threadId` is never attached. Session-key orchestration stays in core
 * via `buildChannelOutboundSessionRoute`.
 */
export function resolveCliqOutboundSessionRoute(params: {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string | null;
  target: string;
  currentSessionKey?: string | null;
  resolvedTarget?: {
    to: string;
    kind: "user" | "group" | "channel";
    display?: string;
    source: "normalized" | "directory";
  } | null;
  replyToId?: string | null;
  threadId?: string | number | null;
}): ChannelOutboundSessionRoute | null {
  const parsed = parseCliqTarget(params.target);
  const id = parsed?.id ?? params.target.trim();
  if (!id) return null;
  // Determine direct vs group: an explicit kind prefix wins; for a bare
  // (ambiguous) id, defer to the directory-resolved kind when available;
  // otherwise default to group.
  const isGroup =
    parsed && parsed.explicit
      ? parsed.kind === "group"
      : params.resolvedTarget
        ? params.resolvedTarget.kind !== "user"
        : true;
  const peer = { kind: isGroup ? ("group" as const) : ("direct" as const), id };
  const to = isGroup ? `cliq:channel:${id}` : `cliq:user:${id}`;
  const from = isGroup ? `cliq:group:${id}` : `cliq:user:${id}`;
  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: CHANNEL_ID,
    accountId: params.accountId,
    peer,
    chatType: isGroup ? "group" : "direct",
    from,
    to,
  });
}

/**
 * Render a target as a human-readable label: `@<user>` for DMs, `#<channel>`
 * for groups. Mirrors the Telegram / Discord display convention.
 */
export function formatCliqTargetDisplay(params: {
  target: string;
  display?: string;
  kind?: "user" | "group" | "channel";
}): string {
  const formatted = params.display?.trim();
  if (formatted) return formatted;
  const trimmedTarget = params.target.trim();
  if (!trimmedTarget) return trimmedTarget;
  const withoutProvider = trimmedTarget.replace(/^cliq:/i, "");
  if (params.kind === "user" || /^user:/i.test(withoutProvider) || /^dm:/i.test(withoutProvider)) {
    return `@${withoutProvider.replace(/^(user|dm):/i, "")}`;
  }
  if (params.kind === "channel" || /^channel:/i.test(withoutProvider)) {
    return `#${withoutProvider.replace(/^channel:/i, "")}`;
  }
  // Unknown kind — show the id verbatim (without provider/kind prefix).
  return withoutProvider.replace(/^(group|chat|dm):/i, "");
}

/** A Cliq target id is any non-empty string after stripping the provider prefix. */
export function looksLikeCliqTargetId(raw: string): boolean {
  return Boolean(raw?.trim() && parseCliqTarget(raw));
}

export const cliqMessagingAdapter: ChannelMessagingAdapter = {
  targetPrefixes: ["cliq"],
  normalizeTarget: normalizeCliqMessagingTarget,
  resolveInboundConversation: resolveCliqInboundConversation,
  resolveDeliveryTarget: resolveCliqDeliveryTarget,
  resolveSessionConversation: resolveCliqSessionConversation,
  resolveSessionTarget: resolveCliqSessionTarget,
  inferTargetChatType: inferCliqTargetChatType,
  resolveOutboundSessionRoute: resolveCliqOutboundSessionRoute,
  formatTargetDisplay: formatCliqTargetDisplay,
  targetResolver: {
    looksLikeId: looksLikeCliqTargetId,
    hint: "<channelUniqueName|userId>",
  },
};
