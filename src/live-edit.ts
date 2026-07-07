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
 *
 * ## `initialDraft` — instant-acknowledgement / "thinking" placeholder
 *
 * When `initialDraft` is set (issue #47), the FIRST `deliver` call EDITS that
 * pre-posted placeholder message into the agent reply instead of sending a new
 * message — so the user sees exactly one message morph from `💭 …` into the
 * reply, with no stray duplicate. The placeholder ref `{messageId, chatId?}`
 * comes from a `sendMessage` the inbound path issued right after admission
 * passed; for group posts the chat id is NOT in the send response, so it is
 * resolved here via `resolveChannelChatId` on the first edit (cached). When
 * the edit cannot be performed cleanly (chat id unresolvable, edit API
 * rejects, …), the placeholder is DELETED and the reply is sent as a fresh
 * message — the "no stray `💭 …` left behind" contract. The placeholder
 * flow is only used when `thinking.mode` is `"placeholder"` OR `"card"`, a `refreshToken`
 * is configured (editing needs a user-context token), and streaming preview
 * is off (live-edit already shows progress); the inbound path enforces this
 * gate before passing `initialDraft`.
 */
import { chunkMessage, type CliqClient } from "./client.js";
import { markdownToCliq } from "./markdown.js";

const DEFAULT_CHAR_LIMIT = 5000;

export interface LiveEditDeliverOptions {
  client: Pick<
    CliqClient,
    | "sendMessage"
    | "editMessage"
    | "resolveChannelChatId"
    | "listChatMessages"
    | "deleteMessage"
  >;
  /** Raw Cliq id the message is addressed to (user id for DMs, chatid/channel id for groups). */
  to: string;
  /** Whether this is a DM (delivered via `userids`) or a group (via `chatid`). */
  isDm: boolean;
  /** When true, edits the draft message in place across blocks; when false, each block is a separate message. */
  enabled: boolean;
  /** Per-message character cap (Cliq enforces 5000). */
  charLimit?: number;
  /**
   * When set, the first `deliver` EDITS this existing message into the agent
   * reply instead of sending a new message (the "thinking" placeholder flow).
   * `chatId` may be omitted for group posts (the send response does not carry
   * it); it is resolved lazily via `resolveChannelChatId` on the first edit.
   */
  initialDraft?: { messageId: string; chatId?: string };
}

export interface LiveEditDeliverStats {
  sends: number;
  edits: number;
  editFailures: number;
}

/**
 * Whether the `initialDraft` placeholder's fate was resolved by a `deliver`
 * call — i.e. it was edited into a reply, deleted after a failed edit, or
 * superseded by a fresh send. `false` means NO deliver touched the
 * placeholder (the dispatcher flushed no blocks, or only empty-text no-ops):
 * the placeholder is still sitting untouched as `💭 …` and the caller should
 * clean it up (edit to a failure message or delete) after the turn ends.
 */
export type LiveEditPlaceholderConsumed = boolean;

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
  /**
   * Set to `true` the moment a `deliver` call resolves the placeholder's
   * fate (edited into a reply, deleted after a failed edit, or superseded by
   * a fresh send). When still `false` after the turn the placeholder is
   * untouched → the inbound path cleans it up. See
   * {@link getLiveEditPlaceholderConsumed}.
   */
  let placeholderConsumed = !opts.initialDraft;

  const attach = <F extends (payload: { text?: string; mediaUrl?: string }) => Promise<void>>(
    fn: F,
  ): F => {
    (fn as unknown as { __stats: LiveEditDeliverStats }).__stats = stats;
    (fn as unknown as { __placeholderConsumed: () => boolean }).__placeholderConsumed =
      () => placeholderConsumed;
    return fn;
  };

  // Live-edit state (per dispatch turn). When `initialDraft` is supplied the
  // first edit targets the pre-posted placeholder instead of a fresh send.
  let draftMessageId: string | undefined = opts.initialDraft?.messageId;
  let draftChatId: string | undefined = opts.initialDraft?.chatId;
  let draftChatIdResolved = Boolean(draftChatId);
  let accumulated = ""; // plain (pre-markdown-conversion) text

  /** Resolve the chat id for a group draft when missing (cached on the client). */
  const resolveDraftChatId = async (): Promise<string | undefined> => {
    if (draftChatId) return draftChatId;
    if (draftChatIdResolved) return undefined; // already attempted — no chatId
    if (isDm) {
      draftChatIdResolved = true;
      return undefined;
    }
    draftChatIdResolved = true;
    try {
      draftChatId = (await client.resolveChannelChatId(to)) ?? undefined;
    } catch {
      draftChatId = undefined;
    }
    return draftChatId;
  };

  /** Best-effort delete the current draft (placeholder) so it does not linger. */
  const safeDeleteDraft = async (): Promise<void> => {
    if (!draftMessageId) return;
    const chatId = await resolveDraftChatId();
    if (!chatId) return;
    try {
      await client.deleteMessage({ chatId, messageId: draftMessageId });
    } catch {
      // Swallow: best-effort cleanup; the turn must not break.
    }
  };

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
      draftChatIdResolved = true;
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

  /**
   * Edit the current draft (`draftMessageId` + `draftChatId`) with `richText`.
   * On a group-edit failure, attempt a one-shot recovery via
   * `listChatMessages` (the canonical chat id may differ). Returns `true` on
   * success, `false` on failure (caller decides whether to fall back to a
   * new send or delete a stray placeholder).
   */
  const editDraft = async (richText: string): Promise<boolean> => {
    if (!draftMessageId || !draftChatId) return false;
    try {
      await client.editMessage({
        chatId: draftChatId,
        messageId: draftMessageId,
        text: richText,
      });
      stats.edits++;
      return true;
    } catch {
      if (!isDm && draftChatId) {
        try {
          const recent = await client.listChatMessages(draftChatId, { limit: 50 });
          const match = recent.find((m) => m.messageId === draftMessageId);
          if (match && match.chatId && match.chatId !== draftChatId) {
            await client.editMessage({
              chatId: match.chatId,
              messageId: draftMessageId,
              text: richText,
            });
            draftChatId = match.chatId;
            stats.edits++;
            return true;
          }
        } catch {
          // recovery failed — fall through
        }
      }
      return false;
    }
  };

  if (!opts.enabled) {
    // Legacy: each block (or the single final reply) is its own message.
    // Chunk against the limit so a long single reply isn't rejected by Cliq.
    // When `initialDraft` is set, the FIRST deliver edits the placeholder
    // into the final reply instead of sending a new message (no stray
    // placeholder); subsequent delivers (rare in legacy mode) send fresh.
    let firstDeliverDone = false;
    return attach(async (payload) => {
      const text = payload.text;
      if (!text) return;
      const rich = markdownToCliq(text);
      const chunks = chunkMessage(rich, limit);

      if (opts.initialDraft && draftMessageId && !firstDeliverDone) {
        firstDeliverDone = true;
        // Entering this branch resolves the placeholder one way or another
        // (edit into the reply, or delete + fresh send on edit failure).
        placeholderConsumed = true;
        const chatId = await resolveDraftChatId();
        if (chatId) {
          if (await editDraft(chunks[0])) {
            // Send overflow chunks as fresh messages; the draft now holds
            // the first chunk and is sealed (no further edits this turn).
            for (let i = 1; i < chunks.length; i++) {
              await client.sendMessage({ to, text: chunks[i], isDm });
              stats.sends++;
            }
            // Mark the draft as consumed so a hypothetical second deliver
            // sends fresh (does not try to re-edit the now-final message).
            draftMessageId = undefined;
            draftChatId = undefined;
            accumulated = "";
            return;
          }
          // Edit failed — fall through to delete + fresh send.
        }
        // Could not edit cleanly (no chatId, or edit rejected). Delete the
        // stray placeholder and send the reply as fresh message(s).
        stats.editFailures++;
        await safeDeleteDraft();
        draftMessageId = undefined;
        draftChatId = undefined;
      }

      for (const chunk of chunks) {
        await client.sendMessage({ to, text: chunk, isDm });
        stats.sends++;
      }
    });
  }

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
      // Accumulated text would overflow the current draft's cap.
      if (opts.initialDraft && !accumulated) {
        // The placeholder is still the draft (nothing accumulated yet) and
        // the FIRST block alone overflows: edit the placeholder with the
        // first chunk and send the rest as fresh messages, then seal.
        placeholderConsumed = true;
        const chunks = chunkMessage(richCandidate, limit);
        const chatId = await resolveDraftChatId();
        if (chatId && (await editDraft(chunks[0]))) {
          for (let i = 1; i < chunks.length; i++) {
            await client.sendMessage({ to, text: chunks[i], isDm });
            stats.sends++;
          }
          // Seal: no further edits to this draft.
          draftMessageId = undefined;
          draftChatId = undefined;
          accumulated = "";
          return;
        }
        // Could not edit cleanly — delete the stray placeholder and send the
        // block chunked as fresh message(s) (no draft retained).
        stats.editFailures++;
        await safeDeleteDraft();
        draftMessageId = undefined;
        draftChatId = undefined;
        for (const chunk of chunks) {
          await client.sendMessage({ to, text: chunk, isDm });
          stats.sends++;
        }
        return;
      }
      // Normal overflow: seal the current draft and start a fresh message
      // with just this block.
      await sendNew(text);
      return;
    }

    if (!draftChatId) {
      // No chatId to edit with. When an `initialDraft` is present we resolve
      // it lazily; if still missing, delete the placeholder and send fresh
      // (no stray `💭 …`). Otherwise (a DM send that didn't return one) fall
      // back to sending the accumulated text as a new message.
      if (opts.initialDraft) {
        const chatId = await resolveDraftChatId();
        if (!chatId) {
          stats.editFailures++;
          placeholderConsumed = true;
          await safeDeleteDraft();
          draftMessageId = undefined;
          draftChatId = undefined;
          await sendNew(candidate);
          return;
        }
      } else {
        await sendNew(candidate);
        return;
      }
    }

    if (await editDraft(richCandidate)) {
      // The placeholder (if any) is now the live draft showing the reply.
      if (opts.initialDraft && !accumulated) placeholderConsumed = true;
      accumulated = candidate;
      return;
    }
    // Edit failed (and recovery failed). Degrade to a new message carrying
    // the accumulated text so no content is lost; that new message becomes
    // the editable draft going forward. When an `initialDraft` was the
    // target of the failed edit, delete it so it is not left stray.
    stats.editFailures++;
    if (opts.initialDraft && !accumulated) {
      placeholderConsumed = true;
      await safeDeleteDraft();
    }
    draftMessageId = undefined;
    draftChatId = undefined;
    await sendNew(candidate);
  };

  return attach(returned);
}

