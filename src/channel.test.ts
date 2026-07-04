import { describe, it, expect } from "vitest";
import { cliqPlugin } from "./channel.js";
import { chunkMessage, resolveCliqConfig } from "./client.js";
import { setCliqClientRegistry } from "./runtime-api.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

function cfgWith(section: Record<string, unknown>): OpenClawConfig {
  return { channels: { cliq: section } } as unknown as OpenClawConfig;
}

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

  it("wires a pairing adapter with the cliq id label", () => {
    expect(cliqPlugin.pairing).toBeDefined();
    const pairing = cliqPlugin.pairing as { idLabel?: string };
    expect(pairing.idLabel).toBe("cliqSenderId");
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
    const calls: { text: string; userids?: string; chatid?: string }[] = [];
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
        calls.push(
          JSON.parse(init.body as string) as {
            text: string;
            userids?: string;
            chatid?: string;
          },
        );
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
    expect(calls).toHaveLength(1);
    // Markdown must be converted to Cliq-native formatting before sending.
    expect(calls[0].text).toBe("*bold* and _italic_");
    // Outbound context lacks chatType, so the client defaults to `chatid`.
    expect(calls[0].chatid ?? calls[0].userids).toBe("user-1");
  });

  it("uploads an http media attachment via multipart to the bot API", async () => {
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
        to: "user-1",
        text: "**see this**",
        mediaUrl: "https://example.com/media/file.png",
        accountId: undefined,
      } as any);
      expect(result.messageId).toBe("msg-media-1");
    } finally {
      globalThis.fetch = original;
    }
    // The bot API call must be multipart/form-data with the file attached.
    const post = seen.find((s) => s.url.includes("/bots/bot/message"));
    expect(post).toBeDefined();
    const form = post!.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("chatid")).toBe("user-1");
    expect(form.get("text")).toBe("*see this*");
    const file = form.get("attachments") as File;
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe("file.png");
    expect(file.type).toBe("image/png");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(mediaBytes);
    // Authorization must be the OAuth token; body is a FormData (multipart) instance.
    expect(post!.headers["authorization"]).toBe("Zoho-oauthtoken tok");
    expect(form).toBeInstanceOf(FormData);
  });

  it("reads a local media file via mediaReadFile and uploads it", async () => {
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
        to: "channel-1",
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
    expect(form.get("chatid")).toBe("channel-1");
    expect(form.get("text")).toBe("doc");
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
