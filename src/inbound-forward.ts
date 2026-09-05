/**
 * Inbound forwarded-message context (issue #223).
 *
 * When a user forwards a message into a Cliq bot DM, the forwarded content is
 * NOT part of the plain `message` string the bot Message handler receives
 * (learning 103: the handler delivers `message` as a string, not the rich
 * message object documented for the platform). A forward therefore reaches the
 * webhook either with no usable body at all — in which case
 * `parseCliqWebhookPayload` rejected it outright before this module existed —
 * or with the forwarded body under one of several sibling keys, depending on
 * what the Deluge handler forwards.
 *
 * This module mirrors the tolerant approach of `inbound-quote.ts`: recognize
 * the observed and plausible field-name variants, merge every source, and
 * surface the original author + text to the agent. Nothing here is required
 * for a plain message, so the parser cost is one cheap key probe per turn.
 *
 * The block this renders is deliberately distinct from the reply/quote block
 * (`↩ Replying to …`) so the agent can tell "the user is answering this" from
 * "the user handed me this to read".
 *
 * Refs:
 *  - Message Object <https://www.zoho.com/cliq/help/platform/cliq-objects/message-object.html>
 */

/** A normalized reference to a forwarded message's origin + content. */
export interface CliqForwardContext {
  /** Original message text. */
  text?: string;
  /** Original author display name. */
  senderName?: string;
  /** Original author id (Zoho user id). */
  senderId?: string;
  /** Original message timestamp, as forwarded (not normalized). */
  time?: string;
  /** Original message id, when the handler forwarded one. */
  messageId?: string;
  /** Originating chat/channel title, when present. */
  sourceTitle?: string;
}

/** Shape of the forwarded-message object a Deluge handler may forward. */
interface RawForwardedMessage {
  id?: string;
  message_id?: string;
  text?: string;
  content?: string | { text?: string; comment?: string };
  time?: string;
  created_time?: string;
  sender?: {
    id?: string;
    name?: string;
    first_name?: string;
    last_name?: string;
  };
  user?: {
    id?: string;
    name?: string;
    first_name?: string;
    last_name?: string;
  };
  from?: {
    id?: string;
    name?: string;
  };
  chat?: { title?: string; name?: string };
  source?: { title?: string; name?: string };
}

/**
 * Payload keys that may carry a forwarded message, at the payload root or
 * nested under `message`. Ordered most-specific first so an explicit
 * forwarded-message object wins over a generic `original` sibling.
 */
const FORWARD_KEYS = [
  "forwarded_message",
  "forwardedMessage",
  "forwarded",
  "forward",
  "forwarded_content",
  "original_message",
  "originalMessage",
] as const;

/**
 * True when the payload carries any recognized forward marker. Used by the
 * parser to distinguish "this is a forward we could not read" from "this is
 * an ordinary message with no text", so the two can be reported differently.
 */
export function hasCliqForwardMarker(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const payload = raw as Record<string, unknown>;
  if (payload.params && typeof payload.params === "object" && !Array.isArray(payload.params)) {
    if (hasCliqForwardMarker(payload.params)) return true;
  }
  if (payload.is_forwarded === true || payload.isForwarded === true) return true;
  for (const key of FORWARD_KEYS) {
    if (payload[key] !== undefined) return true;
  }
  const message = payload.message;
  if (message && typeof message === "object" && !Array.isArray(message)) {
    const msg = message as Record<string, unknown>;
    if (msg.is_forwarded === true || msg.isForwarded === true) return true;
    for (const key of FORWARD_KEYS) {
      if (msg[key] !== undefined) return true;
    }
  }
  return false;
}

/**
 * Parse forwarded-message context from a raw Cliq webhook payload.
 *
 * Tolerates the `params`-wrapped shape, the forward object at the payload
 * root, and the forward object nested under `message`. Sources are merged
 * first-wins so a richer object does not lose fields to a sparser one.
 *
 * Returns `undefined` when no forwarded message is present or when the
 * candidate object carries neither text nor an author (an empty marker is not
 * useful to the agent and must not create a misleading block).
 */
