import { mutateConfigFile } from "openclaw/plugin-sdk/config-mutation";
import type { OpenClawConfig } from "openclaw/plugin-sdk/setup";
import {
  buildCliqInboundVerificationPatch,
  decideCliqVerificationWrite,
  type CliqVerificationOutcome,
} from "./inbound-verification.js";

export type CliqConfigMutator = (
  mutate: (draft: OpenClawConfig) => void,
) => Promise<void>;

const defaultMutator: CliqConfigMutator = async (mutate) => {
  // `skipOutputLogs` keeps the SDK's human-readable write notes out of the
  // command's stdout, so `--json` stays pipeable.
  await mutateConfigFile({ mutate, writeOptions: { skipOutputLogs: true } });
};

export interface PersistCliqInboundVerificationParams {
  targetUrl: string;
  configuredUrl: string | undefined;
  outcome: CliqVerificationOutcome;
  suppressed?: boolean;
  foreignSecret?: boolean;
  now?: Date;
  mutator?: CliqConfigMutator;
}

export interface PersistCliqInboundVerificationResult {
  written: boolean;
  reason: string;
  at?: string;
}

export async function persistCliqInboundVerification(
  params: PersistCliqInboundVerificationParams,
): Promise<PersistCliqInboundVerificationResult> {
  const decision = decideCliqVerificationWrite({
    targetUrl: params.targetUrl,
    configuredUrl: params.configuredUrl,
    suppressed: params.suppressed === true,
    foreignSecret: params.foreignSecret === true,
  });
  if (!decision.write) return { written: false, reason: decision.reason };

  const at = (params.now ?? new Date()).toISOString();
  const patch = buildCliqInboundVerificationPatch(params.outcome, at);
  const mutator = params.mutator ?? defaultMutator;
  let written = false;
  await mutator((draft) => {
    const root = draft as unknown as { channels?: Record<string, Record<string, unknown>> };
    const section = root.channels?.cliq;
    if (!section) return;
    const currentUrl = section.publicWebhookUrl;
    const currentDecision = decideCliqVerificationWrite({
      targetUrl: params.targetUrl,
      configuredUrl: typeof currentUrl === "string" ? currentUrl : undefined,
      suppressed: false,
    });
    if (!currentDecision.write) return;
    if (patch.inboundVerifiedAt === undefined) delete section.inboundVerifiedAt;
    else section.inboundVerifiedAt = patch.inboundVerifiedAt;
    if (patch.inboundVerificationFailedAt === undefined) {
      delete section.inboundVerificationFailedAt;
    } else {
      section.inboundVerificationFailedAt = patch.inboundVerificationFailedAt;
    }
    written = true;
  });

  if (!written) {
    return {
      written: false,
      reason: "the config changed before it could be written, so no verification state was recorded",
    };
  }
  return {
    written: true,
    at,
    reason:
      params.outcome === "pass"
        ? `recorded channels.cliq.inboundVerifiedAt = ${at}`
        : `recorded channels.cliq.inboundVerificationFailedAt = ${at} and cleared any stale verification`,
  };
}

export interface PersistCliqHandlerUrlAdoptionParams {
  url: string;
  configuredUrl: string | undefined;
  accountId?: string;
  foreignSecret?: boolean;
  now?: Date;
  mutator?: CliqConfigMutator;
}

/**
 * Atomically store a verified handler URL and its inbound verification
 * timestamp (issue #172). Writes only when `publicWebhookUrl` is still
 * absent; a foreign-secret probe or a live config that already has a URL
 * leaves the file unchanged.
 */
export async function persistCliqHandlerUrlAdoption(
  params: PersistCliqHandlerUrlAdoptionParams,
): Promise<PersistCliqInboundVerificationResult> {
  if (params.foreignSecret) {
    return {
      written: false,
      reason:
        "--secret overrode the configured webhookSecret, so this run does not prove the configured secret works and was not recorded",
    };
  }
  if (params.configuredUrl) {
    return {
      written: false,
      reason:
        "channels.cliq.publicWebhookUrl is already configured, so the handler URL was not adopted",
    };
  }

  const at = (params.now ?? new Date()).toISOString();
  const mutator = params.mutator ?? defaultMutator;
  let written = false;
  let section: Record<string, unknown> | undefined;
  let previousPublicWebhookUrl: unknown;
  let previousInboundVerifiedAt: unknown;
  let previousHadInboundVerifiedAt = false;
  let previousInboundVerificationFailedAt: unknown;
  let previousHadInboundVerificationFailedAt = false;
  try {
    await mutator((draft) => {
      const root = draft as unknown as { channels?: Record<string, Record<string, unknown>> };
      const cliq = root.channels?.cliq;
      if (!cliq) return;
      if (params.accountId && params.accountId !== "default") {
        const accounts = cliq.accounts;
        if (!accounts || typeof accounts !== "object") return;
        const account = (accounts as Record<string, Record<string, unknown> | undefined>)[params.accountId];
        if (!account) return;
        section = account;
      } else {
        section = cliq;
      }
      const currentUrl = section.publicWebhookUrl;
      if (typeof currentUrl === "string" && currentUrl.trim()) return;
      previousPublicWebhookUrl = currentUrl;
      previousHadInboundVerifiedAt = Object.prototype.hasOwnProperty.call(section, "inboundVerifiedAt");
      previousInboundVerifiedAt = section.inboundVerifiedAt;
      previousHadInboundVerificationFailedAt = Object.prototype.hasOwnProperty.call(
        section,
        "inboundVerificationFailedAt",
      );
      previousInboundVerificationFailedAt = section.inboundVerificationFailedAt;
      section.publicWebhookUrl = params.url;
      section.inboundVerifiedAt = at;
      delete section.inboundVerificationFailedAt;
      written = true;
    });
  } catch (err) {
    if (written && section) {
      if (previousPublicWebhookUrl === undefined) delete section.publicWebhookUrl;
      else section.publicWebhookUrl = previousPublicWebhookUrl;
      if (previousHadInboundVerifiedAt) section.inboundVerifiedAt = previousInboundVerifiedAt;
      else delete section.inboundVerifiedAt;
      if (previousHadInboundVerificationFailedAt) {
        section.inboundVerificationFailedAt = previousInboundVerificationFailedAt;
      } else {
        delete section.inboundVerificationFailedAt;
      }
    }
    const detail = err instanceof Error ? err.message : "unknown error";
    return {
      written: false,
      reason: `the config could not be written: ${detail}`,
    };
  }

  if (!written) {
    return {
      written: false,
      reason: "the config changed before it could be written, so no verification state was recorded",
    };
  }
  return {
    written: true,
    at,
    reason: `recorded channels.cliq.publicWebhookUrl and inboundVerifiedAt = ${at}`,
  };
}
