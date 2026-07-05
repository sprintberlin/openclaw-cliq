import { describe, it, expect } from "vitest";
import {
  cliqSecretsAdapter,
  cliqSecretTargetRegistryEntries,
  collectCliqRuntimeConfigAssignments,
} from "./secret-contract.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

function cfgWith(section: Record<string, unknown> | null): OpenClawConfig {
  if (section === null) return {} as unknown as OpenClawConfig;
  return { channels: { cliq: section } } as unknown as OpenClawConfig;
}

/**
 * Minimal ResolverContext stub matching the SDK's shape
 * (`runtime-shared-DoAXKQzg.js`): `pushAssignment` writes to
 * `context.assignments`, `pushWarning`/`pushInactiveSurfaceWarning` write to
 * `context.warnings` (deduped via `context.warningKeys`).
 */
function makeContext() {
  const assignments: Array<{ ref: unknown; path: string; expected: string; apply: (value: unknown) => void }> = [];
  const warnings: unknown[] = [];
  const warningKeys = new Set<string>();
  return {
    context: { assignments, warnings, warningKeys },
    assignments,
    warnings,
  };
}

const ENV_REF = { source: "env", provider: "default", id: "CLIQ_CLIENT_SECRET" };

describe("cliqSecretTargetRegistryEntries", () => {
  it("registers exactly the three Cliq secret fields at the channel root", () => {
    const paths = cliqSecretTargetRegistryEntries.map((e) => e.pathPattern);
    expect(paths).toEqual([
      "channels.cliq.clientSecret",
      "channels.cliq.webhookSecret",
      "channels.cliq.refreshToken",
    ]);
  });

  it("each entry is an auditable, plan-able, configurable secret_input", () => {
    for (const entry of cliqSecretTargetRegistryEntries) {
      expect(entry.configFile).toBe("openclaw.json");
      expect(entry.secretShape).toBe("secret_input");
      expect(entry.expectedResolvedValue).toBe("string");
      expect(entry.includeInPlan).toBe(true);
      expect(entry.includeInConfigure).toBe(true);
      expect(entry.includeInAudit).toBe(true);
      expect(entry.id).toBe(entry.targetType);
      expect(entry.targetType).toBe(entry.pathPattern);
    }
  });
});

describe("cliqSecretsAdapter", () => {
  it("is wired with the registry + collector", () => {
    expect(cliqSecretsAdapter.secretTargetRegistryEntries).toBe(
      cliqSecretTargetRegistryEntries,
    );
    expect(cliqSecretsAdapter.collectRuntimeConfigAssignments).toBe(
      collectCliqRuntimeConfigAssignments,
    );
  });
});

describe("collectCliqRuntimeConfigAssignments", () => {
  it("no-ops when there is no channels.cliq section", () => {
    const { context, assignments } = makeContext();
    collectCliqRuntimeConfigAssignments({
      config: cfgWith(null),
      defaults: undefined,
      context: context as never,
    });
    expect(assignments).toEqual([]);
  });

  it("collects a SecretRef assignment for each configured secret field", () => {
    const { context, assignments } = makeContext();
    collectCliqRuntimeConfigAssignments({
      config: cfgWith({
        clientId: "cid",
        botId: "bot",
        clientSecret: ENV_REF,
        webhookSecret: { source: "env", provider: "default", id: "CLIQ_WEBHOOK_SECRET" },
        refreshToken: { source: "env", provider: "default", id: "CLIQ_REFRESH_TOKEN" },
      }),
      defaults: undefined,
      context: context as never,
    });
    const paths = assignments.map((a) => a.path).sort();
    expect(paths).toEqual([
      "channels.cliq.clientSecret",
      "channels.cliq.refreshToken",
      "channels.cliq.webhookSecret",
    ]);
    for (const a of assignments) {
      expect(a.expected).toBe("string");
      expect(typeof a.apply).toBe("function");
      expect(a.ref).toBeTruthy();
    }
  });

  it("ignores plaintext values (they are not SecretRef assignments)", () => {
    const { context, assignments } = makeContext();
    collectCliqRuntimeConfigAssignments({
      config: cfgWith({
        clientSecret: "plaintext-secret",
        webhookSecret: "plaintext-wh",
        refreshToken: "plaintext-rt",
      }),
      defaults: undefined,
      context: context as never,
    });
    expect(assignments).toEqual([]);
  });

  it("collects only the field that carries a SecretRef", () => {
    const { context, assignments } = makeContext();
    collectCliqRuntimeConfigAssignments({
      config: cfgWith({
        clientSecret: ENV_REF,
        webhookSecret: "plaintext-wh",
        refreshToken: undefined,
      }),
      defaults: undefined,
      context: context as never,
    });
    expect(assignments.map((a) => a.path)).toEqual([
      "channels.cliq.clientSecret",
    ]);
  });

  it("records an inactive-surface warning for a SecretRef on a disabled channel", () => {
    const { context, assignments, warnings } = makeContext();
    collectCliqRuntimeConfigAssignments({
      config: cfgWith({
        enabled: false,
        clientSecret: ENV_REF,
      }),
      defaults: undefined,
      context: context as never,
    });
    expect(assignments).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });
});
