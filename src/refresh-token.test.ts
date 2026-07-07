import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CliqClient } from "./client.js";
import { setCliqDefaultLogger } from "./logger.js";
import {
  CliqClientRegistry,
  resolveCliqClient,
  setCliqClientRegistry,
} from "./runtime-api.js";
import type { ResolvedCliqAccount } from "./client.js";

/**
 * Refresh-token grant behavior (issue #27).
 *
 * The `client_credentials` grant cannot obtain a usable token for
 * `ZohoCliq.Channels.UPDATE` / `ZohoCliq.Messages.UPDATE` — Zoho issues a
 * token that reports the scope but the API rejects it with
 * `oauthtoken_scope_invalid`. So channel posts and message edits must mint
 * access tokens via `grant_type=refresh_token` when a `refreshToken` is
 * configured. Bot DMs keep using `client_credentials`. Without a
 * `refreshToken`, behavior is unchanged (client_credentials for everything;
 * channel posts/edits will fail at the API — i.e. DM-only setups keep
 * working).
 */
describe("CliqClient refresh-token grant (issue #27)", () => {
  let restoreFetch: (() => void) | null = null;
  let fetchCalls: { url: string; method: string }[] = [];

  beforeEach(() => {
    setCliqDefaultLogger(null);
    fetchCalls = [];
  });

  afterEach(() => {
    if (restoreFetch) {
      restoreFetch();
      restoreFetch = null;
    }
    setCliqClientRegistry(null);
  });

  function mockFetch(opts: {
    ccToken?: string;
    refreshToken?: string;
    expires_in?: number;
    sendStatus?: number;
    sendBody?: string;
  }): void {
    const original = globalThis.fetch;
    const ccToken = opts.ccToken ?? "CC_TOKEN_VALUE";
    const refreshTokenVal = opts.refreshToken ?? "REFRESH_TOKEN_VALUE";
    const expiresIn = opts.expires_in ?? 3600;
    const sendStatus = opts.sendStatus ?? 200;
    const sendBody = opts.sendBody ?? JSON.stringify({ id: "msg-1" });
    globalThis.fetch = (async (input: URL | string, init?: RequestInit) => {
      const urlStr = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      fetchCalls.push({ url: urlStr, method });
      if (urlStr.includes("/oauth/v2/token")) {
        if (urlStr.includes("grant_type=refresh_token")) {
          return new Response(
            JSON.stringify({ access_token: refreshTokenVal, expires_in: expiresIn }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({ access_token: ccToken, expires_in: expiresIn }),
          { status: 200 },
        );
      }
      return new Response(sendBody, { status: sendStatus });
    }) as typeof fetch;
    restoreFetch = () => {
      globalThis.fetch = original;
    };
  }

  function fetchCount(grantType: "client_credentials" | "refresh_token"): number {
    return fetchCalls.filter(
      (c) =>
        c.url.includes("/oauth/v2/token") &&
        c.url.includes(`grant_type=${grantType}`),
    ).length;
  }

  it("uses the refresh_token grant for a CHANNEL send when refreshToken is set", async () => {
    mockFetch({});
    const client = new CliqClient(
      "id",
      "secret",
      "bot",
      undefined,
      undefined,
      { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => {}, random: () => 0 },
      undefined,
      "rt-secret",
    );
    await client.sendMessage({ to: "engineering", isDm: false, text: "hi channel" });
    expect(fetchCount("refresh_token")).toBe(1);
    expect(fetchCount("client_credentials")).toBe(0);
    // The Authorization header on the send must carry the refresh-token
    // access token, not the client_credentials one.
    const sendCall = fetchCalls.find(
      (c) => !c.url.includes("/oauth/v2/token") && c.method === "POST",
    );
    expect(sendCall).toBeDefined();
  });

  it("uses client_credentials for a DM send even when refreshToken is set", async () => {
    mockFetch({});
    const client = new CliqClient(
      "id",
      "secret",
      "bot",
      undefined,
      undefined,
      { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => {}, random: () => 0 },
      undefined,
      "rt-secret",
    );
    await client.sendMessage({ to: "user-7", isDm: true, text: "hi dm" });
    expect(fetchCount("client_credentials")).toBe(1);
    expect(fetchCount("refresh_token")).toBe(0);
  });

  it("uses the refresh_token grant for an edit when refreshToken is set", async () => {
    mockFetch({});
    const client = new CliqClient(
      "id",
      "secret",
      "bot",
      undefined,
      undefined,
      { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => {}, random: () => 0 },
      undefined,
      "rt-secret",
    );
    await client.editMessage({ chatId: "CT_1", messageId: "m-1", text: "edited" });
    expect(fetchCount("refresh_token")).toBe(1);
    expect(fetchCount("client_credentials")).toBe(0);
  });

  it("caches and reuses the refreshed access token across channel + edit calls", async () => {
    mockFetch({});
    const client = new CliqClient(
      "id",
      "secret",
      "bot",
      undefined,
      undefined,
      { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => {}, random: () => 0 },
      undefined,
      "rt-secret",
    );
    // A channel send then an edit — both share the refresh-token access
    // token, so only ONE refresh-token OAuth round-trip happens.
    await client.sendMessage({ to: "engineering", isDm: false, text: "first" });
    await client.editMessage({ chatId: "CT_1", messageId: "m-1", text: "edit" });
    await client.sendMessage({ to: "engineering", isDm: false, text: "second" });
    expect(fetchCount("refresh_token")).toBe(1);
    // The DM path still mints its own client_credentials token.
    await client.sendMessage({ to: "user-7", isDm: true, text: "dm" });
    expect(fetchCount("client_credentials")).toBe(1);
  });

  it("falls back to client_credentials for channel sends when no refreshToken is set", async () => {
    mockFetch({});
    const client = new CliqClient(
      "id",
      "secret",
      "bot",
      undefined,
      undefined,
      { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => {}, random: () => 0 },
    );
    // No refreshToken → legacy client_credentials path (will fail at the
    // real API for Channels.UPDATE, but the grant type selection is what
    // we assert here — DM-only setups keep working unchanged).
    await client.sendMessage({ to: "engineering", isDm: false, text: "hi" });
    expect(fetchCount("client_credentials")).toBe(1);
    expect(fetchCount("refresh_token")).toBe(0);
  });

  it("getRefreshedAccessToken throws when no refreshToken is configured", async () => {
    mockFetch({});
    const client = new CliqClient("id", "secret", "bot");
    await expect(client.getRefreshedAccessToken()).rejects.toThrow(
      /no refreshToken configured/,
    );
  });

  it("the refresh-token request includes grant_type, client_id, client_secret, refresh_token params", async () => {
    mockFetch({});
    const client = new CliqClient(
      "cid",
      "csec",
      "bot",
      undefined,
      undefined,
      { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => {}, random: () => 0 },
      undefined,
      "RT-VALUE",
    );
    await client.sendMessage({ to: "engineering", isDm: false, text: "hi" });
    const refreshCall = fetchCalls.find(
      (c) => c.url.includes("/oauth/v2/token") && c.url.includes("grant_type=refresh_token"),
    );
    expect(refreshCall).toBeDefined();
    expect(refreshCall!.url).toContain("client_id=cid");
    expect(refreshCall!.url).toContain("client_secret=csec");
    expect(refreshCall!.url).toContain("refresh_token=RT-VALUE");
    // Must NOT carry a scope param — a refresh-token access token carries
    // whatever scopes were consented at the authorization-code grant.
    expect(refreshCall!.url).not.toContain("scope=");
  });

  it("logs the refresh-token OAuth flow without leaking the refresh token value", async () => {
    const calls: { level: string; msg: string }[] = [];
    const logger = {
      debug: (m: string) => calls.push({ level: "debug", msg: m }),
      info: (m: string) => calls.push({ level: "info", msg: m }),
      warn: (m: string) => calls.push({ level: "warn", msg: m }),
      error: (m: string) => calls.push({ level: "error", msg: m }),
    };
    mockFetch({ refreshToken: "RT-SECRET-VALUE_xyz" });
    const client = new CliqClient(
      "id",
      "secret",
      "bot",
      undefined,
      undefined,
      { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => {}, random: () => 0 },
      logger,
      "RT-SECRET-VALUE_xyz",
    );
    await client.sendMessage({ to: "engineering", isDm: false, text: "hi" });
    for (const c of calls) {
      expect(c.msg).not.toContain("RT-SECRET-VALUE_xyz");
    }
  });

  it("resolvesCliqClient threads refreshToken from the account into the cached client", async () => {
    mockFetch({});
    const account: ResolvedCliqAccount = {
      accountId: null,
      clientId: "id",
      clientSecret: "secret",
      botId: "bot",
      allowFrom: [],
      dmPolicy: undefined,
      ackPolicy: "after_dispatch",
      selfSenderIds: [],
      blockStreaming: false,
      thinking: { mode: "off", text: "💭 …" },
      welcome: { enabled: false, text: "", textRejoin: "" },
    pairing: { notifyOwnerTarget: null, approveLabel: "Approve", denyLabel: "Deny", approvalTitle: "🔐 Pairing request", approvedOwnerText: "✅ Approved.", deniedOwnerText: "🚫 Denied." },
      refreshToken: "from-config-rt",
    };
    const client = resolveCliqClient(account);
    // A channel send must use the refresh-token grant — proving the
    // registry passed account.refreshToken through to the client.
    await client.sendMessage({ to: "engineering", isDm: false, text: "hi" });
    expect(fetchCount("refresh_token")).toBe(1);
    const refreshCall = fetchCalls.find(
      (c) => c.url.includes("grant_type=refresh_token"),
    );
    expect(refreshCall!.url).toContain("refresh_token=from-config-rt");
  });

  it("CliqClientRegistry.getOrCreate creates a client that uses refresh-token grant when account has refreshToken", async () => {
    mockFetch({});
    const registry = new CliqClientRegistry();
    const account: ResolvedCliqAccount = {
      accountId: "a1",
      clientId: "id",
      clientSecret: "secret",
      botId: "bot",
      allowFrom: [],
      dmPolicy: undefined,
      ackPolicy: "after_dispatch",
      selfSenderIds: [],
      blockStreaming: false,
      thinking: { mode: "off", text: "💭 …" },
      welcome: { enabled: false, text: "", textRejoin: "" },
    pairing: { notifyOwnerTarget: null, approveLabel: "Approve", denyLabel: "Deny", approvalTitle: "🔐 Pairing request", approvedOwnerText: "✅ Approved.", deniedOwnerText: "🚫 Denied." },
      refreshToken: "registry-rt",
    };
    const client = registry.getOrCreate(account);
    await client.sendMessage({ to: "engineering", isDm: false, text: "hi" });
    expect(fetchCount("refresh_token")).toBe(1);
    // DM on the same client still uses client_credentials.
    await client.sendMessage({ to: "user-1", isDm: true, text: "dm" });
    expect(fetchCount("client_credentials")).toBe(1);
  });
});
