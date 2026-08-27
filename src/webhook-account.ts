import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import { describeWebhookAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { isConfiguredCliqAccountShape } from "./account-inspect.js";
import { CLIQ_DEFAULT_ACCOUNT_ID, type ResolvedCliqAccount } from "./client.js";

/** The single HTTP route the plugin registers for inbound Cliq delivery. */
export const CLIQ_WEBHOOK_ROUTE_PATH = "/cliq/webhook";

/** Transport identifier reported to every status surface. */
export const CLIQ_TRANSPORT_MODE = "webhook" as const;

/**
 * Transport metadata every status surface should agree on for this channel.
 *
 * Cliq is event-driven: inbound delivery arrives as HTTP POSTs from a Zoho
 * Deluge handler, so there is no socket or polling loop. Publishing the mode
 * explicitly lets `openclaw status` describe the integration as a webhook
 * channel instead of implying a connection that is never opened.
 */
export function cliqTransportStatusFields(): {
  mode: typeof CLIQ_TRANSPORT_MODE;
  webhookPath: string;
} {
  return { mode: CLIQ_TRANSPORT_MODE, webhookPath: CLIQ_WEBHOOK_ROUTE_PATH };
}

/**
 * Build the account snapshot the gateway shows for a Cliq account.
 *
 * Wired as `config.describeAccount`, this is the snapshot the startup and
 * status paths read, so it carries the webhook transport fields and a
 * `configured` verdict computed by the same predicate `config.isConfigured`
 * uses. Sharing that predicate is what keeps the `Channels` and `Health`
 * tables from disagreeing about the same account (issue #98).
 */
export function describeCliqWebhookAccount(
  account: ResolvedCliqAccount,
): ChannelAccountSnapshot {
  const named = account as ResolvedCliqAccount & { name?: string };
  return describeWebhookAccountSnapshot({
    account: {
      accountId: account.accountId ?? CLIQ_DEFAULT_ACCOUNT_ID,
      enabled: account.enabled !== false,
      name: named.name ?? account.botName ?? account.botId,
    },
    configured: isConfiguredCliqAccountShape(account),
    mode: CLIQ_TRANSPORT_MODE,
    extra: {
      webhookPath: CLIQ_WEBHOOK_ROUTE_PATH,
      botId: account.botId,
    },
  });
}
