/**
 * Plugin-owned pairing state for the Cliq channel.
 *
 * Two records are persisted per account:
 *
 *  - **issued codes** — the `code → senderId` mapping written when a pairing
 *    challenge is issued, so an Approve click can resolve which sender a code
 *    belongs to. Codes are single-use (consumed on approval) and expire after
 *    {@link CLIQ_PAIRING_CODE_TTL_MS}, mirroring the SDK's 1h pairing TTL.
 *  - **approvals** — the sender ids an owner has admitted, together with the
 *    approving owner id and a timestamp. This is unioned into DM admission,
 *    so approval works on every supported OpenClaw version even where the
 *    SDK's `approveChannelPairingCode` helper was withdrawn.
 *
 * Storage is a plugin-owned JSON file under the OpenClaw state directory
 * rather than an SDK store: `plugin-state-store-runtime` exists only on
 * `2026.8.1-beta.3`, and `persistent-dedupe` is a TTL/replay guard whose
 * entries may be pruned by size — neither is a safe home for an
 * authorization record that must survive as long as the allowlist does.
 * The file is small, written atomically, and cached in process.
 *
 * The pairing **code is never stored** in the approval record; only the
 * resolved sender id, the approving owner, and the timestamp.
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

/** Pairing codes expire after one hour, mirroring the SDK's pairing TTL. */
export const CLIQ_PAIRING_CODE_TTL_MS = 60 * 60 * 1000;

export interface CliqPairingApproval {
  senderId: string;
  approvedBy: string;
  approvedAt: number;
}

interface CliqPairingIssuedCode {
  senderId: string;
  issuedAt: number;
}

interface CliqPairingStoreFile {
  version: 1;
  accounts: Record<
    string,
    {
      codes: Record<string, CliqPairingIssuedCode>;
      approvals: CliqPairingApproval[];
    }
  >;
}

function emptyStore(): CliqPairingStoreFile {
  return { version: 1, accounts: {} };
}

/** Codes are compared case-insensitively — the SDK uppercases them. */
function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

function normalizeAccountId(accountId: string | null | undefined): string {
  return accountId?.trim() || "default";
}

export function resolveCliqPairingStorePath(env?: NodeJS.ProcessEnv): string {
  return join(resolveStateDir(env ?? process.env), "cliq", "pairing-store.json");
}

/**
 * Process cache keyed by resolved file path. Reads are on the inbound path,
 * so they must not hit the disk on every webhook call. Only a successfully
 * read (or written) store is ever cached.
 */
const cache = new Map<string, CliqPairingStoreFile>();

/** Raised when the store exists but could not be read or parsed. */
export class CliqPairingStoreUnavailableError extends Error {
  constructor(path: string, cause: unknown) {
    super(`cliq: pairing store at ${path} could not be read: ${String(cause)}`);
    this.name = "CliqPairingStoreUnavailableError";
  }
}

function loadStore(path: string): CliqPairingStoreFile {
  const cached = cache.get(path);
  if (cached) return cached;
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      // No store yet — nothing has ever been approved. Do not cache: the file
      // may be created by another process before the next read.
      return emptyStore();
    }
    // A transient read failure (permissions, fd exhaustion) must NOT be
    // cached as "no approvals", and must never be written over — that would
    // silently deny approved senders and then destroy their records.
    throw new CliqPairingStoreUnavailableError(path, err);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (err) {
    throw new CliqPairingStoreUnavailableError(path, err);
  }
  if (!parsed || typeof parsed !== "object" || !(parsed as CliqPairingStoreFile).accounts) {
    throw new CliqPairingStoreUnavailableError(path, "unexpected store shape");
  }
  const store = parsed as CliqPairingStoreFile;
  cache.set(path, store);
  return store;
}

