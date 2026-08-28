import { describe, it, expect, vi } from "vitest";
import {
  buildCliqInboundVerificationPatch,
  decideCliqVerificationWrite,
  describeCliqInboundVerification,
  isSameWebhookUrl,
} from "./inbound-verification.js";
import {
  persistCliqHandlerUrlAdoption,
  persistCliqInboundVerification,
} from "./inbound-verification-store.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/setup";
import { createCliqTestConfig as cfgWith } from "./test-api.js";

const URL_OK = "https://host.example.com/cliq/webhook";

function section(cfg: OpenClawConfig): Record<string, unknown> {
  return (cfg as never as { channels: { cliq: Record<string, unknown> } }).channels.cliq;
}

/** A mutator over an in-memory config, standing in for the real config file. */
function mutatorOver(cfg: OpenClawConfig): {
  mutator: (mutate: (draft: OpenClawConfig) => void) => Promise<void>;
  calls: () => number;
} {
  let calls = 0;
  return {
    calls: () => calls,
    mutator: async (mutate) => {
      calls += 1;
      mutate(cfg);
    },
  };
}

describe("isSameWebhookUrl (issue #106)", () => {
  it("treats a trailing slash and case-different host as the same endpoint", () => {
    expect(isSameWebhookUrl(URL_OK, "https://HOST.example.com/cliq/webhook/")).toBe(true);
  });

  it("does not treat a different host as the same endpoint", () => {
    expect(isSameWebhookUrl(URL_OK, "https://other.example.com/cliq/webhook")).toBe(false);
  });

  it("does not treat a different scheme as the same endpoint", () => {
    expect(isSameWebhookUrl(URL_OK, "http://host.example.com/cliq/webhook")).toBe(false);
  });

  it("ignores an explicit default port", () => {
    expect(isSameWebhookUrl(URL_OK, "https://host.example.com:443/cliq/webhook")).toBe(true);
  });

  it("does not treat a non-default port as the same endpoint", () => {
    expect(isSameWebhookUrl(URL_OK, "https://host.example.com:8443/cliq/webhook")).toBe(false);
  });

  it("is false when either side is missing", () => {
    expect(isSameWebhookUrl(URL_OK, undefined)).toBe(false);
    expect(isSameWebhookUrl(undefined, URL_OK)).toBe(false);
  });
});

describe("decideCliqVerificationWrite (issue #106)", () => {
  it("writes when the checked URL is the configured public webhook URL", () => {
    const decision = decideCliqVerificationWrite({
      targetUrl: URL_OK,
      configuredUrl: URL_OK,
      suppressed: false,
    });
    expect(decision.write).toBe(true);
  });

  it("never writes for a URL that is not this install's", () => {
    const decision = decideCliqVerificationWrite({
      targetUrl: "https://someone-else.example.com/cliq/webhook",
      configuredUrl: URL_OK,
      suppressed: false,
    });
    expect(decision.write).toBe(false);
    expect(decision.reason).toMatch(/not the configured/i);
  });

  it("never writes when no public webhook URL is configured", () => {
    const decision = decideCliqVerificationWrite({
      targetUrl: URL_OK,
      configuredUrl: undefined,
      suppressed: false,
    });
    expect(decision.write).toBe(false);
    expect(decision.reason).toMatch(/publicWebhookUrl/);
  });

  it("never writes when the operator asked for a read-only run", () => {
    const decision = decideCliqVerificationWrite({
      targetUrl: URL_OK,
      configuredUrl: URL_OK,
      suppressed: true,
    });
    expect(decision.write).toBe(false);
    expect(decision.reason).toMatch(/no-write/);
  });

  it("never writes a verdict obtained with a secret other than the configured one", () => {
    const decision = decideCliqVerificationWrite({
      targetUrl: URL_OK,
      configuredUrl: URL_OK,
      suppressed: false,
      foreignSecret: true,
    });
    expect(decision.write).toBe(false);
    expect(decision.reason).toMatch(/--secret/);
  });
});

describe("buildCliqInboundVerificationPatch (issue #106)", () => {
  it("records the pass and clears any recorded failure", () => {
    expect(buildCliqInboundVerificationPatch("pass", "T")).toEqual({
      inboundVerifiedAt: "T",
      inboundVerificationFailedAt: undefined,
    });
  });

  it("records the failure and clears any stale verification", () => {
    expect(buildCliqInboundVerificationPatch("fail", "T")).toEqual({
      inboundVerifiedAt: undefined,
      inboundVerificationFailedAt: "T",
    });
  });
});

