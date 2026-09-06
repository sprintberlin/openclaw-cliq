/**
 * Durable, opaque cursor storage for bounded inbound catch-up (issue #229).
 *
 * The key is SHA-256(account id + chat id), so the state file does not expose
 * conversational routing ids. The cursor is a Cliq-native message id: opaque
 * transport metadata, never message text. Atomic mode-600 writes follow the
 * existing pairing-state contract.
 */

import { createHash } from "node:crypto";
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

interface CliqInboundCatchupStoreFile {
  version: 1;
  conversations: Record<string, { cursor: string; updatedAt: number }>;
}

const cache = new Map<string, CliqInboundCatchupStoreFile>();
const locks = new Map<string, Promise<void>>();

function emptyStore(): CliqInboundCatchupStoreFile {
  return { version: 1, conversations: {} };
}

export function resolveCliqInboundCatchupStorePath(env?: NodeJS.ProcessEnv): string {
  return join(resolveStateDir(env ?? process.env), "cliq", "inbound-catchup.json");
}

/** SHA-256 keeps the state lookup key opaque at rest and in diagnostics. */
export function cliqInboundCatchupConversationKey(
  accountId: string | null | undefined,
  chatId: string,
): string {
  return createHash("sha256")
    .update(`${accountId?.trim() || "default"}\0${chatId}`)
    .digest("hex");
}

export function readCliqInboundCatchupCursor(params: {
  accountId?: string | null;
  chatId: string;
  env?: NodeJS.ProcessEnv;
  storePath?: string;
}): string | undefined {
  if (!params.chatId) return undefined;
  const store = loadStore(params.storePath ?? resolveCliqInboundCatchupStorePath(params.env));
  return store.conversations[cliqInboundCatchupConversationKey(params.accountId, params.chatId)]?.cursor;
}

export function recordCliqInboundCatchupCursor(params: {
  accountId?: string | null;
  chatId: string;
  cursor: string;
  now?: number;
  env?: NodeJS.ProcessEnv;
  storePath?: string;
}): void {
  if (!params.chatId || !params.cursor) return;
  const path = params.storePath ?? resolveCliqInboundCatchupStorePath(params.env);
  const store = loadStore(path);
  store.conversations[cliqInboundCatchupConversationKey(params.accountId, params.chatId)] = {
    cursor: params.cursor,
    updatedAt: params.now ?? Date.now(),
  };
  persist(path, store);
}

/**
 * Serialize recovery scans for one account/chat within this gateway process.
 * It prevents two admitted webhooks from reading the same persisted cursor and
 * dispatching the same history gap concurrently. The normal dedupe claim is
 * still the final no-duplicate gate across all paths/processes.
 */
export async function withCliqInboundCatchupConversationLock<T>(params: {
  accountId?: string | null;
  chatId: string;
  run: () => Promise<T>;
}): Promise<T> {
  const key = cliqInboundCatchupConversationKey(params.accountId, params.chatId);
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  locks.set(key, queued);
  await previous;
  try {
    return await params.run();
  } finally {
    release();
    if (locks.get(key) === queued) locks.delete(key);
  }
}

function loadStore(path: string): CliqInboundCatchupStoreFile {
  const cached = cache.get(path);
  if (cached) return cached;
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return emptyStore();
    throw new Error(`cliq: inbound catch-up store could not be read: ${String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (err) {
    throw new Error(`cliq: inbound catch-up store could not be parsed: ${String(err)}`);
  }
  if (!parsed || typeof parsed !== "object" ||
    (parsed as Partial<CliqInboundCatchupStoreFile>).version !== 1 ||
    !(parsed as Partial<CliqInboundCatchupStoreFile>).conversations ||
    typeof (parsed as Partial<CliqInboundCatchupStoreFile>).conversations !== "object") {
    throw new Error("cliq: inbound catch-up store has an unexpected shape");
  }
  const store = parsed as CliqInboundCatchupStoreFile;
  cache.set(path, store);
  return store;
}

function persist(path: string, store: CliqInboundCatchupStoreFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const handle = openSync(tmp, "w", 0o600);
  try {
    writeFileSync(handle, JSON.stringify(store));
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(tmp, path);
  cache.set(path, store);
}

/** Test helper: clear process cache without touching persisted state. */
export function resetCliqInboundCatchupStoreForTest(): void {
  cache.clear();
  locks.clear();
}
