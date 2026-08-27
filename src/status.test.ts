import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  cliqStatusAdapter,
  probeCliqStatus,
  resolveCliqStatusAccount,
} from "./status.js";
import { resolveCliqConfig, type ResolvedCliqAccount } from "./client.js";
import { setCliqClientRegistry } from "./runtime-api.js";
import { inspectCliqAccount } from "./account-inspect.js";
import { createCliqTestConfig as cfgWith } from "./test-api.js";

const CONFIGURED = cfgWith({
  clientId: "id",
  clientSecret: "secret",
  botId: "bot",
  botName: "MyBot",
  allowFrom: ["alice@example.com"],
});

function configuredAccount(): ResolvedCliqAccount {
  return resolveCliqConfig(CONFIGURED);
}

function installFetch(opts: {
  tokenStatus?: number;
  tokenBody?: unknown;
  delayMs?: number;
} = {}): { restore: () => void; oauthCalls: number } {
  const original = globalThis.fetch;
  let oauthCalls = 0;
  globalThis.fetch = (async (url: URL | string) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("/oauth/v2/token")) {
      oauthCalls++;
      if (opts.delayMs) {
        await new Promise((r) => setTimeout(r, opts.delayMs));
      }
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
    get oauthCalls() {
      return oauthCalls;
    },
  };
}

describe("probeCliqStatus", () => {
  beforeEach(() => setCliqClientRegistry(null));
  afterEach(() => setCliqClientRegistry(null));

  it("resolves ok when OAuth token fetch succeeds", async () => {
    const fetch = installFetch();
    try {
      const probe = await probeCliqStatus(configuredAccount(), 2000);
      expect(probe.ok).toBe(true);
      expect(probe.reason).toBe("ok");
      expect(probe.probedAt).toBeGreaterThan(0);
      expect(fetch.oauthCalls).toBe(1);
    } finally {
      fetch.restore();
    }
  });

  it("reports not ok when OAuth fails with a reason", async () => {
    const fetch = installFetch({
      tokenStatus: 401,
      tokenBody: { error: "invalid_client" },
    });
    try {
      const probe = await probeCliqStatus(configuredAccount(), 2000);
      expect(probe.ok).toBe(false);
      expect(probe.reason).toMatch(/401/);
    } finally {
      fetch.restore();
    }
  });

  it("returns a timeout probe when OAuth does not resolve in time", async () => {
    const fetch = installFetch({ delayMs: 200 });
    try {
      const probe = await probeCliqStatus(configuredAccount(), 30);
      expect(probe.ok).toBe(false);
      expect(probe.reason).toMatch(/timeout/i);
    } finally {
      fetch.restore();
    }
  });

  it("clamps an oversized timeout to the default cap", async () => {
    // A huge timeoutMs is clamped internally; just verify it does not throw
    // and still produces a successful probe against a fast fetch.
    const fetch = installFetch();
    try {
      const probe = await probeCliqStatus(configuredAccount(), 60_000);
      expect(probe.ok).toBe(true);
    } finally {
      fetch.restore();
    }
  });
});