describe("persistCliqInboundVerification (issue #106)", () => {
  const now = new Date("2026-08-27T09:00:00.000Z");

  it("records a passing check against the configured URL", async () => {
    const cfg = cfgWith({ publicWebhookUrl: URL_OK });
    const { mutator } = mutatorOver(cfg);
    const result = await persistCliqInboundVerification({
      targetUrl: URL_OK,
      configuredUrl: URL_OK,
      outcome: "pass",
      now,
      mutator,
    });
    expect(result.written).toBe(true);
    expect(section(cfg).inboundVerifiedAt).toBe("2026-08-27T09:00:00.000Z");
    expect(section(cfg).inboundVerificationFailedAt).toBeUndefined();
  });

  it("clears a stale verification and records the failure when the check fails", async () => {
    const cfg = cfgWith({
      publicWebhookUrl: URL_OK,
      inboundVerifiedAt: "2026-01-01T00:00:00.000Z",
    });
    const { mutator } = mutatorOver(cfg);
    const result = await persistCliqInboundVerification({
      targetUrl: URL_OK,
      configuredUrl: URL_OK,
      outcome: "fail",
      now,
      mutator,
    });
    expect(result.written).toBe(true);
    expect(section(cfg).inboundVerifiedAt).toBeUndefined();
    expect(section(cfg).inboundVerificationFailedAt).toBe("2026-08-27T09:00:00.000Z");
  });

  it("never touches config when the checked URL is not the configured one", async () => {
    const cfg = cfgWith({ publicWebhookUrl: URL_OK });
    const { mutator, calls } = mutatorOver(cfg);
    const result = await persistCliqInboundVerification({
      targetUrl: "https://third-party.example.com/cliq/webhook",
      configuredUrl: URL_OK,
      outcome: "pass",
      now,
      mutator,
    });
    expect(result.written).toBe(false);
    expect(calls()).toBe(0);
    expect(section(cfg).inboundVerifiedAt).toBeUndefined();
  });

  it("never touches config when the write is explicitly suppressed", async () => {
    const cfg = cfgWith({ publicWebhookUrl: URL_OK });
    const { mutator, calls } = mutatorOver(cfg);
    const result = await persistCliqInboundVerification({
      targetUrl: URL_OK,
      configuredUrl: URL_OK,
      outcome: "pass",
      suppressed: true,
      now,
      mutator,
    });
    expect(result.written).toBe(false);
    expect(calls()).toBe(0);
    expect(section(cfg).inboundVerifiedAt).toBeUndefined();
  });

  it("does not open the config when no config/publicWebhookUrl is present", async () => {
    const mutator = vi.fn(async () => {});
    const result = await persistCliqInboundVerification({
      targetUrl: URL_OK,
      configuredUrl: undefined,
      outcome: "pass",
      now,
      mutator,
    });
    expect(result.written).toBe(false);
    expect(mutator).not.toHaveBeenCalled();
  });

  it("declines the write when the config no longer carries the matching URL", async () => {
    // The file changed between the read that produced `configuredUrl` and the
    // mutation: recording against a now-different endpoint would be a lie.
    const cfg = cfgWith({ publicWebhookUrl: "https://moved.example.com/cliq/webhook" });
    const { mutator } = mutatorOver(cfg);
    const result = await persistCliqInboundVerification({
      targetUrl: URL_OK,
      configuredUrl: URL_OK,
      outcome: "pass",
      now,
      mutator,
    });
    expect(result.written).toBe(false);
    expect(section(cfg).inboundVerifiedAt).toBeUndefined();
  });

  it("declines the write when the config has no cliq section at all", async () => {
    const cfg = {} as unknown as OpenClawConfig;
    const { mutator } = mutatorOver(cfg);
    const result = await persistCliqInboundVerification({
      targetUrl: URL_OK,
      configuredUrl: URL_OK,
      outcome: "pass",
      now,
      mutator,
    });
    expect(result.written).toBe(false);
    expect(cfg).toEqual({});
  });

  it("never records a verdict obtained with an overriding --secret", async () => {
    const cfg = cfgWith({ publicWebhookUrl: URL_OK });
    const { mutator, calls } = mutatorOver(cfg);
    const result = await persistCliqInboundVerification({
      targetUrl: URL_OK,
      configuredUrl: URL_OK,
      outcome: "pass",
      foreignSecret: true,
      now,
      mutator,
    });
    expect(result.written).toBe(false);
    expect(calls()).toBe(0);
  });
});

