/**
 * Live-edit streaming delivery for the inbound dispatch path.
 *
 * When block streaming is enabled for an account (`channels.cliq.streaming.preview: "on"`),
 * the SDK's buffered block dispatcher delivers the agent's reply as a sequence of
 * coalesced "block" payloads (one `deliver` call per block). Without live-edit,
 * each block becomes a SEPARATE Cliq message — a long agent reply clutters the
 * chat with many progressive messages.
 *
 * Live-edit-in-place instead keeps a single "draft" message per overflow window:
 *   - the first block SENDS a message and remembers its `{messageId, chatId}` ref;
 *   - each subsequent block EDITS that message in place with the accumulated text;
 *   - when the accumulated text would exceed Cliq's 5000-char limit, the current
 *     draft is "sealed" and a new message is started for the overflow.
 *
 * chatId resolution is the crux:
 *   - DMs: `sendMessage` returns `message_details[<userId>].{chat_id, message_id}` →
 *     a reliable chatId, so live-edit works fully.
 *   - Groups/channel posts: `sendMessage` returns only a top-level `{ id }` (the
 *     message id); the chat id is NOT in the response. We resolve the channel
 *     unique name → chat id (`CT_xxx`) once via `CliqClient.resolveChannelChatId`
 *     (cached per account) and use that as the draft chat id. When an edit with
 *     that chat id still fails, we fall back to listing recent chat messages
 *     (`CliqClient.listChatMessages`) to recover the canonical editable
 *     `{ chat_id, message_id }` for the just-sent message (the bernesto
 *     reference pattern) and retry the edit once. If recovery also fails, we
 *     gracefully degrade to a new message — the draft is simply not reused.
 *
 * When block streaming is OFF (the default), each agent reply is a single `deliver`
 * call with the full text. The legacy path sends it as one message; this module
 * additionally chunks it against the 5000-char limit (a latent gap — the inbound
 * `deliver` previously did not chunk, so a >5000-char reply would be rejected by
 * the Cliq API).
 */
import { chunkMessage, type CliqClient } from "./client.js";
import { markdownToCliq } from "./markdown.js";

const DEFAULT_CHAR_LIMIT = 5000;

export interface LiveEditDeliverOptions {
  client: Pick<
    CliqClient,
    "sendMessage" | "editMessage" | "resolveChannelChatId" | "listChatMessages"
  >;
  /** Raw Cliq id the message is addressed to (user id for DMs, chatid/channel id for groups). */
  to: string;
  /** Whether this is a DM (delivered via `userids`) or a group (via `chatid`). */
  isDm: boolean;
  /** When true, edits the draft message in place across blocks; when false, each block is a separate message. */
  enabled: boolean;
  /** Per-message character cap (Cliq enforces 5000). */
  charLimit?: number;
}

export interface LiveEditDeliverStats {
  sends: number;
  edits: number;
  editFailures: number;
}

/**
 * Build a `deliver` callback for the inbound block-dispatch path. The returned
 * function accumulates block text and either edits the current draft message
 * in place (`enabled`) or sends each block as a separate message (`!enabled`).
 *
 * The callback closes over mutable state (the current draft ref + accumulated
 * plain text), so it is scoped to a SINGLE agent turn / dispatch — do not reuse
 * it across dispatches.
 */
