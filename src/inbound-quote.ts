/**
 * Inbound quote / reply context (issue #49).
 *
 * When a user replies to or quotes a message in Cliq, the Deluge message
 * handler receives the new message. Cliq's message object can carry a
 * `reply_to` field (the message id of the message being replied to), and a
 * Deluge handler that wants to surface the quoted content can forward the
 * parent message object alongside the new message under a custom key. The
 * plugin parser tolerates the common field names so a handler author does not
 * have to follow a strict contract.
 *
 * The plugin then carries the referenced message's id + text + sender into the
 * agent context. When only the parent message id is present (the default Cliq
 * shape — the bot handler receives just the reply id, not the parent text),
 * the plugin best-effort fetches the parent message via
 * `GET /api/v2/chats/{chatId}/messages` (the chat-messages list endpoint,
 * scope `ZohoCliq.Messages.READ`, requires a user-context refresh token — the
 * same `client_credentials` limitation as channel posts / edits / reactions).
 * A fetch failure degrades to "no quote text" and never breaks the turn.
 *
 * Refs:
 *  - Message Object (quote fields) <https://www.zoho.com/cliq/help/platform/cliq-objects/message-object.html>
 *  - Post message `reply_to` arg <https://www.zoho.com/cliq/help/restapi/v2/messages/>
 */

import {
  parseCliqForwardContext,
  type CliqForwardContext,
} from "./inbound-forward.js";

/** A normalized reference to the message a user replied to / quoted. */
export interface CliqReplyToContext {
  /** Parent message id (Cliq message id, e.g. `1542711601585_349430767610289`). */
  messageId?: string;
  /** Parent message text, when the Deluge handler forwarded it or the fetch resolved it. */
  text?: string;
  /** Parent message sender display name. */
  senderName?: string;
  /** Parent message sender id (Zoho user id). */
  senderId?: string;
  /** Parent message timestamp (as the handler forwarded it; not normalized). */
  time?: string;
}

/**
 * Shape of the parent-message object.
 *
 * Two families are tolerated:
 *
 *  1. The hand-assembled family a Deluge handler may forward (`text`, string
 *     `time`).
 *  2. The **actual** shape Cliq stores on a reply, verified live 2026-09-07
 *     against `GET /api/v2/chats/{chatId}/messages`:
 *
 *       replied_to: {
 *         id:      "<parent message id>",
 *         content: "<parent body text>",
 *         time:    <epoch milliseconds, NUMBER>,
 *         type:    "text",
 *         sender:  { id: "<id>", name: "<display name>" }
 *       }
 *
 *     Note `time` is a NUMBER here, unlike `forward_info.time` which is a
 *     numeric string (see inbound-forward.ts). Reading it as a string only
 *     silently dropped the parent timestamp.
 */
interface RawParentMessage {
  id?: string;
  message_id?: string;
  text?: string;
  /** Cliq `replied_to.content`: the parent body text. */
  content?: string;
  /** String for hand-assembled handlers; epoch-ms NUMBER for Cliq's own shape. */
  time?: string | number;
  sender?: {
    id?: string;
    name?: string;
    first_name?: string;
    last_name?: string;
    email?: string;
    email_id?: string;
  };
}

const RAW_PARENT_KEYS = [
  // Cliq's own field name, verified live on a real reply (2026-09-07).
  "replied_to",
  "repliedTo",
  "reply_to",
  "parent",
  "parent_message",
  "quoted",
  "quoted_message",
  "reply_to_message",
] as const;

/**
 * Parse the quote / reply-to context from a raw Cliq webhook payload.
 * Tolerates the field-name variants observed across Cliq API versions and
 * Deluge handler conventions:
 *
 *  - `message.reply_to` (string message id) — the documented Cliq shape.
 *  - `message.reply_to` (object) — a handler that enriches the message with
 *    the full parent object.
 *  - `reply_to` / `parent` / `parent_message` / `quoted` / `quoted_message`
 *    / `reply_to_message` at the payload root or nested under `message` — a
 *    handler that forwards the parent as a sibling field.
 *
 * The common case is `message.reply_to` carrying only the parent message id
 * while a Deluge handler forwards the full parent object (text + sender)
 * alongside it under a sibling key. So we MERGE every source we find: the
 * string id from `message.reply_to` is combined with the text/sender from a
 * root-level parent object when both are present.
 *
 * Returns the merged context (possibly with only `messageId` set), or
 * `undefined` when no reply-to / quote reference is present.
 */
