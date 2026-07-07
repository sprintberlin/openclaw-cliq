import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import {
  runCliqStartupMaintenance,
  onCliqAccountConfigChanged,
  onCliqAccountRemoved,
  cliqLifecycleAdapter,
} from "./lifecycle.js";
import {
  CliqClientRegistry,
  setCliqClientRegistry,
  type CliqAccountIdentity,
} from "./runtime-api.js";
import type { ResolvedCliqAccount } from "./client.js";
import { createCliqTestConfig as cfgWith } from "./test-api.js";

function multiCfg(
  top: Record<string, unknown>,
  accounts: Record<string, Record<string, unknown>>,
): OpenClawConfig {
  return {
    channels: { cliq: { ...top, accounts } },
  } as unknown as OpenClawConfig;
}

function captureLog() {
  const info: string[] = [];
  const warn: string[] = [];
  return {
    info,
    warn,
    log: {
      info: (m: string) => void info.push(m),
      warn: (m: string) => void warn.push(m),
    },
  };
}

function account(overrides: Partial<ResolvedCliqAccount> = {}): ResolvedCliqAccount {
  return {
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
    ...overrides,
  };
}

/**
 * Install a fetch mock that responds to the OAuth token endpoint and tracks
 * the scopes requested. Returns a restore function and a call log.
 */
function installFetch(opts: {
  tokenStatus?: number;
  tokenBody?: unknown;
} = {}): {
  restore: () => void;
  oauthScopes: string[];
} {
  const original = globalThis.fetch;
  const oauthScopes: string[] = [];
  globalThis.fetch = (async (url: URL | string) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("/oauth/v2/token")) {
      const u = new URL(urlStr);
      const scope = u.searchParams.get("scope") ?? "";
      oauthScopes.push(scope);
      const status = opts.tokenStatus ?? 200;
      const body = opts.tokenBody ?? { access_token: "tok", expires_in: 3600 };
      return new Response(JSON.stringify(body), { status });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    get oauthScopes() {
      return oauthScopes;
    },
  };
}

describe("runCliqStartupMaintenance", () => {
  beforeEach(() => setCliqClientRegistry(new CliqClientRegistry()));
  afterEach(() => setCliqClientRegistry(null));

  it("logs a not-configured message when the channel is absent", async () => {
    const log = captureLog();
    const fetch = installFetch();
    try {
      await runCliqStartupMaintenance({ cfg: {} as OpenClawConfig, log: log.log });
      expect(log.info.some((m) => m.includes("no accounts configured"))).toBe(true);
      expect(log.warn).toEqual([]);
      expect(fetch.oauthScopes).toEqual([]);
    } finally {
      fetch.restore();
    }
  });

  it("warns when the webhook secret is missing on a configured account", async () => {
    const log = captureLog();
    const fetch = installFetch();
    try {
      await runCliqStartupMaintenance({
        cfg: cfgWith({ clientId: "id", clientSecret: "s", botId: "b" }),
        log: log.log,
      });
      expect(log.warn.some((m) => m.includes("no webhook secret"))).toBe(true);
      expect(log.info.some((m) => m.includes("/cliq/webhook"))).toBe(true);
      expect(fetch.oauthScopes).toEqual(["ZohoCliq.Webhooks.CREATE"]);
    } finally {
      fetch.restore();
    }
  });

  it("pre-warms the OAuth token and does not warn when the secret is set", async () => {
    const log = captureLog();
    const fetch = installFetch();
    try {
      await runCliqStartupMaintenance({
        cfg: cfgWith({
          clientId: "id",
          clientSecret: "s",
          botId: "b",
          webhookSecret: "wh",
        }),
        log: log.log,
      });
      expect(log.info.some((m) => m.includes("pre-warmed"))).toBe(true);
      expect(log.warn).toEqual([]);
      expect(fetch.oauthScopes).toEqual(["ZohoCliq.Webhooks.CREATE"]);
    } finally {
      fetch.restore();
    }
  });

  it("swallows OAuth pre-warm failures into a warn (never throws)", async () => {
    const log = captureLog();
    const fetch = installFetch({ tokenStatus: 401 });
    try {
      await runCliqStartupMaintenance({
        cfg: cfgWith({
          clientId: "id",
          clientSecret: "s",
          botId: "b",
          webhookSecret: "wh",
        }),
        log: log.log,
      });
      expect(log.warn.some((m) => m.includes("OAuth pre-warm failed"))).toBe(true);
    } finally {
      fetch.restore();
    }
  });

  it("warns per-account when required credentials are missing", async () => {
    const log = captureLog();
    const fetch = installFetch();
    try {
      await runCliqStartupMaintenance({
        cfg: multiCfg(
          { clientId: "shared" },
          {
            botA: { clientSecret: "sa", botId: "botA" },
            botB: { clientId: "b" },
          },
        ),
        log: log.log,
      });
      expect(log.warn.some((m) => m.includes('"botB"') && m.includes("missing required credentials"))).toBe(true);
      expect(log.info.some((m) => m.includes('"botA"') && m.includes("pre-warmed"))).toBe(true);
    } finally {
      fetch.restore();
    }
  });

  it("uses the logPrefix when provided", async () => {
    const log = captureLog();
    const fetch = installFetch();
    try {
      await runCliqStartupMaintenance({
        cfg: {} as OpenClawConfig,
        log: log.log,
        logPrefix: "  [cliq]  ",
      });
      expect(log.info.some((m) => m.startsWith("[cliq]:"))).toBe(true);
    } finally {
      fetch.restore();
    }
  });
});

