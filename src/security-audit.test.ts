import { describe, it, expect } from "vitest";
import {
  collectCliqSecurityAuditFindings,
  cliqSecurityAuditCollector,
} from "./security-audit.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { createCliqTestConfig as cfgWith } from "./test-api.js";
import { cliqPlugin } from "./channel.js";

const REFINED = {
  clientId: "id",
  clientSecret: "secret",
  botId: "bot",
  webhookSecret: "s3cr3t",
  dmPolicy: "allowlist",
  allowFrom: ["user@example.com"],
} as const;

describe("collectCliqSecurityAuditFindings — absent channel", () => {
  it("returns no findings when there is no channels.cliq section", () => {
    expect(
      collectCliqSecurityAuditFindings({ cfg: {} as unknown as OpenClawConfig }),
    ).toEqual([]);
    expect(
      collectCliqSecurityAuditFindings({
        cfg: { channels: {} } as unknown as OpenClawConfig,
      }),
    ).toEqual([]);
    expect(
      collectCliqSecurityAuditFindings({
        cfg: { channels: { cliq: "nope" } } as unknown as OpenClawConfig,
      }),
    ).toEqual([]);
  });
});

describe("collectCliqSecurityAuditFindings — clean config", () => {
  it("emits no findings for a locked-down config with ref-backed secrets", () => {
    const cfg = cfgWith({
      ...REFINED,
      clientSecret: { source: "env", provider: "default", id: "CLIQ_CLIENT_SECRET" },
      webhookSecret: { source: "env", provider: "default", id: "CLIQ_WEBHOOK_SECRET" },
    });
    expect(collectCliqSecurityAuditFindings({ cfg })).toEqual([]);
  });

  it("does not flag plaintext when secrets use $NAME shorthand", () => {
    const cfg = cfgWith({
      ...REFINED,
      clientSecret: "$CLIQ_CLIENT_SECRET",
      webhookSecret: "${CLIQ_WEBHOOK_SECRET}",
    });
    const findings = collectCliqSecurityAuditFindings({ cfg });
    expect(findings.some((f) => f.checkId === "channels.cliq.secrets.plaintext")).toBe(false);
  });
});

describe("channels.cliq.webhook_secret.missing", () => {
  it("flags a missing webhook secret as critical", () => {
    const cfg = cfgWith({
      clientId: "id",
      clientSecret: { source: "env", provider: "default", id: "CLIQ_CLIENT_SECRET" },
      botId: "bot",
      dmPolicy: "allowlist",
      allowFrom: ["user@example.com"],
    });
    const findings = collectCliqSecurityAuditFindings({ cfg });
    const finding = findings.find(
      (f) => f.checkId === "channels.cliq.webhook_secret.missing",
    );
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("critical");
    expect(finding!.title).toMatch(/webhook secret is not configured/i);
    expect(finding!.remediation).toMatch(/openclaw secrets apply/);
  });

  it("does not flag a configured (literal) webhook secret", () => {
    const cfg = cfgWith({ ...REFINED });
    const findings = collectCliqSecurityAuditFindings({ cfg });
    expect(
      findings.some((f) => f.checkId === "channels.cliq.webhook_secret.missing"),
    ).toBe(false);
  });

  it("does not flag a ref-backed webhook secret", () => {
    const cfg = cfgWith({
      ...REFINED,
      webhookSecret: { source: "file", provider: "mounted", id: "/cliq/webhook" },
    });
    const findings = collectCliqSecurityAuditFindings({ cfg });
    expect(
      findings.some((f) => f.checkId === "channels.cliq.webhook_secret.missing"),
    ).toBe(false);
  });

  it("flags an empty-string webhook secret as missing", () => {
    const cfg = cfgWith({ ...REFINED, webhookSecret: "   " });
    const findings = collectCliqSecurityAuditFindings({ cfg });
    expect(
      findings.some((f) => f.checkId === "channels.cliq.webhook_secret.missing"),
    ).toBe(true);
  });
});

describe("channels.cliq.allow_from.wildcard", () => {
  it("flags a wildcard allowFrom as critical under any dmPolicy", () => {
    const cfg = cfgWith({ ...REFINED, dmPolicy: "allowlist", allowFrom: ["*"] });
    const findings = collectCliqSecurityAuditFindings({ cfg });
    const finding = findings.find(
      (f) => f.checkId === "channels.cliq.allow_from.wildcard",
    );
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("critical");
  });

  it("flags a wildcard even under open dmPolicy (stacks with the open finding)", () => {
    const cfg = cfgWith({ ...REFINED, dmPolicy: "open", allowFrom: ["*"] });
    const findings = collectCliqSecurityAuditFindings({ cfg });
    expect(
      findings.some((f) => f.checkId === "channels.cliq.allow_from.wildcard"),
    ).toBe(true);
    expect(
      findings.some((f) => f.checkId === "channels.cliq.dm_policy.open"),
    ).toBe(true);
  });

  it("does not flag a concrete allowlist", () => {
    const cfg = cfgWith({ ...REFINED, allowFrom: ["u1", "u2"] });
    const findings = collectCliqSecurityAuditFindings({ cfg });
    expect(
      findings.some((f) => f.checkId === "channels.cliq.allow_from.wildcard"),
    ).toBe(false);
  });

  it("trims entries before matching the wildcard", () => {
    const cfg = cfgWith({ ...REFINED, allowFrom: ["  *  "] });
    const findings = collectCliqSecurityAuditFindings({ cfg });
    expect(
      findings.some((f) => f.checkId === "channels.cliq.allow_from.wildcard"),
    ).toBe(true);
  });
});

