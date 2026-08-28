import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { resolveCliqConfig, type ResolvedCliqAccount } from "./client.js";
import { normalizeCliqRouteTarget } from "./client.js";
import { resolveCliqClient } from "./runtime-api.js";
import { CliqSendError } from "./send-retry.js";
import { parseCliqTarget } from "./messaging.js";

export interface CliqHeartbeatProbeResult {
  ok: boolean;
  reason: string;
}

/**
 * Minimum wall-clock gap between two native typing activity posts for the
 * same chat. Zoho's activities limit is 100 req/min/user; exceeding it can
 * lock the caller for up to 50 minutes. 4.5s stays well under that bound.
 */
export const DEFAULT_CLIQ_TYPING_MIN_INTERVAL_MS = 4_500;

/** Bound how long a single turn keeps pulsing typing (issue #178). */
export const DEFAULT_CLIQ_TYPING_MAX_DURATION_MS = 60_000;

/** Zoho chat ids look like `CT_…`; a bare user id is not a chat id. */
export function isCliqChatId(id: string | undefined | null): boolean {
  if (!id) return false;
  return /^CT_[A-Za-z0-9._-]+$/.test(id.trim());
}

interface TypingTurnState {
  chatId: string;
  startedAt: number;
  lastSentAt: number;
  /** Set after a 429 so this turn sends no further activities. */
  rateLimited: boolean;
  inFlight: boolean;
  sent: boolean;
}

const chatIdMemory = new Map<string, string>();
const typingTurns = new Map<string, TypingTurnState>();
let typingNow: () => number = () => Date.now();

function accountKey(accountId?: string | null): string {
  return accountId?.trim() || "default";
}

function memoryKey(accountId: string | null | undefined, alias: string): string {
  return `${accountKey(accountId)}|${alias}`;
}

function rememberAlias(
  accountId: string | null | undefined,
  alias: string | undefined | null,
  chatId: string,
): void {
  const trimmed = alias?.trim();
  if (!trimmed) return;
  chatIdMemory.set(memoryKey(accountId, trimmed), chatId);
}

/**
 * Remember a real inbound chat id so `heartbeat.sendTyping` can address
 * `/api/v3/chats/{chatId}/activities` instead of a user id. A user id
 * returns `chat_access_denied` / HTTP 403.
 */
export function rememberCliqChatId(params: {
  accountId?: string | null;
  chatId: string;
  senderId?: string;
  channelUniqueName?: string;
  isGroup: boolean;
}): void {
  const chatId = params.chatId.trim();
  if (!isCliqChatId(chatId)) return;
  const acct = params.accountId;
  rememberAlias(acct, chatId, chatId);
  rememberAlias(acct, `chat:${chatId}`, chatId);
  rememberAlias(acct, `cliq:chat:${chatId}`, chatId);
  if (params.isGroup) {
    const name = params.channelUniqueName?.trim();
    if (name) {
      rememberAlias(acct, name, chatId);
      rememberAlias(acct, `channel:${name}`, chatId);
      rememberAlias(acct, `group:${name}`, chatId);
      rememberAlias(acct, `cliq:channel:${name}`, chatId);
      rememberAlias(acct, `cliq:group:${name}`, chatId);
      rememberAlias(acct, `cliq:chat:${name}`, chatId);
    }
  } else {
    const sender = params.senderId?.trim();
    if (sender) {
      rememberAlias(acct, sender, chatId);
      rememberAlias(acct, `user:${sender}`, chatId);
      rememberAlias(acct, `dm:${sender}`, chatId);
      rememberAlias(acct, `cliq:${sender}`, chatId);
      rememberAlias(acct, `cliq:user:${sender}`, chatId);
      rememberAlias(acct, `cliq:dm:${sender}`, chatId);
    }
  }
}

/** Look up a remembered chat id for a heartbeat `to` target. */
export function lookupCliqChatId(
  accountId: string | null | undefined,
  to: string,
): string | undefined {
  const raw = to.trim();
  if (!raw) return undefined;
  const direct = chatIdMemory.get(memoryKey(accountId, raw));
  if (direct) return direct;
  const parsed = parseCliqTarget(raw);
  if (parsed) {
    const hit = chatIdMemory.get(memoryKey(accountId, parsed.id));
    if (hit) return hit;
    const prefixed = parsed.kind === "direct" ? `user:${parsed.id}` : `channel:${parsed.id}`;
    const prefixedHit = chatIdMemory.get(memoryKey(accountId, prefixed));
    if (prefixedHit) return prefixedHit;
  }
  const normalized = normalizeCliqRouteTarget(raw);
  if (normalized.to && normalized.to !== raw) {
    return chatIdMemory.get(memoryKey(accountId, normalized.to));
  }
  return undefined;
}

/**
 * Reset typing memory + turn state. Tests inject `now` so throttle / duration
 * assertions do not wait on wall-clock time.
 */
export function resetCliqTypingState(opts?: { now?: () => number }): void {
  chatIdMemory.clear();
  typingTurns.clear();
  typingNow = opts?.now ?? (() => Date.now());
}

function turnKey(accountId: string | null | undefined, chatId: string): string {
  return `${accountKey(accountId)}|${chatId}`;
}

async function resolveTypingChatId(params: {
  account: ResolvedCliqAccount;
  to: string;
}): Promise<string | undefined> {
  const raw = params.to.trim();
  if (!raw) return undefined;
  if (isCliqChatId(raw)) return raw.trim();
  const remembered = lookupCliqChatId(params.account.accountId, raw);
  if (remembered) return remembered;
  const parsed = parseCliqTarget(raw);
  const id = parsed?.id ?? normalizeCliqRouteTarget(raw).to;
  if (isCliqChatId(id)) return id;
  return undefined;
}

