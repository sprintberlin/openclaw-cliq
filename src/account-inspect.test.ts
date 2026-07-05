import { describe, it, expect } from "vitest";
import {
  inspectCliqAccount,
  CLIQ_OAUTH_SCOPES,
  CLIQ_API_BASE,
  CLIQ_OAUTH_BASE,
  type InspectedCliqAccount,
} from "./account-inspect.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

function cfgWith(section: Record<string, unknown>): OpenClawConfig {
  return { channels: { cliq: section } } as unknown as OpenClawConfig;
}

describe("inspectCliqAccount", () => {
  it("reports a fully configured account", () => {
    const cfg = cfgWith({
      clientId: "id",
      clientSecret: "secret",
      botId: "bot",
      botName: "MyBot",
      webhookSecret: "wh",
      allowFrom: ["user1", "user2"],
      dmPolicy: "pairing",
      selfSenderIds: ["bot-zuid-1"],
      ackPolicy: "immediate",
    });
    const r = inspectCliqAccount({ cfg }) as InspectedCliqAccount;
    expect(r.configured).toBe(true);
    expect(r.enabled).toBe(true);
    expect(r.name).toBe("MyBot");
    expect(r.botId).toBe("bot");
    expect(r.tokenStatus).toBe("available");
    expect(r.tokenSource).toBe("config");
    expect(r.accountId).toBe("default");
    expect(r.scopes).toEqual(CLIQ_OAUTH_SCOPES);
    expect(r.apiBase).toBe(CLIQ_API_BASE);
    expect(r.oauthBase).toBe(CLIQ_OAUTH_BASE);
    expect(r.config.clientId).toBe("id");
    expect(r.config.botId).toBe("bot");
    expect(r.config.botName).toBe("MyBot");
    // secrets are presence-only — never the value
    expect(r.config.webhookSecret).toBe(true);
    expect(r.config.allowFrom).toEqual(["user1", "user2"]);
    expect(r.config.dmPolicy).toBe("pairing");
    expect(r.config.selfSenderIds).toEqual(["bot-zuid-1"]);
    expect(r.config.ackPolicy).toBe("immediate");
  });

  it("reports missing config without throwing", () => {
    const r = inspectCliqAccount({ cfg: cfgWith({}) }) as InspectedCliqAccount;
    expect(r.configured).toBe(false);
    expect(r.tokenStatus).toBe("missing");
    expect(r.tokenSource).toBe("none");
    expect(r.botId).toBeUndefined();
    expect(r.name).toBeUndefined();
    expect(r.config.webhookSecret).toBe(false);
    expect(r.config.allowFrom).toEqual([]);
    expect(r.config.selfSenderIds).toEqual([]);
    // ackPolicy always has a default
    expect(r.config.ackPolicy).toBe("after_dispatch");
    expect(r.scopes.length).toBeGreaterThan(0);
  });

  it("reports partially configured account with per-field presence", () => {
    const r = inspectCliqAccount({
      cfg: cfgWith({ clientId: "id", botId: "bot" }),
    }) as InspectedCliqAccount;
    // missing clientSecret → not configured
    expect(r.configured).toBe(false);
    expect(r.tokenStatus).toBe("missing");
    expect(r.config.clientId).toBe("id");
    expect(r.config.botId).toBe("bot");
  });

  it("normalizes a null/undefined accountId to 'default'", () => {
    const cfg = cfgWith({ clientId: "id", clientSecret: "s", botId: "b" });
    expect(inspectCliqAccount({ cfg, accountId: undefined }).accountId).toBe("default");
    expect(inspectCliqAccount({ cfg, accountId: null }).accountId).toBe("default");
    expect(inspectCliqAccount({ cfg, accountId: "acct-7" }).accountId).toBe("acct-7");
  });

  it("never exposes the clientSecret value", () => {
    const cfg = cfgWith({
      clientId: "id",
      clientSecret: "super-secret-value",
      botId: "bot",
    });
    const r = inspectCliqAccount({ cfg }) as InspectedCliqAccount;
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain("super-secret-value");
  });

  it("never exposes the webhookSecret value", () => {
    const cfg = cfgWith({
      clientId: "id",
      clientSecret: "s",
      botId: "b",
      webhookSecret: "top-secret-wh",
    });
    const r = inspectCliqAccount({ cfg }) as InspectedCliqAccount;
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain("top-secret-wh");
    expect(r.config.webhookSecret).toBe(true);
  });

  it("defaults ackPolicy to after_dispatch when unset", () => {
    const cfg = cfgWith({
      clientId: "id",
      clientSecret: "s",
      botId: "b",
    });
    expect(inspectCliqAccount({ cfg }).config.ackPolicy).toBe("after_dispatch");
  });

  it("exposes the EU endpoints and OAuth scopes", () => {
    const r = inspectCliqAccount({ cfg: cfgWith({}) });
    expect(r.apiBase).toBe("https://cliq.zoho.eu");
    expect(r.oauthBase).toBe("https://accounts.zoho.eu");
    expect(r.scopes).toContain("ZohoCliq.Webhooks.CREATE");
    expect(r.scopes).toContain("ZohoCliq.Channels.READ");
    expect(r.scopes).toContain("ZohoCliq.Users.READ");
  });

  it("treats a missing channels.cliq section as unconfigured", () => {
    const r = inspectCliqAccount({ cfg: {} as OpenClawConfig });
    expect(r.configured).toBe(false);
    expect(r.enabled).toBe(false);
    expect(r.tokenStatus).toBe("missing");
  });
});
