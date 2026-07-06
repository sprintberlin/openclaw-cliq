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

/** Shape of the parent-message object the Deluge handler may forward. */
interface RawParentMessage {
  id?: string;
  message_id?: string;
  text?: string;
  content?: string;
  time?: string;
  sender?: {
    id?: string;
    name?: string;
    first_name?: string;
    last_name?: string;
    email?: string;
    email_id?: string;
  };
}

/**
 * Parse the quote / reply-to context from a raw Cliq webhook payload.
 * Tolerates the field-name variants observed across Cliq API versions and
 * Deluge handler conventions:
 *
 *  - `message.reply_to` (string message id) — the documented Cliq shape.
 *  - `message.reply_to` (object) — a handler that enriches the message with
 *    the full parent object.
 *  - `reply_to` / `parent` / `parent_message` / `quoted` / `quoted_message`
 *    / `reply_to_message` at the payload root — a handler that forwards the
 *    parent as a sibling field.
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

  // 1. `message.reply_to` — string id OR a parent object.
  const message = payload.message;
  if (message && typeof message === "object" && !Array.isArray(message)) {
    const msg = message as Record<string, unknown>;
    merge(parseRawParent(msg.reply_to) ?? parseStringId(msg.reply_to));
    // Also tolerate `message.parent` / `message.quoted`.
    merge(parseRawParent(msg.parent));
    merge(parseRawParent(msg.quoted));
  }

  // 2. Root-level variants — a Deluge handler forwarding the parent as a
  //    sibling. These carry the text/sender when `message.reply_to` only
  //    had the id, so they fill the gaps in the merge.
  for (const key of [
    "reply_to",
    "parent",
    "parent_message",
    "quoted",
    "quoted_message",
    "reply_to_message",
  ]) {
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
  const time =
    (typeof rec.time === "string" && rec.time.trim() && rec.time.trim()) || undefined;
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
