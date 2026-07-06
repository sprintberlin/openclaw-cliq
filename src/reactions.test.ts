import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CliqClient } from "./client.js";
import { setCliqDefaultLogger } from "./logger.js";

/**
 * Reaction API (issue #30). Cliq exposes add / delete reactions at
 * `/api/v2/chats/{chatId}/messages/{messageId}/reactions` with body
 * `{ emoji_code }`. Both endpoints require the user-context
 * `ZohoCliq.messageactions.CREATE` scope, which the `client_credentials`
 * grant cannot obtain a usable token for (same constraint as channel posts
 * + edits, issue #27) — so the path must route through the refresh-token
 * grant when one is configured.
 */
describe("CliqClient reactions API (issue #30)", () => {
  let restoreFetch: (() => void) | null = null;

  beforeEach(() => {
    setCliqDefaultLogger(null);
  });

  afterEach(() => {
    if (restoreFetch) {
      restoreFetch();
      restoreFetch = null;
    }
  });

  function mockFetch(opts: {
    oauthStatus?: number;
    ccToken?: string;
    refreshToken?: string;
    reactStatus?: number;
  }): { fetchCalls: { url: string; method: string; body?: string }[] } {
    const original = globalThis.fetch;
    const ccToken = opts.ccToken ?? "CC_TOKEN";
    const refreshTokenVal = opts.refreshToken ?? "RT_TOKEN";
    const oauthStatus = opts.oauthStatus ?? 200;
    const reactStatus = opts.reactStatus ?? 200;
    const fetchCalls: { url: string; method: string; body?: string }[] = [];
    globalThis.fetch = (async (input: URL | string, init?: RequestInit) => {
      const urlStr = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      fetchCalls.push({ url: urlStr, method, body: init?.body as string | undefined });
      if (urlStr.includes("/oauth/v2/token")) {
        if (urlStr.includes("grant_type=refresh_token")) {
          return new Response(
            JSON.stringify({ access_token: refreshTokenVal, expires_in: 3600 }),
            { status: oauthStatus },
          );
        }
        return new Response(
          JSON.stringify({ access_token: ccToken, expires_in: 3600 }),
          { status: oauthStatus },
        );
      }
      return new Response("{}", { status: reactStatus });
    }) as typeof fetch;
    restoreFetch = () => {
      globalThis.fetch = original;
    };
    return { fetchCalls };
  }

  it("addMessageReaction POSTs { emoji_code } to the reactions endpoint with the messageactions.CREATE scope", async () => {
    const { fetchCalls } = mockFetch({});
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
    const ok = await client.addMessageReaction({ chatId: "CT_chat1", messageId: "m-1", emoji: ":smile:" });
    expect(ok).toBe(true);

    // OAuth: refresh-token grant (NOT client_credentials) because reactions
    // need a user-context scope.
    const oauthCall = fetchCalls.find((c) => c.url.includes("/oauth/v2/token"));
    expect(oauthCall).toBeDefined();
    expect(oauthCall!.url).toContain("grant_type=refresh_token");
    // No per-scope param on the refresh-token request (carries consented scopes).
    expect(oauthCall!.url).not.toContain("scope=");

    const post = fetchCalls.find((c) => c.method === "POST" && c.url.includes("/reactions"));
    expect(post).toBeDefined();
    expect(post!.url).toContain("/chats/CT_chat1/messages/m-1/reactions");
    expect(JSON.parse(post!.body!)).toEqual({ emoji_code: ":smile:" });
  });

  it("removeMessageReaction DELETEs { emoji_code } to the reactions endpoint", async () => {
    const { fetchCalls } = mockFetch({});
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
    const ok = await client.removeMessageReaction({ chatId: "CT_c", messageId: "m", emoji: "😄" });
    expect(ok).toBe(true);

    const del = fetchCalls.find((c) => c.method === "DELETE" && c.url.includes("/reactions"));
    expect(del).toBeDefined();
    expect(del!.url).toContain("/chats/CT_c/messages/m/reactions");
    expect(JSON.parse(del!.body!)).toEqual({ emoji_code: "😄" });
  });

  it("addMessageReaction throws on a fatal 4xx (matches deleteMessage behavior)", async () => {
    mockFetch({ reactStatus: 404 });
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
    await expect(
      client.addMessageReaction({ chatId: "CT_c", messageId: "m", emoji: ":smile:" }),
    ).rejects.toMatchObject({ kind: "fatal", status: 404 });
  });

  it("addMessageReaction falls back to client_credentials when no refreshToken is configured (DM-only setups)", async () => {
    const { fetchCalls } = mockFetch({});
    const client = new CliqClient("id", "secret", "bot", undefined, undefined, {
      maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => {}, random: () => 0,
    });
    await client.addMessageReaction({ chatId: "CT_c", messageId: "m", emoji: ":smile:" });
    // No refresh-token grant happens; client_credentials is used (will fail at
    // the real API, but the grant selection is what we assert here).
    const ccCall = fetchCalls.find(
      (c) => c.url.includes("/oauth/v2/token") && c.url.includes("grant_type=client_credentials"),
    );
    expect(ccCall).toBeDefined();
    expect(ccCall!.url).toContain("scope=ZohoCliq.messageactions.CREATE");
  });

  /**
   * v3 dead-end guard (issue #57). The v3 REST API has NO reactions
   * equivalent — confirmed against the v3 Messages, Chats, and Threads
   * OpenAPI / REST docs (v3 Messages has only delete-multiple, post,
   * forward, search; v3 Chats has no message operations; the v3 sidebar
   * exposes Stars + Pin Messages but no Reactions). The add/remove
   * reactions paths therefore stay on `/api/v2/...` REGARDLESS of the
   * `apiVersion` opt-in, indefinitely. This test locks that invariant so a
   * future contributor does not accidentally wire reactions to a v3 path
   * that does not exist.
   */
  it("reactions stay on /api/v2 even when apiVersion==='v3' (v3 has no reactions endpoint)", async () => {
    const { fetchCalls } = mockFetch({});
    // 9th constructor param is `apiVersion`. v3 opts the channel-text,
    // bot-DM, and message-delete families into their v3 endpoints — but
    // reactions have no v3 equivalent and must remain v2.
    const client = new CliqClient(
      "id",
      "secret",
      "bot",
      undefined,
      undefined,
      { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => {}, random: () => 0 },
      undefined,
      "rt-secret",
      "v3",
    );
    await client.addMessageReaction({ chatId: "CT_c", messageId: "m", emoji: ":smile:" });
    await client.removeMessageReaction({ chatId: "CT_c", messageId: "m", emoji: ":smile:" });

    const reactionCalls = fetchCalls.filter((c) => c.url.includes("/reactions"));
    expect(reactionCalls.length).toBe(2);
    for (const c of reactionCalls) {
      expect(c.url).toContain("/api/v2/chats/CT_c/messages/m/reactions");
      expect(c.url).not.toContain("/api/v3/");
    }
  });
});
