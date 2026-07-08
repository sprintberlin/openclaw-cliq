import { describe, it, expect, beforeEach } from "vitest";
import {
  cliqPlugin,
  resolveCliqConfig,
  readEffectiveCliqSection,
  CLIQ_DEFAULT_ACCOUNT_ID,
  resolveCliqApiVersion,
} from "./channel.js";
import { inspectCliqAccount } from "./account-inspect.js";
import {
  CliqClientRegistry,
  resolveCliqClient,
  setCliqClientRegistry,
} from "./runtime-api.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

/**
 * Multi-account config shape:
 *   channels:
 *     cliq:                       # top-level defaults (shared)
 *       webhookSecret: wh-shared
 *       dmPolicy: allowlist
 *       accounts:
 *         alpha:                  # per-account override
 *           clientId: id-alpha
 *           clientSecret: sec-alpha
 *           botId: bot-alpha
 *           botName: AlphaBot
 *           allowFrom: [user-a1]
 *         beta:                   # per-account override
 *           clientId: id-beta
 *           clientSecret: sec-beta
 *           botId: bot-beta
 *           botName: BetaBot
 *           allowFrom: [user-b1, user-b2]
 */
function multiAccountCfg(): OpenClawConfig {
  return {
    channels: {
      cliq: {
        webhookSecret: "wh-shared",
        dmPolicy: "allowlist",
        accounts: {
          alpha: {
            clientId: "id-alpha",
            clientSecret: "sec-alpha",
            botId: "bot-alpha",
            botName: "AlphaBot",
            allowFrom: ["user-a1"],
          },
          beta: {
            clientId: "id-beta",
            clientSecret: "sec-beta",
            botId: "bot-beta",
            botName: "BetaBot",
            allowFrom: ["user-b1", "user-b2"],
          },
        },
      },
    },
  } as unknown as OpenClawConfig;
}

describe("readEffectiveCliqSection — multi-account overlay", () => {
  it("returns the top-level section for the default / null accountId", () => {
    const cfg = multiAccountCfg();
    const r = readEffectiveCliqSection(cfg);
    expect(r.isPerAccount).toBe(false);
    expect(r.accountId).toBeNull();
    // The merged section is the top-level (no account override applied).
    expect((r.section as Record<string, unknown>).webhookSecret).toBe(
      "wh-shared",
    );
  });

  it("treats 'default' the same as null (single-account convention)", () => {
    const cfg = multiAccountCfg();
    const r = readEffectiveCliqSection(cfg, CLIQ_DEFAULT_ACCOUNT_ID);
    expect(r.isPerAccount).toBe(false);
    expect(r.accountId).toBeNull();
  });

  it("overlays the per-account section on top of the top-level defaults", () => {
    const cfg = multiAccountCfg();
    const r = readEffectiveCliqSection(cfg, "alpha");
    expect(r.isPerAccount).toBe(true);
    expect(r.accountId).toBe("alpha");
    // Per-account override wins for credentials / botId.
    expect(r.section?.clientId).toBe("id-alpha");
    expect(r.section?.botId).toBe("bot-alpha");
    expect(r.section?.botName).toBe("AlphaBot");
    // Top-level defaults are inherited.
    expect((r.section as Record<string, unknown>).webhookSecret).toBe(
      "wh-shared",
    );
    expect(r.section?.dmPolicy).toBe("allowlist");
  });

  it("replaces (not concatenates) allowFrom from the per-account override", () => {
    const cfg = multiAccountCfg();
    const r = readEffectiveCliqSection(cfg, "beta");
    expect(r.section?.allowFrom).toEqual(["user-b1", "user-b2"]);
  });

  it("falls back to top-level when accountId has no matching accounts entry", () => {
    const cfg = multiAccountCfg();
    const r = readEffectiveCliqSection(cfg, "ghost");
    expect(r.isPerAccount).toBe(false);
    // No override applied; the top-level section has no clientId of its own.
    expect(r.section?.clientId).toBeUndefined();
  });

  it("returns undefined section when channels.cliq is absent", () => {
    const cfg = {} as OpenClawConfig;
    expect(readEffectiveCliqSection(cfg).section).toBeUndefined();
    expect(readEffectiveCliqSection(cfg, "alpha").section).toBeUndefined();
  });
});