describe("channels.cliq.dm_policy.open", () => {
  it("flags dmPolicy open as warn", () => {
    const cfg = cfgWith({ ...REFINED, dmPolicy: "open", allowFrom: ["user@example.com"] });
    const findings = collectCliqSecurityAuditFindings({ cfg });
    const finding = findings.find(
      (f) => f.checkId === "channels.cliq.dm_policy.open",
    );
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warn");
  });

  it("does not flag the default (allowlist) dmPolicy", () => {
    const cfg = cfgWith({ ...REFINED });
    const findings = collectCliqSecurityAuditFindings({ cfg });
    expect(
      findings.some((f) => f.checkId === "channels.cliq.dm_policy.open"),
    ).toBe(false);
  });

  it("does not flag an unset dmPolicy (defaults to allowlist)", () => {
    const cfg = cfgWith({
      clientId: "id",
      clientSecret: { source: "env", provider: "default", id: "CLIQ_CLIENT_SECRET" },
      botId: "bot",
      webhookSecret: "s",
      allowFrom: ["u1"],
    });
    const findings = collectCliqSecurityAuditFindings({ cfg });
    expect(
      findings.some((f) => f.checkId === "channels.cliq.dm_policy.open"),
    ).toBe(false);
  });
});

describe("channels.cliq.secrets.plaintext", () => {
  it("flags a plaintext clientSecret", () => {
    const cfg = cfgWith({
      ...REFINED,
      clientSecret: "literal-secret",
      webhookSecret: { source: "env", provider: "default", id: "CLIQ_WEBHOOK_SECRET" },
    });
    const findings = collectCliqSecurityAuditFindings({ cfg });
    const finding = findings.find(
      (f) => f.checkId === "channels.cliq.secrets.plaintext",
    );
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warn");
    expect(finding!.detail).toContain("clientSecret");
    expect(finding!.remediation).toMatch(/openclaw secrets apply/);
  });

  it("lists every plaintext secret in one finding", () => {
    const cfg = cfgWith({
      ...REFINED,
      clientSecret: "lit-client",
      webhookSecret: "lit-webhook",
      refreshToken: "lit-refresh",
    });
    const findings = collectCliqSecurityAuditFindings({ cfg });
    const finding = findings.find(
      (f) => f.checkId === "channels.cliq.secrets.plaintext",
    );
    expect(finding).toBeDefined();
    expect(finding!.detail).toContain("clientSecret");
    expect(finding!.detail).toContain("webhookSecret");
    expect(finding!.detail).toContain("refreshToken");
  });

  it("does not flag ref-backed secrets", () => {
    const cfg = cfgWith({
      ...REFINED,
      clientSecret: { source: "env", provider: "default", id: "CLIQ_CLIENT_SECRET" },
      webhookSecret: { source: "file", provider: "mounted", id: "/cliq/webhook" },
      refreshToken: { source: "exec", provider: "vault", id: "cliq/refresh" },
    });
    const findings = collectCliqSecurityAuditFindings({ cfg });
    expect(
      findings.some((f) => f.checkId === "channels.cliq.secrets.plaintext"),
    ).toBe(false);
  });

  it("does not flag $NAME / ${NAME} env-shorthand secrets", () => {
    const cfg = cfgWith({
      ...REFINED,
      clientSecret: "$CLIQ_CLIENT_SECRET",
      webhookSecret: "${CLIQ_WEBHOOK_SECRET}",
    });
    const findings = collectCliqSecurityAuditFindings({ cfg });
    expect(
      findings.some((f) => f.checkId === "channels.cliq.secrets.plaintext"),
    ).toBe(false);
  });
});

describe("stacked findings", () => {
  it("emits the full set for a wide-open config", () => {
    const cfg = cfgWith({
      clientId: "id",
      clientSecret: "lit",
      botId: "bot",
      dmPolicy: "open",
      allowFrom: ["*"],
      // webhookSecret intentionally absent
    });
    const findings = collectCliqSecurityAuditFindings({ cfg });
    const ids = findings.map((f) => f.checkId).sort();
    expect(ids).toEqual(
      [
        "channels.cliq.allow_from.wildcard",
        "channels.cliq.dm_policy.open",
        "channels.cliq.secrets.plaintext",
        "channels.cliq.session_scope.shared",
        "channels.cliq.webhook_secret.missing",
      ].sort(),
    );
  });
});

