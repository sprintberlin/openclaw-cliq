import { describe, it, expect } from "vitest";
import { cliqPlugin } from "./channel.js";
import { chunkMessage, normalizeCliqRouteTarget, resolveCliqConfig } from "./client.js";
import { setCliqClientRegistry } from "./runtime-api.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { createCliqTestConfig as cfgWith } from "./test-api.js";

describe("cliq plugin", () => {
  it("resolves account from config", () => {
    const cfg = cfgWith({
      clientId: "id",
      clientSecret: "secret",
      botId: "bot",
      allowFrom: ["user1"],
    });
    const account = cliqPlugin.config.resolveAccount(cfg, undefined);
    expect(account.clientId).toBe("id");
    expect(account.botId).toBe("bot");
    expect(account.allowFrom).toEqual(["user1"]);
    expect(account.accountId).toBeNull();
  });

  it("inspects configured account", () => {
    const cfg = cfgWith({
      clientId: "id",
      clientSecret: "secret",
      botId: "bot",
    });
    const result = cliqPlugin.config.inspectAccount!(cfg, undefined) as {
      configured: boolean;
      tokenStatus: string;
    };
    expect(result.configured).toBe(true);
    expect(result.tokenStatus).toBe("available");
  });

  it("reports missing config", () => {
    const cfg = cfgWith({});
    const result = cliqPlugin.config.inspectAccount!(cfg, undefined) as {
      configured: boolean;
      tokenStatus: string;
    };
    expect(result.configured).toBe(false);
    expect(result.tokenStatus).toBe("missing");
  });

  it("throws when required fields are missing", () => {
    const cfg = cfgWith({ clientId: "id" });
    expect(() => resolveCliqConfig(cfg)).toThrow(/clientSecret/);
  });

  it("preserves accountId when provided", () => {
    const cfg = cfgWith({
      clientId: "id",
      clientSecret: "secret",
      botId: "bot",
    });
    const account = resolveCliqConfig(cfg, "acct-1");
    expect(account.accountId).toBe("acct-1");
  });

  it("lists configured account ids", () => {
    const cfg = {
      channels: { cliq: { accounts: { a: {}, b: {} } } },
    } as unknown as OpenClawConfig;
    expect(cliqPlugin.config.listAccountIds(cfg).sort()).toEqual(["a", "b"]);
  });

  it("applies account config writing fields", () => {
    const cfg = cfgWith({});
    const next = cliqPlugin.setup!.applyAccountConfig({
      cfg,
      accountId: "default",
      input: {
        clientId: "cid",
        clientSecret: "sec",
        botId: "bot",
        botName: "Bot",
      },
    } as any);
    const section = (next as any).channels.cliq;
    expect(section.clientId).toBe("cid");
    expect(section.clientSecret).toBe("sec");
    expect(section.botId).toBe("bot");
    expect(section.botName).toBe("Bot");
  });

  it("advertises direct + group chat types, reply, and media capabilities", () => {
    expect(cliqPlugin.capabilities.chatTypes).toEqual(["direct", "group"]);
    expect(cliqPlugin.capabilities.reply).toBe(true);
    expect(cliqPlugin.capabilities.media).toBe(true);
  });

  it("advertises block-streaming + edit capabilities for streaming previews", () => {
    expect(cliqPlugin.capabilities.blockStreaming).toBe(true);
    expect(cliqPlugin.capabilities.edit).toBe(true);
  });

  it("wires presentation capabilities + renderPresentation + sendPayload on the outbound adapter", () => {
    const outbound = cliqPlugin.outbound as {
      presentationCapabilities?: { supported?: boolean; buttons?: boolean };
      renderPresentation?: unknown;
      sendPayload?: unknown;
    };
    expect(outbound.presentationCapabilities?.supported).toBe(true);
    expect(outbound.presentationCapabilities?.buttons).toBe(true);
    expect(typeof outbound.renderPresentation).toBe("function");
    expect(typeof outbound.sendPayload).toBe("function");
  });

  it("publishes block-streaming coalesce defaults tuned for Cliq", () => {
    const streaming = (cliqPlugin as { streaming?: { blockStreamingCoalesceDefaults?: { minChars: number; idleMs: number } } }).streaming;
    expect(streaming?.blockStreamingCoalesceDefaults).toBeDefined();
    const coalesce = streaming!.blockStreamingCoalesceDefaults!;
    expect(coalesce.minChars).toBeGreaterThan(0);
    expect(coalesce.idleMs).toBeGreaterThanOrEqual(0);
    // minChars must stay well under the 5000-char message cap so blocks flush.
    expect(coalesce.minChars).toBeLessThanOrEqual(5000);
  });

  it("resolves streaming.preview=on into blockStreaming=true on the account", () => {
    const cfg = cfgWith({
      clientId: "id",
      clientSecret: "secret",
      botId: "bot",
      streaming: { preview: "on" },
    });
    const account = resolveCliqConfig(cfg);
    expect(account.blockStreaming).toBe(true);
  });

  it("defaults blockStreaming=false when streaming.preview is unset", () => {
    const cfg = cfgWith({
      clientId: "id",
      clientSecret: "secret",
      botId: "bot",
    });
    expect(resolveCliqConfig(cfg).blockStreaming).toBe(false);
  });

  it("applies streaming config through applyAccountConfig", () => {
    const cfg = cfgWith({});
    const next = cliqPlugin.setup!.applyAccountConfig({
      cfg,
      accountId: "default",
      input: { streaming: { preview: "on" } },
    } as any);
    const section = (next as any).channels.cliq;
    expect(section.streaming).toEqual({ preview: "on" });
  });

  it("wires the threading adapter (not the legacy topLevelReplyToMode shape)", () => {
    const threading = cliqPlugin.threading as {
      resolveReplyToMode?: unknown;
      allowExplicitReplyTagsWhenOff?: boolean;
      buildToolContext?: unknown;
      resolveReplyTransport?: unknown;
      resolveCurrentChannelId?: unknown;
      topLevelReplyToMode?: unknown;
    };
    expect(typeof threading.resolveReplyToMode).toBe("function");
    expect(threading.allowExplicitReplyTagsWhenOff).toBe(true);
    expect(typeof threading.buildToolContext).toBe("function");
    expect(typeof threading.resolveReplyTransport).toBe("function");
    expect(typeof threading.resolveCurrentChannelId).toBe("function");
    // The broken `topLevelReplyToMode: "reply"` (treated as a channel id,
    // resolved to "off" via a non-existent cfg.channels["reply"] lookup)
    // must NOT be present — the resolver form replaces it.
    expect(threading.topLevelReplyToMode).toBeUndefined();
  });

  it("threading.resolveReplyToMode defaults to off and honors channels.cliq.replyToMode", () => {
    const threading = cliqPlugin.threading as {
      resolveReplyToMode: (p: { cfg: any; chatType?: string | null }) => string;
    };
    expect(
      threading.resolveReplyToMode({ cfg: cfgWith({ clientId: "id", clientSecret: "s", botId: "b" }), chatType: "group" }),
    ).toBe("off");
    expect(
      threading.resolveReplyToMode({
        cfg: cfgWith({ clientId: "id", clientSecret: "s", botId: "b", replyToMode: "all" }),
        chatType: "group",
      }),
    ).toBe("all");
  });

  it("wires a pairing adapter with the cliq id label", () => {
    expect(cliqPlugin.pairing).toBeDefined();
    const pairing = cliqPlugin.pairing as { idLabel?: string };
    expect(pairing.idLabel).toBe("cliqSenderId");
  });

  it("wires a heartbeat adapter with checkReady + sendTyping + clearTyping", () => {
    expect(cliqPlugin.heartbeat).toBeDefined();
    const heartbeat = cliqPlugin.heartbeat as {
      checkReady?: unknown;
      sendTyping?: unknown;
      clearTyping?: unknown;
    };
    expect(typeof heartbeat.checkReady).toBe("function");
    expect(typeof heartbeat.sendTyping).toBe("function");
    expect(typeof heartbeat.clearTyping).toBe("function");
  });

  it("applies markdown→cliq formatting on outbound sendText", async () => {
    // Reset the client registry so this test starts with no cached OAuth
    // token and the mocked fetch OAuth branch is exercised deterministically.
    setCliqClientRegistry(null);
    const cfg = cfgWith({
      clientId: "id",
      clientSecret: "secret",
      botId: "bot",
    });
    const seen: { url: string; body: string }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/oauth/v2/token")) {
        return new Response(
          JSON.stringify({ access_token: "tok", expires_in: 3600 }),
          { status: 200 },
        );
      }
      if (init?.method === "POST") {
        seen.push({ url: urlStr, body: init.body as string });
        return new Response(JSON.stringify({ id: "msg-1" }), { status: 200 });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;
    try {
      await cliqPlugin.outbound!.sendText!({
        cfg,
        to: "user-1",
        text: "**bold** and *italic*",
        accountId: undefined,
      } as any);
    } finally {
      globalThis.fetch = original;
    }
    expect(seen).toHaveLength(1);
    const parsed = JSON.parse(seen[0].body) as { text: string };
    // Markdown must be converted to Cliq-native formatting before sending.
    expect(parsed.text).toBe("*bold* and _italic_");
    // A bare target with no `cliq:` prefix defaults to group/channel delivery,
    // which now routes through the channelsbyname endpoint (no chatid key).
    expect(seen[0].url).toContain("/channelsbyname/user-1/message");
    expect(seen[0].url).toContain("bot_unique_name=bot");
    expect(parsed).not.toHaveProperty("chatid");
    expect(parsed).not.toHaveProperty("userids");
  });

  it("sendText routes DM targets via userids with isDm (issue #11)", async () => {
    setCliqClientRegistry(null);
    const cfg = cfgWith({
      clientId: "id",
      clientSecret: "secret",
      botId: "bot",
    });
    const seen: { url: string; body: string }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/oauth/v2/token")) {
        return new Response(
          JSON.stringify({ access_token: "tok", expires_in: 3600 }),
          { status: 200 },
        );
      }
      if (init?.method === "POST") {
        seen.push({ url: urlStr, body: init.body as string });
        return new Response(JSON.stringify({ id: "msg-dm-1" }), { status: 200 });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;
    try {
      await cliqPlugin.outbound!.sendText!({
        cfg,
        to: "cliq:user:20098819618",
        text: "hello dm",
        accountId: undefined,
      } as any);
    } finally {
      globalThis.fetch = original;
    }
    expect(seen).toHaveLength(1);
    const parsed = JSON.parse(seen[0].body) as { text: string; userids?: string };
    // DMs route to the bot-message endpoint with userids (no chatid).
    expect(seen[0].url).toContain("/bots/bot/message");
    expect(parsed.userids).toBe("20098819618");
    expect(parsed).not.toHaveProperty("chatid");
  });

  it("sendText routes group chat targets through channelsbyname (issue #26)", async () => {
    setCliqClientRegistry(null);
    const cfg = cfgWith({
      clientId: "id",
      clientSecret: "secret",
      botId: "bot",
    });
    const seen: { url: string; body: string }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/oauth/v2/token")) {
        return new Response(
          JSON.stringify({ access_token: "tok", expires_in: 3600 }),
          { status: 200 },
        );
      }
      if (init?.method === "POST") {
        seen.push({ url: urlStr, body: init.body as string });
        return new Response(JSON.stringify({ id: "msg-grp-1" }), { status: 200 });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;
    try {
      await cliqPlugin.outbound!.sendText!({
        cfg,
        to: "cliq:chat:CT_channel_chat",
        text: "hello group",
        accountId: undefined,
      } as any);
    } finally {
      globalThis.fetch = original;
    }
    expect(seen).toHaveLength(1);
    const parsed = JSON.parse(seen[0].body) as { text: string };
    // Channel posts route to channelsbyname/<unique_name>/message with the
    // bot identity as a bot_unique_name query param. The body is just
    // { text } — NO chatid key (the bot endpoint rejects it: issue #26).
    expect(seen[0].url).toContain("/channelsbyname/CT_channel_chat/message");
    expect(seen[0].url).toContain("bot_unique_name=bot");
    expect(parsed).not.toHaveProperty("chatid");
    expect(parsed).not.toHaveProperty("userids");
    expect(parsed.text).toBe("hello group");
  });

  it("sendText routes cliq:channel:<name> through channelsbyname (issue #26)", async () => {
    setCliqClientRegistry(null);
    const cfg = cfgWith({
      clientId: "id",
      clientSecret: "secret",
      botId: "bot",
    });
    const seen: { url: string; body: string }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/oauth/v2/token")) {
        return new Response(
          JSON.stringify({ access_token: "tok", expires_in: 3600 }),
          { status: 200 },
        );
      }
      if (init?.method === "POST") {
        seen.push({ url: urlStr, body: init.body as string });
        return new Response(JSON.stringify({ id: "msg-grp-2" }), { status: 200 });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;
    try {
      await cliqPlugin.outbound!.sendText!({
        cfg,
        to: "cliq:channel:dev-team",
        text: "hi team",
        accountId: undefined,
      } as any);
    } finally {
      globalThis.fetch = original;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toContain("/channelsbyname/dev-team/message");
    expect(seen[0].url).toContain("bot_unique_name=bot");
  });

  it("sendText uses ZohoCliq.Channels.UPDATE scope for channels, Webhooks.CREATE for DMs (issue #26)", async () => {
    setCliqClientRegistry(null);
    const cfg = cfgWith({
      clientId: "id",
      clientSecret: "secret",
      botId: "bot",
    });
    const oauthScopes: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/oauth/v2/token")) {
        const scope = new URL(urlStr).searchParams.get("scope");
        oauthScopes.push(scope ?? "");
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      }
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ id: "m" }), { status: 200 });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;
    try {
      await cliqPlugin.outbound!.sendText!({ cfg, to: "cliq:user:u1", text: "dm", accountId: undefined } as any);
      setCliqClientRegistry(null);
      await cliqPlugin.outbound!.sendText!({ cfg, to: "cliq:channel:dev-team", text: "chan", accountId: undefined } as any);
    } finally {
      globalThis.fetch = original;
    }
    expect(oauthScopes).toContain("ZohoCliq.Webhooks.CREATE");
    expect(oauthScopes).toContain("ZohoCliq.Channels.UPDATE");
  });

  it("uploads an http media attachment via multipart to the bot DM API", async () => {
    setCliqClientRegistry(null);
    const cfg = cfgWith({
      clientId: "id",
      clientSecret: "secret",
      botId: "bot",
    });
    const seen: { url: string; method: string; body: unknown; headers: Record<string, string> }[] = [];
    const mediaBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/oauth/v2/token")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      }
      if (urlStr.includes("/media/file.png")) {
        return new Response(mediaBytes, { status: 200, headers: { "content-type": "image/png" } });
      }
      if (init?.method === "POST") {
        const headers: Record<string, string> = {};
        const h = init.headers;
        if (h instanceof Headers) {
          h.forEach((v, k) => { headers[k.toLowerCase()] = v; });
        } else if (h && typeof h === "object") {
          for (const [k, v] of Object.entries(h as Record<string, string>)) headers[k.toLowerCase()] = v;
        }
        seen.push({ url: urlStr, method: init.method ?? "POST", body: init.body, headers });
        return new Response(JSON.stringify({ id: "msg-media-1" }), { status: 200 });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;
    try {
      const result = await cliqPlugin.outbound!.sendMedia!({
        cfg,
        to: "cliq:user:user-1",
        text: "**see this**",
        mediaUrl: "https://example.com/media/file.png",
        accountId: undefined,
      } as any);
      expect(result.messageId).toBe("msg-media-1");
    } finally {
      globalThis.fetch = original;
    }
    // The bot DM API call must be multipart/form-data with userids + the file attached.
    const post = seen.find((s) => s.url.includes("/bots/bot/message"));
    expect(post).toBeDefined();
    const form = post!.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("userids")).toBe("user-1");
    expect(form.get("text")).toBe("*see this*");
    expect(form.get("chatid")).toBeNull();
    const file = form.get("attachments") as File;
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe("file.png");
    expect(file.type).toBe("image/png");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(mediaBytes);
    // Authorization must be the OAuth token; body is a FormData (multipart) instance.
    expect(post!.headers["authorization"]).toBe("Zoho-oauthtoken tok");
  });

  it("uploads a media attachment to a channel via the channelsbyname endpoint (issue #26)", async () => {
    setCliqClientRegistry(null);
    const cfg = cfgWith({
      clientId: "id",
      clientSecret: "secret",
      botId: "bot",
    });
    const seen: { url: string; body: unknown }[] = [];
    const mediaBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/oauth/v2/token")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      }
      if (urlStr.includes("/media/file.png")) {
        return new Response(mediaBytes, { status: 200, headers: { "content-type": "image/png" } });
      }
      if (init?.method === "POST") {
        seen.push({ url: urlStr, body: init.body });
        return new Response(JSON.stringify({ id: "msg-media-chan" }), { status: 200 });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;
    try {
      const result = await cliqPlugin.outbound!.sendMedia!({
        cfg,
        to: "cliq:channel:dev-team",
        text: "see this",
        mediaUrl: "https://example.com/media/file.png",
        accountId: undefined,
      } as any);
      expect(result.messageId).toBe("msg-media-chan");
    } finally {
      globalThis.fetch = original;
    }
    const post = seen.find((s) => s.url.includes("/channelsbyname/dev-team/message"));
    expect(post).toBeDefined();
    expect(post!.url).toContain("bot_unique_name=bot");
    const form = post!.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    // Channel media posts must NOT carry a chatid or userids key (issue #26).
    expect(form.get("chatid")).toBeNull();
    expect(form.get("userids")).toBeNull();
    expect(form.get("text")).toBe("see this");
    const file = form.get("attachments") as File;
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe("file.png");
  });

  it("reads a local media file via mediaReadFile and uploads it to a DM", async () => {
    setCliqClientRegistry(null);
    const cfg = cfgWith({
      clientId: "id",
      clientSecret: "secret",
      botId: "bot",
    });
    const seen: { url: string; body: unknown }[] = [];
    const fileBytes = Buffer.from("hello world");
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/oauth/v2/token")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      }
      if (init?.method === "POST") {
        seen.push({ url: urlStr, body: init.body });
        return new Response(JSON.stringify({ id: "msg-media-2" }), { status: 200 });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;
    try {
      const result = await cliqPlugin.outbound!.sendMedia!({
        cfg,
        to: "cliq:user:u-1",
        text: "doc",
        mediaUrl: "/tmp/report.txt",
        mediaReadFile: async () => fileBytes,
        accountId: undefined,
      } as any);
      expect(result.messageId).toBe("msg-media-2");
    } finally {
      globalThis.fetch = original;
    }
    const post = seen.find((s) => s.url.includes("/bots/bot/message"));
    expect(post).toBeDefined();
    const form = post!.body as FormData;
    expect(form.get("userids")).toBe("u-1");
    expect(form.get("text")).toBe("doc");
    expect(form.get("chatid")).toBeNull();
    const file = form.get("attachments") as File;
    expect(file.name).toBe("report.txt");
    expect(file.type).toBe("text/plain");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array(fileBytes));
  });

  it("throws when sendMedia is called without a mediaUrl", async () => {
    const cfg = cfgWith({ clientId: "id", clientSecret: "secret", botId: "bot" });
    await expect(
      cliqPlugin.outbound!.sendMedia!({
        cfg,
        to: "user-1",
        text: "no media",
        accountId: undefined,
      } as any),
    ).rejects.toThrow(/mediaUrl/);
  });
});

