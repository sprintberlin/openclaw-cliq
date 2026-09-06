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
  /**
   * Originating chat id (`forward_info.chid`). Cliq reports the source chat
   * as an opaque id, not a title, so this is kept separate from
   * {@link CliqForwardContext.sourceTitle} and never rendered as a name.
   */
  sourceChatId?: string;
}

/**
 * Shape of the forwarded-message object a Deluge handler may forward.
 *
 * Two families are tolerated:
 *
 *  1. The nested/object family originally assumed here (`sender` as an object
 *     with `id`/`name`), which a handler may hand-assemble.
 *  2. The **actual** shape Cliq returns on a real forwarded message, verified
 *     live on 2026-09-06 against `GET /api/v2/chats/{chatId}/messages`
 *     (3 forwards in a 72-message window):
 *
 *       message_type: "forwarded"
 *       forward_info: {
 *         sender: "123456789",       // ORIGINAL author's user id, as a STRING
 *         dname:  "Some Name",       // ORIGINAL author's display name
 *         chid:   "1234...",         // originating chat id (opaque, not a title)
 *         msguid: "...",             // original message id
 *         time:   "1788..."          // epoch milliseconds, as a STRING
 *       }
 *
 *     `forward_info.sender` / `.dname` are the ORIGINAL author and differ from
 *     the forwarding user (`message.sender.*`) — verified 0/3 equal for both.
 *     The forwarded body itself is not inside `forward_info`; it arrives as the
 *     message's own `content.text` (2/3 in the sample; a forward can be empty).
 *
 * The string-`sender` form is why the object-only parser returned `undefined`
 * for every real forward, which also silently disabled the catch-up forward
 * path in `inbound-catchup.ts`.
 */