describe("resolveCliqConfig — per-account resolution", () => {
  it("resolves each account to its own credentials + botId", () => {
    const cfg = multiAccountCfg();
    const alpha = resolveCliqConfig(cfg, "alpha");
    const beta = resolveCliqConfig(cfg, "beta");
    expect(alpha.clientId).toBe("id-alpha");
    expect(alpha.botId).toBe("bot-alpha");
    expect(alpha.botName).toBe("AlphaBot");
    expect(alpha.accountId).toBe("alpha");
    expect(beta.clientId).toBe("id-beta");
    expect(beta.botId).toBe("bot-beta");
    expect(beta.botName).toBe("BetaBot");
    expect(beta.accountId).toBe("beta");
  });

  it("inherits shared top-level config (webhookSecret, dmPolicy) into each account", () => {
    const cfg = multiAccountCfg();
    const alpha = resolveCliqConfig(cfg, "alpha");
    expect(alpha.webhookSecret).toBe("wh-shared");
    expect(alpha.dmPolicy).toBe("allowlist");
  });

  it("preserves per-account allowFrom (not the top-level one)", () => {
    const cfg = multiAccountCfg();
    expect(resolveCliqConfig(cfg, "alpha").allowFrom).toEqual(["user-a1"]);
    expect(resolveCliqConfig(cfg, "beta").allowFrom).toEqual([
      "user-b1",
      "user-b2",
    ]);
  });

  it("resolves the default account from top-level credentials (single-account backward compat)", () => {
    const cfg = {
      channels: {
        cliq: {
          clientId: "id",
          clientSecret: "secret",
          botId: "bot",
          allowFrom: ["u1"],
        },
      },
    } as unknown as OpenClawConfig;
    const account = resolveCliqConfig(cfg);
    expect(account.clientId).toBe("id");
    expect(account.botId).toBe("bot");
    expect(account.accountId).toBeNull();
    expect(account.allowFrom).toEqual(["u1"]);
  });

  it("defaults dmPost to v3 (and the other families to v2) when apiVersion is unset (single-account)", () => {
    const cfg = {
      channels: {
        cliq: { clientId: "id", clientSecret: "secret", botId: "bot" },
      },
    } as unknown as OpenClawConfig;
    const resolved = resolveCliqConfig(cfg);
    // Unset → raw config is undefined; per-family defaults apply.
    expect(resolved.apiVersion).toBeUndefined();
    expect(resolveCliqApiVersion(resolved.apiVersion, "dmPost")).toBe("v3");
    expect(resolveCliqApiVersion(resolved.apiVersion, "channelPost")).toBe("v2");
    expect(resolveCliqApiVersion(resolved.apiVersion, "channelCard")).toBe("v2");
    expect(resolveCliqApiVersion(resolved.apiVersion, "delete")).toBe("v2");
  });

  it("reads a top-level apiVersion=v3 string as a global override (all migratable families → v3)", () => {
    const cfg = {
      channels: {
        cliq: {
          clientId: "id", clientSecret: "secret", botId: "bot",
          apiVersion: "v3",
        },
      },
    } as unknown as OpenClawConfig;
    const resolved = resolveCliqConfig(cfg);
    expect(resolved.apiVersion).toBe("v3");
    expect(resolveCliqApiVersion(resolved.apiVersion, "dmPost")).toBe("v3");
    expect(resolveCliqApiVersion(resolved.apiVersion, "channelPost")).toBe("v3");
    expect(resolveCliqApiVersion(resolved.apiVersion, "channelCard")).toBe("v3");
    expect(resolveCliqApiVersion(resolved.apiVersion, "delete")).toBe("v3");
  });

  it("reads a per-family apiVersion object (one family pilots v3, others keep defaults)", () => {
    const cfg = {
      channels: {
        cliq: {
          clientId: "id", clientSecret: "secret", botId: "bot",
          apiVersion: { channelPost: "v3" },
        },
      },
    } as unknown as OpenClawConfig;
    const resolved = resolveCliqConfig(cfg);
    expect(resolveCliqApiVersion(resolved.apiVersion, "dmPost")).toBe("v3");
    expect(resolveCliqApiVersion(resolved.apiVersion, "channelPost")).toBe("v3");
    expect(resolveCliqApiVersion(resolved.apiVersion, "channelCard")).toBe("v2");
    expect(resolveCliqApiVersion(resolved.apiVersion, "delete")).toBe("v2");
  });

  it("applies a per-account apiVersion override (one account pilots v3, another stays default)", () => {
    const cfg = {
      channels: {
        cliq: {
          webhookSecret: "wh",
          accounts: {
            alpha: { clientId: "id-a", clientSecret: "s", botId: "bot-a", apiVersion: "v3" },
            beta: { clientId: "id-b", clientSecret: "s", botId: "bot-b" },
          },
        },
      },
    } as unknown as OpenClawConfig;
    const alpha = resolveCliqConfig(cfg, "alpha");
    const beta = resolveCliqConfig(cfg, "beta");
    // alpha: global v3 override → all migratable families v3.
    expect(resolveCliqApiVersion(alpha.apiVersion, "dmPost")).toBe("v3");
    expect(resolveCliqApiVersion(alpha.apiVersion, "channelPost")).toBe("v3");
    // beta: unset → defaults (dmPost v3, others v2).
    expect(resolveCliqApiVersion(beta.apiVersion, "dmPost")).toBe("v3");
    expect(resolveCliqApiVersion(beta.apiVersion, "channelPost")).toBe("v2");
  });

  it("rejects an unknown apiVersion string value (falls back to defaults)", () => {
    const cfg = {
      channels: {
        cliq: {
          clientId: "id", clientSecret: "secret", botId: "bot",
          apiVersion: "v4" as unknown as string,
        },
      },
    } as unknown as OpenClawConfig;
    const resolved = resolveCliqConfig(cfg);
    // Unknown string → normalized to undefined → defaults apply.
    expect(resolved.apiVersion).toBeUndefined();
    expect(resolveCliqApiVersion(resolved.apiVersion, "dmPost")).toBe("v3");
    expect(resolveCliqApiVersion(resolved.apiVersion, "channelPost")).toBe("v2");
  });

  it("throws on a per-account section missing required credentials", () => {
    const cfg = {
      channels: {
        cliq: {
          accounts: {
            partial: { clientId: "only-id" }, // missing clientSecret + botId
          },
        },
      },
    } as unknown as OpenClawConfig;
    expect(() => resolveCliqConfig(cfg, "partial")).toThrow(/clientSecret/);
  });
});

