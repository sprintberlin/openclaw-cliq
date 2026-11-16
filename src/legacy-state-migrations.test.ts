import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import {
  cliqLegacyConfigRules,
  normalizeCliqCompatibilityConfig,
  repairCliqConfig,
  detectCliqLegacyStateMigrations,
} from "./legacy-state-migrations.js";

function cfgWith(section: Record<string, unknown>): OpenClawConfig {
  return { channels: { cliq: section } } as unknown as OpenClawConfig;
}

/**
 * Minimal re-implementation of the SDK's `findLegacyConfigIssues` walker
 * (legacy-config-issues-CPAE70WU.js): for each rule, resolve `rule.path`
 * against the config and emit `{ path, message }` when the value is defined
 * and the optional `match` predicate passes. Inlined here so the test does
 * not import an internal SDK module.
 */
function findLegacyConfigIssues(
  root: Record<string, unknown>,
  rules: Array<{ path: string[]; message: string; match?: (value: unknown, root: Record<string, unknown>) => boolean }>,
): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  for (const rule of rules) {
    let cursor: unknown = root;
    for (const key of rule.path) {
      if (!cursor || typeof cursor !== "object") {
        cursor = undefined;
        break;
      }
      cursor = (cursor as Record<string, unknown>)[key];
    }
    if (cursor !== undefined && (!rule.match || rule.match(cursor, root))) {
      issues.push({ path: rule.path.join("."), message: rule.message });
    }
  }
  return issues;
}

const DOCTOR_FIX = "openclaw doctor --fix";

describe("cliqLegacyConfigRules", () => {
  it("declares a rule for every snake_case alias", () => {
    const paths = cliqLegacyConfigRules.map((r) => r.path.join("."));
    expect(paths).toEqual(
      expect.arrayContaining([
        "channels.cliq.client_id",
        "channels.cliq.client_secret",
        "channels.cliq.bot_id",
        "channels.cliq.bot_name",
        "channels.cliq.webhook_secret",
        "channels.cliq.refresh_token",
        "channels.cliq.allow_from",
        "channels.cliq.self_sender_ids",
        "channels.cliq.dm_policy",
        "channels.cliq.ack_policy",
      ]),
    );
    for (const rule of cliqLegacyConfigRules) {
      expect(typeof rule.message).toBe("string");
      expect(rule.message.length).toBeGreaterThan(0);
    }
  });

  it("never rewrites an existing open policy or infers trustedOrganization", () => {
    const cfg = cfgWith({
      clientId: "id",
      clientSecret: "sec",
      botId: "bot",
      dmPolicy: "open",
      allowFrom: ["*"],
    });
    const repaired = repairCliqConfig({
      cfg,
      doctorFixCommand: DOCTOR_FIX,
    });
    expect(repaired.changes).toHaveLength(0);
    const section = (
      repaired.config as unknown as { channels: { cliq: Record<string, unknown> } }
    ).channels.cliq;
    expect(section.dmPolicy).toBe("open");
    expect(section.allowFrom).toEqual(["*"]);
    expect(section.trustedOrganization).toBeUndefined();
  });

  it("fires a warning for each present snake_case key (via findLegacyConfigIssues)", () => {
    const cfg = cfgWith({
      client_id: "id",
      client_secret: "sec",
      bot_id: "bot",
      webhook_secret: "wh",
    });
    const issues = findLegacyConfigIssues(
      cfg as unknown as Record<string, unknown>,
      cliqLegacyConfigRules,
    );
    const paths = issues.map((i) => i.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "channels.cliq.client_id",
        "channels.cliq.client_secret",
        "channels.cliq.bot_id",
        "channels.cliq.webhook_secret",
      ]),
    );
    expect(issues.every((i) => i.message.includes("openclaw doctor --fix"))).toBe(true);
  });

  it("does not fire when no snake_case or legacy streaming keys are present", () => {
    const cfg = cfgWith({
      clientId: "id",
      clientSecret: "s",
      botId: "b",
      streaming: { mode: "partial" },
    });
    const issues = findLegacyConfigIssues(
      cfg as unknown as Record<string, unknown>,
      cliqLegacyConfigRules,
    );
    expect(issues).toEqual([]);
  });

  it("fires for root and per-account legacy streaming.preview keys", () => {
    const cfg = cfgWith({
      streaming: { preview: "on" },
      accounts: { franzi: { streaming: { preview: "off" } } },
    });
    const issues = findLegacyConfigIssues(
      cfg as unknown as Record<string, unknown>,
      cliqLegacyConfigRules,
    );
    expect(issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        "channels.cliq.streaming.preview",
        "channels.cliq.accounts",
      ]),
    );
    expect(issues.every((issue) => issue.message.includes("openclaw doctor --fix"))).toBe(true);
  });
});