interface RawForwardedMessage {
  id?: string;
  message_id?: string;
  /** Cliq `forward_info.msguid`: original message id. */
  msguid?: string;
  text?: string;
  content?: string | { text?: string; comment?: string };
  /** Cliq `forward_info.time`: epoch milliseconds, delivered as a string. */
  time?: string | number;
  created_time?: string;
  /** Cliq `forward_info.dname`: original author display name. */
  dname?: string;
  /** Cliq `forward_info.chid`: originating chat id (opaque). */
  chid?: string;
  /**
   * Object form (hand-assembled handlers) or Cliq's string form, where the
   * value is the original author's user id.
   */
  sender?:
    | string
    | {
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
      sourceChatId: merged.sourceChatId ?? next.sourceChatId,
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

  // `sender` is an object for hand-assembled handler payloads and a bare user
  // id STRING for Cliq's own `forward_info` (verified live). Reading `.id` off
  // the string form yielded `undefined` for every real forward, which is why
  // this parser used to reject them all.
  const senderObj =
    rec.sender && typeof rec.sender === "object" && !Array.isArray(rec.sender)
      ? rec.sender
      : undefined;
  const senderFromString =
    typeof rec.sender === "string" && rec.sender.trim() ? rec.sender.trim() : undefined;

  const senderName =
    readName(senderObj) ??
    readName(rec.user) ??
    readName(rec.from) ??
    // Cliq `forward_info.dname`: the ORIGINAL author's display name.
    (typeof rec.dname === "string" && rec.dname.trim() ? rec.dname.trim() : undefined);
  const senderId =
    senderFromString ??
    (senderObj && typeof senderObj.id === "string" && senderObj.id.trim()
      ? senderObj.id.trim()
      : undefined) ??
    (rec.user && typeof rec.user.id === "string" && rec.user.id.trim()
      ? rec.user.id.trim()
      : undefined) ??
    (rec.from && typeof rec.from.id === "string" && rec.from.id.trim()
      ? rec.from.id.trim()
      : undefined);
  const time =
    normalizeForwardTime(rec.time) ??
    (typeof rec.created_time === "string" && rec.created_time.trim()
      ? rec.created_time.trim()
      : undefined);
  const messageId =
    (typeof rec.id === "string" && rec.id.trim() && rec.id.trim()) ||
    (typeof rec.message_id === "string" && rec.message_id.trim() && rec.message_id.trim()) ||
    // Cliq `forward_info.msguid`: the original message id.
    (typeof rec.msguid === "string" && rec.msguid.trim() && rec.msguid.trim()) ||
    undefined;
  const sourceChatId =
    typeof rec.chid === "string" && rec.chid.trim() ? rec.chid.trim() : undefined;
  const sourceTitle =
    (rec.chat && typeof rec.chat.title === "string" && rec.chat.title.trim()) ||
    (rec.chat && typeof rec.chat.name === "string" && rec.chat.name.trim()) ||
    (rec.source && typeof rec.source.title === "string" && rec.source.title.trim()) ||
    (rec.source && typeof rec.source.name === "string" && rec.source.name.trim()) ||
    undefined;

  // An object with neither content nor an author tells the agent nothing.
  if (!text && !senderName && !senderId) return undefined;
  return { text, senderName, senderId, time, messageId, sourceTitle, sourceChatId };
}

/**
 * Normalize a forwarded timestamp for display.
 *
 * Cliq delivers `forward_info.time` as epoch milliseconds in a string (verified
 * live: 13 digits). Rendering that raw tells the agent nothing, so a plausible
 * epoch is converted to ISO-8601. Anything else is passed through trimmed, and
 * an out-of-range number is dropped rather than rendered as a bogus date.
 */
function normalizeForwardTime(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return epochMsToIso(value);
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  // A purely numeric value can only be a timestamp. If it is not a plausible
  // epoch, drop it: rendering a bare number as a time tells the agent nothing
  // and looks like real data. Non-numeric strings are human-readable dates a
  // handler may already have formatted, so those pass through untouched.
  if (/^\d+$/.test(trimmed)) {
    return epochMsToIso(Number(trimmed));
  }
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

/**
 * Recover forwarded-message attribution from Cliq chat history (issue #223).
 *
 * The deployed handler does not expose a verified Deluge forward symbol.
 * Adding an unverified symbol can permanently fail handler validation, so the
 * gateway reads the metadata back through the already-used user-context API.
 *
 * Matching is intentionally conservative: exact native message id first;
 * otherwise an exact, unique text match among forwarded messages. Ambiguous
 * text yields no attribution rather than attributing the wrong author.
 */
export async function resolveCliqForwardContext(
  forward: CliqForwardContext | undefined,
  params: {
    client: {
      listChatMessages: (
        chatId: string,
        opts?: { limit?: number },
      ) => Promise<
        {
          messageId: string;
          text?: string;
          messageType?: string;
          forwardInfo?: unknown;
        }[]
      >;
    };
    chatId?: string;
    messageId?: string;
    text?: string;
    canReadChatMessages: boolean;
    recentMessagesLimit?: number;
    onError?: (err: unknown, info: { kind: string }) => void;
  },
): Promise<CliqForwardContext | undefined> {
  // Handler-delivered attribution wins and needs no network read.
  if (forward && (forward.senderName || forward.senderId)) return forward;
  if (!params.canReadChatMessages) return forward;
  const chatId = params.chatId?.trim();
  if (!chatId) return forward;

  const liveId = params.messageId?.trim();
  const liveText = params.text?.trim();
  if (!liveId && !liveText) return forward;

  let messages: {
    messageId: string;
    text?: string;
    messageType?: string;
    forwardInfo?: unknown;
  }[];
  try {
    messages = await params.client.listChatMessages(chatId, {
      limit: params.recentMessagesLimit ?? 50,
    });
  } catch (err) {
    params.onError?.(err, { kind: "inbound-forward-fetch" });
    return forward;
  }

  const forwards = messages.filter(
    (m) => m.messageType === "forwarded" && m.forwardInfo !== undefined,
  );
  if (!forwards.length) return forward;

  let matched = liveId ? forwards.find((m) => m.messageId === liveId) : undefined;
  if (!matched && liveText) {
    const sameText = forwards.filter((m) => m.text?.trim() === liveText);
    if (sameText.length === 1) matched = sameText[0];
  }
  if (!matched) return forward;

  const recovered = parseCliqForwardContext({ forwarded_message: matched.forwardInfo });
  if (!recovered) return forward;
  return {
    text: forward?.text ?? recovered.text,
    senderName: forward?.senderName ?? recovered.senderName,
    senderId: forward?.senderId ?? recovered.senderId,
    time: forward?.time ?? recovered.time,
    messageId: forward?.messageId ?? recovered.messageId,
    sourceTitle: forward?.sourceTitle ?? recovered.sourceTitle,
    sourceChatId: forward?.sourceChatId ?? recovered.sourceChatId,
  };
}
