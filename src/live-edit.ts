/**
 * Live-edit streaming delivery for the inbound dispatch path.
 *
 * When block streaming is enabled for an account (the default; opt out with
 * `channels.cliq.streaming.preview: "off"`),
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
 * When block streaming is OFF (the explicit opt-out), each agent reply is a single `deliver`
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
   * flow is used when `thinking.mode` is `"placeholder"` OR `"card"` and a
   * `refreshToken` is configured (editing needs a user-context token). When
   * streaming preview is also on, the placeholder is the same draft the
   * live-edit path then grows in place (issue #175) — one progress surface.
   * The thinking animator must not edit that draft (issue #184).
 */
import { chunkMessage, type CliqClient } from "./client.js";
import { markdownToCliq } from "./markdown.js";
import {
  isCliqCardChannelData,
  type CliqRenderedCard,
} from "./outbound-presentation.js";

const DEFAULT_CHAR_LIMIT = 5000;

/**
 * Minimal marker the "thinking" placeholder is edited to when a card reply
 * arrives through the live-edit path with no accompanying body text (e.g. a
 * bare `/models` button menu). A Cliq bot message can't be edited to ADD
 * buttons and Zoho rejects DELETE for bot messages, so the card is sent as a
 * NEW message; the placeholder must then be finalized to something that is
 * neither the lingering `💭 …` nor the stray-placeholder failure notice. A
 * single space keeps the now-redundant placeholder bubble minimal (the card
 * carries the real content right below).
 */
const CLIQ_CARD_PLACEHOLDER_FINAL = " ";

export interface LiveEditDeliverOptions {
  client: Pick<
    CliqClient,
    | "sendMessage"
    | "editMessage"
    | "resolveChannelChatId"
    | "listChatMessages"
    | "deleteMessage"
    | "sendCard"
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
  initialDraft?: { messageId: string; chatId?: string; text?: string };
  /**
   * Minimum wall-clock distance between two preview edits of the same draft
   * (issue #175). Intermediate blocks that arrive inside the window are
   * coalesced into the next edit instead of issuing one API call per block,
   * so a chatty agent turn cannot hammer the Cliq edit endpoint. The final
   * block of a turn bypasses the wait so the answer is never delayed.
   * Defaults to {@link DEFAULT_LIVE_EDIT_MIN_INTERVAL_MS}.
   */
  minEditIntervalMs?: number;
  /** Clock source (tests inject a deterministic one). */
  now?: () => number;
  /** Sleep used for throttling + rate-limit backoff (tests inject their own). */
  sleep?: (ms: number) => Promise<void>;
}

/** Per-block metadata the inbound dispatch path forwards to the deliver callback. */
export interface LiveEditDeliverInfo {
  /**
   * Whether this payload is the turn's final answer. A final payload is
   * flushed immediately (no throttle wait) so the answer never lags behind
   * the preview window.
   */
  final?: boolean;
  /** The SDK's delivery kind (`"block"` / `"final"` / …), when available. */
  kind?: string;
  snapshot?: boolean;
}

export interface LiveEditDeliverStats {
  sends: number;
  edits: number;
  editFailures: number;
  /** Edits not issued because the rendered draft text was already current. */
  skippedUnchanged: number;
  /** Blocks folded into an in-flight edit instead of issuing their own call. */
  coalesced: number;
  /** Edits retried after a Cliq rate-limit (429) response. */
  rateLimitRetries: number;
}

/**
 * Default minimum distance between two preview edits of one draft. Matches the
 * 1s block-coalesce window the channel publishes to the SDK, so the plugin
 * issues at most roughly one edit per second per in-flight turn.
 */
export const DEFAULT_LIVE_EDIT_MIN_INTERVAL_MS = 1_000;

/** Maximum number of rate-limit (429) retries for a single preview edit. */
const MAX_EDIT_RATE_LIMIT_RETRIES = 2;