describe("persistCliqHandlerUrlAdoption (issue #172)", () => {
  const now = new Date("2026-08-27T09:00:00.000Z");

  it("writes the verified URL and inboundVerifiedAt in one mutation when the field is missing", async () => {
    const cfg = cfgWith({ publicWebhookUrl: undefined });
    const { mutator, calls } = mutatorOver(cfg);
    const result = await persistCliqHandlerUrlAdoption({
      url: URL_OK,
      configuredUrl: undefined,
      now,
      mutator,
    });
    expect(result.written).toBe(true);
    expect(calls()).toBe(1);
    expect(section(cfg).publicWebhookUrl).toBe(URL_OK);
    expect(section(cfg).inboundVerifiedAt).toBe("2026-08-27T09:00:00.000Z");
    expect(section(cfg).inboundVerificationFailedAt).toBeUndefined();
  });

  it("leaves config unchanged when the mutator fails after applying the draft", async () => {
    const cfg = cfgWith({ publicWebhookUrl: undefined });
    const result = await persistCliqHandlerUrlAdoption({
      url: URL_OK,
      configuredUrl: undefined,
      now,
      mutator: async (mutate) => {
        mutate(cfg);
        throw new Error("config write failed");
      },
    });
    expect(result.written).toBe(false);
    expect(result.reason).toMatch(/could not be written|failed/i);
    expect(section(cfg).publicWebhookUrl).toBeUndefined();
    expect(section(cfg).inboundVerifiedAt).toBeUndefined();
  });

  it("declines when the live config already has a different publicWebhookUrl", async () => {
    const cfg = cfgWith({ publicWebhookUrl: "https://moved.example.com/cliq/webhook" });
    const { mutator } = mutatorOver(cfg);
    const result = await persistCliqHandlerUrlAdoption({
      url: URL_OK,
      configuredUrl: undefined,
      now,
      mutator,
    });
    expect(result.written).toBe(false);
    expect(section(cfg).publicWebhookUrl).toBe("https://moved.example.com/cliq/webhook");
    expect(section(cfg).inboundVerifiedAt).toBeUndefined();
  });

  it("never writes for a --secret/foreign-secret probe", async () => {
    const cfg = cfgWith({ publicWebhookUrl: undefined });
    const { mutator, calls } = mutatorOver(cfg);
    const result = await persistCliqHandlerUrlAdoption({
      url: URL_OK,
      configuredUrl: undefined,
      foreignSecret: true,
      now,
      mutator,
    });
    expect(result.written).toBe(false);
    expect(calls()).toBe(0);
    expect(section(cfg).publicWebhookUrl).toBeUndefined();
    expect(section(cfg).inboundVerifiedAt).toBeUndefined();
  });

  it("writes a named account without changing the top-level fallback", async () => {
    const cfg = cfgWith({
      accounts: {
        team: {
          publicWebhookUrl: undefined,
          inboundVerificationFailedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    const { mutator } = mutatorOver(cfg);
    const result = await persistCliqHandlerUrlAdoption({
      url: URL_OK,
      configuredUrl: undefined,
      accountId: "team",
      now,
      mutator,
    });
    const root = section(cfg);
    const team = (root.accounts as Record<string, Record<string, unknown>>).team;
    expect(result.written).toBe(true);
    expect(root.publicWebhookUrl).toBeUndefined();
    expect(team.publicWebhookUrl).toBe(URL_OK);
    expect(team.inboundVerifiedAt).toBe("2026-08-27T09:00:00.000Z");
    expect(team.inboundVerificationFailedAt).toBeUndefined();
  });

  it("never overwrites an already-configured publicWebhookUrl", async () => {
    const cfg = cfgWith({ publicWebhookUrl: URL_OK });
    const { mutator, calls } = mutatorOver(cfg);
    const result = await persistCliqHandlerUrlAdoption({
      url: URL_OK,
      configuredUrl: URL_OK,
      now,
      mutator,
    });
    expect(result.written).toBe(false);
    expect(calls()).toBe(0);
  });
});

describe("describeCliqInboundVerification (issue #106)", () => {
  it("distinguishes never-checked from last-check-failed", () => {
    const never = describeCliqInboundVerification({
      publicUrl: URL_OK,
      verifiedAt: undefined,
      failedAt: undefined,
    });
    const failed = describeCliqInboundVerification({
      publicUrl: URL_OK,
      verifiedAt: undefined,
      failedAt: "2026-08-27T09:00:00.000Z",
    });
    expect(never).toMatch(/never checked/i);
    expect(failed).toMatch(/failed/i);
    expect(failed).toContain("2026-08-27T09:00:00.000Z");
    expect(never).not.toBe(failed);
  });

  it("reports the verified timestamp when the last check passed", () => {
    expect(
      describeCliqInboundVerification({
        publicUrl: URL_OK,
        verifiedAt: "2026-08-27T09:00:00.000Z",
        failedAt: undefined,
      }),
    ).toBe(`inbound: verified 2026-08-27T09:00:00.000Z at ${URL_OK}`);
  });

  it("says so when no public webhook URL is configured at all", () => {
    expect(
      describeCliqInboundVerification({
        publicUrl: undefined,
        verifiedAt: undefined,
        failedAt: undefined,
      }),
    ).toMatch(/no public webhook URL/i);
  });

  it("reports the newer timestamp when both are somehow present", () => {
    expect(
      describeCliqInboundVerification({
        publicUrl: URL_OK,
        verifiedAt: "2026-01-01T00:00:00.000Z",
        failedAt: "2026-08-27T09:00:00.000Z",
      }),
    ).toMatch(/FAILED/);
    expect(
      describeCliqInboundVerification({
        publicUrl: URL_OK,
        verifiedAt: "2026-08-27T09:00:00.000Z",
        failedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toMatch(/verified/);
  });
});