function persist(path: string, store: CliqPairingStoreFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const handle = openSync(tmp, "w", 0o600);
  try {
    writeFileSync(handle, JSON.stringify(store, null, 2));
    // Flush before the rename so a crash cannot leave a truncated store that
    // would later be treated as unreadable.
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(tmp, path);
  cache.set(path, store);
}

function accountBucket(
  store: CliqPairingStoreFile,
  accountId: string,
): { codes: Record<string, CliqPairingIssuedCode>; approvals: CliqPairingApproval[] } {
  const key = normalizeAccountId(accountId);
  const existing = store.accounts[key];
  if (existing) {
    existing.codes ??= {};
    existing.approvals ??= [];
    return existing;
  }
  const created = { codes: {}, approvals: [] };
  store.accounts[key] = created;
  return created;
}

/**
 * Record the `code → senderId` mapping for a freshly issued pairing
 * challenge. Expired codes are pruned on write so the file stays small.
 */
export function recordCliqPairingCode(params: {
  accountId?: string | null;
  code: string;
  senderId: string;
  now?: number;
  env?: NodeJS.ProcessEnv;
  storePath?: string;
}): void {
  const code = normalizeCode(params.code);
  if (!code || !params.senderId) return;
  const path = params.storePath ?? resolveCliqPairingStorePath(params.env);
  const now = params.now ?? Date.now();
  const store = loadStore(path);
  const bucket = accountBucket(store, normalizeAccountId(params.accountId));
  for (const [existing, entry] of Object.entries(bucket.codes)) {
    if (now - entry.issuedAt > CLIQ_PAIRING_CODE_TTL_MS) {
      delete bucket.codes[existing];
    }
  }
  bucket.codes[code] = { senderId: params.senderId, issuedAt: now };
  persist(path, store);
}

/**
 * Resolve a pairing code to the sender who requested it and consume it, so a
 * replayed code cannot re-admit. Returns `null` when the code is unknown,
 * already consumed, or older than {@link CLIQ_PAIRING_CODE_TTL_MS}.
 */
export function consumeCliqPairingCode(params: {
  accountId?: string | null;
  code: string;
  now?: number;
  env?: NodeJS.ProcessEnv;
  storePath?: string;
}): string | null {
  const code = normalizeCode(params.code);
  if (!code) return null;
  const path = params.storePath ?? resolveCliqPairingStorePath(params.env);
  const now = params.now ?? Date.now();
  const store = loadStore(path);
  const bucket = accountBucket(store, normalizeAccountId(params.accountId));
  const entry = bucket.codes[code];
  if (!entry) return null;
  delete bucket.codes[code];
  persist(path, store);
  if (now - entry.issuedAt > CLIQ_PAIRING_CODE_TTL_MS) return null;
  return entry.senderId;
}

/** Persist an owner-approved sender id for this account. */
export function recordCliqPairingApproval(params: {
  accountId?: string | null;
  senderId: string;
  approvedBy: string;
  now?: number;
  env?: NodeJS.ProcessEnv;
  storePath?: string;
}): void {
  if (!params.senderId) return;
  const path = params.storePath ?? resolveCliqPairingStorePath(params.env);
  const store = loadStore(path);
  const bucket = accountBucket(store, normalizeAccountId(params.accountId));
  const already = bucket.approvals.some(
    (a) => a.senderId.toLowerCase() === params.senderId.toLowerCase(),
  );
  if (!already) {
    bucket.approvals.push({
      senderId: params.senderId,
      approvedBy: params.approvedBy,
      approvedAt: params.now ?? Date.now(),
    });
  }
  persist(path, store);
}

/**
 * Remove a previously approved sender for this account, so access granted by
 * a button click can be withdrawn again. Returns true when an entry was
 * removed. Comparison is case-insensitive, matching admission.
 */
export function removeCliqPairingApproval(params: {
  accountId?: string | null;
  senderId: string;
  env?: NodeJS.ProcessEnv;
  storePath?: string;
}): boolean {
  if (!params.senderId) return false;
  const path = params.storePath ?? resolveCliqPairingStorePath(params.env);
  const store = loadStore(path);
  const bucket = accountBucket(store, normalizeAccountId(params.accountId));
  const target = params.senderId.trim().toLowerCase();
  const before = bucket.approvals.length;
  bucket.approvals = bucket.approvals.filter(
    (a) => a.senderId.trim().toLowerCase() !== target,
  );
  if (bucket.approvals.length === before) return false;
  persist(path, store);
  return true;
}

/**
 * Drop every pairing record (pending codes + approvals) for one account, used
 * when the account is removed so a later re-add does not inherit access.
 */
export function dropCliqPairingAccount(params: {
  accountId?: string | null;
  env?: NodeJS.ProcessEnv;
  storePath?: string;
}): void {
  const path = params.storePath ?? resolveCliqPairingStorePath(params.env);
  const store = loadStore(path);
  const key = normalizeAccountId(params.accountId);
  if (!store.accounts[key]) return;
  delete store.accounts[key];
  persist(path, store);
}

/** Read the sender ids approved for this account (cheap, process-cached). */
export function readCliqApprovedSenders(params: {
  accountId?: string | null;
  env?: NodeJS.ProcessEnv;
  storePath?: string;
}): string[] {
  const path = params.storePath ?? resolveCliqPairingStorePath(params.env);
  const store = loadStore(path);
  const bucket = store.accounts[normalizeAccountId(params.accountId)];
  return bucket?.approvals?.map((a) => a.senderId) ?? [];
}

/** Test-only: drop the process cache so a fresh read hits the file. */
export function resetCliqPairingStoreCacheForTests(): void {
  cache.clear();
}