describe("normalizeCliqCompatibilityConfig", () => {
  it("is a no-op when there is no channels.cliq section", () => {
    const cfg = {} as unknown as OpenClawConfig;
    const result = normalizeCliqCompatibilityConfig({ cfg });
    expect(result.changes).toEqual([]);
    expect(result.config).toBe(cfg);
  });

  it("is a no-op when the section has only camelCase keys", () => {
    const cfg = cfgWith({ clientId: "id", clientSecret: "s", botId: "b" });
    const result = normalizeCliqCompatibilityConfig({ cfg });
    expect(result.changes).toEqual([]);
    expect(result.config).toBe(cfg);
  });

  it("moves a snake_case key to camelCase when the canonical is absent", () => {
    const cfg = cfgWith({ client_id: "id", bot_id: "bot" });
    const result = normalizeCliqCompatibilityConfig({ cfg });
    expect(result.changes).toEqual(
      expect.arrayContaining([
        "Moved channels.cliq.client_id → channels.cliq.clientId.",
        "Moved channels.cliq.bot_id → channels.cliq.botId.",
      ]),
    );
    const section = (result.config as unknown as { channels: { cliq: Record<string, unknown> } })
      .channels.cliq;
    expect(section.clientId).toBe("id");
    expect(section.botId).toBe("bot");
    expect(section.client_id).toBeUndefined();
    expect(section.bot_id).toBeUndefined();
  });

  it("keeps the canonical key and drops the snake_case copy on conflict", () => {
    const cfg = cfgWith({
      client_id: "stale",
      clientId: "canonical",
    });
    const result = normalizeCliqCompatibilityConfig({ cfg });
    expect(result.changes).toEqual([
      "Removed channels.cliq.client_id (channels.cliq.clientId already set).",
    ]);
    const section = (result.config as unknown as { channels: { cliq: Record<string, unknown> } })
      .channels.cliq;
    expect(section.clientId).toBe("canonical");
    expect(section.client_id).toBeUndefined();
  });

  it("migrates every snake_case alias in one pass", () => {
    const cfg = cfgWith({
      client_id: "id",
      client_secret: "sec",
      bot_id: "bot",
      bot_name: "Bot",
      webhook_secret: "wh",
      refresh_token: "rt",
      allow_from: ["u1"],
      own_sender_ids: ["b-this"],
      self_sender_ids: ["s1"],
      dm_policy: "open",
      ack_policy: "immediate",
    });
    const result = normalizeCliqCompatibilityConfig({ cfg });
    expect(result.changes).toHaveLength(11);
    const section = (result.config as unknown as { channels: { cliq: Record<string, unknown> } })
      .channels.cliq;
    expect(section).toEqual({
      clientId: "id",
      clientSecret: "sec",
      botId: "bot",
      botName: "Bot",
      webhookSecret: "wh",
      refreshToken: "rt",
      allowFrom: ["u1"],
      ownSenderIds: ["b-this"],
      selfSenderIds: ["s1"],
      dmPolicy: "open",
      ackPolicy: "immediate",
    });
  });

  it("migrates root and per-account streaming.preview idempotently", () => {
    const cfg = cfgWith({
      streaming: { preview: "on", minEditIntervalMs: 2500 },
      accounts: {
        franzi: { streaming: { preview: "off" } },
        mara: { streaming: { preview: "off", mode: "progress" } },
      },
    });
    const first = normalizeCliqCompatibilityConfig({ cfg });
    const section = (first.config as unknown as {
      channels: {
        cliq: {
          streaming: Record<string, unknown>;
          accounts: Record<string, { streaming: Record<string, unknown> }>;
        };
      };
    }).channels.cliq;
    expect(section.streaming).toEqual({ mode: "partial", minEditIntervalMs: 2500 });
    expect(section.accounts.franzi.streaming).toEqual({ mode: "off" });
    expect(section.accounts.mara.streaming).toEqual({ mode: "progress" });
    expect(first.changes).toEqual([
      "Moved channels.cliq.streaming.preview → channels.cliq.streaming.mode (partial).",
      "Moved channels.cliq.accounts.franzi.streaming.preview → channels.cliq.accounts.franzi.streaming.mode (off).",
      "Removed channels.cliq.accounts.mara.streaming.preview (channels.cliq.accounts.mara.streaming.mode already set).",
    ]);
    const second = normalizeCliqCompatibilityConfig({ cfg: first.config });
    expect(second.changes).toEqual([]);
    expect(second.config).toBe(first.config);
  });

  it("does not mutate nested account streaming objects", () => {
    const cfg = cfgWith({
      accounts: { franzi: { streaming: { preview: "off" } } },
    });
    const snapshot = JSON.parse(JSON.stringify(cfg));
    normalizeCliqCompatibilityConfig({ cfg });
    expect(cfg).toEqual(snapshot);
  });

  it("is idempotent — a second pass produces no changes", () => {
    const cfg = cfgWith({ client_id: "id", bot_id: "bot" });
    const first = normalizeCliqCompatibilityConfig({ cfg });
    const second = normalizeCliqCompatibilityConfig({ cfg: first.config });
    expect(second.changes).toEqual([]);
    expect(second.config).toBe(first.config);
  });

  it("does not mutate the input config", () => {
    const cfg = cfgWith({ client_id: "id" });
    const snapshot = JSON.parse(JSON.stringify(cfg));
    normalizeCliqCompatibilityConfig({ cfg });
    expect(cfg).toEqual(snapshot);
  });

  it("preserves unrelated keys on the section and on the root", () => {
    const cfg = {
      agents: { defaults: { model: "x" } },
      channels: { cliq: { client_id: "id", botName: "B" }, telegram: { token: "t" } },
    } as unknown as OpenClawConfig;
    const result = normalizeCliqCompatibilityConfig({ cfg });
    const root = result.config as unknown as {
      agents: { defaults: { model: string } };
      channels: { cliq: Record<string, unknown>; telegram: { token: string } };
    };
    expect(root.agents.defaults.model).toBe("x");
    expect(root.channels.telegram.token).toBe("t");
    expect(root.channels.cliq.clientId).toBe("id");
    expect(root.channels.cliq.botName).toBe("B");
    expect(root.channels.cliq.client_id).toBeUndefined();
  });
});