describe("onCliqAccountConfigChanged / onCliqAccountRemoved", () => {
  let registry: CliqClientRegistry;
  beforeEach(() => {
    registry = new CliqClientRegistry();
    setCliqClientRegistry(registry);
  });
  afterEach(() => setCliqClientRegistry(null));

  it("evicts the cached client for the single-account identity on a clientSecret rotation", () => {
    const prev = cfgWith({ clientId: "id", clientSecret: "s", botId: "bot" });
    const next = cfgWith({ clientId: "id", clientSecret: "s2", botId: "bot" });
    const prevAccount = account({ clientId: "id", clientSecret: "s", botId: "bot" });
    const nextAccount = account({ clientId: "id", clientSecret: "s2", botId: "bot" });
    // Both identities share the cache key `cc:id:bot`; the cached client was
    // constructed with the OLD clientSecret and would keep using it without
    // eviction. Pre-populate, then evict, then assert the slot is gone so
    // the next getOrCreate(nextAccount) builds a fresh client.
    registry.getOrCreate(prevAccount);
    expect(registry.get(prevAccount)).toBeDefined();
    onCliqAccountConfigChanged({ prevCfg: prev, nextCfg: next, accountId: "default" });
    expect(registry.get(prevAccount)).toBeUndefined();
    expect(registry.get(nextAccount)).toBeUndefined();
  });

  it("evicts the acct:<id> slot plus the cc: identity for a named account", () => {
    const prev = multiCfg(
      { clientId: "shared", clientSecret: "shared", botId: "sharedBot" },
      { botA: { clientId: "a", clientSecret: "sa", botId: "botA" } },
    );
    const next = multiCfg(
      { clientId: "shared", clientSecret: "shared", botId: "sharedBot" },
      { botA: { clientId: "a", clientSecret: "sa2", botId: "botA" } },
    );
    const identity: CliqAccountIdentity = {
      accountId: "botA",
      clientId: "a",
      botId: "botA",
    };
    const namedAccount = account({
      accountId: "botA",
      clientId: "a",
      clientSecret: "sa",
      botId: "botA",
    });
    registry.getOrCreate(namedAccount);
    expect(registry.get(identity)).toBeDefined();
    onCliqAccountConfigChanged({ prevCfg: prev, nextCfg: next, accountId: "botA" });
    expect(registry.get(identity)).toBeUndefined();
  });

  it("onCliqAccountRemoved evicts the previous identity", () => {
    const prev = cfgWith({ clientId: "id", clientSecret: "s", botId: "bot" });
    const prevAccount = account({ clientId: "id", clientSecret: "s", botId: "bot" });
    registry.getOrCreate(prevAccount);
    expect(registry.get(prevAccount)).toBeDefined();
    onCliqAccountRemoved({ prevCfg: prev, accountId: "default" });
    expect(registry.get(prevAccount)).toBeUndefined();
  });

  it("does not throw when the account is absent from prevCfg", () => {
    expect(() =>
      onCliqAccountRemoved({ prevCfg: {} as OpenClawConfig, accountId: "ghost" }),
    ).not.toThrow();
  });
});

describe("cliqLifecycleAdapter wiring", () => {
  it("exposes runStartupMaintenance, onAccountConfigChanged, onAccountRemoved, detectLegacyStateMigrations", () => {
    expect(typeof cliqLifecycleAdapter.runStartupMaintenance).toBe("function");
    expect(typeof cliqLifecycleAdapter.onAccountConfigChanged).toBe("function");
    expect(typeof cliqLifecycleAdapter.onAccountRemoved).toBe("function");
    expect(typeof cliqLifecycleAdapter.detectLegacyStateMigrations).toBe("function");
  });
});