/** Expose the per-turn send/edit/failure counts (mainly for tests + diagnostics). */
export function getLiveEditDeliverStats(
  deliver: ReturnType<typeof createLiveEditDeliver>,
): LiveEditDeliverStats | undefined {
  return (deliver as unknown as { __stats?: LiveEditDeliverStats }).__stats;
}

/**
 * Edit the status card's title text in place to advance it to the next phase
 * (e.g. `💭 thinking…` → `⚙️ generating…`). Used by the inbound path's
 * `thinking.mode === "card"` flow to transition the status card through
 * explicit phases as the turn progresses (the card is posted with the
 * "thinking" phase title, then edited to the "generating" phase title right
 * before the agent turn dispatches; the final reply is the "done" phase,
 * handled by the live-edit deliver's edit-into-reply). Best-effort: a failed
 * edit (or an unresolvable chat id for a group post) is swallowed + reported
 * via `onError` so a phase transition never breaks or delays the turn. Resolves
 * the chat id lazily for group posts (the card send response carries no
 * chatId) — the resolution is cached on the client, so the live-edit
 * deliver's later edit reuses it.
 */
export async function editStatusCardPhase(opts: {
  client: Pick<CliqClient, "editMessage" | "resolveChannelChatId">;
  draft: { messageId: string; chatId?: string };
  /** Raw Cliq id the card was addressed to (channel unique name for groups). */
  to: string;
  /** Whether the card was a DM (carries a chatId in the send response) or a group post. */
  isDm: boolean;
  /** The next phase's title text to edit the card into. */
  text: string;
  onError?: (err: unknown, info: { kind: string }) => void;
}): Promise<void> {
  const { client, draft, to, isDm, text, onError } = opts;
  if (!text) return;
  let chatId = draft.chatId;
  if (!chatId && !isDm) {
    try {
      chatId = (await client.resolveChannelChatId(to)) ?? undefined;
    } catch (err) {
      onError?.(err, { kind: "thinking-card-phase-resolve" });
      return;
    }
  }
  if (!chatId) return;
  try {
    await client.editMessage({ chatId, messageId: draft.messageId, text });
  } catch (err) {
    onError?.(err, { kind: "thinking-card-phase" });
  }
}

/**
 * Whether the `initialDraft` placeholder's fate was resolved by a `deliver`
 * call (`true`), or whether it is still sitting untouched as `💭 …` waiting
 * for the caller to clean it up (`false`). Returns `true` when no
 * `initialDraft` was supplied (nothing to clean up).
 */
export function getLiveEditPlaceholderConsumed(
  deliver: ReturnType<typeof createLiveEditDeliver>,
): boolean {
  return (
    (deliver as unknown as { __placeholderConsumed?: () => boolean }).__placeholderConsumed?.() ??
    true
  );
}
