import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { CliqSecurityAuditFinding } from "./security-audit.js";
import { CLIQ_ORGANIZATION_BOUNDARY_STATEMENT } from "./identity.js";

export type TrustedOrganizationStatus =
  | "unacknowledged_wildcard"
  | "acknowledged_open_without_wildcard"
  | "acknowledged";

export interface CliqTrustedOrganizationConfig {
  /** Explicit acknowledgement that all members of the Zoho organization may use the bot. */
  acknowledged: boolean;
  /** Optional label for the deployment, e.g. "Pay-Jet" (display only). */
  label?: string;
  /**
   * Optional ISO timestamp recording when the operator acknowledged the
   * exposure. Written by the setup wizard; never modified on upgrade.
   */
  acknowledgedAt?: string;
}

function readCliqSection(
  cfg: OpenClawConfig,
): Record<string, unknown> | null {
  const channels = (cfg as unknown as { channels?: Record<string, unknown> })
    .channels;
  if (!channels || typeof channels !== "object") return null;
  const section = (channels as Record<string, unknown>)["cliq"];
  if (!section || typeof section !== "object") return null;
  return section as Record<string, unknown>;
}

export function readCliqTrustedOrganization(
  cfg: OpenClawConfig,
): CliqTrustedOrganizationConfig | null {
  const section = readCliqSection(cfg);
  const raw = section?.trustedOrganization;
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (record.acknowledged !== true) return null;
  return {
    acknowledged: true,
    label: typeof record.label === "string" ? record.label : undefined,
    acknowledgedAt:
      typeof record.acknowledgedAt === "string" ? record.acknowledgedAt : undefined,
  };
}

export function resolveTrustedOrganizationStatus(params: {
  cfg: OpenClawConfig;
}): TrustedOrganizationStatus | null {
  const section = readCliqSection(params.cfg);
  if (!section) return null;
  const trusted = readCliqTrustedOrganization(params.cfg);
  const dmPolicy = typeof section.dmPolicy === "string" ? section.dmPolicy : "allowlist";
  const allowFrom = Array.isArray(section.allowFrom)
    ? section.allowFrom.filter((v): v is string => typeof v === "string")
    : [];
  const wildcard = allowFrom.some((entry) => entry.trim() === "*");
  const open =
    dmPolicy === "open" ||
    wildcard ||
    (typeof section.groupPolicy === "string" && section.groupPolicy === "open");
  if (trusted?.acknowledged === true && open) return "acknowledged";
  if (open) return "unacknowledged_wildcard";
  if (trusted?.acknowledged === true) return "acknowledged_open_without_wildcard";
  return null;
}

/**
 * Security-audit downgrade for an explicitly acknowledged trusted
 * organization deployment: the wildcard/open finding stays visible but is
 * reclassified as informational, and an acknowledgement finding records the
 * deliberate policy. An unacknowledged wildcard stays critical.
 */
export function trustedOrganizationAuditAdjustments(params: {
  cfg: OpenClawConfig;
}): {
  downgradeToInfo: boolean;
  extraFindings: CliqSecurityAuditFinding[];
} {
  const status = resolveTrustedOrganizationStatus({ cfg: params.cfg });
  const section = readCliqSection(params.cfg);
  if (!section) return { downgradeToInfo: false, extraFindings: [] };
  const trusted = readCliqTrustedOrganization(params.cfg);
  const findings: CliqSecurityAuditFinding[] = [];
  if (status === "acknowledged") {
    findings.push({
      checkId: "channels.cliq.trusted_organization.acknowledged",
      severity: "info",
      title: "Trusted-organization deployment acknowledged",
      detail: `channels.cliq.trustedOrganization.acknowledged is true${trusted?.label ? ` (label: ${trusted.label})` : ""}. Organization-wide DM/group access is recorded as a deliberate deployment policy. ${CLIQ_ORGANIZATION_BOUNDARY_STATEMENT}`,
    });
  }
  if (status === "acknowledged_open_without_wildcard") {
    findings.push({
      checkId: "channels.cliq.trusted_organization.acknowledged_but_closed",
      severity: "info",
      title: "Trusted-organization acknowledgement present but access is not open",
      detail:
        'channels.cliq.trustedOrganization.acknowledged is true, but dmPolicy is not "open", allowFrom contains no wildcard, and groupPolicy is not "open". The acknowledgement has no effect — it is metadata only. Remove it, or actually open admission.',
    });
  }
  return { downgradeToInfo: status === "acknowledged", extraFindings: findings };
}