describe("repairCliqConfig", () => {
  it("delegates snake_case normalization to normalizeCliqCompatibilityConfig", () => {
    const cfg = cfgWith({ client_id: "id" });
    const repair = repairCliqConfig({ cfg, doctorFixCommand: DOCTOR_FIX });
    const norm = normalizeCliqCompatibilityConfig({ cfg });
    expect(repair.changes).toEqual(norm.changes);
    expect(repair.config).toEqual(norm.config);
  });

  it("migrates after_dispatch to after_receive_record (issue #344)", () => {
    const cfg = cfgWith({ ackPolicy: "after_dispatch" });
    const repair = repairCliqConfig({ cfg, doctorFixCommand: DOCTOR_FIX });
    expect(repair.changes).toEqual([
      'Moved channels.cliq.ackPolicy "after_dispatch" → "after_receive_record".',
    ]);
    const section = (repair.config as unknown as { channels: { cliq: Record<string, unknown> } })
      .channels.cliq;
    expect(section.ackPolicy).toBe("after_receive_record");
    expect(cfgWith({ ackPolicy: "after_dispatch" }).channels).toEqual(
      (cfg as unknown as { channels: unknown }).channels,
    );
    // Idempotent: a second pass produces no changes.
    const second = repairCliqConfig({ cfg: repair.config, doctorFixCommand: DOCTOR_FIX });
    expect(second.changes).toEqual([]);
  });

  it("migrates the deprecated immediate alias to after_receive_record (issue #344)", () => {
    const cfg = cfgWith({ ackPolicy: "immediate" });
    const repair = repairCliqConfig({ cfg, doctorFixCommand: DOCTOR_FIX });
    expect(repair.changes).toEqual([
      'Moved channels.cliq.ackPolicy "immediate" → "after_receive_record".',
    ]);
    const section = (repair.config as unknown as { channels: { cliq: Record<string, unknown> } })
      .channels.cliq;
    expect(section.ackPolicy).toBe("after_receive_record");
  });

  it("never migrates an explicitly overridden after_dispatch (issue #344)", () => {
    const cfg = cfgWith({ ackPolicy: "after_dispatch", allowBlockingAck: true });
    const repair = repairCliqConfig({ cfg, doctorFixCommand: DOCTOR_FIX });
    expect(repair.changes).toEqual([]);
    const section = (repair.config as unknown as { channels: { cliq: Record<string, unknown> } })
      .channels.cliq;
    expect(section.ackPolicy).toBe("after_dispatch");
    expect(section.allowBlockingAck).toBe(true);
  });

  it("leaves an already-optimal policy untouched (issue #344)", () => {
    for (const ackPolicy of [undefined, "after_receive_record"]) {
      const cfg = cfgWith(ackPolicy === undefined ? {} : { ackPolicy });
      const repair = repairCliqConfig({ cfg, doctorFixCommand: DOCTOR_FIX });
      expect(repair.changes).toEqual([]);
    }
  });

  it("fires a migration warning for a blocking ackPolicy (issue #344)", () => {
    for (const ackPolicy of ["after_dispatch", "immediate"]) {
      const issues = findLegacyConfigIssues(
        cfgWith({ ackPolicy }) as unknown as Record<string, unknown>,
        cliqLegacyConfigRules,
      );
      expect(issues.map((i) => i.path)).toContain("channels.cliq.ackPolicy");
      expect(issues.every((i) => i.message.includes("openclaw doctor --fix"))).toBe(true);
    }
    // Untouched when already optimal or explicitly overridden.
    for (const section of [{}, { ackPolicy: "after_receive_record" }, { ackPolicy: "after_dispatch", allowBlockingAck: true }]) {
      expect(
        findLegacyConfigIssues(
          cfgWith(section) as unknown as Record<string, unknown>,
          cliqLegacyConfigRules,
        ).map((i) => i.path),
      ).not.toContain("channels.cliq.ackPolicy");
    }
  });
});

describe("detectCliqLegacyStateMigrations", () => {
  it("returns an empty plan today (no on-disk plugin-state files)", () => {
    const plans = detectCliqLegacyStateMigrations({
      cfg: cfgWith({ clientId: "id", clientSecret: "s", botId: "b" }),
      env: process.env,
      stateDir: "/tmp/state",
      oauthDir: "/tmp/oauth",
    });
    expect(plans).toEqual([]);
  });
});
