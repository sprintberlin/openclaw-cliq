/**
 * Cross-request CliqClient registry.
 *
 * A `CliqClient` instance holds an OAuth access-token cache (the
 * `accessToken` / `tokenExpiresAt` fields on the client). The webhook handler,
 * the outbound `sendText` adapter, and the pairing notification path each
 * historically minted a *fresh* `CliqClient` per request, so the token cache
 * was effectively per-request — every message cost an OAuth round-trip to
 * `accounts.zoho.eu`.
 *
 * The registry caches one `CliqClient` per resolved account identity so the
 * OAuth token is reused across requests until it expires (the client refreshes
 * it on demand 60s before expiry). The cache key is `acct:<accountId>` when an
 * accountId is set, otherwise `cc:<clientId>:<botId>` (the single-account
 * default-config case).
 *
 * The registry is a module-level singleton by default (`getCliqClientRegistry` /
 * `resolveCliqClient`), but a fresh instance can be created and injected for
 * tests. `setCliqClientRegistry(null)` resets the singleton (used by tests to
 * guarantee isolation).
 */

import { CliqClient, type ResolvedCliqAccount } from "./client.js";
import type { CliqLogger } from "./logger.js";

/** Minimal identity shape needed to key a cached client. */
export interface CliqAccountIdentity {
  accountId: string | null;
  clientId: string;
  botId: string;
}

export class CliqClientRegistry {
  private readonly clients = new Map<string, CliqClient>();
  private logger?: CliqLogger;

  /**
   * Build the cache key for an account. Prefers `accountId` (stable across
   * config edits that don't change the account id); falls back to
   * `clientId:botId` for the default single-account config.
   */
  static buildKey(account: CliqAccountIdentity): string {
    if (account.accountId) return `acct:${account.accountId}`;
    return `cc:${account.clientId}:${account.botId}`;
  }

  /** Return the cached client for the account, creating one if missing. */
  getOrCreate(account: ResolvedCliqAccount): CliqClient {
    const key = CliqClientRegistry.buildKey(account);
    let client = this.clients.get(key);
    if (!client) {
      client = new CliqClient(
        account.clientId,
        account.clientSecret,
        account.botId,
        undefined,
        undefined,
        undefined,
        this.logger,
      );
      this.clients.set(key, client);
    }
    return client;
  }

  /**
   * Inject the gateway `api.logger` so every client created by this registry
   * emits its outbound send logs to the gateway log sink instead of the
   * console fallback. Called once from `registerFull` at plugin registration.
   * Existing cached clients keep whatever logger they were constructed with
   * (typically the console fallback) — clients are created lazily on first
   * send, so in practice this is set before any client exists.
   */
  setLogger(logger: CliqLogger): void {
    this.logger = logger;
  }

  /** Return the cached client for the account, or undefined when absent. */
  get(account: CliqAccountIdentity): CliqClient | undefined {
    return this.clients.get(CliqClientRegistry.buildKey(account));
  }

  /** Drop the cached client for an account (e.g. after a config change). */
  evict(account: CliqAccountIdentity): boolean {
    return this.clients.delete(CliqClientRegistry.buildKey(account));
  }

  /** Drop all cached clients. */
  clear(): void {
    this.clients.clear();
  }

  /** Number of cached clients. */
  get size(): number {
    return this.clients.size;
  }
}

let defaultRegistry: CliqClientRegistry | null = null;

/** Module-level singleton registry used by the webhook + outbound paths. */
export function getCliqClientRegistry(): CliqClientRegistry {
  if (!defaultRegistry) defaultRegistry = new CliqClientRegistry();
  return defaultRegistry;
}

/**
 * Replace (or clear) the singleton registry. Passing `null` resets it so the
 * next `getCliqClientRegistry` call creates a fresh one. Used by tests to
 * guarantee isolation between cases.
 */
export function setCliqClientRegistry(
  registry: CliqClientRegistry | null,
): void {
  defaultRegistry = registry;
}

/**
 * Resolve a cached `CliqClient` for an account from the singleton registry,
 * creating one on first use. All callers (webhook dispatch, outbound
 * `sendText`, pairing notify) should go through this so the OAuth token is
 * shared across requests.
 */
export function resolveCliqClient(account: ResolvedCliqAccount): CliqClient {
  return getCliqClientRegistry().getOrCreate(account);
}
