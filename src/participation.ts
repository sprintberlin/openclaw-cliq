import type { CliqWebhookPayload } from "./inbound.js";

/** Recognized operations forwarded by a Deluge participation_handler. */
export type CliqParticipationOperation =
  | "message_sent"
  | "bot_added"
  | "bot_removed"
  | "message_deleted"
  | (string & {});

export interface CliqParticipationPayload extends CliqWebhookPayload {
  handler: "participation";
  operation?: string;
}

/**
 * Check whether a raw webhook payload is sent by Zoho Cliq's participation_handler.
 */
export function isCliqParticipationPayload(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const handler = (raw as { handler?: unknown }).handler;
  return typeof handler === "string" && handler.trim().toLowerCase() === "participation";
}

/**
 * Check whether a participation payload represents a message event (`operation: "message_sent"`).
 * Non-message participation events (e.g. `bot_added`, `bot_removed`) should be acknowledged
 * gracefully without spawning an agent turn.
 */
export function isCliqParticipationMessage(raw: unknown): boolean {
  if (!isCliqParticipationPayload(raw)) return false;
  const payload = raw as { operation?: unknown };
  const op = typeof payload.operation === "string" ? payload.operation.trim().toLowerCase() : "";
  // If operation is omitted or "message_sent", treat it as message participation
  return !op || op === "message_sent";
}