describe("cliqSecurityAuditCollector (SDK adapter)", () => {
  it("adapts the SDK context shape and forwards findings", () => {
    const cfg = cfgWith({
      clientId: "id",
      clientSecret: "lit",
      botId: "bot",
      dmPolicy: "open",
      allowFrom: ["*"],
    });
    const findings = cliqSecurityAuditCollector({
      config: cfg,
      sourceConfig: cfg,
      env: process.env,
      stateDir: "/tmp/state",
      configPath: "/tmp/openclaw.json",
    });
    expect(findings.length).toBeGreaterThan(0);
    expect(
      findings.some((f) => f.checkId === "channels.cliq.allow_from.wildcard"),
    ).toBe(true);
  });

  it("returns [] for an absent channel section", () => {
    expect(
      cliqSecurityAuditCollector({
        config: {} as unknown as OpenClawConfig,
        sourceConfig: {} as unknown as OpenClawConfig,
        env: process.env,
        stateDir: "/tmp/state",
        configPath: "/tmp/openclaw.json",
      }),
    ).toEqual([]);
  });

  it("never throws on a malformed section — degrades to []", () => {
    // A section whose allowFrom is a non-array, non-string garbage value
    // must not crash the collector (the SDK aborts the whole sweep on a
    // thrown collector).
    const cfg = cfgWith({
      clientId: "id",
      clientSecret: 12345,
      botId: "bot",
      allowFrom: "not-an-array",
      dmPolicy: { weird: true },
    });
    expect(() => cliqSecurityAuditCollector({ config: cfg })).not.toThrow();
  });
});

describe("channel security adapter delivery (issue #111)", () => {
  it("exposes collectAuditFindings on the channel security adapter", () => {
    expect(typeof cliqPlugin.security?.collectAuditFindings).toBe("function");
  });

  it("returns the plaintext-secret finding through the channel adapter", async () => {
    const cfg = cfgWith({
      clientId: "id",
      clientSecret: "literal-client-secret",
      botId: "bot",
      webhookSecret: "literal-webhook-secret",
      refreshToken: "literal-refresh-token",
      dmPolicy: "allowlist",
      allowFrom: ["user@example.com"],
    });
    const collect = cliqPlugin.security?.collectAuditFindings as (
      ctx: unknown,
    ) => Promise<Array<{ checkId: string }>> | Array<{ checkId: string }>;
    const findings = await collect({
      cfg,
      sourceConfig: cfg,
      accountId: null,
      account: {},
      orderedAccountIds: ["default"],
      hasExplicitAccountPath: false,
    });
    expect(findings.map((f) => f.checkId)).toContain(
      "channels.cliq.secrets.plaintext",
    );
  });

  it("returns no findings through the adapter for an unconfigured channel", async () => {
    const collect = cliqPlugin.security?.collectAuditFindings as (
      ctx: unknown,
    ) => Promise<Array<{ checkId: string }>> | Array<{ checkId: string }>;
    const findings = await collect({
      cfg: {} as unknown as OpenClawConfig,
      sourceConfig: {} as unknown as OpenClawConfig,
      accountId: null,
      account: {},
      orderedAccountIds: ["default"],
      hasExplicitAccountPath: false,
    });
    expect(findings).toEqual([]);
  });
});

describe("channels.cliq.session_scope.shared (issue #104)", () => {
  it("flags the runtime default main scope when session is absent and DMs are open", () => {
    const cfg = cfgWith({ ...REFINED, dmPolicy: "open", allowFrom: ["*"] });
    const finding = collectCliqSecurityAuditFindings({ cfg }).find(
      (entry) => entry.checkId === "channels.cliq.session_scope.shared",
    );
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("critical");
    expect(finding!.detail).toMatch(/session\.dmScope.*main/i);
    expect(finding!.detail).toMatch(/conversation|context/i);
    expect(finding!.remediation).toContain("per-channel-peer");
  });

  it.each([
    ["pairing policy", { dmPolicy: "pairing", allowFrom: [] }],
    ["wildcard allowlist", { dmPolicy: "allowlist", allowFrom: ["*"] }],
    ["multiple allowlisted senders", { dmPolicy: "allowlist", allowFrom: ["u1", "u2"] }],
  ])("flags main scope for %s", (_label, section) => {
    const cfg = cfgWith({ ...REFINED, ...section });
    expect(
      collectCliqSecurityAuditFindings({ cfg }).some(
        (entry) => entry.checkId === "channels.cliq.session_scope.shared",
      ),
    ).toBe(true);
  });

  it.each([
    ["one allowlisted sender", { dmPolicy: "allowlist", allowFrom: ["u1"] }, undefined],
    ["disabled DMs", { dmPolicy: "disabled", allowFrom: ["u1", "u2"] }, undefined],
    ["per-channel-peer", { dmPolicy: "open", allowFrom: ["*"] }, "per-channel-peer"],
    ["per-account-channel-peer", { dmPolicy: "open", allowFrom: ["*"] }, "per-account-channel-peer"],
  ])("does not flag %s", (_label, section, dmScope) => {
    const cfg = cfgWith({ ...REFINED, ...section });
    if (dmScope) (cfg as any).session = { dmScope };
    expect(
      collectCliqSecurityAuditFindings({ cfg }).some(
        (entry) => entry.checkId === "channels.cliq.session_scope.shared",
      ),
    ).toBe(false);
  });
});
