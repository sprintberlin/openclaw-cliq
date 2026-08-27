export type CliqVerificationOutcome = "pass" | "fail";

export interface CliqInboundVerificationPatch {
  inboundVerifiedAt: string | undefined;
  inboundVerificationFailedAt: string | undefined;
}

export function buildCliqInboundVerificationPatch(
  outcome: CliqVerificationOutcome,
  at: string,
): CliqInboundVerificationPatch {
  return {
    inboundVerifiedAt: outcome === "pass" ? at : undefined,
    inboundVerificationFailedAt: outcome === "fail" ? at : undefined,
  };
}

function canonicalUrl(raw: string): string {
  const trimmed = raw.trim();
  try {
    const parsed = new URL(trimmed);
    // `host` keeps an explicit default port, which would make
    // `https://h:443/cliq/webhook` a different endpoint from `https://h/...`.
    const path = parsed.pathname.replace(/\/+$/, "");
    const port =
      (parsed.protocol === "https:" && parsed.port === "443") ||
      (parsed.protocol === "http:" && parsed.port === "80")
        ? ""
        : parsed.port;
    const authority = port ? `${parsed.hostname.toLowerCase()}:${port}` : parsed.hostname.toLowerCase();
    return `${parsed.protocol}//${authority}${path}${parsed.search}`;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

export function isSameWebhookUrl(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return canonicalUrl(a) === canonicalUrl(b);
}

export interface CliqVerificationWriteDecisionInput {
  targetUrl: string;
  configuredUrl: string | undefined;
  suppressed: boolean;
  /**
   * The probe authenticated with a secret other than the configured one
   * (`--secret`). Such a run says nothing about whether *this install's*
   * configured secret works, so its verdict must not be recorded.
   */
  foreignSecret?: boolean;
}

export interface CliqVerificationWriteDecision {
  write: boolean;
  reason: string;
}

export function decideCliqVerificationWrite(
  input: CliqVerificationWriteDecisionInput,
): CliqVerificationWriteDecision {
  if (input.suppressed) {
    return { write: false, reason: "--no-write was given, so the result was not recorded" };
  }
  if (input.foreignSecret) {
    return {
      write: false,
      reason:
        "--secret overrode the configured webhookSecret, so this run does not prove the configured secret works and was not recorded",
    };
  }
  if (!input.configuredUrl) {
    return {
      write: false,
      reason:
        "channels.cliq.publicWebhookUrl is not configured, so there is no install to record this result against",
    };
  }
  if (!isSameWebhookUrl(input.targetUrl, input.configuredUrl)) {
    return {
      write: false,
      reason: `the checked URL is not the configured channels.cliq.publicWebhookUrl (${input.configuredUrl}), so nothing was recorded`,
    };
  }
  return {
    write: true,
    reason: "the checked URL is the configured channels.cliq.publicWebhookUrl",
  };
}

export function describeCliqInboundVerification(params: {
  publicUrl: string | undefined;
  verifiedAt: string | undefined;
  failedAt: string | undefined;
}): string {
  if (!params.publicUrl) return "inbound: never checked (no public webhook URL configured)";
  const verifiedAt = params.verifiedAt;
  const failedAt = params.failedAt;
  if (verifiedAt && failedAt) {
    // Both fields set means a write path did not clear its sibling. Trust the
    // newer one rather than always preferring "verified": reporting a stale
    // pass over a fresh failure is the exact lie this field exists to prevent.
    return failedAt > verifiedAt
      ? `inbound: last check FAILED ${failedAt} at ${params.publicUrl}`
      : `inbound: verified ${verifiedAt} at ${params.publicUrl}`;
  }
  if (verifiedAt) return `inbound: verified ${verifiedAt} at ${params.publicUrl}`;
  if (failedAt) return `inbound: last check FAILED ${failedAt} at ${params.publicUrl}`;
  return `inbound: never checked (${params.publicUrl})`;
}
