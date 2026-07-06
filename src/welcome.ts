/**
 * Welcome-message-on-subscribe (issue #52).
 *
 * The Cliq bot **Welcome Handler** fires when a user subscribes (or
 * re-subscribes) to the bot. The Deluge handler can forward that event to our
 * webhook — the same `invokeUrl` POST the Message/Mention handlers use, with a
 * distinct `handler` marker (`"welcome"` or `"subscribe"`) and a `newuser`
 * boolean Cliq passes to the welcome handler scope. When `welcome.enabled` is
 * set in config, the bot posts a configurable greeting DM to the subscriber.
 *
 * Admission: the DM policy (`dmPolicy` / `allowFrom`) is honored so a denied
 * sender is never greeted — the welcome path reuses the same
 * `resolveCliqDmAdmission` gate as an inbound DM. Under the `pairing` policy
 * an unknown (un-paired) subscriber is not greeted either; the pairing flow
 * owns their first contact.
 *
 * Idempotency: a Cliq redelivery of the same subscribe event would greet the
 * user twice, so the webhook handler dedupes welcome events by subscriber id
 * (the synthetic `messageId` `welcome:<userId>` flows through the same
 * `claimCliqMessage` guard as inbound messages).
 */

import type { CliqClient, ResolvedCliqAccount } from "./client.js";
import { resolveCliqDmAdmission } from "./admission.js";
import type { ParsedCliqInbound } from "./inbound.js";

/** A welcome event forwarded by the Deluge Welcome Handler. */
export interface ParsedCliqWelcome {
  /** Cliq user object of the subscriber (id + name + email fields). */
  user: {
    id?: string;
    name?: string;
    first_name?: string;
    last_name?: string;
    email_id?: string;
    email?: string;
  };
  /** True when the subscriber is new (first subscription); false on re-subscribe. */
  newUser: boolean;
  /** Resolved subscriber id (the `to` for the greeting DM). */
  senderId: string;
  /** Resolved subscriber display name (for the `{{name}}` placeholder). */
  senderName: string;
  /** Resolved subscriber email (for the `{{email}}` placeholder). */
  senderEmail?: string;
  /** The raw `handler` marker the Deluge script set. */
  handler: string;
}

/** Raw welcome payload shape the Deluge handler POSTs. */
interface CliqWelcomeWebhookPayload {
  handler?: string;
  user?: {
    id?: string;
    name?: string;
    first_name?: string;
    last_name?: string;
    email_id?: string;
    email?: string;
  };
  /** Cliq Welcome Handler attribute: true for first-time subscribers. */
  newuser?: boolean;
  /** Some handlers wrap the event in `params`. */
  params?: {
    user?: CliqWelcomeWebhookPayload["user"];
    newuser?: boolean;
  };
}

/** Recognized `handler` markers for a Cliq subscribe event. */
const WELCOME_HANDLER_MARKERS = new Set(["welcome", "subscribe"]);

/**
 * Detect whether a raw webhook payload is a welcome/subscribe event (as
 * opposed to a Message/Mention event). The Deluge Welcome Handler sets
 * `handler` to `"welcome"` (or `"subscribe"`); we accept both so operators
 * can use whichever spelling they prefer in their Deluge script.
 */
export function isCliqWelcomePayload(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const payload = raw as CliqWelcomeWebhookPayload;
  const handler = payload.handler?.trim().toLowerCase();
  return handler !== undefined && WELCOME_HANDLER_MARKERS.has(handler);
}

/**
 * Parse a raw welcome webhook payload into a normalized welcome event.
 * Returns `null` when the payload carries no resolvable subscriber id (there
 * is no one to greet). The `newuser` flag defaults to `true` when absent
 * (the conservative read: a welcome with no `newuser` attribute is treated
 * as a first-time subscription, so the primary greeting is used).
 */
export function parseCliqWelcomePayload(raw: unknown): ParsedCliqWelcome | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  let payload = raw as CliqWelcomeWebhookPayload;
  if (payload.params) {
    payload = {
      ...payload,
      user: payload.params.user ?? payload.user,
      newuser: payload.params.newuser ?? payload.newuser,
    };
  }
  const user = payload.user;
  if (!user?.id) return null;
  const composedName = [user.first_name, user.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  const senderName =
    user.name?.trim() || composedName || user.id;
  return {
    user,
    newUser: payload.newuser !== false,
    senderId: user.id,
    senderName,
    senderEmail: user.email_id ?? user.email,
    handler: payload.handler ?? "",
  };
}