export function parseCliqReplyToContext(
  raw: unknown,
): CliqReplyToContext | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const payload = raw as Record<string, unknown>;

  // The `params`-wrapped variant — unwrap and recurse once so the same
  // merge logic applies to both the raw and the wrapped shape.
  if (payload.params && typeof payload.params === "object" && !Array.isArray(payload.params)) {
    return parseCliqReplyToContext(payload.params);
  }

  let merged: CliqReplyToContext | undefined;
  const merge = (next: CliqReplyToContext | undefined) => {
    if (!next) return;
    if (!merged) {
      merged = { ...next };
      return;
    }
    merged = {
      messageId: merged.messageId ?? next.messageId,
      text: merged.text ?? next.text,
      senderName: merged.senderName ?? next.senderName,
      senderId: merged.senderId ?? next.senderId,
      time: merged.time ?? next.time,
    };
  };

  // 1. `message.*` variants — string id OR a parent object.
  const message = payload.message;
  if (message && typeof message === "object" && !Array.isArray(message)) {
    const msg = message as Record<string, unknown>;
    for (const key of RAW_PARENT_KEYS) {
      const v = msg[key];
      if (v === undefined) continue;
      merge(parseRawParent(v) ?? parseStringId(v));
    }
  }

  // 2. Root-level variants — a Deluge handler forwarding the parent as a
  //    sibling. These carry the text/sender when `message.reply_to` only
  //    had the id, so they fill the gaps in the merge.
  for (const key of RAW_PARENT_KEYS) {
    const v = payload[key];
    if (v === undefined) continue;
    merge(parseRawParent(v) ?? parseStringId(v));
  }

  return merged;
}

function parseStringId(v: unknown): CliqReplyToContext | undefined {
  if (typeof v === "string" && v.trim()) {
    return { messageId: v.trim() };
  }
  return undefined;
}

function parseRawParent(v: unknown): CliqReplyToContext | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const rec = v as RawParentMessage;
  const messageId =
    (typeof rec.id === "string" && rec.id.trim() && rec.id.trim()) ||
    (typeof rec.message_id === "string" && rec.message_id.trim() && rec.message_id.trim()) ||
    undefined;
  const text =
    (typeof rec.text === "string" && rec.text.trim() && rec.text.trim()) ||
    (typeof rec.content === "string" && rec.content.trim() && rec.content.trim()) ||
    undefined;
  const time = normalizeParentTime(rec.time);
  const sender = rec.sender;
  const senderId =
    (sender && typeof sender.id === "string" && sender.id.trim() && sender.id.trim()) ||
    undefined;
  const senderName =
    (sender && typeof sender.name === "string" && sender.name.trim() && sender.name.trim()) ||
    (sender &&
      [sender.first_name, sender.last_name]
        .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
        .join(" ") || undefined) ||
    undefined;
  if (!messageId && !text) return undefined;
  return { messageId, text, senderId, senderName, time };
}

/**
 * Normalize a parent-message timestamp for display.
 *
 * Cliq delivers `replied_to.time` as epoch milliseconds in a NUMBER; a
 * hand-assembled handler may send an already-formatted string. A plausible
 * epoch becomes ISO-8601; a bare number outside that range is dropped rather
 * than rendered as a bogus date; other strings pass through untouched.
 */
function normalizeParentTime(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return epochMsToIso(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) return epochMsToIso(Number(trimmed));
  return trimmed;
}

/** Epoch milliseconds within a sane range, as ISO-8601. */
function epochMsToIso(ms: number): string | undefined {
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  const date = new Date(ms);
  const year = date.getUTCFullYear();
  if (Number.isNaN(date.getTime()) || year < 2000 || year > 2100) return undefined;
  return date.toISOString();
}

/**
 * Best-effort fetch of the parent message text when only the message id is
 * present. Queries `GET /api/v2/chats/{chatId}/messages` (the chat-messages
 * list endpoint) and matches the parent by id. Requires a user-context refresh
 * token (chat-message reads need a user-consented scope the
 * `client_credentials` grant cannot obtain — see AGENTS.md Learnings). Any
 * failure (no refresh token, no chatId, API rejection, no match) resolves to
 * `undefined` so the inbound dispatch never breaks on a missing quote.
 *
 * Returns the resolved `CliqReplyToContext` (the input, possibly enriched
 * with `text` / `senderName` / `senderId`), or the input unchanged when no
 * enrichment was possible.
 */
