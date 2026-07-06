import { describe, it, expect } from "vitest";
import {
  cliqDoctorAdapter,
  collectCliqPreviewWarnings,
  collectCliqMutableAllowlistWarnings,
  readCliqDoctorSection,
} from "./doctor.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

function cfgWith(section: Record<string, unknown>): OpenClawConfig {
  return { channels: { cliq: section } } as unknown as OpenClawConfig;
}

const DOCTOR_FIX = "openclaw doctor --fix";

describe("cliqDoctorAdapter shape", () => {
  it("declares topOnly dmAllowFromMode and skips the default empty group allowlist warning", () => {
    expect(cliqDoctorAdapter.dmAllowFromMode).toBe("topOnly");
    expect(
      cliqDoctorAdapter.shouldSkipDefaultEmptyGroupAllowlistWarning?.({
        account: {},
        channelName: "cliq",
        prefix: "channels.cliq",
      }),
    ).toBe(true);
  });
});

describe("readCliqDoctorSection", () => {
  it("returns null when there is no channels.cliq section", () => {
    expect(readCliqDoctorSection({} as unknown as OpenClawConfig)).toBeNull();
    expect(
      readCliqDoctorSection({ channels: {} } as unknown as OpenClawConfig),
    ).toBeNull();
    expect(
      readCliqDoctorSection({
        channels: { cliq: "not-an-object" },
      } as unknown as OpenClawConfig),
    ).toBeNull();
  });

  it("returns the section object when present", () => {
    const cfg = cfgWith({ botId: "b" });
    expect(readCliqDoctorSection(cfg)).toEqual({ botId: "b" });
  });
});

