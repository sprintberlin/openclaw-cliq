import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { buildCliqHandlerScript } from "./bot-provisioning.js";
import { validateWebhookUrl } from "./webhook-preflight.js";

/** Literal emitted when no output-safe secret source was explicitly supplied. */
export const CLIQ_HANDLER_SECRET_PLACEHOLDER = "<webhookSecret>";

export interface CliqPrintHandlersCommandOptions {
  cfg?: OpenClawConfig;
  webhookUrl?: string;
  /**
   * An explicitly supplied secret for a one-time console paste. The command
   * never falls back to the configured secret: reading it merely to print it
   * would put a credential into terminal scrollback by surprise.
   */
  webhookSecret?: string;
  json?: boolean;
}

export interface CliqPrintHandlersCommandDeps {
  writeLine: (line: string) => void;
  writeError: (line: string) => void;
}

const defaultDeps: CliqPrintHandlersCommandDeps = {
  writeLine: (line) => process.stdout.write(`${line}\n`),
  writeError: (line) => process.stderr.write(`${line}\n`),
};

function configuredWebhookUrl(cfg: OpenClawConfig | undefined): string | undefined {
  const root = cfg as unknown as { channels?: { cliq?: { publicWebhookUrl?: unknown } } };
  const value = root?.channels?.cliq?.publicWebhookUrl;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Render the canonical Message and Mention Deluge handlers for manual console
 * pasting. This is deliberately a thin wrapper around the provisioning
 * builder so the manually pasted scripts cannot drift from API provisioning.
 */
export function runCliqPrintHandlersCommand(
  options: CliqPrintHandlersCommandOptions,
  deps: CliqPrintHandlersCommandDeps = defaultDeps,
): number {
  const webhookUrl = options.webhookUrl?.trim() || configuredWebhookUrl(options.cfg);
  if (!webhookUrl) {
    deps.writeError("Missing --webhook-url (and channels.cliq.publicWebhookUrl is not configured).");
    return 2;
  }
  const validation = validateWebhookUrl(webhookUrl);
  if (!validation.ok) {
    deps.writeError(`Invalid webhook URL: ${validation.reason}.`);
    return 2;
  }

  const webhookSecret = options.webhookSecret?.trim() || CLIQ_HANDLER_SECRET_PLACEHOLDER;
  const messageHandler = buildCliqHandlerScript({
    handlerType: "message_handler",
    webhookUrl,
    webhookSecret,
  });
  const mentionHandler = buildCliqHandlerScript({
    handlerType: "mention_handler",
    webhookUrl,
    webhookSecret,
  });

  if (options.json) {
    deps.writeLine(JSON.stringify({ messageHandler, mentionHandler, webhookUrl }, null, 2));
  } else {
    deps.writeLine("=== message_handler (DMs) ===");
    deps.writeLine(messageHandler);
    deps.writeLine("=== mention_handler (channels) ===");
    deps.writeLine(mentionHandler);
  }
  return 0;
}