export async function resolveCliqReplyToContext(
  replyTo: CliqReplyToContext | undefined,
  params: {
    client: {
      listChatMessages: (
        chatId: string,
        opts?: { limit?: number },
      ) => Promise<{ messageId: string; chatId?: string; text?: string }[]>;
    };
    chatId?: string;
    /** When false, the fetch is skipped (no refresh token configured). */
    canReadChatMessages: boolean;
    onError?: (err: unknown, info: { kind: string }) => void;
  },
): Promise<CliqReplyToContext | undefined> {
  if (!replyTo) return replyTo;
  // Already have text — no fetch needed.
  if (replyTo.text) return replyTo;
  // Need an id to look up.
  const parentMessageId = replyTo.messageId?.trim();
  if (!parentMessageId) return replyTo;
  if (!params.canReadChatMessages) return replyTo;
  const chatId = params.chatId?.trim();
  if (!chatId) return replyTo;

  try {
    const messages = await params.client.listChatMessages(chatId, {
      limit: 50,
    });
    for (const m of messages) {
      if (m.messageId === parentMessageId) {
        return {
          ...replyTo,
          text: m.text?.trim() || replyTo.text,
        };
      }
    }
    return replyTo;
  } catch (err) {
    params.onError?.(err, { kind: "reply-to-fetch" });
    return replyTo;
  }
}

/** Combine handler and history fields only when both identify the same parent. */
export function mergeCliqReplyToContexts(
  handler: CliqReplyToContext | undefined,
  recovered: CliqReplyToContext | undefined,
): CliqReplyToContext | undefined {
  if (!handler) return recovered;
  if (!recovered) return handler;
  // A matching text, sender and time does not prove the live record is in
  // history yet. Conflicting or missing parent IDs cannot be merged safely.
  if (!handler.messageId || !recovered.messageId || handler.messageId !== recovered.messageId) {
    return handler;
  }
  return {
    messageId: handler.messageId,
    text: handler.text ?? recovered.text,
    senderName: handler.senderName ?? recovered.senderName,
    senderId: handler.senderId ?? recovered.senderId,
    time: handler.time ?? recovered.time,
  };
}

/**
 * Recover inbound context (reply / forward) from Cliq's chat history
 * (issues #230 + #223).
 *
 * The deployed Deluge Message handler forwards `message` / `user` / `chat`
 * only: no parent reference for replies, no forward marker, and no native
 * message id (`parsed.messageId` is a `syn:` fallback for string-message
 * traffic), so id-based matching is impossible. Cliq does store both on the
 * message itself — verified live 2026-09-07, a real reply carried
 * `replied_to: { id, content, sender: { id, name }, time }`, and forwards
 * carry `message_type: "forwarded"` + `forward_info` — reachable only via
 * `GET /api/v2/chats/{chatId}/messages`.
 *
 * Neither a reply nor a caption-bearing forward has any marker in the handler
 * payload, so this cannot be gated on evidence and costs one history read per
 * inbound message. It is therefore opt-in via
 * `channels.cliq.replyContextRecovery` and off by default.
 *
 * Match a native incoming message id when available. Otherwise require a
 * unique normalized-text match from the same sender within the time window.
 * Ambiguous matches are discarded rather than choosing an unrelated parent.
 */
