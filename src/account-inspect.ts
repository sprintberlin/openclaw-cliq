import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import {
  resolveCliqConfig,
  type CliqChannelConfig,
  type ResolvedCliqAccount,
} from "./client.js";

/**
 * OAuth scopes this plugin requests from Zoho. The webhook/bot-message
 * (DM) surface needs `ZohoCliq.Webhooks.CREATE`; channel posts go through
 * the channelsbyname endpoint and need `ZohoCliq.Channels.UPDATE`; the
 * directory adapter reads `ZohoCliq.Users.READ` + `ZohoCliq.Channels.READ`;
 * live-edit / message-edit uses `ZohoCliq.Messages.UPDATE`. Exposed on the
 * inspected account so `openclaw channels inspect` can render what scopes
 * the plugin will mint tokens for (useful when filing the Zoho OAuth client
 * grant — all listed scopes must be consented for the corresponding surface
 * to work).
 */
export const CLIQ_OAUTH_SCOPES: readonly string[] = [
  "ZohoCliq.Webhooks.CREATE",
  "ZohoCliq.Channels.UPDATE",
  "ZohoCliq.Channels.READ",
  "ZohoCliq.Users.READ",
  "ZohoCliq.Messages.UPDATE",
] as const;

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
  allowFrom: string[];
  dmPolicy?: string;
  selfSenderIds: string[];
  ackPolicy: "after_dispatch" | "immediate";
  /** Whether progressive (block-streaming) reply delivery is opted-in. */
  streamingPreview: "on" | "off";
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

function readSection(cfg: OpenClawConfig): CliqChannelConfig | undefined {
  const channels = (cfg as unknown as {
    channels?: Record<string, CliqChannelConfig | undefined>;
  }).channels;
  return channels?.["cliq"];
}

function isConfiguredSection(section: CliqChannelConfig | undefined): boolean {
  return Boolean(section && section.clientId && section.clientSecret && section.botId);
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
  const section = readSection(params.cfg);
  const configured = isConfiguredSection(section);

  let resolved: ResolvedCliqAccount | null = null;
  if (configured) {
    try {
      resolved = resolveCliqConfig(params.cfg, params.accountId ?? null);
    } catch {
      resolved = null;
    }
  }

  const clientSecret = section?.clientSecret;
  const tokenStatus: CliqCredentialStatus = clientSecret
    ? "available"
    : "missing";
  const tokenSource: "config" | "none" = clientSecret ? "config" : "none";

  return {
    accountId,
    enabled: Boolean(section),
    name: section?.botName,
    botId: section?.botId,
    scopes: CLIQ_OAUTH_SCOPES,
    apiBase: CLIQ_API_BASE,
    oauthBase: CLIQ_OAUTH_BASE,
    tokenStatus,
    tokenSource,
    configured,
    config: {
      clientId: section?.clientId,
      botId: section?.botId,
      botName: section?.botName,
      webhookSecret: Boolean(section?.webhookSecret),
      allowFrom: resolved?.allowFrom ?? section?.allowFrom ?? [],
      dmPolicy: section?.dmPolicy,
      selfSenderIds: resolved?.selfSenderIds ?? section?.selfSenderIds ?? [],
      ackPolicy: resolved?.ackPolicy ?? "after_dispatch",
      streamingPreview:
        (section?.streaming?.preview === "on" ? "on" : "off"),
    },
  };
}