describe("CliqClient.editMessage — Cliq message edit API (streaming preview building block)", () => {
  it("PUTs to /chats/{chatId}/messages/{messageId} with the Messages.UPDATE scope", async () => {
    setCliqClientRegistry(null);
    const { CliqClient } = await import("./client.js");
    const client = new CliqClient("id", "secret", "bot");
    const seen: { url: string; method?: string; body?: string; auth?: string }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/oauth/v2/token")) {
        // Capture the scope requested — editMessage must use Messages.UPDATE.
        const scope = new URL(urlStr).searchParams.get("scope");
        seen.push({ url: `oauth?scope=${scope}` });
        return new Response(JSON.stringify({ access_token: "edit-tok", expires_in: 3600 }), { status: 200 });
      }
      seen.push({
        url: urlStr,
        method: init?.method,
        body: init?.body as string,
        auth: (init?.headers as Record<string, string>)?.["Authorization"],
      });
      return new Response(JSON.stringify({ message_id: "m-1", chat_id: "CT_x" }), { status: 200 });
    }) as typeof fetch;
    try {
      const result = await client.editMessage({ chatId: "CT_chat1", messageId: "m-1", text: "*updated*" });
      expect(result.messageId).toBe("m-1");
      expect(result.chatId).toBe("CT_x");
    } finally {
      globalThis.fetch = original;
    }
    // The OAuth token request must have asked for the Messages.UPDATE scope.
    const oauth = seen.find((s) => s.url.startsWith("oauth?scope="));
    expect(oauth?.url).toContain("ZohoCliq.Messages.UPDATE");
    const put = seen.find((s) => s.method === "PUT");
    expect(put).toBeDefined();
    expect(put!.url).toContain("/chats/CT_chat1/messages/m-1");
    expect(put!.auth).toBe("Zoho-oauthtoken edit-tok");
    expect(JSON.parse(put!.body!)).toEqual({ text: "*updated*" });
  });

  it("classifies a 400 format error as format_rejected (no retry fallback inside editMessage)", async () => {
    setCliqClientRegistry(null);
    const { CliqClient } = await import("./client.js");
    const client = new CliqClient("id", "secret", "bot", undefined, undefined, {
      maxAttempts: 2,
      baseDelayMs: 1,
      maxDelayMs: 5,
      sleep: async () => {},
      random: () => 0.1,
    });
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: URL | string) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/oauth/v2/token")) {
        return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
      }
      return new Response("invalid markdown format", { status: 400 });
    }) as typeof fetch;
    try {
      await expect(
        client.editMessage({ chatId: "CT_chat1", messageId: "m-1", text: "x" }),
      ).rejects.toMatchObject({ kind: "format_rejected", status: 400 });
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("CliqClient.sendMessage message-ref parsing", () => {
  it("extracts messageId + chatId from a bot-DM message_details response", async () => {
    setCliqClientRegistry(null);
    const { CliqClient } = await import("./client.js");
    const client = new CliqClient("id", "secret", "bot");
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/oauth/v2/token")) {
        return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
      }
      const body = JSON.parse(init?.body as string) as { userids?: string };
      return new Response(
        JSON.stringify({
          message_details: { [body.userids!]: { chat_id: "CT_dm-1", message_id: "msg-99" } },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    try {
      const result = await client.sendMessage({ to: "u-1", isDm: true, text: "hi" });
      expect(result.messageId).toBe("msg-99");
      expect(result.chatId).toBe("CT_dm-1");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("extracts messageId from a top-level { id } channel response", async () => {
    setCliqClientRegistry(null);
    const { CliqClient } = await import("./client.js");
    const client = new CliqClient("id", "secret", "bot");
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: URL | string) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/oauth/v2/token")) {
        return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "msg-chan-1" }), { status: 200 });
    }) as typeof fetch;
    try {
      const result = await client.sendMessage({ to: "CT_channel", isDm: false, text: "hi" });
      expect(result.messageId).toBe("msg-chan-1");
      expect(result.chatId).toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("CliqClient.sendMessage v3 channel post (apiVersion==='v3')", () => {
  it("POSTs to /api/v3/channelsbyname/{name}/messages with the Webhooks.CREATE scope (no refresh token)", async () => {
    setCliqClientRegistry(null);
    const { CliqClient } = await import("./client.js");
    // v3 channel post opts in via the 9th constructor param.
    const client = new CliqClient("id", "secret", "bot", undefined, undefined, undefined, undefined, undefined, "v3");
    const seen: { url: string; method?: string; body?: string; scope?: string | null }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/oauth/v2/token")) {
        const scope = new URL(urlStr).searchParams.get("scope");
        seen.push({ url: "oauth", scope });
        return new Response(JSON.stringify({ access_token: "v3-tok", expires_in: 3600 }), { status: 200 });
      }
      seen.push({
        url: urlStr,
        method: init?.method,
        body: init?.body as string,
      });
      // v3 channel post returns 204 No response (no message id).
      return new Response(JSON.stringify({ "Response Code": "204 No response" }), { status: 200 });
    }) as typeof fetch;
    try {
      const result = await client.sendMessage({ to: "dev-team", isDm: false, text: "hello v3" });
      expect(result.messageId).toBeUndefined();
      expect(result.chatId).toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
    // OAuth must use the Webhooks.CREATE scope (client_credentials) — NOT Channels.UPDATE.
    const oauth = seen.find((s) => s.url === "oauth");
    expect(oauth?.scope).toBe("ZohoCliq.Webhooks.CREATE");
    // The send must hit the v3 channelsbyname messages endpoint.
    const post = seen.find((s) => s.method === "POST" && s.url.includes("/channelsbyname/"));
    expect(post).toBeDefined();
    expect(post!.url).toContain("/api/v3/channelsbyname/dev-team/messages");
    expect(post!.url).toContain("bot_unique_name=bot");
    // The body is the v3 shape: { text } (no userids, no chatid).
    expect(JSON.parse(post!.body!)).toEqual({ text: "hello v3" });
  });

  it("defaults to v2 channel post when apiVersion is unset (no v3 path)", async () => {
    setCliqClientRegistry(null);
    const { CliqClient } = await import("./client.js");
    const client = new CliqClient("id", "secret", "bot");
    const seen: { url: string; scope?: string | null }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: URL | string) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/oauth/v2/token")) {
        const scope = new URL(urlStr).searchParams.get("scope");
        seen.push({ url: "oauth", scope });
        return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "msg-v2" }), { status: 200 });
    }) as typeof fetch;
    try {
      await client.sendMessage({ to: "dev-team", isDm: false, text: "hi" });
    } finally {
      globalThis.fetch = original;
    }
    // Default v2 channel post requests Channels.UPDATE scope.
    const oauth = seen.find((s) => s.url === "oauth");
    expect(oauth?.scope).toBe("ZohoCliq.Channels.UPDATE");
  });

  it("v3 channel post still uses client_credentials Webhooks.CREATE even when a refresh token is configured", async () => {
    setCliqClientRegistry(null);
    const { CliqClient } = await import("./client.js");
    const client = new CliqClient("id", "secret", "bot", undefined, undefined, undefined, undefined, "rt-token", "v3");
    const seen: { url: string; scope?: string | null; grantType?: string | null }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: URL | string) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/oauth/v2/token")) {
        const u = new URL(urlStr);
        seen.push({ url: "oauth", scope: u.searchParams.get("scope"), grantType: u.searchParams.get("grant_type") });
        return new Response(JSON.stringify({ access_token: "v3-tok", expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ "Response Code": "204 No response" }), { status: 200 });
    }) as typeof fetch;
    try {
      await client.sendMessage({ to: "dev-team", isDm: false, text: "hi" });
    } finally {
      globalThis.fetch = original;
    }
    // v3 channel post must NOT use the refresh-token grant even when one is configured.
    const oauth = seen.find((s) => s.url === "oauth");
    expect(oauth?.grantType).toBe("client_credentials");
    expect(oauth?.scope).toBe("ZohoCliq.Webhooks.CREATE");
  });
});