function prewarmOauth(account: ResolvedCliqAccount): void {
  const client = resolveCliqClient(account);
  void client.getAccessToken().catch(() => {
    // Swallow: a failed typing keepalive must never break the agent turn.
  });
}

function canSendTyping(account: ResolvedCliqAccount): boolean {
  return Boolean(account.refreshToken);
}

/**
 * Probe Cliq account readiness for the heartbeat runner. Fetching an OAuth
 * access token is the cheapest end-to-end check that exercises credentials +
 * the EU OAuth endpoint reachability without posting a message. Used as the
 * gate before a heartbeat delivery / "ok" ping so a misconfigured account
 * doesn't burn a model turn.
 */
export async function probeCliqHeartbeat(
  account: ResolvedCliqAccount,
): Promise<CliqHeartbeatProbeResult> {
  try {
    const client = resolveCliqClient(account);
    await client.getAccessToken();
    return { ok: true, reason: "ok" };
  } catch (err) {
    return { ok: false, reason: String(err) };
  }
}

/**
 * Resolve a Cliq account from cfg for a heartbeat adapter call without
 * throwing. When the channel is unconfigured there is nothing to probe or
 * pre-warm; the adapter returns a benign "not ready" / no-op.
 */
function resolveAccountSafe(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedCliqAccount | null {
  try {
    return resolveCliqConfig(cfg, accountId ?? null);
  } catch {
    return null;
  }
}

/**
 * Channel heartbeat adapter for Zoho Cliq.
 *
 * `checkReady` — probes OAuth token fetch; gates heartbeat delivery so a
 * broken account is skipped instead of producing a failed model turn.
 *
 * `sendTyping` — native v3 chat activity (`POST /api/v3/chats/{chatId}/activities`
 * with `{"action":"typing"}`, scope `ZohoCliq.Chats.UPDATE`). Sent only when a
 * refresh token is configured and a real chat id is known (inbound webhook
 * `chat.id`, never a Zoho user id). Throttled to at most one request every
 * {@link DEFAULT_CLIQ_TYPING_MIN_INTERVAL_MS} and bounded by
 * {@link DEFAULT_CLIQ_TYPING_MAX_DURATION_MS}. A 429 stops further activity
 * for the rest of the turn. HTTP 204 is API acceptance only; Cliq client UI
 * visibility is unconfirmed. Failures are swallowed — typing must never
 * break or delay an agent turn. When typing cannot be sent, the call still
 * pre-warms the cached OAuth token.
 *
 * `clearTyping` — posts `{"action":"text_cleared"}` for the same chat and
 * drops turn state. Also non-fatal.
 */
export const cliqHeartbeatAdapter = {
  checkReady: async (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }): Promise<CliqHeartbeatProbeResult> => {
    const account = resolveAccountSafe(params.cfg, params.accountId);
    if (!account) return { ok: false, reason: "cliq not configured" };
    return probeCliqHeartbeat(account);
  },
  sendTyping: (params: {
    cfg: OpenClawConfig;
    to: string;
    accountId?: string | null;
  }): void => {
    const account = resolveAccountSafe(params.cfg, params.accountId);
    if (!account || !params.to) return;
    if (!canSendTyping(account)) {
      prewarmOauth(account);
      return;
    }
    void (async () => {
      try {
        const chatId = await resolveTypingChatId({ account, to: params.to });
        if (!chatId) {
          prewarmOauth(account);
          return;
        }
        const key = turnKey(account.accountId, chatId);
        const now = typingNow();
        let turn = typingTurns.get(key);
        if (!turn) {
          turn = {
            chatId,
            startedAt: now,
            lastSentAt: 0,
            rateLimited: false,
            inFlight: false,
            sent: false,
          };
          typingTurns.set(key, turn);
        }
        if (turn.rateLimited || turn.inFlight) return;
        if (now - turn.startedAt > DEFAULT_CLIQ_TYPING_MAX_DURATION_MS) return;
        if (turn.lastSentAt > 0 && now - turn.lastSentAt < DEFAULT_CLIQ_TYPING_MIN_INTERVAL_MS) {
          return;
        }
        turn.inFlight = true;
        try {
          const client = resolveCliqClient(account);
          await client.sendChatActivity({ chatId, action: "typing" });
          turn.lastSentAt = typingNow();
          turn.sent = true;
        } catch (err) {
          if (err instanceof CliqSendError && err.status === 429) {
            turn.rateLimited = true;
          }
        } finally {
          turn.inFlight = false;
        }
      } catch {
        // Swallow: a failed typing keepalive must never break the agent turn.
      }
    })();
  },
  clearTyping: (params?: {
    cfg: OpenClawConfig;
    to: string;
    accountId?: string | null;
  }): void => {
    if (!params?.cfg || !params.to) return;
    const account = resolveAccountSafe(params.cfg, params.accountId);
    if (!account || !canSendTyping(account)) return;
    void (async () => {
      try {
        const chatId = await resolveTypingChatId({ account, to: params.to });
        if (!chatId) return;
        const key = turnKey(account.accountId, chatId);
        const turn = typingTurns.get(key);
        typingTurns.delete(key);
        if (turn?.rateLimited) return;
        if (!turn?.sent) return;
        const client = resolveCliqClient(account);
        await client.sendChatActivity({ chatId, action: "text_cleared" });
      } catch {
        // Swallow: clearing typing must never break the agent turn.
      }
    })();
  },
};