/**
 * Resolve a placeholder-bearing template against a subscriber's user fields.
 * Supported placeholders (case-insensitive, `{{ }}` or bare):
 *   - `{{firstName}}` / `{{first_name}}` — `user.first_name` (falls back to
 *     the first token of `user.name` when `first_name` is absent)
 *   - `{{lastName}}` / `{{last_name}}` — `user.last_name`
 *   - `{{name}}` — `user.name` (falls back to `firstName lastName`)
 *   - `{{id}}` — `user.id`
 *   - `{{email}}` — `user.email_id` / `user.email`
 * An unknown placeholder is left verbatim so a misconfigured template is
 * visible to the operator rather than silently empty.
 */
export function renderCliqWelcomeText(
  template: string,
  user: ParsedCliqWelcome["user"],
): string {
  const firstName =
    user.first_name?.trim() || user.name?.trim().split(/\s+/)[0] || "";
  const lastName = user.last_name?.trim() || "";
  const name =
    user.name?.trim() || [firstName, lastName].filter(Boolean).join(" ");
  const email = user.email_id ?? user.email ?? "";
  const values: Record<string, string> = {
    firstname: firstName,
    first_name: firstName,
    lastname: lastName,
    last_name: lastName,
    name,
    id: user.id ?? "",
    email,
  };
  return template.replace(/\{\{\s*([a-zA-Z_]+)\s*}}/g, (m, key: string) => {
    const lookup = values[key.toLowerCase()];
    return lookup === undefined ? m : lookup;
  });
}

/**
 * Build a minimal `ParsedCliqInbound` shape so the welcome event can flow
 * through the shared DM-admission gate and dedupe guard (both of which take a
 * `ParsedCliqInbound`). The synthetic `messageId` (`welcome:<senderId>`)
 * makes redelivery idempotent — a second welcome for the same subscriber
 * within the dedupe TTL is dropped instead of greeting twice.
 */
export function buildCliqWelcomeInbound(
  welcome: ParsedCliqWelcome,
): ParsedCliqInbound {
  return {
    text: "",
    messageId: `welcome:${welcome.senderId}`,
    timestamp: new Date().toISOString(),
    senderId: welcome.senderId,
    senderName: welcome.senderName,
    senderEmail: welcome.senderEmail,
    chatId: "",
    isGroup: false,
    isMention: false,
    mentionIds: [],
    attachments: [],
    handler: welcome.handler,
  };
}

/**
 * Resolve whether a welcome event should produce a greeting DM, given the
 * account's DM admission policy. Reuses {@link resolveCliqDmAdmission} so the
 * welcome path matches the same `dmPolicy` / `allowFrom` semantics as an
 * inbound DM. Returns the greeting text to send, or `null` when the event
 * should be silently acknowledged (greeting skipped — denied sender, disabled
 * policy, or an un-paired subscriber under `pairing` policy).
 */
export function resolveCliqWelcomeGreeting(
  welcome: ParsedCliqWelcome,
  account: ResolvedCliqAccount,
): string | null {
  if (!account.welcome.enabled) return null;
  const parsed = buildCliqWelcomeInbound(welcome);
  const admission = resolveCliqDmAdmission(parsed, account);
  if (admission.decision !== "allow") return null;
  const template = welcome.newUser
    ? account.welcome.text
    : account.welcome.textRejoin;
  return renderCliqWelcomeText(template, welcome.user);
}

/**
 * Send the welcome greeting DM to the subscriber via the Cliq bot-message
 * endpoint. Returns the send ref when the greeting was posted, `null` when
 * the event was skipped (disabled / denied / un-paired). A send failure is
 * swallowed + reported via `onError` so a rejected greeting never breaks the
 * webhook ack — the subscribe event is still acknowledged so Cliq does not
 * redeliver it.
 */
export async function handleCliqWelcome(params: {
  account: ResolvedCliqAccount;
  welcome: ParsedCliqWelcome;
  client: Pick<CliqClient, "sendMessage">;
  onError?: (err: unknown, info: { kind: string }) => void;
}): Promise<{ messageId?: string; chatId?: string } | null> {
  const { account, welcome, client, onError } = params;
  const greeting = resolveCliqWelcomeGreeting(welcome, account);
  if (greeting === null) return null;
  try {
    return await client.sendMessage({
      to: welcome.senderId,
      text: greeting,
      isDm: true,
    });
  } catch (err) {
    // Swallow + log: a failed greeting must never break the webhook ack.
    onError?.(err, { kind: "welcome-greeting" });
    return null;
  }
}