describe("CliqClientRegistry — per-account token cache isolation", () => {
  let registry: CliqClientRegistry;

  beforeEach(() => {
    registry = new CliqClientRegistry();
    setCliqClientRegistry(registry);
  });

  it("caches a distinct CliqClient per account (no token leakage between accounts)", () => {
    const cfg = multiAccountCfg();
    const alpha = resolveCliqConfig(cfg, "alpha");
    const beta = resolveCliqConfig(cfg, "beta");
    const alphaClient = resolveCliqClient(alpha);
    const betaClient = resolveCliqClient(beta);
    expect(alphaClient).not.toBe(betaClient);
    // Both clients coexist in the registry cache.
    expect(registry.size).toBe(2);
    // Re-resolving returns the same cached instances.
    expect(resolveCliqClient(alpha)).toBe(alphaClient);
    expect(resolveCliqClient(beta)).toBe(betaClient);
  });

  it("mints separate OAuth tokens per account (no shared token between bots)", async () => {
    const cfg = multiAccountCfg();
    const tokensRequested: { clientId: string; scope: string }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: URL | string) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/oauth/v2/token")) {
        const u = new URL(urlStr);
        const clientId = u.searchParams.get("client_id") ?? "";
        const scope = u.searchParams.get("scope") ?? "";
        tokensRequested.push({ clientId, scope });
        return new Response(
          JSON.stringify({
            access_token: `tok-${clientId}`,
            expires_in: 3600,
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ id: "m" }), { status: 200 });
    }) as typeof fetch;
    try {
      await cliqPlugin.outbound!.sendText!({
        cfg,
        to: "cliq:user:u1",
        text: "hi",
        accountId: "alpha",
      } as any);
      await cliqPlugin.outbound!.sendText!({
        cfg,
        to: "cliq:user:u2",
        text: "hi",
        accountId: "beta",
      } as any);
    } finally {
      globalThis.fetch = original;
    }
    // Each account minted its own OAuth token (one per clientId).
    const clientIds = tokensRequested.map((t) => t.clientId).sort();
    expect(clientIds).toEqual(["id-alpha", "id-beta"]);
  });
});

