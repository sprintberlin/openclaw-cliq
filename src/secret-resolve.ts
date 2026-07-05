import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import {
  resolveSecretInputString,
  normalizeSecretInputString,
} from "openclaw/plugin-sdk/secret-input-runtime";

/**
 * Built-in default provider alias used when a SecretRef omits a source-specific
 * provider and no `secrets.defaults.env` is configured. Inlined (rather than
 * imported from `openclaw/plugin-sdk/provider-auth`, which is a heavy module)
 * to match the SDK's `DEFAULT_SECRET_PROVIDER_ALIAS` constant — Cliq only
 * resolves env-backed refs synchronously, so this single alias suffices.
 */
const DEFAULT_ENV_PROVIDER_ALIAS = "default";

/**
 * Read the `secrets` block from config as a loose record (it is optional and
 * its shape is governed by the SDK's `SecretsConfig`, not by Cliq).
 */
function readSecretsConfig(cfg: OpenClawConfig): {
  providers?: Record<string, { source?: string; allowlist?: string[] }>;
  defaults?: { env?: string; file?: string; exec?: string };
} | undefined {
  return (cfg as unknown as {
    secrets?: {
      providers?: Record<string, { source?: string; allowlist?: string[] }>;
      defaults?: { env?: string; file?: string; exec?: string };
    };
  }).secrets;
}

/**
 * Resolve an env-backed SecretRef to its literal value by reading the env var
 * `ref.id`. Mirrors the bundled Telegram channel's `resolveEnvSecretRefValue`:
 * validates the named provider is an `env` source (and that the id is on its
 * allowlist when one is configured), then reads the env var. A missing env var
 * resolves to an empty string (the caller treats that as "credential not
 * available", matching how Telegram returns `token: ""` / `source: "none"`).
 */
function resolveEnvSecretRefValue(params: {
  cfg: OpenClawConfig;
  provider: string;
  id: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const secrets = readSecretsConfig(params.cfg);
  const providerConfig = secrets?.providers?.[params.provider];
  const defaultAlias =
    secrets?.defaults?.env?.trim() || DEFAULT_ENV_PROVIDER_ALIAS;
  if (providerConfig) {
    if (providerConfig.source !== "env") {
      throw new Error(
        `Secret provider "${params.provider}" has source "${providerConfig.source}" but ref requests "env".`,
      );
    }
    if (
      providerConfig.allowlist &&
      !providerConfig.allowlist.includes(params.id)
    ) {
      throw new Error(
        `Environment variable "${params.id}" is not allowlisted in secrets.providers.${params.provider}.allowlist.`,
      );
    }
  } else if (params.provider !== defaultAlias) {
    throw new Error(
      `Secret provider "${params.provider}" is not configured (ref: env:${params.provider}:${params.id}).`,
    );
  }
  return (
    normalizeSecretInputString((params.env ?? process.env)[params.id]) ?? ""
  );
}

/**
 * Synchronously resolve a Cliq secret-bearing config field to a literal string.
 *
 * Cliq's secret fields (`clientSecret`, `webhookSecret`, `refreshToken`) may
 * be configured either as plaintext strings or as structured SecretRef objects
 * (the form `openclaw secrets apply` rewrites plaintext into). The gateway
 * does NOT auto-resolve registered channel secret paths before handing config
 * to a plugin channel, so the channel must resolve them itself.
 *
 * Resolution model (mirrors the bundled Telegram channel's
 * `resolveRuntimeTokenValue`):
 *  - **plaintext** → returned verbatim (trimmed).
 *  - **env-backed SecretRef** → the named env var is read synchronously; a
 *    missing/empty env var resolves to `""` (treated as "not available").
 *  - **file/exec-backed SecretRef** → cannot be resolved synchronously, so
 *    `""` is returned (the credential is reported as unavailable, same as a
 *    missing one). The async `resolveConfiguredSecretInputString` would be
 *    needed to fully resolve these, but the channel's `resolveAccount` path
 *    is synchronous and consumed everywhere; matching Telegram, we accept
 *    this limitation and only support plaintext + env refs at runtime.
 *  - **missing** → `""`.
 *
 * Never returns `undefined`; always a string (possibly empty). Callers that
 * require a non-empty value (e.g. `clientSecret`) validate and throw.
 */
export function resolveCliqSecretString(params: {
  cfg: OpenClawConfig;
  value: unknown;
  path: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const secrets = readSecretsConfig(params.cfg);
  const resolved = resolveSecretInputString({
    value: params.value,
    path: params.path,
    defaults: secrets?.defaults,
    mode: "inspect",
  });
  if (resolved.status === "available") {
    return resolved.value ?? "";
  }
  if (resolved.status === "missing") {
    return "";
  }
  // configured_unavailable — a SecretRef is present. Only env-backed refs
  // can be resolved synchronously; file/exec degrade to "" (unavailable).
  if (resolved.ref.source === "env") {
    const envValue = resolveEnvSecretRefValue({
      cfg: params.cfg,
      provider: resolved.ref.provider,
      id: resolved.ref.id,
      env: params.env,
    });
    if (envValue) return envValue;
    return "";
  }
  return "";
}
