import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { hasConfiguredSecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import {
  readEffectiveCliqSection,
  resolveCliqConfig,
  resolveCliqApiVersion,
  type CliqApiFamily,
  type CliqApiVersion,
  type CliqChannelConfig,
  type ResolvedCliqAccount,
} from "./client.js";
import {
  ALL_CAPABILITY_SCOPES,
  RUNTIME_SCOPE_STRING,
  SETUP_INSPECT_SCOPE_STRING,
  SETUP_PROVISION_SCOPE_STRING,
  SETUP_SCOPE_STRING,
  FULL_SCOPE_STRING,
} from "./capabilities.js";

/**
 * OAuth scopes this plugin requests from Zoho — derived from the capability
 * matrix (`src/capabilities.ts`) as the single source of truth.
 *
 * Exposed on the inspected account so `openclaw channels inspect` can render
 * what scopes the plugin will mint tokens for (useful when filing the Zoho
 * OAuth client grant — all listed scopes must be consented for the
 * corresponding surface to work).
 */
export const CLIQ_OAUTH_SCOPES: readonly string[] = ALL_CAPABILITY_SCOPES;

/**
 * Canonical scope strings for the two capability profiles. These are the
 * comma-separated strings an operator copies into the Zoho API Console's
 * "Generate Code" scope field.
 *
 * - `RUNTIME` — all scopes needed for normal DM/channel messaging + optional
 *   features (reactions, media, streaming, message read/delete).
 * - `SETUP_INSPECT` — `ZohoCliq.Bots.READ` only, for existing-bot inspection.
 * - `SETUP_PROVISION` — bot read/create/update for bot + handler provisioning.
 * - `FULL` — combined (runtime + setup provisioning) for a single consent that covers
 *   everything.
 */
export const CLIQ_SCOPE_PROFILES = {
  runtime: RUNTIME_SCOPE_STRING,
  setupInspect: SETUP_INSPECT_SCOPE_STRING,
  setupProvision: SETUP_PROVISION_SCOPE_STRING,
  setup: SETUP_SCOPE_STRING,
  full: FULL_SCOPE_STRING,
} as const;

/** Hard-coded EU endpoints (see AGENTS.md — `.com` would require a code change). */
export const CLIQ_API_BASE = "https://cliq.zoho.eu";
export const CLIQ_OAUTH_BASE = "https://accounts.zoho.eu";

const DEFAULT_ACCOUNT_ID = "default";

export type CliqCredentialStatus =
  | "available"
  | "configured_unavailable"
  | "missing";

/**
 * Redacted snapshot of the resolved Cliq account config — secret *values* are
 * never exposed (only presence flags), so `openclaw channels inspect` can
 * surface what's configured without leaking `clientSecret` / `webhookSecret`.
 */
export interface InspectedCliqAccountConfig {
  clientId?: string;
  botId?: string;
  botName?: string;
  /** Whether a webhook shared secret is configured (presence only). */
  webhookSecret: boolean;
  /**
   * Whether a user-context OAuth refresh token is configured (presence
   * only — required for channel posts and message edits; see README §3).
   */
  refreshToken: boolean;
  allowFrom: string[];
  dmPolicy?: string;
  groupPolicy?: string;
  /**
   * Explicit trusted-organization acknowledgement (presence + label only).
   * Reported so operators can see that organization-wide access is a
   * deliberate policy rather than an accidental wildcard.
   */
  trustedOrganization?: {
    acknowledged: boolean;
    label?: string;
    acknowledgedAt?: string;
  };
  selfSenderIds: string[];
  ackPolicy: "after_dispatch" | "immediate";
  /** Whether progressive (block-streaming) reply delivery is opted-in. */
  streamingPreview: "on" | "off";
  /** Per-family resolved REST API generation (dmPost / channelPost / channelCard / delete). */
  apiVersion: Record<CliqApiFamily, CliqApiVersion>;
}

export interface InspectedCliqAccount {
  /** Normalized account id (falls back to `"default"` for the single-account case). */
  accountId: string;
  /** Whether the channel section is enabled (Cliq has no `enabled` flag — `true` when the section exists). */
  enabled: boolean;
  /** Human-friendly bot name (bot identity). */
  name?: string;
  /** Bot unique name used in the Cliq bot-message API URL (bot identity). */
  botId?: string;
  /** OAuth scopes the plugin requests. */
  scopes: readonly string[];
  /**
   * Canonical scope strings for the two capability profiles. Operators copy
   * these into the Zoho API Console's "Generate Code" scope field.
   */
  scopeProfiles: {
    /** All runtime scopes (DM, channel, messaging, rich features). */
    runtime: string;
    /** Inspect-only setup scope (bot read). */
    setupInspect: string;
    /** Setup provisioning scopes (bot read/create/update). */
    setupProvision: string;
    /** Backward-compatible alias for setup provisioning. */
    setup: string;
    /** Combined (runtime + setup). */
    full: string;
  };
  /** EU REST API base URL. */
  apiBase: string;
  /** EU OAuth base URL. */
  oauthBase: string;
  /** Status of the `clientSecret` credential (the OAuth grant secret). */
  tokenStatus: CliqCredentialStatus;
  /** Where the `clientSecret` is sourced from. */
  tokenSource: "config" | "none";
  /** Whether all three core credentials (clientId/clientSecret/botId) are present. */
  configured: boolean;
  /** Redacted resolved account config. */
  config: InspectedCliqAccountConfig;
}

function readSection(cfg: OpenClawConfig, accountId?: string | null): CliqChannelConfig | undefined {
  return readEffectiveCliqSection(cfg, accountId).section;
}

/**
 * Whether a Cliq channel section is "configured" — all three core credentials
 * (clientId / clientSecret / botId) are present. The secret fields use the
 * SDK's `hasConfiguredSecretInput` so a SecretRef-configured `clientSecret`
 * (the form `openclaw secrets apply` produces) still counts as present,
 * rather than being reported as missing because the value is no longer a
 * plaintext string.
 */
function isConfiguredSection(section: CliqChannelConfig | undefined): boolean {
  return Boolean(
    section &&
      section.clientId &&
      hasConfiguredSecretInput(section.clientSecret) &&
      section.botId,
  );
}

/**
 * Whether an account object counts as configured, accepting BOTH account
 * shapes the gateway hands to `config.isConfigured`.
 *
 * `openclaw channels status` passes the *resolved* account (plaintext
 * `clientId`/`clientSecret`/`botId`), while the gateway health path passes the
 * *redacted* `inspectAccount` result, which deliberately carries no
 * `clientSecret` at all and keeps `clientId` under `config`. A predicate that
 * only understands the resolved shape therefore reports a healthy account as
 * "not configured" on the Health table while the Channels table says
 * "configured" — the same account, contradicting itself in the same second
 * (issue #98).
 *
 * For the redacted shape, credential presence is read from `tokenStatus`:
 * `"available"` and `"configured_unavailable"` both mean the operator
 * configured a secret (the latter is a file/exec SecretRef that cannot be
 * resolved synchronously), matching the SDK's own snapshot semantics. Only
 * `"missing"` counts as unconfigured.
 */
export function isConfiguredCliqAccountShape(account: unknown): boolean {
  if (!account || typeof account !== "object") return false;
  const shape = account as {
    clientId?: unknown;
    clientSecret?: unknown;
    botId?: unknown;
    configured?: unknown;
    tokenStatus?: unknown;
    config?: { clientId?: unknown; botId?: unknown };
  };
  // Redacted `inspectAccount` shape: it already computed `configured` from the
  // raw section (SecretRef-aware), so trust it rather than re-deriving from
  // fields it intentionally omits.
  if (typeof shape.tokenStatus === "string") {
    if (typeof shape.configured === "boolean") return shape.configured;
    const clientId = shape.clientId ?? shape.config?.clientId;
    const botId = shape.botId ?? shape.config?.botId;
    return Boolean(clientId && botId && shape.tokenStatus !== "missing");
  }
  // Resolved runtime account shape.
  return Boolean(shape.clientId && shape.clientSecret && shape.botId);
}

/**
 * Inspect a Cliq account for `openclaw channels inspect` / `openclaw configure`.
 *
 * Mirrors the shape the bundled Telegram/Discord channels return (accountId,
 * enabled, name, token*, configured, config) but adapted to Cliq's
 * `client_credentials` OAuth model: there is no single bot token, so
 * `tokenStatus` reports the `clientSecret` (the OAuth grant secret), and the
 * inspected `config` includes bot identity, OAuth scopes, EU endpoints, and the
 * configured admission surfaces (allowFrom / dmPolicy / webhookSecret presence
 * / selfSenderIds / ackPolicy) — the things an operator needs to verify the
 * channel is wired correctly.
 *
 * Never throws: an unconfigured / partially-configured account is reported with
 * `configured: false` and per-field presence flags, not as an error.
 */
export function inspectCliqAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): InspectedCliqAccount {
  const accountId = (params.accountId ?? null) ?? DEFAULT_ACCOUNT_ID;
  const section = readSection(params.cfg, params.accountId);
  const configured = isConfiguredSection(section);

  let resolved: ResolvedCliqAccount | null = null;
  if (configured) {
    try {
      resolved = resolveCliqConfig(params.cfg, params.accountId ?? null);
    } catch {
      resolved = null;
    }
  }

  const clientSecretConfigured =
    section?.clientSecret !== undefined &&
    hasConfiguredSecretInput(section.clientSecret);
  const tokenStatus: CliqCredentialStatus = clientSecretConfigured
    ? "available"
    : "missing";
  const tokenSource: "config" | "none" = clientSecretConfigured
    ? "config"
    : "none";

  return {
    accountId,
    // A present section is enabled unless it explicitly opts out; an absent
    // section is not an account at all (issue #125).
    enabled: Boolean(section) && section?.enabled !== false,
    name: section?.botName,
    botId: section?.botId,
    scopes: CLIQ_OAUTH_SCOPES,
    scopeProfiles: CLIQ_SCOPE_PROFILES,
    apiBase: resolved?.apiBase ?? section?.apiBase ?? CLIQ_API_BASE,
    oauthBase: resolved?.oauthBase ?? section?.oauthBase ?? CLIQ_OAUTH_BASE,
    tokenStatus,
    tokenSource,
    configured,
    config: {
      clientId: section?.clientId,
      botId: section?.botId,
      botName: section?.botName,
      webhookSecret: Boolean(
        section?.webhookSecret !== undefined &&
          hasConfiguredSecretInput(section.webhookSecret),
      ),
      refreshToken: Boolean(
        section?.refreshToken !== undefined &&
          hasConfiguredSecretInput(section.refreshToken),
      ),
      allowFrom: resolved?.allowFrom ?? section?.allowFrom ?? [],
      dmPolicy: section?.dmPolicy,
      groupPolicy: section?.groupPolicy,
      trustedOrganization: resolved?.trustedOrganization
        ? {
            acknowledged: true,
            ...(resolved.trustedOrganization.label
              ? { label: resolved.trustedOrganization.label }
              : {}),
            ...(resolved.trustedOrganization.acknowledgedAt
              ? { acknowledgedAt: resolved.trustedOrganization.acknowledgedAt }
              : {}),
          }
        : undefined,
      selfSenderIds: resolved?.selfSenderIds ?? section?.selfSenderIds ?? [],
      ackPolicy: resolved?.ackPolicy ?? "after_dispatch",
      streamingPreview:
        (section?.streaming?.preview === "on" ? "on" : "off"),
      apiVersion: {
        dmPost: resolveCliqApiVersion(resolved?.apiVersion, "dmPost"),
        channelPost: resolveCliqApiVersion(resolved?.apiVersion, "channelPost"),
        channelCard: resolveCliqApiVersion(resolved?.apiVersion, "channelCard"),
        delete: resolveCliqApiVersion(resolved?.apiVersion, "delete"),
      },
    },
  };
}