export function createLiveEditDeliver(
  opts: LiveEditDeliverOptions,
): (payload: { text?: string; mediaUrl?: string }) => Promise<void> {
  const limit = opts.charLimit ?? DEFAULT_CHAR_LIMIT;
  const client = opts.client;
  const to = opts.to;
  const isDm = opts.isDm;

  const stats: LiveEditDeliverStats = { sends: 0, edits: 0, editFailures: 0 };

  const attach = <F extends (payload: { text?: string; mediaUrl?: string }) => Promise<void>>(
    fn: F,
  ): F => {
    (fn as unknown as { __stats: LiveEditDeliverStats }).__stats = stats;
    return fn;
  };

  if (!opts.enabled) {
    // Legacy: each block (or the single final reply) is its own message.
    // Chunk against the limit so a long single reply isn't rejected by Cliq.
    return attach(async (payload) => {
      const text = payload.text;
      if (!text) return;
      const rich = markdownToCliq(text);
      for (const chunk of chunkMessage(rich, limit)) {
        await client.sendMessage({ to, text: chunk, isDm });
        stats.sends++;
      }
    });
  }

  // Live-edit state (per dispatch turn).
  let draftMessageId: string | undefined;
  let draftChatId: string | undefined;
  let accumulated = ""; // plain (pre-markdown-conversion) text

  /** Send a fresh message and make it the current draft. */
  const sendNew = async (plainText: string): Promise<void> => {
    const rich = markdownToCliq(plainText);
    const chunks = chunkMessage(rich, limit);
    if (chunks.length === 1) {
      // Fits in one message → becomes the editable draft.
      const result = await client.sendMessage({ to, text: chunks[0], isDm });
      stats.sends++;
      draftMessageId = result.messageId;
      // For DMs the send response carries chat_id in message_details; for
      // group/channel posts it is absent, so we resolve the channel unique
      // name → chat id once (cached) via `resolveChannelChatId`. That id is
      // what the chat-message edit API expects (NOT the channel unique name).
      // When resolution fails (channel not found / no refresh token / API
      // error) we leave draftChatId undefined → edits fall back to a new send.
      if (result.chatId) {
        draftChatId = result.chatId;
      } else if (!isDm) {
        draftChatId = (await client.resolveChannelChatId(to)) ?? undefined;
      } else {
        draftChatId = undefined;
      }
      accumulated = plainText;
      return;
    }
    // The block itself exceeds the message cap → deliver as separate
    // (non-editable) messages. No draft is retained because an editable
    // draft can only hold one message's worth of content.
    for (const chunk of chunks) {
      await client.sendMessage({ to, text: chunk, isDm });
      stats.sends++;
    }
    draftMessageId = undefined;
    draftChatId = undefined;
    accumulated = "";
  };

  const returned = async (payload: {
    text?: string;
    mediaUrl?: string;
  }) => {
    const text = payload.text;
    if (!text) return;

    if (!draftMessageId) {
      // First block of the turn (or after an overflow reset): send + capture.
      await sendNew(text);
      return;
    }

    const candidate = accumulated ? `${accumulated}\n\n${text}` : text;
    const richCandidate = markdownToCliq(candidate);

    if (richCandidate.length > limit) {
      // Accumulated text would overflow the current draft's cap. Seal it and
      // start a fresh message with just this block.
      await sendNew(text);
      return;
    }

    if (!draftChatId) {
      // No chatId to edit with (e.g. a DM send that didn't return one). Fall
      // back to sending the accumulated text as a new message.
      await sendNew(candidate);
      return;
    }

    try {
      await client.editMessage({
        chatId: draftChatId,
        messageId: draftMessageId,
        text: richCandidate,
      });
      stats.edits++;
      accumulated = candidate;
    } catch {
      // Edit failed. For group/channel posts the chat id we resolved may
      // not be the canonical one the edit API expects (the bot-message send
      // `id` is not always the chat-message `message_id`), so attempt a
      // one-shot recovery: list recent chat messages and look up the
      // editable ref matching our draft message id. If found, retry the
      // edit with the recovered chat id; the recovered id is cached as the
      // draft chat id for subsequent edits this turn. DMs skip this — the
      // DM send response already carries the authoritative chat id.
      let recovered = false;
      if (!isDm && draftChatId) {
        try {
          const recent = await client.listChatMessages(draftChatId, { limit: 50 });
          const match = recent.find((m) => m.messageId === draftMessageId);
          if (match && match.chatId && match.chatId !== draftChatId) {
            await client.editMessage({
              chatId: match.chatId,
              messageId: draftMessageId,
              text: richCandidate,
            });
            draftChatId = match.chatId;
            stats.edits++;
            recovered = true;
          }
        } catch {
          // recovery failed — fall through to the new-message fallback
        }
      }
      if (recovered) {
        accumulated = candidate;
        return;
      }
      // Degrade to a new message carrying the accumulated text so no content
      // is lost; that new message becomes the editable draft going forward.
      stats.editFailures++;
      await sendNew(candidate);
    }
  };

  return attach(returned);
}

/** Expose the per-turn send/edit/failure counts (mainly for tests + diagnostics). */
export function getLiveEditDeliverStats(
  deliver: ReturnType<typeof createLiveEditDeliver>,
): LiveEditDeliverStats | undefined {
  return (deliver as unknown as { __stats?: LiveEditDeliverStats }).__stats;
}
