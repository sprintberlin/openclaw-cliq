import { createHash } from "node:crypto";
import type { WizardPrompter } from "openclaw/plugin-sdk/setup";
import type { CliqResolvedAllowlistEntry } from "./setup-directory.js";

export type CliqFirstContactResult =
  | { sent: true; chatId: string; messageId: string }
  | { sent: false; reason: "cancelled" | "send_failed"; detail?: string };

export function redactCliqIdentifier(value: string | undefined): string {
  const cleaned = value?.trim();
  if (!cleaned) return "unknown";
  const prefix = cleaned.includes("_") ? `${cleaned.split("_", 1)[0]}_` : cleaned.slice(0, 3);
  const fingerprint = createHash("sha256").update(cleaned, "utf8").digest("hex").slice(0, 8);
  return `${prefix}…${fingerprint}`;
}

function safeFailure(err: unknown, sensitiveValues: readonly string[]): string {
  let message = err instanceof Error ? err.message : String(err);
  for (const value of sensitiveValues) {
    if (value) message = message.split(value).join("[redacted]");
  }
  const status = /(?:HTTP\s*)?(\d{3})/i.exec(message)?.[1];
  return status ? `Zoho rejected the first-contact DM with HTTP ${status}` : "the first-contact DM failed";
}

export async function sendCliqFirstContactDm(params: {
  client: {
    sendMessage(options: { to: string; text: string; isDm?: boolean }): Promise<{
      messageId?: string;
      chatId?: string;
    }>;
  };
  target: Pick<CliqResolvedAllowlistEntry, "id" | "label" | "resolved">;
  prompter: Pick<WizardPrompter, "confirm" | "note">;
  sensitiveValues?: readonly string[];
}): Promise<CliqFirstContactResult> {
  const label = params.target.label ?? params.target.id;
  const warning = params.target.resolved
    ? ""
    : " The directory could not resolve this target, so confirm the literal value carefully.";
  const confirmed = await params.prompter.confirm({
    message: `Send one clearly labeled first-contact test DM to ${label}?${warning}`,
    initialValue: false,
  });
  if (!confirmed) return { sent: false, reason: "cancelled" };
  try {
    const sent = await params.client.sendMessage({
      to: params.target.id,
      isDm: true,
      text: "[OpenClaw Cliq first-contact test] Setup sent this one-time message after explicit operator confirmation. Reply here to continue the conversation.",
    });
    const result: CliqFirstContactResult = {
      sent: true,
      chatId: redactCliqIdentifier(sent.chatId),
      messageId: redactCliqIdentifier(sent.messageId),
    };
    await params.prompter.note(
      `First-contact DM sent. Redacted chat id: ${result.chatId}; redacted message id: ${result.messageId}.`,
      "Zoho Cliq first contact",
    );
    return result;
  } catch (err) {
    const detail = safeFailure(err, params.sensitiveValues ?? []);
    await params.prompter.note(detail, "Zoho Cliq first contact");
    return { sent: false, reason: "send_failed", detail };
  }
}
