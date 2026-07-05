import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { ChannelSecretsAdapter } from "openclaw/plugin-sdk/channel-runtime";
import {
  collectSimpleChannelFieldAssignments,
  getChannelSurface,
  type ResolverContext,
  type SecretDefaults,
  type SecretTargetRegistryEntry,
} from "openclaw/plugin-sdk/channel-secret-runtime";

/**
 * The three Cliq config fields that carry secret material and are therefore
 * eligible for `openclaw secrets` management (audit / apply / reload):
 *
 *  - `clientSecret` — the OAuth `client_credentials` grant secret (required).
 *  - `webhookSecret` — the shared secret used to verify `x-cliq-webhook-secret`
 *    on inbound delivery (recommended).
 *  - `refreshToken` — the user-context OAuth refresh token (required for
 *    channel posts + message edits; see README §3).
 *
 * Cliq is single-account (no `channels.cliq.accounts.*` nesting — see the
 * doctor adapter's `dmAllowFromMode: "topOnly"`), so each field has exactly
 * one registered target at the channel root. The bundled Discord/Telegram
 * channels register per-account variants too; Cliq does not need them yet.
 */
const CLIQ_SECRET_FIELDS = [
  "clientSecret",
  "webhookSecret",
  "refreshToken",
] as const;

/**
 * Registry entries consumed by `openclaw secrets` (audit / apply / configure
 * / plan / targeted discovery). Each entry declares one secret-bearing config
 * path so the CLI can:
 *  - **audit** — scan `openclaw.json` for plaintext values at these paths
 *    (`includeInAudit`).
 *  - **apply** — rewrite plaintext at these paths into SecretRef form
 *    (`includeInPlan` + the `collectRuntimeConfigAssignments` apply hooks).
 *  - **configure** — generate interactive configure candidates for these
 *    fields (`includeInConfigure`).
 *
 * `secretShape: "secret_input"` means the value is stored inline as a
 * `SecretInput` (a `string | SecretRef`), not via a sibling `*Ref` field.
 */
export const cliqSecretTargetRegistryEntries: SecretTargetRegistryEntry[] =
  CLIQ_SECRET_FIELDS.map((field) => ({
    id: `channels.cliq.${field}`,
    targetType: `channels.cliq.${field}`,
    configFile: "openclaw.json",
    pathPattern: `channels.cliq.${field}`,
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  }));

/**
 * Collect runtime config assignments for `openclaw secrets apply` — walks each
 * registered Cliq secret field at the channel root (and any explicit
 * per-account overrides, though Cliq has none today) and feeds it through
 * `collectSecretInputAssignment`, whose `apply` callback rewrites the value in
 * place (plaintext → SecretRef). Delegates to the SDK's
 * `collectSimpleChannelFieldAssignments` so active/inactive surface reasoning
 * matches every other channel: a field is "active" when its owning surface is
 * enabled and (for accounts) the account is enabled.
 */
export function collectCliqRuntimeConfigAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, "cliq");
  if (!resolved) return;
  const { channel: cliq, surface } = resolved;
  for (const field of CLIQ_SECRET_FIELDS) {
    collectSimpleChannelFieldAssignments({
      channelKey: "cliq",
      field,
      channel: cliq,
      surface,
      defaults: params.defaults,
      context: params.context,
      topInactiveReason: `no enabled Cliq surface inherits this top-level ${field}.`,
      accountInactiveReason: "Cliq account is disabled.",
    });
  }
}

/**
 * Cliq channel secrets adapter. Wired onto the plugin's `base` (forwarded by
 * `createChatChannelPlugin`'s `{ ...params.base }` spread) so `openclaw secrets
 * audit/apply/reload` recognize the three Cliq secret fields and can move
 * them out of plaintext config.
 */
export const cliqSecretsAdapter: ChannelSecretsAdapter = {
  secretTargetRegistryEntries: cliqSecretTargetRegistryEntries,
  collectRuntimeConfigAssignments: collectCliqRuntimeConfigAssignments,
};