describe("cliqStatusAdapter", () => {
  beforeEach(() => setCliqClientRegistry(null));
  afterEach(() => setCliqClientRegistry(null));

  it("exposes a stopped webhook-mode default runtime snapshot", () => {
    const runtime = cliqStatusAdapter.defaultRuntime;
    expect(runtime).toBeDefined();
    expect(runtime?.accountId).toBe("default");
    expect(runtime?.running).toBe(false);
    expect(runtime?.mode).toBe("webhook");
    expect(runtime?.webhookPath).toBe("/cliq/webhook");
  });

  it("probeAccount resolves ok for a configured account", async () => {
    const fetch = installFetch();
    try {
      const probe = await cliqStatusAdapter.probeAccount!({
        account: configuredAccount(),
        timeoutMs: 2000,
        cfg: CONFIGURED,
      });
      expect(probe.ok).toBe(true);
    } finally {
      fetch.restore();
    }
  });

  it("buildAccountSnapshot reports configured + botName + probe", () => {
    const account = configuredAccount();
    const snapshot = cliqStatusAdapter.buildAccountSnapshot!({
      account,
      cfg: CONFIGURED,
      probe: { ok: true, reason: "ok", probedAt: 123 },
    }) as Record<string, unknown>;
    expect(snapshot.accountId).toBe("default");
    expect(snapshot.configured).toBe(true);
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.name).toBe("MyBot");
    expect(snapshot.botId).toBe("bot");
    expect(snapshot.mode).toBe("webhook");
    expect(snapshot.webhookPath).toBe("/cliq/webhook");
    expect(snapshot.probe).toEqual({ ok: true, reason: "ok", probedAt: 123 });
  });

  it("buildAccountSnapshot carries healthy running webhook lifecycle state", () => {
    const snapshot = cliqStatusAdapter.buildAccountSnapshot!({
      account: configuredAccount(),
      cfg: CONFIGURED,
      runtime: {
        accountId: "default",
        running: true,
        lastStartAt: 100,
        lastStopAt: null,
        lastError: null,
      },
      probe: { ok: true, reason: "ok", probedAt: 123 },
    }) as Record<string, unknown>;
    expect(snapshot).toMatchObject({
      configured: true,
      enabled: true,
      running: true,
      mode: "webhook",
      webhookPath: "/cliq/webhook",
      lastStartAt: 100,
      lastError: null,
    });
  });

  it("buildAccountSnapshot carries degraded lifecycle and probe state", () => {
    const snapshot = cliqStatusAdapter.buildAccountSnapshot!({
      account: configuredAccount(),
      cfg: CONFIGURED,
      runtime: {
        accountId: "default",
        running: false,
        lastStartAt: 100,
        lastStopAt: 200,
        lastError: "transport stopped",
      },
      probe: { ok: false, reason: "401 invalid_client", probedAt: 210 },
    }) as Record<string, unknown>;
    expect(snapshot).toMatchObject({
      configured: true,
      enabled: true,
      running: false,
      mode: "webhook",
      lastStopAt: 200,
      lastError: "transport stopped",
      probe: { ok: false, reason: "401 invalid_client", probedAt: 210 },
    });
  });

  it("buildAccountSnapshot accepts the redacted inspectAccount shape used by gateway health", () => {
    const inspected = inspectCliqAccount({ cfg: CONFIGURED, accountId: "default" });
    const snapshot = cliqStatusAdapter.buildAccountSnapshot!({
      account: inspected as never,
      cfg: CONFIGURED,
      probe: { ok: true, reason: "ok", probedAt: 123 },
    }) as Record<string, unknown>;
    expect(snapshot.accountId).toBe("default");
    expect(snapshot.configured).toBe(true);
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.name).toBe("MyBot");
    expect(snapshot.botId).toBe("bot");
  });

  it("agrees with inspectAccount so Channels and Health never disagree for the same account", () => {
    const inspected = inspectCliqAccount({ cfg: CONFIGURED, accountId: "default" });
    const fromInspected = cliqStatusAdapter.buildAccountSnapshot!({
      account: inspected as never,
      cfg: CONFIGURED,
      runtime: {
        accountId: "default",
        running: true,
        lastStartAt: 1,
        lastStopAt: null,
        lastError: null,
      },
      probe: { ok: true, reason: "ok", probedAt: 123 },
    }) as Record<string, unknown>;
    const fromResolved = cliqStatusAdapter.buildAccountSnapshot!({
      account: configuredAccount(),
      cfg: CONFIGURED,
      runtime: {
        accountId: "default",
        running: true,
        lastStartAt: 1,
        lastStopAt: null,
        lastError: null,
      },
      probe: { ok: true, reason: "ok", probedAt: 123 },
    }) as Record<string, unknown>;
    expect(fromInspected.configured).toBe(true);
    expect(fromResolved.configured).toBe(true);
    expect(fromInspected.enabled).toBe(fromResolved.enabled);
    expect(fromInspected.running).toBe(true);
    expect(fromResolved.running).toBe(true);
    expect(fromInspected.mode).toBe("webhook");
    expect(fromResolved.mode).toBe("webhook");
  });

  it("does not treat a successful probe as proof the account is configured", () => {
    const snapshot = cliqStatusAdapter.buildAccountSnapshot!({
      account: {
        accountId: null,
        clientId: "",
        clientSecret: "",
        botId: "",
        allowFrom: [],
        dmPolicy: undefined,
        ackPolicy: "after_dispatch" as const,
        selfSenderIds: [],
        blockStreaming: false,
        thinking: { mode: "off" as const, text: "thinking" },
        welcome: { enabled: false, text: "", textRejoin: "" },
        pairing: {
          notifyOwnerTarget: null,
          approveLabel: "Approve",
          denyLabel: "Deny",
          approvalTitle: "Pairing request",
          approvedOwnerText: "Approved.",
          deniedOwnerText: "Denied.",
        },
      },
      cfg: {} as never,
      probe: { ok: true, reason: "ok", probedAt: 1 },
    }) as Record<string, unknown>;
    expect(snapshot.configured).toBe(false);
    expect(snapshot.probe).toEqual({ ok: true, reason: "ok", probedAt: 1 });
  });

  it("buildAccountSnapshot reports disabled when the account section is absent", () => {
    const partial = {
      accountId: null,
      clientId: "",
      clientSecret: "",
      botId: "",
      allowFrom: [],
      dmPolicy: undefined,
      ackPolicy: "after_dispatch" as const,
      selfSenderIds: [],
      blockStreaming: false,
      thinking: { mode: "off" as const, text: "💭 …" },
      welcome: { enabled: false, text: "", textRejoin: "" },
      pairing: { notifyOwnerTarget: null, approveLabel: "Approve", denyLabel: "Deny", approvalTitle: "Pairing request", approvedOwnerText: "Approved.", deniedOwnerText: "Denied." },
    };
    const snapshot = cliqStatusAdapter.buildAccountSnapshot!({
      account: partial,
      cfg: {} as never,
    }) as Record<string, unknown>;
    expect(snapshot.configured).toBe(false);
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.running).toBe(false);
    expect(snapshot.mode).toBe("webhook");
  });

  it("buildAccountSnapshot reports unconfigured for a partial account", () => {
    const account = {
      accountId: null,
      clientId: "id",
      clientSecret: "",
      botId: "",
      allowFrom: [],
      dmPolicy: undefined,
      ackPolicy: "after_dispatch" as const,
      selfSenderIds: [],
      blockStreaming: false,
      thinking: { mode: "off" as const, text: "💭 …" },
      welcome: { enabled: false, text: "", textRejoin: "" },
    pairing: { notifyOwnerTarget: null, approveLabel: "Approve", denyLabel: "Deny", approvalTitle: "🔐 Pairing request", approvedOwnerText: "✅ Approved.", deniedOwnerText: "🚫 Denied." },
    };
    const snapshot = cliqStatusAdapter.buildAccountSnapshot!({
      account,
      cfg: cfgWith({ clientId: "id" }),
    }) as Record<string, unknown>;
    expect(snapshot.configured).toBe(false);
    expect(snapshot.enabled).toBe(false);
  });

  it("buildChannelSummary surfaces probe + botId", () => {
    const summary = cliqStatusAdapter.buildChannelSummary!({
      snapshot: {
        accountId: "default",
        configured: true,
        botId: "bot",
        probe: { ok: false, reason: "401", probedAt: 9 },
      } as never,
      account: configuredAccount(),
      cfg: CONFIGURED,
      defaultAccountId: "default",
    });
    expect(summary).toMatchObject({
      configured: true,
      mode: "webhook",
      webhookPath: "/cliq/webhook",
      botId: "bot",
      probeOk: false,
      probeReason: "401",
      probedAt: 9,
    });
  });

  it("collectStatusIssues emits a config issue for an unconfigured account", () => {
    const issues = cliqStatusAdapter.collectStatusIssues!([
      {
        accountId: "default",
        configured: false,
        enabled: false,
      },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe("config");
    expect(issues[0]?.channel).toBe("cliq");
    expect(issues[0]?.message).toMatch(/not fully configured/);
  });

  it("collectStatusIssues emits an auth issue when the probe failed", () => {
    const issues = cliqStatusAdapter.collectStatusIssues!([
      {
        accountId: "default",
        configured: true,
        enabled: true,
        probe: { ok: false, reason: "401 invalid_client", probedAt: 1 },
      },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe("auth");
    expect(issues[0]?.message).toMatch(/401 invalid_client/);
  });

  it("collectStatusIssues emits nothing for a healthy account", () => {
    const issues = cliqStatusAdapter.collectStatusIssues!([
      {
        accountId: "default",
        configured: true,
        enabled: true,
        probe: { ok: true, reason: "ok", probedAt: 1 },
      },
    ]);
    expect(issues).toHaveLength(0);
  });

  it("collectStatusIssues does not double-count an unconfigured+failed account", () => {
    const issues = cliqStatusAdapter.collectStatusIssues!([
      {
        accountId: "default",
        configured: false,
        enabled: false,
        probe: { ok: false, reason: "x", probedAt: 1 },
      },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe("config");
  });

  it("resolveAccountState maps configured→configured", () => {
    expect(
      cliqStatusAdapter.resolveAccountState!({
        account: configuredAccount(),
        cfg: CONFIGURED,
        configured: true,
        enabled: true,
      }),
    ).toBe("configured");
    expect(
      cliqStatusAdapter.resolveAccountState!({
        account: configuredAccount(),
        cfg: CONFIGURED,
        configured: false,
        enabled: false,
      }),
    ).toBe("not configured");
  });
});

describe("resolveCliqStatusAccount", () => {
  it("returns the account when configured", () => {
    expect(resolveCliqStatusAccount(CONFIGURED)?.botId).toBe("bot");
  });

  it("returns null when unconfigured instead of throwing", () => {
    expect(resolveCliqStatusAccount(cfgWith({}))).toBeNull();
  });
});
