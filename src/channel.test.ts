import { describe, it, expect } from "vitest";
import { cliqPlugin } from "./channel.js";
import { chunkMessage, resolveCliqConfig } from "./client.js";
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

  it("advertises direct + group chat types and reply capability", () => {
    expect(cliqPlugin.capabilities.chatTypes).toEqual(["direct", "group"]);
    expect(cliqPlugin.capabilities.reply).toBe(true);
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