describe("CliqClient.sendMessage v3 bot DM post (apiVersion==='v3')", () => {
  it("POSTs to /api/v3/bots/{botId}/messages with user_ids + sync_message, Webhooks.CREATE scope (no refresh token)", async () => {
    setCliqClientRegistry(null);
    const { CliqClient } = await import("./client.js");
    const client = new CliqClient("id", "secret", "bot", undefined, undefined, undefined, undefined, undefined, "v3");
    const seen: { url: string; method?: string; body?: string; scope?: string | null }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/oauth/v2/token")) {
        const scope = new URL(urlStr).searchParams.get("scope");
        seen.push({ url: "oauth", scope });
        return new Response(JSON.stringify({ access_token: "v3-dm-tok", expires_in: 3600 }), { status: 200 });
      }
      seen.push({ url: urlStr, method: init?.method, body: init?.body as string });
      // v3 bot DM with sync_message:true returns { data: { message_id, chat_id } }.
      return new Response(
        JSON.stringify({ data: { message_id: "v3-dm-msg", chat_id: "CT_dm" } }),
        { status: 200 },
      );
    }) as typeof fetch;
    let result;
    try {
      result = await client.sendMessage({ to: "20098819618", isDm: true, text: "hi v3 dm" });
    } finally {
      globalThis.fetch = original;
    }
    // OAuth must use the Webhooks.CREATE scope (client_credentials) — NOT a refresh-token grant.
    const oauth = seen.find((s) => s.url === "oauth");
    expect(oauth?.scope).toBe("ZohoCliq.Webhooks.CREATE");
    // The send must hit the v3 bot-message endpoint (bot id in the path → posts AS the bot).
    const post = seen.find((s) => s.method === "POST" && s.url.includes("/bots/bot/messages"));
    expect(post).toBeDefined();
    expect(post!.url).toContain("/api/v3/bots/bot/messages");
    // The body is the v3 shape: { text, user_ids, sync_message: true } (NOT v2's `userids`).
    expect(JSON.parse(post!.body!)).toEqual({ text: "hi v3 dm", user_ids: "20098819618", sync_message: true });
    // The v3 sync_message response (wrapped under `data`) is parsed into a message ref.
    expect(result).toEqual({ messageId: "v3-dm-msg", chatId: "CT_dm" });
  });

  it("defaults to v2 bot DM when apiVersion is unset (v2 userids + /api/v2/bots/{botId}/message)", async () => {
    setCliqClientRegistry(null);
    const { CliqClient } = await import("./client.js");
    const client = new CliqClient("id", "secret", "bot");
    const seen: { url: string; method?: string; body?: string; scope?: string | null }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/oauth/v2/token")) {
        seen.push({ url: "oauth", scope: new URL(urlStr).searchParams.get("scope") });
        return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
      }
      seen.push({ url: urlStr, method: init?.method, body: init?.body as string });
      // v2 DM response: { message_details: { <userId>: { chat_id, message_id } } }.
      return new Response(
        JSON.stringify({ message_details: { "20098819618": { chat_id: "CT_dm", message_id: "v2-msg" } } }),
        { status: 200 },
      );
    }) as typeof fetch;
    let result;
    try {
      result = await client.sendMessage({ to: "20098819618", isDm: true, text: "hi" });
    } finally {
      globalThis.fetch = original;
    }
    const post = seen.find((s) => s.method === "POST" && s.url.includes("/bots/bot/message"));
    expect(post).toBeDefined();
    expect(post!.url).toContain("/api/v2/bots/bot/message");
    expect(JSON.parse(post!.body!)).toEqual({ text: "hi", userids: "20098819618" });
    expect(result).toEqual({ messageId: "v2-msg", chatId: "CT_dm" });
  });

  it("v3 bot DM still uses client_credentials Webhooks.CREATE even when a refresh token is configured", async () => {
    setCliqClientRegistry(null);
    const { CliqClient } = await import("./client.js");
    const client = new CliqClient("id", "secret", "bot", undefined, undefined, undefined, undefined, "rt-token", "v3");
    const seen: { url: string; scope?: string | null; grantType?: string | null }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: URL | string) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/oauth/v2/token")) {
        const u = new URL(urlStr);
        seen.push({ url: "oauth", scope: u.searchParams.get("scope"), grantType: u.searchParams.get("grant_type") });
        return new Response(JSON.stringify({ access_token: "v3-dm-tok", expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { message_id: "m", chat_id: "c" } }), { status: 200 });
    }) as typeof fetch;
    try {
      await client.sendMessage({ to: "u1", isDm: true, text: "hi" });
    } finally {
      globalThis.fetch = original;
    }
    // v3 DM must NOT use the refresh-token grant even when one is configured.
    const oauth = seen.find((s) => s.url === "oauth");
    expect(oauth?.grantType).toBe("client_credentials");
    expect(oauth?.scope).toBe("ZohoCliq.Webhooks.CREATE");
  });

  it("v3 bot DM tolerates a 204 No response (no message id) — live-edit degrades to block-streaming", async () => {
    setCliqClientRegistry(null);
    const { CliqClient } = await import("./client.js");
    const client = new CliqClient("id", "secret", "bot", undefined, undefined, undefined, undefined, undefined, "v3");
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: URL | string) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/oauth/v2/token")) {
        return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ "Response Code": "204 No response" }), { status: 200 });
    }) as typeof fetch;
    let result;
    try {
      result = await client.sendMessage({ to: "u1", isDm: true, text: "hi" });
    } finally {
      globalThis.fetch = original;
    }
    // No message id / chat id in a 204 response → undefined ref (no throw).
    expect(result).toEqual({});
  });
});

