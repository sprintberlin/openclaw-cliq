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