describe("collectCliqPreviewWarnings", () => {
  it("returns nothing when the channel is absent", () => {
    expect(
      collectCliqPreviewWarnings({
        cfg: {} as unknown as OpenClawConfig,
        doctorFixCommand: DOCTOR_FIX,
      }),
    ).toEqual([]);
  });

  it("warns about all missing core credentials in one line", () => {
    const warnings = collectCliqPreviewWarnings({
      cfg: cfgWith({ dmPolicy: "open", allowFrom: ["u1"] }),
      doctorFixCommand: DOCTOR_FIX,
    });
    // dmPolicy open + non-empty allowFrom suppresses the empty-allowlist and
    // open+wildcard warnings so only the missing-creds + missing-webhookSecret
    // lines remain.
    const credsLine = warnings.find((w) => /missing required credentials/.test(w));
    expect(credsLine).toBeDefined();
    expect(credsLine!).toMatch(/clientId.*clientSecret.*botId/);
    expect(credsLine!).toContain(DOCTOR_FIX);
  });

  it("warns about a missing webhook secret even when core creds are present", () => {
    const warnings = collectCliqPreviewWarnings({
      cfg: cfgWith({
        clientId: "id",
        clientSecret: "secret",
        botId: "bot",
        dmPolicy: "open",
        allowFrom: ["u1"],
      }),
      doctorFixCommand: DOCTOR_FIX,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/webhookSecret is not set/);
  });

  it("warns about wildcard allowFrom under open dmPolicy", () => {
    const warnings = collectCliqPreviewWarnings({
      cfg: cfgWith({
        clientId: "id",
        clientSecret: "secret",
        botId: "bot",
        webhookSecret: "s",
        dmPolicy: "open",
        allowFrom: ["*"],
      }),
      doctorFixCommand: DOCTOR_FIX,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/dmPolicy is "open".*wildcard/);
  });

  it("does not warn about wildcard allowFrom under allowlist dmPolicy (covered by empty/open checks)", () => {
    const warnings = collectCliqPreviewWarnings({
      cfg: cfgWith({
        clientId: "id",
        clientSecret: "secret",
        botId: "bot",
        webhookSecret: "s",
        dmPolicy: "allowlist",
        allowFrom: ["*"],
      }),
      doctorFixCommand: DOCTOR_FIX,
    });
    // Wildcard under allowlist still admits everyone, but the policy is the
    // explicit opt-in; preview only flags the open+wildcard combination and
    // the empty-allowlist case. So no warning here.
    expect(warnings).toEqual([]);
  });

  it("warns about an empty allowFrom under the default allowlist policy", () => {
    const warnings = collectCliqPreviewWarnings({
      cfg: cfgWith({
        clientId: "id",
        clientSecret: "secret",
        botId: "bot",
        webhookSecret: "s",
        // dmPolicy defaults to "allowlist"
      }),
      doctorFixCommand: DOCTOR_FIX,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/allowFrom is empty/);
  });

  it("warns about ackPolicy immediate", () => {
    const warnings = collectCliqPreviewWarnings({
      cfg: cfgWith({
        clientId: "id",
        clientSecret: "secret",
        botId: "bot",
        webhookSecret: "s",
        dmPolicy: "open",
        allowFrom: ["someone"],
        ackPolicy: "immediate",
      }),
      doctorFixCommand: DOCTOR_FIX,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/ackPolicy is "immediate"/);
  });

  it("emits no warnings for a clean, locked-down config", () => {
    const warnings = collectCliqPreviewWarnings({
      cfg: cfgWith({
        clientId: "id",
        clientSecret: "secret",
        botId: "bot",
        webhookSecret: "s",
        dmPolicy: "allowlist",
        allowFrom: ["user@example.com"],
      }),
      doctorFixCommand: DOCTOR_FIX,
    });
    expect(warnings).toEqual([]);
  });

  it("emits multiple warnings when several issues stack", () => {
    const warnings = collectCliqPreviewWarnings({
      cfg: cfgWith({
        botId: "bot", // missing clientId + clientSecret
        dmPolicy: "allowlist", // empty allowFrom
      }),
      doctorFixCommand: DOCTOR_FIX,
    });
    // 1) missing creds (clientId, clientSecret) + 2) missing webhookSecret +
    // 3) empty allowFrom under allowlist policy.
    expect(warnings).toHaveLength(3);
    expect(warnings.some((w) => /missing required credentials/.test(w))).toBe(true);
    expect(warnings.some((w) => /webhookSecret is not set/.test(w))).toBe(true);
    expect(warnings.some((w) => /allowFrom is empty/.test(w))).toBe(true);
  });
});

describe("collectCliqPreviewWarnings — data-center validation (issue #46)", () => {
  const base = {
    clientId: "id",
    clientSecret: "secret",
    botId: "bot",
    webhookSecret: "s",
    dmPolicy: "open" as const,
    allowFrom: ["u1"],
  };

  it("warns when only oauthBase is set (apiBase defaults to EU)", () => {
    const warnings = collectCliqPreviewWarnings({
      cfg: cfgWith({ ...base, oauthBase: "https://accounts.zoho.com" }),
      doctorFixCommand: DOCTOR_FIX,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/only one of oauthBase \/ apiBase is set/);
    expect(warnings[0]).toContain("apiBase=—");
  });

  it("warns when only apiBase is set (oauthBase defaults to EU)", () => {
    const warnings = collectCliqPreviewWarnings({
      cfg: cfgWith({ ...base, apiBase: "https://cliq.zoho.com" }),
      doctorFixCommand: DOCTOR_FIX,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/only one of oauthBase \/ apiBase is set/);
  });

  it("warns when oauthBase and apiBase point at different regions", () => {
    const warnings = collectCliqPreviewWarnings({
      cfg: cfgWith({
        ...base,
        oauthBase: "https://accounts.zoho.com",
        apiBase: "https://cliq.zoho.in",
      }),
      doctorFixCommand: DOCTOR_FIX,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/point at different Zoho data centers/);
  });

  it("does not warn when both are set to the same region", () => {
    const warnings = collectCliqPreviewWarnings({
      cfg: cfgWith({
        ...base,
        oauthBase: "https://accounts.zoho.in",
        apiBase: "https://cliq.zoho.in",
      }),
      doctorFixCommand: DOCTOR_FIX,
    });
    expect(warnings).toEqual([]);
  });

  it("does not warn when neither is set (EU default is consistent)", () => {
    const warnings = collectCliqPreviewWarnings({
      cfg: cfgWith({ ...base }),
      doctorFixCommand: DOCTOR_FIX,
    });
    expect(warnings).toEqual([]);
  });

  it("does not warn for a non-region custom apiBase + oauthBase that match no DC", () => {
    const warnings = collectCliqPreviewWarnings({
      cfg: cfgWith({
        ...base,
        oauthBase: "https://accounts.example.internal",
        apiBase: "https://cliq.example.internal",
      }),
      doctorFixCommand: DOCTOR_FIX,
    });
    // Both set, neither matches a known DC — no region-mismatch warning
    // (cannot prove they disagree without a known-region mapping).
    expect(warnings).toEqual([]);
  });
});

describe("collectCliqMutableAllowlistWarnings", () => {
  it("returns nothing when there is no section", () => {
    expect(
      collectCliqMutableAllowlistWarnings({
        cfg: {} as unknown as OpenClawConfig,
      }),
    ).toEqual([]);
  });

  it("warns about a wildcard allowlist doctor will not auto-edit", () => {
    const warnings = collectCliqMutableAllowlistWarnings({
      cfg: cfgWith({ allowFrom: ["*"] }),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/wildcard.*doctor will not edit/);
  });

  it("does not warn for a concrete allowlist", () => {
    const warnings = collectCliqMutableAllowlistWarnings({
      cfg: cfgWith({ allowFrom: ["u1", "u2"] }),
    });
    expect(warnings).toEqual([]);
  });

  it("does not warn for an empty allowlist", () => {
    const warnings = collectCliqMutableAllowlistWarnings({
      cfg: cfgWith({ allowFrom: [] }),
    });
    expect(warnings).toEqual([]);
  });
});

describe("cliqDoctorAdapter integration with the doctor adapter contract", () => {
  it("collectPreviewWarnings routes through the adapter", async () => {
    const lines = await cliqDoctorAdapter.collectPreviewWarnings!({
      cfg: cfgWith({}),
      doctorFixCommand: DOCTOR_FIX,
    });
    expect(lines.some((l) => /missing required credentials/.test(l))).toBe(true);
  });

  it("collectMutableAllowlistWarnings routes through the adapter", async () => {
    const lines = await cliqDoctorAdapter.collectMutableAllowlistWarnings!({
      cfg: cfgWith({ allowFrom: ["*"] }),
    });
    expect(lines).toHaveLength(1);
  });
});
