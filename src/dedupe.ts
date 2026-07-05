/**
 * Inbound message idempotency / de-duplication for the Cliq webhook.
 *
 * Cliq (via the Deluge bot handler) can redeliver a message: a slow agent
 * round-trip, a gateway restart between ack and dispatch, or a network blip
 * can all cause the same `messageId` to arrive more than once. Without dedupe
 * the agent would answer twice and side effects (tools, writes) would rerun.
 *
 * We use the SDK's `createClaimableDedupe` guard (the same primitive the
 * bundled Zalo and Nextcloud Talk channels use) in **memory-only** mode: no
 * `pluginId`/`stateMaxEntries` are passed, so it falls back to an in-process
 * TTL/LRU cache rather than the SQLite-backed plugin-state store. This covers
 * the common case — redelivery within the same gateway process — which is the
 * case that matters in practice (Cliq's redelivery window is short, and the
 * durable-before-ack policy already makes a crash mid-dispatch retryable by
 * returning 5xx before the slot is recorded).
 *
 * Semantics:
 *   - `claimCliqMessage` → `"claimed"` (yours to process), `"duplicate"`
 *     (already handled, ack and stop), or `"inflight"` (another request is
 *     processing the same id right now, ack and stop).
 *   - On successful dispatch → `commitCliqMessage` so future redeliveries
 *     within the TTL are dropped.
 *   - On retryable failure → `releaseCliqMessage` so the next redelivery can
 *     re-enter the pipeline (the slot is not recorded).
 *
 * The dedupe key prefers the Cliq `message.id`. When the Deluge handler
 * omits it (rare), we fall back to a composite of sender + chat + text —
 * which means two *distinct* identical messages from the same sender in the
 * same chat within the TTL would be wrongly deduped. This is an acceptable
 * tradeoff because the canonical Deluge handler always sets `message.id`.
 */

import { createClaimableDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import type { ClaimableDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import type { ParsedCliqInbound } from "./inbound.js";

/** TTL for the in-memory dedupe cache. Matches Cliq's practical redelivery window. */
const CLIQ_DEDUPE_TTL_MS = 30 * 60 * 1000;
/** Max entries retained in the in-memory dedupe cache. */
const CLIQ_DEDUPE_MEMORY_MAX_SIZE = 5000;

let dedupe: ClaimableDedupe | null = null;

function getCliqDedupe(): ClaimableDedupe {
  if (!dedupe) {
    dedupe = createClaimableDedupe({
      ttlMs: CLIQ_DEDUPE_TTL_MS,
      memoryMaxSize: CLIQ_DEDUPE_MEMORY_MAX_SIZE,
    });
  }
  return dedupe;
}

/**
 * Build the dedupe key for an inbound Cliq message.
 *
 * Prefers the Cliq `messageId` (stable across redeliveries). When absent,
 * falls back to a `sender:chat:text` composite so the same payload replayed
 * by Cliq is still caught. Returns `null` only when there is nothing stable
 * to key on (no message id AND no sender/chat/text), in which case dedupe is
 * skipped for that message.
 */
export function buildCliqDedupeKey(
  parsed: ParsedCliqInbound,
  account: { accountId: string | null },
): string | null {
  const ns = account.accountId ?? "default";
  if (parsed.messageId) return `cliq:${ns}:mid:${parsed.messageId}`;
  const sender = parsed.senderId || "";
  const chat = parsed.chatId || "";
  const text = parsed.text || "";
  if (!sender || !chat || !text) return null;
  return `cliq:${ns}:cmp:${sender}:${chat}:${text}`;
}

export type CliqDedupeClaimKind = "claimed" | "duplicate" | "inflight";

/**
 * Claim a Cliq message for processing. Returns `null` when there is no stable
 * key to dedupe on (caller should proceed without dedupe). The returned
 * `key` must be passed to `commitCliqMessage`/`releaseCliqMessage` so the
 * caller does not have to recompute it.
 */
export async function claimCliqMessage(
  parsed: ParsedCliqInbound,
  account: { accountId: string | null },
): Promise<{ kind: CliqDedupeClaimKind; key: string | null } | null> {
  const key = buildCliqDedupeKey(parsed, account);
  if (!key) return null;
  const result = await getCliqDedupe().claim(key);
  return { kind: result.kind, key };
}

/** Record a claimed message as processed so future redeliveries are dropped. */
export async function commitCliqMessage(key: string | null): Promise<void> {
  if (!key) return;
  await getCliqDedupe().commit(key);
}

/**
 * Release a claimed message without recording it, so the next redelivery can
 * re-enter the pipeline. Use on retryable dispatch failures.
 */
export function releaseCliqMessage(key: string | null, error?: unknown): void {
  if (!key) return;
  getCliqDedupe().release(key, error !== undefined ? { error } : undefined);
}

/** Test helper: clear the in-memory dedupe cache between cases. */
export function resetCliqDedupeForTest(): void {
  if (dedupe) {
    dedupe.clearMemory();
    dedupe = null;
  }
}