describe("CliqClient.deleteMessage v3 (apiVersion==='v3')", () => {
  it("DELETEs to /api/v3/chats/{chatId}/messagess?message_ids=<id> with the Messages.DELETE scope (refresh-token grant)", async () => {
    setCliqClientRegistry(null);
    const { CliqClient } = await import("./client.js");
    // v3 delete opts in via the 9th constructor param (apiVersion). A
    // refreshToken (8th param) is required because Messages.DELETE is a
    // user-context scope (same constraint as Messages.UPDATE — issue #27).
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
    const seen: { url: string; method?: string; grantType?: string | null; scope?: string | null }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/oauth/v2/token")) {
        const u = new URL(urlStr);
        seen.push({
          url: "oauth",
          grantType: u.searchParams.get("grant_type"),
          scope: u.searchParams.get("scope"),
        });
        return new Response(JSON.stringify({ access_token: "v3-del-tok", expires_in: 3600 }), { status: 200 });
      }
      seen.push({ url: urlStr, method: init?.method });
      // v3 delete-multiple 2xx response: per-message result list.
      return new Response(
        JSON.stringify({
          type: "message.delete_result",
          data: [{ id: "msg-1", status: "success" }],
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    let ok: boolean | undefined;
    try {
      ok = await client.deleteMessage({ chatId: "CT_chat", messageId: "msg-1" });
    } finally {
      globalThis.fetch = original;
    }
    expect(ok).toBe(true);
    // OAuth must use the refresh-token grant (NOT client_credentials) because
    // Messages.DELETE is a user-context scope.
    const oauth = seen.find((s) => s.url === "oauth");
    expect(oauth?.grantType).toBe("refresh_token");
    // No per-scope param on a refresh-token request (carries consented scopes).
    expect(oauth?.scope).toBeNull();
    // The delete must hit the v3 bulk-delete endpoint (path `messagess`, query
    // `message_ids=<id>`, no body).
    const del = seen.find((s) => s.method === "DELETE" && s.url.includes("/chats/"));
    expect(del).toBeDefined();
    expect(del!.url).toContain("/api/v3/chats/CT_chat/messagess");
    expect(del!.url).toContain("message_ids=msg-1");
  });

  it("returns false on a 2xx whose data[0].status === 'failed' (logical failure, no throw)", async () => {
    setCliqClientRegistry(null);
    const { CliqClient } = await import("./client.js");
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
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: URL | string) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/oauth/v2/token")) {
        return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
      }
      // 2xx but the per-message delete failed (e.g. access_denied).
      return new Response(
        JSON.stringify({
          type: "message.delete_result",
          data: [{ id: "msg-x", status: "failed", error: { code: "access_denied", message: "no perms" } }],
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    let ok: boolean | undefined;
    try {
      ok = await client.deleteMessage({ chatId: "CT_c", messageId: "msg-x" });
    } finally {
      globalThis.fetch = original;
    }
    expect(ok).toBe(false);
  });

  it("returns false on a 2xx with no/empty data array (defensive, no throw)", async () => {
    setCliqClientRegistry(null);
    const { CliqClient } = await import("./client.js");
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
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: URL | string) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/oauth/v2/token")) {
        return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ type: "message.delete_result", data: [] }), { status: 200 });
    }) as typeof fetch;
    let ok: boolean | undefined;
    try {
      ok = await client.deleteMessage({ chatId: "CT_c", messageId: "msg-y" });
    } finally {
      globalThis.fetch = original;
    }
    expect(ok).toBe(false);
  });

  it("defaults to v2 single-message delete when apiVersion is unset (Messages.UPDATE scope, refresh-token grant)", async () => {
    setCliqClientRegistry(null);
    const { CliqClient } = await import("./client.js");
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
    const seen: { url: string; method?: string; scope?: string | null; grantType?: string | null }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/oauth/v2/token")) {
        const u = new URL(urlStr);
        seen.push({ url: "oauth", scope: u.searchParams.get("scope"), grantType: u.searchParams.get("grant_type") });
        return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
      }
      seen.push({ url: urlStr, method: init?.method });
      // v2 single-message delete returns 204 No Content on success.
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    let ok: boolean | undefined;
    try {
      ok = await client.deleteMessage({ chatId: "CT_c", messageId: "m" });
    } finally {
      globalThis.fetch = original;
    }
    expect(ok).toBe(true);
    const oauth = seen.find((s) => s.url === "oauth");
    expect(oauth?.grantType).toBe("refresh_token");
    // The v2 delete path uses the refresh-token grant (which carries consented
    // scopes — no per-scope param), routing through Messages.UPDATE.
    expect(oauth?.scope).toBeNull();
    const del = seen.find((s) => s.method === "DELETE" && s.url.includes("/chats/"));
    expect(del).toBeDefined();
    expect(del!.url).toContain("/api/v2/chats/CT_c/messages/m");
  });

  it("throws on a fatal 4xx (no retry, no fallback) — matches v2 delete behavior", async () => {
    setCliqClientRegistry(null);
    const { CliqClient } = await import("./client.js");
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
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: URL | string) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/oauth/v2/token")) {
        return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
      }
      return new Response("chat_not_found", { status: 404 });
    }) as typeof fetch;
    try {
      await expect(
        client.deleteMessage({ chatId: "CT_missing", messageId: "m" }),
      ).rejects.toMatchObject({ kind: "fatal", status: 404 });
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("normalizeCliqRouteTarget (issue #11)", () => {
  it("routes cliq:user:<id> to a DM user target", () => {
    expect(normalizeCliqRouteTarget("cliq:user:20098819618")).toEqual({
      to: "20098819618",
      isDm: true,
    });
  });

  it("routes cliq:dm:<id> to a DM user target", () => {
    expect(normalizeCliqRouteTarget("cliq:dm:20098819618")).toEqual({
      to: "20098819618",
      isDm: true,
    });
  });

  it("routes cliq:chat:<id> to a group chat target", () => {
    expect(normalizeCliqRouteTarget("cliq:chat:CT_channel_chat")).toEqual({
      to: "CT_channel_chat",
      isDm: false,
    });
  });

  it("routes cliq:channel:<name> to a group chat target", () => {
    expect(normalizeCliqRouteTarget("cliq:channel:dev-team")).toEqual({
      to: "dev-team",
      isDm: false,
    });
  });

  it("defaults a bare id to group delivery (backward compat)", () => {
    expect(normalizeCliqRouteTarget("20098819618")).toEqual({
      to: "20098819618",
      isDm: false,
    });
  });

  it("handles empty input", () => {
    expect(normalizeCliqRouteTarget("")).toEqual({ to: "", isDm: false });
  });
});

describe("chunkMessage", () => {
  it("returns single chunk when under limit", () => {
    expect(chunkMessage("hello")).toEqual(["hello"]);
  });

  it("splits long text on newline boundaries", () => {
    const line = "x".repeat(80) + "\n";
    const text = line.repeat(100);
    const chunks = chunkMessage(text, 500);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });

  it("falls back to hard cut when no newline", () => {
    const text = "x".repeat(1200);
    const chunks = chunkMessage(text, 500);
    expect(chunks.length).toBe(3);
    expect(chunks.join("")).toBe(text);
  });
});

describe("outbound error classification + retry (Closes #15)", () => {
  function mockFetchSeq(statuses: number[], opts?: { bodies?: string[]; retryAfter?: string }) {
    const calls: { url: string; body: string }[] = [];
    const original = globalThis.fetch;
    const bodies = opts?.bodies ?? statuses.map(() => JSON.stringify({ id: "m-1" }));
    let i = 0;
    globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/oauth/v2/token")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      }
      const status = statuses[Math.min(i, statuses.length - 1)];
      const body = bodies[Math.min(i, bodies.length - 1)];
      calls.push({ url: urlStr, body: init?.body as string });
      i++;
      const headers: Record<string, string> = {};
      if (opts?.retryAfter) headers["retry-after"] = opts.retryAfter;
      return new Response(body, { status, headers });
    }) as typeof fetch;
    return {
      calls,
      restore: () => { globalThis.fetch = original; },
    };
  }

  it("retries transient (5xx) then succeeds on a follow-up 200", async () => {
    setCliqClientRegistry(null);
    const cfg = cfgWith({ clientId: "id", clientSecret: "secret", botId: "bot" });
    const mock = mockFetchSeq([500, 200]);
    try {
      // Patch the client factory to use a fast backoff for this test.
      const { setCliqClientRegistry, getCliqClientRegistry } = await import("./runtime-api.js");
      setCliqClientRegistry(null);
      // Inject a client with a tiny sleep so the test runs fast.
      const { CliqClient } = await import("./client.js");
      const fastClient = new CliqClient("id", "secret", "bot", undefined, undefined, {
        maxAttempts: 3,
        baseDelayMs: 1,
        maxDelayMs: 5,
        sleep: async () => {},
        random: () => 0.1,
      });
      // Reach into the registry cache and replace the client the outbound path resolves.
      const reg = getCliqClientRegistry();
      (reg as unknown as { clients: Map<string, unknown> }).clients.set("cc:id:bot", fastClient);
      await cliqPlugin.outbound!.sendText!({
        cfg,
        to: "cliq:user:user-1",
        text: "hello",
        accountId: undefined,
      } as any);
    } finally {
      mock.restore();
    }
    // Two send attempts: the 500 retry and the 200 success.
    const sendCalls = mock.calls.filter((c) => c.url.includes("/bots/bot/message"));
    expect(sendCalls).toHaveLength(2);
  });

  it("falls back rich→plain on a format_rejected 400", async () => {
    setCliqClientRegistry(null);
    const cfg = cfgWith({ clientId: "id", clientSecret: "secret", botId: "bot" });
    const calls: { text: string }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/oauth/v2/token")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      }
      if (init?.method === "POST") {
        const parsed = JSON.parse(init.body as string) as { text: string };
        // First send (rich, markdown-converted) is rejected as a format error.
        // Second send (plain raw text) succeeds.
        const isRich = parsed.text !== "raw **agent** text";
        calls.push({ text: parsed.text });
        if (isRich) {
          return new Response("invalid markdown format", { status: 400 });
        }
        return new Response(JSON.stringify({ id: "m-plain" }), { status: 200 });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;
    try {
      const result = await cliqPlugin.outbound!.sendText!({
        cfg,
        to: "user-1",
        text: "raw **agent** text",
        accountId: undefined,
      } as any);
      expect(result.messageId).toBe("m-plain");
    } finally {
      globalThis.fetch = original;
    }
    // Two sends: first rich (converted), second raw fallback.
    expect(calls).toHaveLength(2);
    expect(calls[0].text).not.toBe("raw **agent** text"); // rich (converted)
    expect(calls[1].text).toBe("raw **agent** text");       // plain fallback
  });

  it("surfaces fatal (404) without retry or fallback", async () => {
    setCliqClientRegistry(null);
    const cfg = cfgWith({ clientId: "id", clientSecret: "secret", botId: "bot" });
    let attempts = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/oauth/v2/token")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      }
      if (init?.method === "POST") {
        attempts++;
        return new Response("bot not found", { status: 404 });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;
    try {
      await expect(
        cliqPlugin.outbound!.sendText!({
          cfg,
          to: "user-1",
          text: "hello",
          accountId: undefined,
        } as any),
      ).rejects.toThrow(/fatal/);
    } finally {
      globalThis.fetch = original;
    }
    expect(attempts).toBe(1);
  });

  it("surfaces transient exhausts as CliqSendError(transient) without fallback", async () => {
    setCliqClientRegistry(null);
    const cfg = cfgWith({ clientId: "id", clientSecret: "secret", botId: "bot" });
    let attempts = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/oauth/v2/token")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      }
      if (init?.method === "POST") {
        attempts++;
        return new Response("boom", { status: 500 });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;
    try {
      await expect(
        cliqPlugin.outbound!.sendText!({
          cfg,
          to: "user-1",
          text: "hello",
          accountId: undefined,
        } as any),
      ).rejects.toThrow(/transient/);
    } finally {
      globalThis.fetch = original;
    }
    // Retried up to maxAttempts (default 3), no plain fallback.
    expect(attempts).toBe(3);
  });
});
