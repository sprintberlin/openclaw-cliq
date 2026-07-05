import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import {
  cliqLegacyConfigRules,
  normalizeCliqCompatibilityConfig,
  repairCliqConfig,
  detectCliqLegacyStateMigrations,
  cliqLifecycleAdapter,
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

  it("does not fire when no snake_case keys are present", () => {
    const cfg = cfgWith({ clientId: "id", clientSecret: "s", botId: "b" });
    const issues = findLegacyConfigIssues(
      cfg as unknown as Record<string, unknown>,
      cliqLegacyConfigRules,
    );
    expect(issues).toEqual([]);
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
      self_sender_ids: ["s1"],
      dm_policy: "open",
      ack_policy: "immediate",
    });
    const result = normalizeCliqCompatibilityConfig({ cfg });
    expect(result.changes).toHaveLength(10);
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
      selfSenderIds: ["s1"],
      dmPolicy: "open",
      ackPolicy: "immediate",
    });
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
  it("delegates to normalizeCliqCompatibilityConfig (same mutation)", () => {
    const cfg = cfgWith({ client_id: "id" });
    const repair = repairCliqConfig({ cfg, doctorFixCommand: DOCTOR_FIX });
    const norm = normalizeCliqCompatibilityConfig({ cfg });
    expect(repair.changes).toEqual(norm.changes);
    expect(repair.config).toEqual(norm.config);
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

  it("is wired on the lifecycle adapter", () => {
    expect(cliqLifecycleAdapter.detectLegacyStateMigrations).toBe(
      detectCliqLegacyStateMigrations,
    );
  });
});