export function parseCliqForwardContext(
  raw: unknown,
): CliqForwardContext | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const payload = raw as Record<string, unknown>;

  if (payload.params && typeof payload.params === "object" && !Array.isArray(payload.params)) {
    const wrapped = parseCliqForwardContext(payload.params);
    if (wrapped) return wrapped;
  }

  let merged: CliqForwardContext | undefined;
  const merge = (next: CliqForwardContext | undefined) => {
    if (!next) return;
    if (!merged) {
      merged = { ...next };
      return;
    }
    merged = {
      text: merged.text ?? next.text,
      senderName: merged.senderName ?? next.senderName,
      senderId: merged.senderId ?? next.senderId,
      time: merged.time ?? next.time,
      messageId: merged.messageId ?? next.messageId,
      sourceTitle: merged.sourceTitle ?? next.sourceTitle,
    };
  };

  for (const key of FORWARD_KEYS) {
    merge(parseRawForward(payload[key]));
  }

  const message = payload.message;
  if (message && typeof message === "object" && !Array.isArray(message)) {
    const msg = message as Record<string, unknown>;
    for (const key of FORWARD_KEYS) {
      merge(parseRawForward(msg[key]));
    }
  }

  return merged;
}

function readName(rec: { name?: string; first_name?: string; last_name?: string } | undefined):
  | string
  | undefined {
  if (!rec) return undefined;
  if (typeof rec.name === "string" && rec.name.trim()) return rec.name.trim();
  const joined = [rec.first_name, rec.last_name]
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .join(" ")
    .trim();
  return joined || undefined;
}

function parseRawForward(v: unknown): CliqForwardContext | undefined {
  if (v === undefined || v === null) return undefined;
  // A handler may forward the original body as a bare string.
  if (typeof v === "string") {
    const text = v.trim();
    return text ? { text } : undefined;
  }
  if (typeof v !== "object" || Array.isArray(v)) return undefined;
  const rec = v as RawForwardedMessage;

  let text: string | undefined;
  if (typeof rec.text === "string" && rec.text.trim()) {
    text = rec.text.trim();
  } else if (typeof rec.content === "string" && rec.content.trim()) {
    text = rec.content.trim();
  } else if (rec.content && typeof rec.content === "object") {
    const c = rec.content as { text?: string; comment?: string };
    if (typeof c.text === "string" && c.text.trim()) text = c.text.trim();
    else if (typeof c.comment === "string" && c.comment.trim()) text = c.comment.trim();
  }

  const senderName = readName(rec.sender) ?? readName(rec.user) ?? readName(rec.from);
  const senderId =
    (rec.sender && typeof rec.sender.id === "string" && rec.sender.id.trim()) ||
    (rec.user && typeof rec.user.id === "string" && rec.user.id.trim()) ||
    (rec.from && typeof rec.from.id === "string" && rec.from.id.trim()) ||
    undefined;
  const time =
    (typeof rec.time === "string" && rec.time.trim() && rec.time.trim()) ||
    (typeof rec.created_time === "string" && rec.created_time.trim() && rec.created_time.trim()) ||
    undefined;
  const messageId =
    (typeof rec.id === "string" && rec.id.trim() && rec.id.trim()) ||
    (typeof rec.message_id === "string" && rec.message_id.trim() && rec.message_id.trim()) ||
    undefined;
  const sourceTitle =
    (rec.chat && typeof rec.chat.title === "string" && rec.chat.title.trim()) ||
    (rec.chat && typeof rec.chat.name === "string" && rec.chat.name.trim()) ||
    (rec.source && typeof rec.source.title === "string" && rec.source.title.trim()) ||
    (rec.source && typeof rec.source.name === "string" && rec.source.name.trim()) ||
    undefined;

  // An object with neither content nor an author tells the agent nothing.
  if (!text && !senderName && !senderId) return undefined;
  return { text, senderName, senderId, time, messageId, sourceTitle };
}

/** Maximum forwarded text rendered into the envelope before truncation. */
const FORWARD_TEXT_LIMIT = 2000;

/**
 * Render a forwarded-message block for the agent envelope body.
 *
 * Deliberately distinct from `formatCliqReplyToBlock` so the agent can tell a
 * reply ("the user is answering this") from a forward ("the user handed me
 * this to read and act on").
 *
 *   ⤷ Forwarded message from <senderName> (<time>):
 *   > <text>
 */
export function formatCliqForwardBlock(forward: CliqForwardContext): string {
  const who = forward.senderName?.trim();
  const when = forward.time?.trim();
  const where = forward.sourceTitle?.trim();
  const parts: string[] = ["⤷ Forwarded message"];
  if (who) parts.push(`from ${who}`);
  if (where) parts.push(`in ${where}`);
  if (when) parts.push(`(${when})`);
  const lines: string[] = [`${parts.join(" ")}:`];
  const text = forward.text?.trim();
  if (text) {
    const trimmed =
      text.length > FORWARD_TEXT_LIMIT ? `${text.slice(0, FORWARD_TEXT_LIMIT)}…` : text;
    for (const line of trimmed.split("\n")) {
      lines.push(`> ${line}`);
    }
  }
  return lines.join("\n");
}
