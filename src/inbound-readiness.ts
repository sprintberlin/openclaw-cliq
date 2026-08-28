import type { CliqPreflightReport } from "./webhook-preflight.js";

/**
 * Inbound readiness gate for Cliq setup (issue #96).
 *
 * Having credentials in the config proves nothing about inbound delivery:
 * Zoho has to be able to *call* the gateway. Setup must therefore not report
 * inbound Cliq as ready on configuration alone — it must have seen a passing
 * public webhook preflight.
 *
 * The gate deliberately treats "never verified" as NOT ready rather than as a
 * soft warning. An operator who is told inbound is ready stops looking, and
 * the failure then surfaces as silence in Cliq, which is the single hardest
 * symptom to diagnose in this channel.
 */
export interface CliqInboundReadinessInput {
  /** Whether the channel config itself is complete (creds + webhook secret). */
  configured: boolean;
  /** The public webhook URL, when one is known. */
  publicUrl: string | undefined;
  /** The preflight report, when one has been run. */
  preflight: CliqPreflightReport | undefined;
}

export interface CliqInboundReadiness {
  ready: boolean;
  inconclusive?: boolean;
  reason: string;
}

/** First stage that actually failed, for a specific remediation message. */
function firstFailure(report: CliqPreflightReport): string | undefined {
  return report.stages.find((s) => s.status === "fail")?.detail;
}

/**
 * Decide whether inbound Cliq may be reported as ready.
 *
 * Ready requires all three: a complete config, a known public URL, and a
 * preflight report whose every stage passed.
 */
export function resolveCliqInboundReadiness(
  input: CliqInboundReadinessInput,
): CliqInboundReadiness {
  if (!input.configured) {
    return {
      ready: false,
      reason:
        "the cliq channel is not configured — clientId, clientSecret, botId, and webhookSecret are all required before inbound delivery can work",
    };
  }
  if (!input.publicUrl) {
    return {
      ready: false,
      reason:
        "no public webhook URL is known — Zoho Cliq delivers inbound messages by calling the gateway, so it needs a public https URL (see docs/setup/public-webhook.md)",
    };
  }
  if (!input.preflight) {
    return {
      ready: false,
      reason:
        "the public webhook has not been verified — run the preflight before treating inbound Cliq as ready",
    };
  }
  if (!input.preflight.ok) {
    const detail = firstFailure(input.preflight);
    if (!detail) {
      const warning = input.preflight.stages.find((stage) => stage.status === "warn")?.detail;
      return {
        ready: false,
        inconclusive: true,
        reason: warning
          ? `the public webhook preflight was inconclusive: ${warning}`
          : "the public webhook preflight was inconclusive",
      };
    }
    return {
      ready: false,
      reason: `the public webhook preflight failed: ${detail}`,
    };
  }
  return {
    ready: true,
    reason: `the public webhook at ${input.publicUrl} is reachable and enforces the shared secret`,
  };
}