export async function recoverCliqInboundContextFromHistory(
  params: {
    client: {
      listChatMessages: (
        chatId: string,
        opts?: { limit?: number },
      ) => Promise<{
        messageId: string;
        text?: string;
        senderId?: string;
        timestamp?: string;
        messageType?: string;
        forwardInfo?: unknown;
        repliedTo?: unknown;
      }[]>;
    };
    chatId?: string;
    /** Body text of the live inbound message. Empty text cannot be matched. */
    text?: string;
    /** Live sender id, used to avoid matching another user's identical text. */
    senderId?: string;
    /** Native incoming message id, if available (not a Deluge event or hash). */
    messageId?: string;
    /** Inbound timestamp, used to reject stale text-only matches when supplied. */
    timestamp?: string;
    /**
     * Comparison normalizer applied to BOTH the live body and each history
     * text (default: whitespace collapse). Pass the channel's mention
     * stripper so a history record that still contains the bot @handle can
     * match the mention-stripped inbound text.
     */
    normalizeText?: (text: string) => string;
    /** When false, the fetch is skipped (feature off or no refresh token). */
    enabled: boolean;
    recentMessagesLimit?: number;
    onError?: (err: unknown, info: { kind: string }) => void;
  },
): Promise<{ replyTo?: CliqReplyToContext; forward?: CliqForwardContext } | undefined> {
  if (!params.enabled) return undefined;
  const chatId = params.chatId?.trim();
  const normalize = (text: string) => (params.normalizeText ?? normalizeCliqHistoryText)(text).trim();
  const liveText = normalize(params.text ?? "");
  if (!chatId || !liveText) return undefined;

  let messages: {
    messageId: string;
    text?: string;
    senderId?: string;
    timestamp?: string;
    messageType?: string;
    forwardInfo?: unknown;
    repliedTo?: unknown;
  }[];
  try {
    messages = await params.client.listChatMessages(chatId, {
      limit: params.recentMessagesLimit ?? 50,
    });
  } catch (err) {
    params.onError?.(err, { kind: "inbound-context-recovery" });
    return undefined;
  }

  // Normalization can make distinct messages look identical. A recent,
  // unique text/sender match reduces ambiguity but is still best effort:
  // Cliq history may not yet contain the inbound message.
  const liveSender = params.senderId?.trim();
  const incomingId = params.messageId?.trim();
  const nativeId = incomingId && !/^(?:evt|syn):/.test(incomingId) ? incomingId : undefined;
  const liveTime = params.timestamp ? parseCliqRecoveryTime(params.timestamp) : undefined;
  if (!nativeId && (!liveSender || liveTime === undefined)) return undefined;
  const candidates = messages.filter((m) => {
    if (nativeId && m.messageId !== nativeId) return false;
    if (!m.text || normalize(m.text) !== liveText) return false;
    if (liveSender && m.senderId && m.senderId.trim() !== liveSender) return false;
    // Text-only matching requires both the sender and a recent timestamp.
    if (!nativeId) {
      if (m.senderId?.trim() !== liveSender) return false;
      const historyTime = parseCliqRecoveryTime(m.timestamp);
      if (historyTime === undefined || liveTime === undefined || Math.abs(historyTime - liveTime) > 120_000) return false;
    }
    return true;
  });
  if (candidates.length !== 1) return undefined;
  const match = candidates[0];

  if (match.repliedTo) {
    const replyTo = parseCliqReplyToContext({ replied_to: match.repliedTo });
    if (replyTo) return { replyTo };
  }
  if (match.messageType === "forwarded" && match.forwardInfo !== undefined) {
    const forward = parseCliqForwardContext({ forwarded_message: match.forwardInfo });
    if (forward) return { forward };
  }
  return undefined;
}

/** Parse ISO or epoch-millisecond timestamps without guessing units. */
function parseCliqRecoveryTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const time = /^\d{13}$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed);
  return Number.isFinite(time) ? time : undefined;
}

/**
 * Default recovery-match normalization: collapse whitespace runs to single
 * spaces. Mention tokens are NOT touched here — callers with a bot identity
 * pass `stripCliqMentions` as `normalizeText` to also remove the handle.
 */
function normalizeCliqHistoryText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Render a quote block for the agent envelope body. Prepended to the user's
 * message text so the agent sees what the user is replying to. The format is
 * deliberately compact and stable so the agent can reason about it without
 * parsing ambiguity.
 *
 *   ↩ Replying to <senderName>:
 *   <text>
 *
 *   <user's message>
 */
export function formatCliqReplyToBlock(replyTo: CliqReplyToContext): string {
  const sender = replyTo.senderName?.trim() || "previous message";
  const text = replyTo.text?.trim();
  const lines: string[] = [`↩ Replying to ${sender}:`];
  if (text) {
    // Indent the quoted text so the agent can distinguish it from the new
    // message. Trim to a reasonable length so a long quote does not drown the
    // turn — the parent message id is carried separately for correlation.
    const trimmed = text.length > 1000 ? `${text.slice(0, 1000)}…` : text;
    for (const line of trimmed.split("\n")) {
      lines.push(`> ${line}`);
    }
  }
  return lines.join("\n");
}
