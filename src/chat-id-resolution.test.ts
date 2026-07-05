import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setCliqClientRegistry } from "./runtime-api.js";

/**
 * Tests for `CliqClient.resolveChannelChatId` and `CliqClient.listChatMessages`
 * — the chat-id resolution building blocks that let live-edit streaming edit
 * group/channel posts in place (the bot-message send response returns only a
 * top-level `{ id }`, NOT the chat id the edit API needs).
 */
describe("CliqClient.resolveChannelChatId — channel unique name → chat id", () => {
  let original: typeof fetch;
  let requests: { url: string; auth?: string }[];

  beforeEach(() => {
    setCliqClientRegistry(null);
    original = globalThis.fetch;
    requests = [];
  });
  afterEach(() => {
    globalThis.fetch = original;
  });

  function installFetch(opts: {
    channelBody?: unknown;
    channelStatus?: number;
  } = {}): void {
    globalThis.fetch = (async (input: URL | string, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const auth = (init?.headers as Record<string, string> | undefined)?.["Authorization"];
      requests.push({ url, auth });
      if (url.includes("/oauth/v2/token")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), {
          status: 200,
        });
      }
      if (url.includes("/api/v2/channelsbyname/")) {
        const status = opts.channelStatus ?? 200;
        if (status !== 200) {
          return new Response('{"error":"not found"}', { status });
        }
        return new Response(JSON.stringify(opts.channelBody ?? {}), { status: 200 });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;
  }

  it("resolves a top-level channel record { id } to a chat id", async () => {
    const { CliqClient } = await import("./client.js");
    installFetch({ channelBody: { id: "CT_dev_team", unique_name: "dev-team" } });
    const client = new CliqClient("id", "secret", "bot");
    const chatId = await client.resolveChannelChatId("dev-team");
    expect(chatId).toBe("CT_dev_team");
    // The channelsbyname GET used the Channels.READ scope (client_credentials).
    const oauth = requests.find((r) => r.url.includes("/oauth/v2/token"));
    expect(oauth?.url).toContain("scope=ZohoCliq.Channels.READ");
    const get = requests.find((r) => r.url.includes("/api/v2/channelsbyname/dev-team"));
    expect(get?.auth).toBe("Zoho-oauthtoken tok");
  });

  it("resolves a channel wrapped under { channel: {...} }", async () => {
    const { CliqClient } = await import("./client.js");
    installFetch({ channelBody: { channel: { chat_id: "CT_real", unique_name: "dev-team" } } });
    const client = new CliqClient("id", "secret", "bot");
    expect(await client.resolveChannelChatId("dev-team")).toBe("CT_real");
  });

  it("prefers chat_id over id when both are present", async () => {
    const { CliqClient } = await import("./client.js");
    installFetch({ channelBody: { id: "channel-id-123", chat_id: "CT_chat_456" } });
    const client = new CliqClient("id", "secret", "bot");
    expect(await client.resolveChannelChatId("dev-team")).toBe("CT_chat_456");
  });

  it("caches the resolved chat id (no second GET on repeat calls)", async () => {
    const { CliqClient } = await import("./client.js");
    installFetch({ channelBody: { id: "CT_cached" } });
    const client = new CliqClient("id", "secret", "bot");
    await client.resolveChannelChatId("dev-team");
    await client.resolveChannelChatId("dev-team");
    const gets = requests.filter((r) => r.url.includes("/api/v2/channelsbyname/"));
    expect(gets).toHaveLength(1);
  });

  it("returns undefined (not throws) when the channel is not found", async () => {
    const { CliqClient } = await import("./client.js");
    installFetch({ channelStatus: 404 });
    const client = new CliqClient("id", "secret", "bot");
    expect(await client.resolveChannelChatId("nope")).toBeUndefined();
  });

  it("returns undefined when the record carries no resolvable id", async () => {
    const { CliqClient } = await import("./client.js");
    installFetch({ channelBody: { unique_name: "dev-team" } });
    const client = new CliqClient("id", "secret", "bot");
    expect(await client.resolveChannelChatId("dev-team")).toBeUndefined();
  });
});

describe("CliqClient.listChatMessages — recent chat messages (edit-recovery)", () => {
  let original: typeof fetch;
  let requests: { url: string; auth?: string }[];

  beforeEach(() => {
    setCliqClientRegistry(null);
    original = globalThis.fetch;
    requests = [];
  });
  afterEach(() => {
    globalThis.fetch = original;
  });

  function installFetch(opts: {
    messagesBody?: unknown;
    messagesStatus?: number;
  } = {}): void {
    globalThis.fetch = (async (input: URL | string, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const auth = (init?.headers as Record<string, string> | undefined)?.["Authorization"];
      requests.push({ url, auth });
      if (url.includes("/oauth/v2/token")) {
        // refresh-token grant: must NOT include a `scope` param.
        return new Response(JSON.stringify({ access_token: "refreshed-tok", expires_in: 3600 }), {
          status: 200,
        });
      }
      if (url.includes("/api/v2/chats/") && url.includes("/messages")) {
        const status = opts.messagesStatus ?? 200;
        if (status !== 200) {
          return new Response('{"error":"denied"}', { status });
        }
        return new Response(JSON.stringify(opts.messagesBody ?? { messages: [] }), { status: 200 });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;
  }

  it("GETs /chats/{chatId}/messages with the refresh-token access token (no scope param)", async () => {
    const { CliqClient } = await import("./client.js");
    installFetch({ messagesBody: { messages: [] } });
    const client = new CliqClient(
      "id",
      "secret",
      "bot",
      undefined,
      undefined,
      undefined,
      undefined,
      "refresh-tok",
    );
    const refs = await client.listChatMessages("CT_chat1");
    expect(refs).toEqual([]);
    // OAuth request used the refresh_token grant (no scope query param).
    const oauth = requests.find((r) => r.url.includes("/oauth/v2/token"));
    expect(oauth?.url).toContain("grant_type=refresh_token");
    expect(oauth?.url).not.toContain("scope=");
    // GET used the refreshed token.
    const get = requests.find((r) => r.url.includes("/api/v2/chats/CT_chat1/messages"));
    expect(get?.auth).toBe("Zoho-oauthtoken refreshed-tok");
    expect(get?.url).toContain("from=0");
    expect(get?.url).toContain("limit=50");
  });

  it("parses { messages: [...] } into message refs", async () => {
    const { CliqClient } = await import("./client.js");
    installFetch({
      messagesBody: {
        messages: [
          { message_id: "m-1", chat_id: "CT_c", text: "hello" },
          { id: "m-2", chat_id: "CT_c" },
          { message_id: "m-3" /* missing chat_id → skipped */ },
        ],
      },
    });
    const client = new CliqClient(
      "id",
      "secret",
      "bot",
      undefined,
      undefined,
      undefined,
      undefined,
      "refresh-tok",
    );
    const refs = await client.listChatMessages("CT_c");
    expect(refs).toHaveLength(2);
    expect(refs[0]).toEqual({ messageId: "m-1", chatId: "CT_c", text: "hello" });
    expect(refs[1]).toEqual({ messageId: "m-2", chatId: "CT_c" });
  });

  it("parses a bare array response", async () => {
    const { CliqClient } = await import("./client.js");
    installFetch({
      messagesBody: [{ message_id: "x", chat_id: "CT_y" }],
    });
    const client = new CliqClient(
      "id",
      "secret",
      "bot",
      undefined,
      undefined,
      undefined,
      undefined,
      "refresh-tok",
    );
    const refs = await client.listChatMessages("CT_y");
    expect(refs).toEqual([{ messageId: "x", chatId: "CT_y" }]);
  });

  it("throws when no refresh token is configured", async () => {
    const { CliqClient } = await import("./client.js");
    installFetch({});
    const client = new CliqClient("id", "secret", "bot");
    await expect(client.listChatMessages("CT_c")).rejects.toThrow(/refreshToken/);
  });

  it("clamps the limit to [1, 200]", async () => {
    const { CliqClient } = await import("./client.js");
    installFetch({ messagesBody: { messages: [] } });
    const client = new CliqClient(
      "id",
      "secret",
      "bot",
      undefined,
      undefined,
      undefined,
      undefined,
      "refresh-tok",
    );
    await client.listChatMessages("CT_c", { limit: 9999 });
    const get = requests.find((r) => r.url.includes("/api/v2/chats/CT_c/messages"));
    expect(get?.url).toContain("limit=200");
  });
});
