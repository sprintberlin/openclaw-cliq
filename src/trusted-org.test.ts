import { describe, expect, it } from "vitest";
import { createCliqTestConfig as cfgWith } from "./test-api.js";
import { collectCliqSecurityAuditFindings } from "./security-audit.js";
import {
  readCliqTrustedOrganization,
  resolveTrustedOrganizationStatus,
} from "./trusted-org.js";

const BASE = {
  clientId: "id",
  clientSecret: { source: "env", provider: "default", id: "CLIQ_CLIENT_SECRET" },
  botId: "bot",
  webhookSecret: { source: "env", provider: "default", id: "CLIQ_WEBHOOK_SECRET" },
} as const;

describe("trusted-organization acknowledgement", () => {
  it("is never inferred from a wildcard alone", () => {
    const cfg = cfgWith({ ...BASE, allowFrom: ["*"] });
    expect(readCliqTrustedOrganization(cfg)).toBeNull();
    expect(resolveTrustedOrganizationStatus({ cfg })).toBe("unacknowledged_wildcard");
  });

  it("requires acknowledged === true", () => {
    const cfg = cfgWith({
      ...BASE,
      allowFrom: ["*"],
      trustedOrganization: { acknowledged: false },
    });
    expect(readCliqTrustedOrganization(cfg)).toBeNull();
  });

  it("records an acknowledged organization-wide deployment", () => {
    const cfg = cfgWith({
      ...BASE,
      allowFrom: ["*"],
      trustedOrganization: { acknowledged: true, label: "Pay-Jet" },
    });
    expect(readCliqTrustedOrganization(cfg)?.label).toBe("Pay-Jet");
    expect(resolveTrustedOrganizationStatus({ cfg })).toBe("acknowledged");
  });
});

describe("security audit acknowledgement semantics", () => {
  it("keeps an unacknowledged wildcard critical", () => {
    const findings = collectCliqSecurityAuditFindings({
      cfg: cfgWith({ ...BASE, allowFrom: ["*"] }),
    });
    const wildcard = findings.find((f) => f.checkId === "channels.cliq.allow_from.wildcard");
    expect(wildcard?.severity).toBe("critical");
  });

  it("downgrades an acknowledged trusted-organization deployment to informational", () => {
    const findings = collectCliqSecurityAuditFindings({
      cfg: cfgWith({
        ...BASE,
        dmPolicy: "open",
        allowFrom: ["*"],
        trustedOrganization: { acknowledged: true, label: "Pay-Jet" },
      }),
    });
    expect(
      findings.find((f) => f.checkId === "channels.cliq.allow_from.wildcard")?.severity,
    ).toBe("info");
    expect(
      findings.find((f) => f.checkId === "channels.cliq.dm_policy.open")?.severity,
    ).toBe("info");
    const ack = findings.find(
      (f) => f.checkId === "channels.cliq.trusted_organization.acknowledged",
    );
    expect(ack?.severity).toBe("info");
    expect(ack?.detail).toMatch(/not a signed tenant claim/i);
  });

  it("flags an acknowledgement that does not correspond to open access", () => {
    const findings = collectCliqSecurityAuditFindings({
      cfg: cfgWith({
        ...BASE,
        dmPolicy: "allowlist",
        allowFrom: ["u1"],
        trustedOrganization: { acknowledged: true },
      }),
    });
    expect(
      findings.some(
        (f) => f.checkId === "channels.cliq.trusted_organization.acknowledged_but_closed",
      ),
    ).toBe(true);
  });

  it("leaves an untouched legacy open config working (no config rewrite)", () => {
    const section = { ...BASE, dmPolicy: "open", allowFrom: ["*"] };
    const cfg = cfgWith(section);
    collectCliqSecurityAuditFindings({ cfg });
    expect((cfg as unknown as { channels: { cliq: unknown } }).channels.cliq).toEqual(section);
  });
});