describe("inspectCliqAccount — per-account inspect", () => {
  it("inspects each account's own botId + credentials", () => {
    const cfg = multiAccountCfg();
    const alpha = inspectCliqAccount({ cfg, accountId: "alpha" });
    const beta = inspectCliqAccount({ cfg, accountId: "beta" });
    expect(alpha.configured).toBe(true);
    expect(alpha.botId).toBe("bot-alpha");
    expect(alpha.name).toBe("AlphaBot");
    expect(alpha.accountId).toBe("alpha");
    expect(beta.configured).toBe(true);
    expect(beta.botId).toBe("bot-beta");
    expect(beta.name).toBe("BetaBot");
    expect(beta.accountId).toBe("beta");
  });

  it("reports a per-account section with missing credentials as unconfigured", () => {
    const cfg = {
      channels: {
        cliq: {
          accounts: {
            partial: { clientId: "only-id" },
          },
        },
      },
    } as unknown as OpenClawConfig;
    const r = inspectCliqAccount({ cfg, accountId: "partial" });
    expect(r.configured).toBe(false);
    expect(r.tokenStatus).toBe("missing");
  });
});

describe("applyAccountConfig — per-account writes", () => {
  it("writes the default account to the top-level section", () => {
    const cfg = { channels: { cliq: {} } } as unknown as OpenClawConfig;
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
    expect(section.botId).toBe("bot");
    expect(section.accounts).toBeUndefined();
  });

  it("writes a non-default account into channels.cliq.accounts.<id>", () => {
    const cfg = { channels: { cliq: {} } } as unknown as OpenClawConfig;
    const next = cliqPlugin.setup!.applyAccountConfig({
      cfg,
      accountId: "gamma",
      input: {
        clientId: "cid-g",
        clientSecret: "sec-g",
        botId: "bot-g",
        botName: "GammaBot",
      },
    } as any);
    const section = (next as any).channels.cliq;
    // The top-level section is untouched.
    expect(section.clientId).toBeUndefined();
    expect(section.accounts.gamma).toBeDefined();
    expect(section.accounts.gamma.clientId).toBe("cid-g");
    expect(section.accounts.gamma.botId).toBe("bot-g");
    expect(section.accounts.gamma.botName).toBe("GammaBot");
  });

  it("round-trips: applyAccountConfig then resolveCliqConfig reads the per-account credentials", () => {
    const cfg = { channels: { cliq: {} } } as unknown as OpenClawConfig;
    const next = cliqPlugin.setup!.applyAccountConfig({
      cfg,
      accountId: "delta",
      input: {
        clientId: "cid-d",
        clientSecret: "sec-d",
        botId: "bot-d",
      },
    } as any);
    const resolved = resolveCliqConfig(next as OpenClawConfig, "delta");
    expect(resolved.clientId).toBe("cid-d");
    expect(resolved.botId).toBe("bot-d");
    expect(resolved.accountId).toBe("delta");
  });
});

describe("config.listAccountIds — multi-account discovery", () => {
  it("lists the per-account ids from channels.cliq.accounts", () => {
    const cfg = multiAccountCfg();
    expect(
      cliqPlugin.config.listAccountIds(cfg).sort(),
    ).toEqual(["alpha", "beta"]);
  });

  it("returns no account ids for the single-account (top-level) convention", () => {
    const cfg = {
      channels: {
        cliq: { clientId: "id", clientSecret: "s", botId: "b" },
      },
    } as unknown as OpenClawConfig;
    expect(cliqPlugin.config.listAccountIds(cfg)).toEqual([]);
  });
});

describe("directory adapter — per-account self identity", () => {
  beforeEach(() => {
    setCliqClientRegistry(null);
  });

  it("resolves the bot self entry from the per-account botId", async () => {
    const cfg = multiAccountCfg();
    const alphaSelf = await (cliqPlugin.directory as any).self({
      cfg,
      accountId: "alpha",
    });
    expect(alphaSelf?.id).toBe("bot-alpha");
    expect(alphaSelf?.name).toBe("AlphaBot");
    const betaSelf = await (cliqPlugin.directory as any).self({
      cfg,
      accountId: "beta",
    });
    expect(betaSelf?.id).toBe("bot-beta");
    expect(betaSelf?.name).toBe("BetaBot");
  });
});