/** Fallback backoff when a 429 carries no usable `Retry-After` hint. */
const DEFAULT_EDIT_RATE_LIMIT_BACKOFF_MS = 1_000;

/**
 * Whether an edit rejection is a Cliq rate-limit (HTTP 429). `CliqSendError`
 * exposes `status` + `retryAfterMs`; a plain error is matched on its message
 * so a wrapped/rethrown rejection is still recognized.
 */
function readEditRateLimit(err: unknown): { retryAfterMs?: number } | null {
  if (!err || typeof err !== "object") return null;
  const status = (err as { status?: unknown }).status;
  const message = String((err as { message?: unknown }).message ?? "");
  const isRateLimited = status === 429 || /\bstatus=429\b/.test(message);
  if (!isRateLimited) return null;
  const retryAfterMs = (err as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
    ? { retryAfterMs }
    : {};
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
): (
  payload: { text?: string; mediaUrl?: string; channelData?: unknown },
  info?: LiveEditDeliverInfo,
) => Promise<void> {
  const limit = opts.charLimit ?? DEFAULT_CHAR_LIMIT;
  const client = opts.client;
  const to = opts.to;
  const isDm = opts.isDm;
  const minEditIntervalMs = Math.max(0, opts.minEditIntervalMs ?? 0);
  const now = opts.now ?? (() => Date.now());
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const stats: LiveEditDeliverStats = {
    sends: 0,
    edits: 0,
    editFailures: 0,
    skippedUnchanged: 0,
    coalesced: 0,
    rateLimitRetries: 0,
  };
  /**
   * Set to `true` the moment a `deliver` call resolves the placeholder's
   * fate (edited into a reply, deleted after a failed edit, or superseded by
   * a fresh send). When still `false` after the turn the placeholder is
   * untouched → the inbound path cleans it up. See
   * {@link getLiveEditPlaceholderConsumed}.
   */
  let placeholderConsumed = !opts.initialDraft;

  const attach = <
    F extends (
      payload: { text?: string; mediaUrl?: string; channelData?: unknown },
      info?: LiveEditDeliverInfo,
    ) => Promise<void>,
  >(
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
  let latestSnapshot = "";
  /**
   * The rendered text last written (or being written) to the current draft.
   * Guards two contracts from issue #175: an unchanged draft is never
   * re-sent, and a slower earlier edit can never overwrite newer content —
   * when this no longer matches the text an in-flight edit was issued for,
   * that edit's result is discarded and the newest text is written instead.
   */
  let appliedDraftText: string | undefined;
  /** Wall-clock time of the last issued edit, for the throttle window. */
  let lastEditAt: number | undefined;
  /**
   * Serializes issued API edits so two PUT calls never race the same draft.
   * A newer block that arrives while an edit is in-flight coalesces onto
   * `pendingDraftText` instead of starting a second PUT.
   */
  let editInFlight: Promise<boolean> | null = null;
  /** Newest rendered text waiting to be written after the in-flight PUT. */
  let pendingDraftText: string | undefined;
  let pendingDraftIsFinal = false;

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
      appliedDraftText = chunks[0];
      lastEditAt = now();
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
    appliedDraftText = undefined;
  };

  /**
   * Edit the current draft (`draftMessageId` + `draftChatId`) with `richText`.
   * On a group-edit failure, attempt a one-shot recovery via
   * `listChatMessages` (the canonical chat id may differ). Returns `true` on
   * success, `false` on failure (caller decides whether to fall back to a
   * new send or delete a stray placeholder).
   */
  const editDraft = async (
    richText: string,
    editOpts: { throttle?: boolean; final?: boolean } = {},
  ): Promise<boolean> => {
    if (!draftMessageId || !draftChatId) return false;
    if (appliedDraftText === richText) {
      stats.skippedUnchanged++;
      return true;
    }
    if (
      appliedDraftText !== undefined &&
      richText.length < appliedDraftText.length
    ) {
      stats.skippedUnchanged++;
      return true;
    }
    if (!editOpts.throttle) {
      return performEdit(richText);
    }
    // An older, shorter draft arriving after a newer one is already applied
    // (or pending) must never overwrite it.
    const newestKnown = pendingDraftText ?? appliedDraftText;
    if (
      newestKnown !== undefined &&
      newestKnown.length > richText.length &&
      newestKnown.startsWith(richText)
    ) {
      stats.coalesced++;
      return true;
    }
    if (editInFlight) {
      // Fold this block into the in-flight PUT: when that PUT settles the
      // waiter writes the newest pending text (or skips it if unchanged).
      stats.coalesced++;
      pendingDraftText = richText;
      pendingDraftIsFinal = pendingDraftIsFinal || Boolean(editOpts.final);
      return editInFlight;
    }
    const run = (async (): Promise<boolean> => {
      let target = richText;
      let isFinal = Boolean(editOpts.final);
      for (;;) {
        if (!isFinal && minEditIntervalMs > 0 && lastEditAt !== undefined) {
          const waitMs = lastEditAt + minEditIntervalMs - now();
          if (waitMs > 0) {
            await sleep(waitMs);
            if (pendingDraftText !== undefined) {
              target = pendingDraftText;
              isFinal = pendingDraftIsFinal;
              pendingDraftText = undefined;
              pendingDraftIsFinal = false;
            }
          }
        }
        if (appliedDraftText === target) {
          stats.skippedUnchanged++;
          return true;
        }
        const ok = await performEdit(target);
        if (!ok) return false;
        if (pendingDraftText === undefined) return true;
        target = pendingDraftText;
        isFinal = pendingDraftIsFinal;
        pendingDraftText = undefined;
        pendingDraftIsFinal = false;
      }
    })();
    editInFlight = run;
    try {
      return await run;
    } finally {
      if (editInFlight === run) editInFlight = null;
    }
  };

  /** Issue one edit call, honoring a Cliq 429 with a bounded backoff retry. */
  const performEdit = async (richText: string): Promise<boolean> => {
    if (!draftMessageId || !draftChatId) return false;
    for (let attempt = 0; ; attempt++) {
      try {
        await client.editMessage({
          chatId: draftChatId,
          messageId: draftMessageId,
          text: richText,
        });
        stats.edits++;
        appliedDraftText = richText;
        lastEditAt = now();
        return true;
      } catch (err) {
        const rateLimited = readEditRateLimit(err);
        if (rateLimited && attempt < MAX_EDIT_RATE_LIMIT_RETRIES) {
          stats.rateLimitRetries++;
          await sleep(rateLimited.retryAfterMs ?? DEFAULT_EDIT_RATE_LIMIT_BACKOFF_MS);
          continue;
        }
        return await recoverEdit(richText);
      }
    }
  };

  /**
   * One-shot group recovery for a failed edit: the canonical chat id may
   * differ from the resolved one (see `listChatMessages` in the module docs).
   */
  const recoverEdit = async (richText: string): Promise<boolean> => {
    if (!isDm && draftChatId) {
      try {
        const recent = await client.listChatMessages(draftChatId, { limit: 50 });
        const match = recent.find((m) => m.messageId === draftMessageId);
        if (match && match.chatId && match.chatId !== draftChatId) {
          if (!draftMessageId) return false;
          await client.editMessage({
            chatId: match.chatId,
            messageId: draftMessageId,
            text: richText,
          });
          draftChatId = match.chatId;
          stats.edits++;
          appliedDraftText = richText;
          lastEditAt = now();
          return true;
        }
      } catch {
        // recovery failed — fall through
      }
    }
    return false;
  };

  /**
   * Deliver a card reply (`payload.channelData.cliqCard`) through the
   * live-edit path. Cliq bot messages can't be edited to ADD buttons and
   * Zoho rejects DELETE for bot messages, so the card is sent as a NEW
   * message via `client.sendCard`; when a "thinking" placeholder is active
   * (`initialDraft`), it is then edited to the card's body text (or a minimal
   * marker) so it isn't left as `💭 …` and does NOT trigger the
   * stray-placeholder failure notice. `placeholderConsumed` is set true so the
   * inbound cleanup skips the placeholder. The draft is sealed (no further
   * in-place edits this turn) — a Cliq bot message either carries buttons OR
   * is editable text, not both, so the card is never an editable draft.
   *
   * Mirrors the card branch of `outbound-presentation.sendCliqPayload` (the
   * non-placeholder path) so the two delivery routes render identically: the
   * first text chunk rides with the card, any overflow chunks go as plain
   * messages.
   */
  const deliverCard = async (
    payload: { text?: string; channelData?: unknown },
  ): Promise<boolean> => {
    const card = isCliqCardChannelData(payload.channelData)
      ? (payload.channelData["cliqCard"] as CliqRenderedCard)
      : null;
    const buttons = card?.buttons;
    const theme = card?.theme;
    const pollOptions = card?.pollOptions;
    const hasCard =
      (buttons && buttons.length > 0) ||
      (theme === "poll" && pollOptions && pollOptions.length > 0);
    if (!hasCard) return false; // not a card — fall through to the text path

    // The card body text lives on `payload.text` for agent-presentation
    // cards (rendered there by `renderCliqPresentation`) and may live on
    // `card.text` for command cards that set a title/body directly. Prefer
    // the payload text (the runtime-combined reply text) and fall back to
    // the card's own body so a title-only card still ships its text.
    const rawText = payload.text ?? card?.text ?? "";
    const richText = rawText ? markdownToCliq(rawText) : "";
    const chunks = richText ? chunkMessage(richText, limit) : [];
    const firstText = chunks[0] || undefined;

    await client.sendCard({
      to,
      isDm,
      ...(firstText ? { text: firstText } : {}),
      ...(buttons && buttons.length > 0 ? { buttons } : {}),
      ...(theme ? { theme } : {}),
      ...(pollOptions && pollOptions.length > 0 ? { pollOptions } : {}),
    });
    stats.sends++;
    // Overflow chunks (text beyond the 5000-char cap) go as plain messages.
    for (let i = 1; i < chunks.length; i++) {
      await client.sendMessage({ to, text: chunks[i], isDm });
      stats.sends++;
    }

    // Reconcile the placeholder (if any): edit it to the card's body text or
    // a minimal marker so it doesn't linger as `💭 …` nor trigger the
    // stray-placeholder → failure-notice cleanup.
    if (opts.initialDraft && draftMessageId) {
      placeholderConsumed = true;
      const chatId = await resolveDraftChatId();
      if (chatId) {
        const finalText = firstText ?? CLIQ_CARD_PLACEHOLDER_FINAL;
        try {
          await client.editMessage({
            chatId,
            messageId: draftMessageId,
            text: finalText,
          });
          stats.edits++;
        } catch {
          // Best-effort: the card is already delivered; a lingering
          // placeholder here is preferable to a misleading failure notice
          // (and consumed=true keeps the cleanup from firing it).
        }
      }
      // Seal the draft — the card is a new message and can't be re-edited.
      draftMessageId = undefined;
      draftChatId = undefined;
      accumulated = "";
      appliedDraftText = undefined;
    }
    return true;
  };

  if (!opts.enabled) {
    // Legacy: each block (or the single final reply) is its own message.
    // Chunk against the limit so a long single reply isn't rejected by Cliq.
    // When `initialDraft` is set, the FIRST deliver edits the placeholder
    // into the final reply instead of sending a new message (no stray
    // placeholder); subsequent delivers (rare in legacy mode) send fresh.
    let firstDeliverDone = false;
    return attach(async (payload) => {
      // A card reply (channelData.cliqCard) bypasses the text path — Cliq
      // cards carry buttons and must be sent via sendCard, not edited in
      // place. Without this a command menu (/model, /models) with little/no
      // top-level text would be dropped (empty-text no-op) and the
      // placeholder would then be turned into the failure notice.
      if (await deliverCard(payload)) return;
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
            appliedDraftText = undefined;
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
        appliedDraftText = undefined;
      }

      for (const chunk of chunks) {
        await client.sendMessage({ to, text: chunk, isDm });
        stats.sends++;
      }
    });
  }

  const returned = async (
    payload: {
      text?: string;
      mediaUrl?: string;
      channelData?: unknown;
    },
    info?: LiveEditDeliverInfo,
  ) => {
    const isFinalBlock = info?.final === true || info?.kind === "final";
    const isSnapshot = info?.snapshot === true;
    // A card reply (channelData.cliqCard) bypasses the in-place text-edit
    // loop — see `deliverCard`. Commands (/model, /models) emit a card with
    // little/no top-level text; without this branch the empty-text guard
    // below would drop it and the placeholder would become the failure
    // notice.
    if (await deliverCard(payload)) return;
    const text = payload.text;
    if (!text) return;

    if (isSnapshot) {
      const placeholderLength = opts.initialDraft?.text?.trim().length ?? 0;
      if (
        opts.initialDraft &&
        !placeholderConsumed &&
        text.trim().length <= placeholderLength
      ) {
        stats.skippedUnchanged++;
        return;
      }
      if (
        latestSnapshot &&
        text.length <= latestSnapshot.length &&
        latestSnapshot.startsWith(text)
      ) {
        stats.skippedUnchanged++;
        return;
      }
      latestSnapshot = text;
    } else if (accumulated) {
      const lastBlock = accumulated.includes("\n\n")
        ? accumulated.slice(accumulated.lastIndexOf("\n\n") + 2)
        : accumulated;
      if (text === lastBlock) {
        stats.skippedUnchanged++;
        return;
      }
    }

    if (!draftMessageId) {
      if (isSnapshot) return;
      await sendNew(text);
      return;
    }

    const base = accumulated || latestSnapshot;
    const candidate = isSnapshot
      ? text
      : base && text.startsWith(base)
        ? text
        : base && base.startsWith(text) && text.length < base.length
          ? base
          : base
            ? `${base}\n\n${text}`
            : text;
    if (!isSnapshot && base && candidate === base && text.length < base.length) {
      stats.skippedUnchanged++;
      return;
    }
    const richCandidate = markdownToCliq(candidate);
    if (isSnapshot && richCandidate.length > limit) return;

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
          appliedDraftText = undefined;
          return;
        }
        // Could not edit cleanly — delete the stray placeholder and send the
        // block chunked as fresh message(s) (no draft retained).
        stats.editFailures++;
        await safeDeleteDraft();
        draftMessageId = undefined;
        draftChatId = undefined;
        appliedDraftText = undefined;
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
          appliedDraftText = undefined;
          await sendNew(candidate);
          return;
        }
      } else {
        await sendNew(candidate);
        return;
      }
    }

    // Record the newest accumulated text BEFORE awaiting the (possibly
    // throttled) edit: a later block must build on this content even while
    // this edit is still waiting for its throttle window.
    const hadPlaceholderPending = Boolean(opts.initialDraft) && !placeholderConsumed;
    if (!isSnapshot) accumulated = candidate;
    if (await editDraft(richCandidate, { throttle: true, final: isFinalBlock })) {
      // The placeholder (if any) is now the live draft showing the reply.
      if (hadPlaceholderPending) placeholderConsumed = true;
      return;
    }
    if (!isSnapshot) accumulated = candidate;
    // Edit failed (and recovery failed). Degrade to a new message carrying
    // the accumulated text so no content is lost; that new message becomes
    // the editable draft going forward. When an `initialDraft` was the
    // target of the failed edit, delete it so it is not left stray.
    stats.editFailures++;
    if (hadPlaceholderPending) {
      placeholderConsumed = true;
      await safeDeleteDraft();
    }
    draftMessageId = undefined;
    draftChatId = undefined;
    appliedDraftText = undefined;
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
