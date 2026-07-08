import { resolveInboundMentionDecision } from "openclaw/plugin-sdk/channel-mention-gating";
import type {
  InboundMentionDecision,
  InboundMentionFacts,
  InboundImplicitMentionKind,
} from "openclaw/plugin-sdk/channel-mention-gating";
import type { IncomingMessage } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { CliqClient, ResolvedCliqAccount } from "./client.js";
import { DEFAULT_CLIQ_CONFIRM_TEXT, DEFAULT_CLIQ_CANCELLED_TEXT } from "./client.js";
import { stripCliqMentions } from "./mentions.js";
import { resolveCliqClient } from "./runtime-api.js";
import { createLiveEditDeliver, getLiveEditPlaceholderConsumed, editStatusCardPhase } from "./live-edit.js";
import { startThinkingAnimation, type ThinkingAnimation } from "./thinking-animate.js";
import {
  isSensitiveInbound,
  buildConfirmCardButtons,
  parseCliqConfirmAction,
} from "./confirm-gate.js";
import { parseCliqPairingApprovalAction } from "./pairing.js";
import {
  isCliqAbortIntent,
  cliqAbortCtxFields,
} from "./abort.js";
import {
  prepareInboundMedia,
  resolveInboundAttachmentFileIds,
  type CliqInboundAttachment,
  type CliqInboundMediaFacts,
} from "./inbound-media.js";
import {
  parseCliqReplyToContext,
  resolveCliqReplyToContext,
  formatCliqReplyToBlock,
  type CliqReplyToContext,
} from "./inbound-quote.js";
import {
  isCliqFormPayload,
  parseCliqFormSubmission,
  type CliqFormSubmission,
} from "./forms.js";
import { parseCliqFormResponse } from "./forms-render.js";

/**
 * Minimal slice of `api.runtime` that the inbound dispatch path needs. Kept
 * narrow so the webhook handler can be unit-tested with a small mock and so
 * we don't import the full (large) PluginRuntime type.
 */
export interface CliqRuntime {
  channel: {
    routing: {
      resolveAgentRoute: (params: {
        cfg: OpenClawConfig;
        channel: string;
        accountId?: string;
        peer: { kind: "dm" | "group"; id: string };
      }) => { agentId: string; sessionKey: string; accountId?: string };
    };
    session: {
      resolveStorePath: (
        store: unknown,
        params: { agentId: string },
      ) => string;
      readSessionUpdatedAt?: (params: {
        storePath: string;
        sessionKey: string;
      }) => number | undefined;
      recordInboundSession: (params: unknown) => unknown | Promise<unknown>;
    };
    reply: {
      resolveEnvelopeFormatOptions: (cfg: OpenClawConfig) => unknown;
      formatAgentEnvelope: (params: Record<string, unknown>) => string;
      finalizeInboundContext: (fields: Record<string, unknown>) => unknown;
      dispatchReplyWithBufferedBlockDispatcher: (params: {
        ctx: unknown;
        cfg: OpenClawConfig;
        dispatcherOptions: {
          deliver: (payload: { text?: string; mediaUrl?: string }) => Promise<void>;
          onError: (err: unknown, info: { kind: string }) => void;
        };
      }) => Promise<unknown>;
    };
    inbound: {
      run: (params: {
        channel: string;
        accountId?: string;
        raw: unknown;
        adapter: {
          ingest: (raw: ParsedCliqInbound) => unknown;
          resolveTurn: (
            input: unknown,
            eventClass: unknown,
            preflight: unknown,
          ) => unknown;
        };
      }) => Promise<unknown>;
    };
    pairing: {
      buildPairingReply: (params: {
        channel: string;
        idLine: string;
        code: string;
      }) => string;
      upsertPairingRequest: (params: {
        channel: string;
        id: string | number;
        accountId: string;
        meta?: Record<string, string | undefined | null>;
        env?: NodeJS.ProcessEnv;
      }) => Promise<{ code: string; created: boolean }>;
      readAllowFromStore?: (params: {
        channel: string;
        accountId: string;
        env?: NodeJS.ProcessEnv;
      }) => Promise<string[]>;
    };
  };
}

/**
 * Shape of the JSON payload the Deluge bot handler POSTs to our webhook.
 *
 * The Deluge mention/message handlers build a Map with `handler`, `message`,
 * `user`, `chat`, and (for mentions) `mentions`, then `invokeUrl` it as JSON.
 * Zoho is inconsistent: `message` may be a string or an object with `text`,
 * `chat` may carry channel info under different keys, and a wrapped `params`
 * shape sometimes appears. We tolerate all of these.
 */
export interface CliqWebhookPayload {
  handler?: string;
  message?:
    | string
    | {
        text?: string;
        id?: string;
        time?: string;
      };
  text?: string;
  user?: {
    id?: string;
    name?: string;
    first_name?: string;
    last_name?: string;
    email_id?: string;
    email?: string;
    zuid?: string;
    zoho_user_id?: string;
  };
  chat?: {
    id?: string;
    type?: string;
    chat_type?: string;
    title?: string;
    channel_unique_name?: string;
    channel_id?: string;
    owner?: string;
  };
  channel?: {
    id?: string;
    name?: string;
    unique_name?: string;
  };
  thread?: { id?: string };
  mentions?: Array<{
    id?: string;
    name?: string;
    type?: string;
    start?: number;
    end?: number;
  }>;
  /**
   * Cliq message `content` block — present on `type: "file"` messages. Holds
   * the file descriptor (`content.file.{id,name,type}`) and an optional
   * `comment` (the caption a user may attach to a file share). See
   * <https://www.zoho.com/cliq/help/platform/cliq-objects/message-object.html>.
   */
  content?: {
    file?: { id?: string; name?: string; type?: string };
    comment?: string;
    thumbnail?: unknown;
  };
  /** Some Deluge handlers forward a bare `file` name string. Parsed best-effort. */
  file?: string;
  /**
   * Defensive: some bot handlers forward an `attachments` array alongside the
   * message object. A Cliq **bot Message handler** delivers `attachments` as
   * an array of bare file-name strings (no id, no MIME) — see issue #84. Each
   * string entry is surfaced as a name-only attachment (`fileName` set, no
   * `fileId`); the file id is recovered best-effort via the chat-messages
   * list endpoint in the dispatch path. Object entries (`{ id, name, type }`)
   * are also tolerated when present.
   */
  attachments?: Array<string | { id?: string; name?: string; type?: string }>;
  /**
   * Cliq platform **Form** submission (Phase 3). When the bot's Form Handler
   * Deluge script forwards a submission to our webhook, the payload carries
   * `handler: "form"` and/or a `values` / `form.values` / `form_data` /
   * `formvalues` object of submitted field values (plus an optional `form.name`
   * / `form_name`). The parser recognizes this before the message-text path
   * and synthesizes an agent-readable body from the field values. See
   * `src/forms.ts`.
   */
  form?: { name?: string; link_name?: string; values?: Record<string, unknown> };
  values?: Record<string, unknown>;
  form_data?: Record<string, unknown>;
  formvalues?: Record<string, unknown>;
  form_name?: string;
  params?: {
    message?: { text?: string; id?: string };
    user?: { id?: string; name?: string };
    channel?: { id?: string; name?: string; unique_name?: string };
    chat?: { id?: string };
  };
  /**
   * Quote / reply context (issue #49). A reply's parent message id may be
   * carried on `message.reply_to` (the documented Cliq shape) or as a
   * sibling parent-message object under `reply_to` / `parent` / `quoted` /
   * `parent_message` / `quoted_message` / `reply_to_message` when the Deluge
   * handler enriches the payload. See {@link parseCliqReplyToContext} for the
   * tolerated variants.
   */
  reply_to?: string | Record<string, unknown>;
  parent?: Record<string, unknown>;
  parent_message?: Record<string, unknown>;
  quoted?: Record<string, unknown>;
  quoted_message?: Record<string, unknown>;
  reply_to_message?: Record<string, unknown>;
}

/** Normalized inbound message extracted from a raw Cliq webhook payload. */
export interface ParsedCliqInbound {
  text: string;
  messageId: string;
  timestamp: string;
  senderId: string;
  senderName: string;
  senderEmail?: string;
  chatId: string;
  channelId?: string;
  channelName?: string;
  channelUniqueName?: string;
  /** True when the message comes from a channel/group context (not a DM). */
  isGroup: boolean;
  /** True when the bot was explicitly @mentioned (handler=mention or a bot mention). */
  isMention: boolean;
  /** Ids of users/bots mentioned in the message (best-effort). */
  mentionIds: string[];
  /** File attachments (images / files / voice) parsed from the message, if any. */
  attachments: CliqInboundAttachment[];
  threadId?: string;
  /**
   * Quote / reply context (issue #49): the message a user replied to or
   * quoted. `messageId` is usually present (Cliq's `reply_to`); `text` /
   * `senderName` / `senderId` are present only when the Deluge handler
   * forwards the parent message object or the dispatcher fetched it via the
   * chat-messages API.
   */
  replyTo?: CliqReplyToContext;
  /**
   * Confirm-gate sentinel parsed from the inbound text (Phase 3). Set when
   * the message was posted by a confirm-card button click (`invoke.bot`):
   *  - `"confirm"` — the user tapped Confirm; the text is the original
   *    gated message, and the turn dispatches the agent with the gate
   *    skipped (no re-prompt loop).
   *  - `"cancel"` — the user tapped Cancel; the turn short-circuits with
   *    `thinking.cancelledText` and NO agent dispatch.
   * `undefined` for a normal inbound message (the gate, if armed, may apply).
   */
  confirmAction?: "confirm" | "cancel";
  /**
   * Form-driven pairing approval (Phase 3, sub-part b): when the inbound
   * text was a pairing approval-card button click (`invoke.bot`), this
   * carries the parsed action (`kind: "approve" | "deny"` + the pairing
   * `code`). The webhook handler short-circuits the dispatch path for a
   * pairing action — it admits the sender via the SDK pairing store (or
   * replies "denied") instead of dispatching the agent. `undefined` for an
   * ordinary message / mention / welcome / form event.
   */
  pairingAction?: { kind: "approve" | "deny"; code: string };
  /**
   * Cliq platform Form submission (Phase 3): when the inbound payload was a
   * Cliq Form submission forwarded by the bot's Form Handler, `formName`
   * carries the form's display name (best-effort) and `formValues` carries the
   * raw submitted field map. The agent-readable body text is the rendering of
   * these values (see `formatCliqFormBody`); the raw structured map is also
   * surfaced on the inbound context as `FormValues` / `FormName` so an agent
   * tool or downstream flow can read it as structured data. Both are
   * `undefined` for an ordinary message / mention / welcome event.
   */
  formName?: string;
  formValues?: Record<string, unknown>;
  handler: string;
}

function extractMessageText(payload: CliqWebhookPayload): {
  text: string;
  messageId: string;
  time: string;
} {
  let text = "";
  let messageId = "";
  let time = "";
  if (typeof payload.message === "string") {
    text = payload.message.trim();
  } else if (payload.message && typeof payload.message === "object") {
    text = payload.message.text?.trim() ?? "";
    messageId = payload.message.id ?? "";
    time = payload.message.time ?? "";
  }
  if (!text && payload.text) text = payload.text.trim();
  // A file share may carry the caption in `content.comment` rather than the
  // message text; surface it so the agent sees what the user said alongside
  // the attachment.
  if (!text && payload.content?.comment) {
    text = payload.content.comment.trim();
  }
  return { text, messageId, time };
}

/**
 * Parse file attachments from a Cliq message payload. A `type: "file"` message
 * carries a single file under `content.file.{id,name,type}` with an optional
 * `content.comment` caption. Some Deluge handlers also forward a bare `file`
 * name string or an `attachments` array; both are tolerated. The `params`
 * wrapper is unwrapped by the caller before this runs.
 *
 * A Cliq **bot Message handler** delivers `attachments` as an array of bare
 * file-name strings (no id, no MIME) — see issue #84. Such entries are surfaced
 * with `fileId` unset and `fileName` only; the file id is recovered
 * best-effort via the chat-messages list endpoint in the dispatch path
 * (`resolveInboundAttachmentFileIds`). A name-only entry that cannot be
 * resolved still surfaces its name to the agent so the turn is useful.
 */
function extractMessageAttachments(payload: CliqWebhookPayload): CliqInboundAttachment[] {
  const out: CliqInboundAttachment[] = [];
  const caption = payload.content?.comment?.trim() || undefined;
  const file = payload.content?.file;
  if (file && typeof file.id === "string" && file.id.trim()) {
    out.push({
      fileId: file.id.trim(),
      fileName: file.name?.trim() || undefined,
      mimeType: file.type?.trim() || undefined,
      caption,
    });
  } else if (Array.isArray(payload.attachments)) {
    for (const a of payload.attachments) {
      if (typeof a === "string") {
        const name = a.trim();
        if (name) {
          out.push({ fileName: name, caption });
        }
      } else if (a && typeof a === "object") {
        const id = typeof a.id === "string" ? a.id.trim() : undefined;
        const name = typeof a.name === "string" ? a.name.trim() : undefined;
        if (id) {
          out.push({
            fileId: id,
            fileName: name || undefined,
            mimeType: a.type?.trim() || undefined,
            caption,
          });
        } else if (name) {
          // Name-only object entry (no id) — same degradation as a string.
          out.push({ fileName: name, mimeType: a.type?.trim() || undefined, caption });
        }
      }
    }
  }
  // A bare `file` string is the file name only — no id — so it is not
  // downloadable by itself. We do not synthesize an attachment for it; the
  // text path still surfaces it when it is the only payload field.
  return out;
}

function buildUserName(user: NonNullable<CliqWebhookPayload["user"]>): string {
  return (
    user.name ??
    [user.first_name, user.last_name].filter(Boolean).join(" ") ??
    user.id ??
    "unknown"
  );
}

/**
 * Derive a stable synthetic message id when the Deluge bot handler omits the
 * real `message.id` (issue #84 / #88). A Cliq bot Message handler delivers
 * `message` as a plain string, so `messageId` is empty for image/file
 * messages. Without a stable id the dedupe layer falls back to a composite
 * key but `MessageSid` stays empty, which can trigger "reply session
 * initialization conflicted" on retries (no stable key to serialize
 * concurrent or retried deliveries).
 *
 * The synthetic id is a deterministic SHA-256 hash of sender + chat +
 * attachment names/ids + (optionally) the payload timestamp, prefixed with
 * `syn:` so it is visually distinct from a real Cliq message id. The
 * timestamp is only included when the payload explicitly provides one
 * (`message.time`); when absent, the hash is stable across Cliq
 * redeliveries (which call `new Date().toISOString()` fresh each time).
 */
function buildSyntheticMessageId(
  senderId: string,
  chatId: string,
  attachments: CliqInboundAttachment[],
  payloadTime: string,
): string {
  const parts = [
    senderId,
    chatId,
    // Only include the timestamp when the payload explicitly provides one
    // (stable across redeliveries). When absent, `new Date().toISOString()`
    // changes on each delivery → omit it so the hash is deterministic.
    ...(payloadTime ? [payloadTime] : []),
    ...attachments.map((a) => a.fileId ?? a.fileName ?? ""),
  ];
  const hash = createHash("sha256").update(parts.join("\0")).digest("hex");
  return `syn:${hash.slice(0, 16)}`;
}

import { createHash } from "node:crypto";

/**
 * Parse a raw Cliq webhook payload into a normalized inbound message.
 * Returns null when the payload is missing required fields (text or sender id).
 */
export function parseCliqWebhookPayload(
  raw: unknown,
): ParsedCliqInbound | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  let payload = raw as CliqWebhookPayload;
  if (payload.params) {
    payload = {
      ...payload,
      message: payload.params.message ?? payload.message,
      user: payload.params.user ?? payload.user,
      channel: payload.params.channel ?? payload.channel,
      chat: payload.params.chat ?? payload.chat,
    };
  }

  const { text, messageId, time } = extractMessageText(payload);
  const attachments = extractMessageAttachments(payload);
  const user = payload.user;
  if (!user?.id) return null;
  // Cliq platform Form submission (Phase 3): when the payload is a Form
  // Handler forward (handler="form" or a values object present) and carries
  // no message text, synthesize the agent-readable body from the submitted
  // field values. A form that ALSO carries a message text (rare — a Deluge
  // handler enriching the submission) keeps the text as the body and still
  // surfaces the raw structured `formValues` on the parsed inbound. A form
  // submission is a directed action at the bot, so the parser marks it as
  // an implicit mention (`isMention: true`) below — group form submissions
  // are admitted without a separate @mention.
  const formSubmission: CliqFormSubmission | null = isCliqFormPayload(payload)
    ? parseCliqFormSubmission(payload)
    : null;
  // Agent-rendered form button-click response (Phase 3, sub-part c): a
  // prompt-card button posts a `__cliq_form__ <field>=<value>` sentinel as
  // the message text. Parse it into structured form values so the answer
  // re-enters as a `FormValues` entry on the inbound context (structured
  // params for a tool call) rather than plain text — the same surfacing the
  // platform Form Handler path uses below. Free-text replies to the summary
  // card are NOT sentinel-prefixed and stay ordinary text.
  const formResponse = parseCliqFormResponse(text);
  let bodyText = text;
  if (formResponse.matched) {
    bodyText = formResponse.body;
  } else if (!bodyText && formSubmission) {
    bodyText = formSubmission.body;
  }
  if (!bodyText && attachments.length > 0) {
    const first = attachments[0];
    if (first.fileId) {
      const kind = first.mimeType?.split("/")[0]?.toLowerCase();
      bodyText = kind ? `<media:${kind}>` : "<media>";
    } else {
      // Name-only attachment (bot Message handler `attachments` string — issue
      // #84): no downloadable id yet, so surface the file name to the agent.
      // The kind cannot be derived reliably from a bare name, so prefer
      // `<file: <name>>`; fall back to `<file>` when no name either.
      const name = first.fileName?.trim();
      bodyText = name ? `<file: ${name}>` : "<file>";
    }
  }
  // When the message carries a caption AND a name-only attachment (no file
  // id), surface the file name alongside the caption so the agent sees that
  // the turn is about a file even before the id is resolved (issue #84).
  // Guards on the original caption `text` so a caption-less file (whose body
  // is already `<file: name>`) is not double-prefixed.
  if (
    text &&
    !formResponse.matched &&
    !formSubmission &&
    attachments.some((a) => !a.fileId)
  ) {
    const name = attachments.find((a) => !a.fileId && a.fileName?.trim())?.fileName?.trim();
    if (name) {
      bodyText = `<file: ${name}>\n${bodyText}`;
    }
  }
  if (!bodyText) return null;

  const userName = buildUserName(user);
  const handler = payload.handler ?? "";

  const hasChannelObject = Boolean(
    payload.channel?.id || payload.channel?.unique_name,
  );
  const isChatChannel =
    payload.chat?.type === "channel" || payload.chat?.chat_type === "channel";
  const isGroup =
    hasChannelObject ||
    isChatChannel ||
    Boolean(payload.chat?.channel_unique_name);

  const channelUniqueName =
    payload.chat?.channel_unique_name ??
    payload.channel?.unique_name ??
    payload.channel?.name;
  const channelId = payload.chat?.channel_id ?? payload.channel?.id;
  let channelName = payload.channel?.name;
  if (isChatChannel && !channelName && payload.chat?.title) {
    channelName = payload.chat.title.replace(/^#\s*/, "").trim();
  }
  const chatId = payload.chat?.id ?? channelId ?? "";

  const mentionIds = (payload.mentions ?? [])
    .map((m) => m.id)
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  const hasBotMention = Boolean(
    payload.mentions?.some((m) => m.type === "bot"),
  );
  const isMention =
    handler.includes("mention") ||
    hasBotMention ||
    Boolean(formSubmission) ||
    Boolean(formResponse.matched) ||
    (isGroup && false);

  const replyTo = parseCliqReplyToContext(payload);

  // Confirm-gate sentinel (Phase 3): a confirm-card button click arrives as
  // an ordinary inbound message whose text starts with a sentinel. Strip it
  // and record the action so the dispatch path can skip the gate (confirm)
  // or short-circuit with the cancelled reply (cancel). The recovered text
  // (the original gated message on confirm) becomes the turn body.
  const confirmParsed = parseCliqConfirmAction(bodyText);
  // Form-driven pairing approval (Phase 3, sub-part b): an approval-card
  // button click arrives as an ordinary inbound message whose text starts
  // with a pairing sentinel. Record the action so the webhook handler can
  // short-circuit the dispatch path and admit/deny the sender via the SDK
  // pairing store (no agent turn). The sentinel + code is stripped from the
  // text the agent would otherwise see (there is no agent turn here).
  const pairingParsed = parseCliqPairingApprovalAction(bodyText);
  const finalText =
    pairingParsed.kind ? pairingParsed.text : confirmParsed.text;

  const resolvedTimestamp = time || new Date().toISOString();
  // Derive a stable synthetic message id when the Deluge bot handler omits
  // the real `message.id` (issue #88). Without a stable id, `MessageSid` is
  // empty and the dispatch path can self-conflict on retries. Pass the raw
  // `time` from the payload (not the resolved timestamp) so the hash is
  // stable across Cliq redeliveries (which generate fresh timestamps).
  const resolvedMessageId =
    messageId ||
    (attachments.length > 0 || bodyText
      ? buildSyntheticMessageId(user.id, chatId, attachments, time)
      : "");

  return {
    text: finalText,
    messageId: resolvedMessageId,
    timestamp: resolvedTimestamp,
    senderId: user.id,
    senderName: userName,
    senderEmail: user.email_id ?? user.email,
    chatId,
    channelId,
    channelName,
    channelUniqueName,
    isGroup,
    isMention,
    mentionIds,
    attachments,
    threadId: payload.thread?.id,
    replyTo,
    confirmAction: confirmParsed.action,
    pairingAction: pairingParsed.kind
      ? { kind: pairingParsed.kind, code: pairingParsed.code }
      : undefined,
    formName: formSubmission?.formName,
    formValues:
      formSubmission?.values ??
      (formResponse.matched && Object.keys(formResponse.formValues).length > 0
        ? formResponse.formValues
        : undefined),
    handler,
  };
}

/**
 * Build the mention facts that `resolveInboundMentionDecision` consumes.
 * For DMs the bot is always "mentioned" (directed); for groups we require an
 * explicit mention unless the account relaxes that.
 */
export function resolveCliqMentionFacts(
  parsed: ParsedCliqInbound,
  account: ResolvedCliqAccount,
  opts: { isReplyToBot?: boolean; isQuoteOfBot?: boolean } = {},
): InboundMentionFacts {
  if (!parsed.isGroup) {
    return { canDetectMention: true, wasMentioned: true, hasAnyMention: true };
  }
  const botIds = new Set<string>();
  if (account.botId) botIds.add(account.botId);
  if (account.botName) botIds.add(account.botName);
  const mentionsBot =
    parsed.isMention ||
    parsed.mentionIds.some((id) => botIds.has(id));
  const implicitKinds: InboundImplicitMentionKind[] = [];
  if (opts.isReplyToBot) implicitKinds.push("reply_to_bot");
  if (opts.isQuoteOfBot) implicitKinds.push("quoted_bot");
  return {
    canDetectMention: true,
    wasMentioned: mentionsBot,
    hasAnyMention: parsed.isMention || parsed.mentionIds.length > 0,
    implicitMentionKinds: implicitKinds,
  };
}

export interface CliqMentionPolicyInput {
  requireMention?: boolean;
  allowTextCommands?: boolean;
  hasControlCommand?: boolean;
  commandAuthorized?: boolean;
  allowImplicitMentionKinds?: readonly InboundImplicitMentionKind[];
}

/**
 * Whether the inbound message is a reply to / quote of a message the bot sent
 * (the bot's own `botId` / `botName` / `selfSenderIds`). Used to mark the turn
 * as an implicit `reply_to_bot` / `quoted_bot` mention so a group reply to the
 * bot is admitted even without a fresh @mention. Returns false when no quote
 * context was parsed or the quoted sender is not a known bot id.
 */
export function isReplyToBot(
  parsed: ParsedCliqInbound,
  account: ResolvedCliqAccount,
): boolean {
  const senderId = parsed.replyTo?.senderId?.trim();
  const senderName = parsed.replyTo?.senderName?.trim();
  if (!senderId && !senderName) return false;
  const botIds = new Set<string>();
  if (account.botId) botIds.add(account.botId.toLowerCase());
  if (account.botName) botIds.add(account.botName.toLowerCase());
  for (const id of account.selfSenderIds ?? []) {
    botIds.add(id.toLowerCase());
  }
  if (senderId && botIds.has(senderId.toLowerCase())) return true;
  if (senderName && botIds.has(senderName.toLowerCase())) return true;
  return false;
}

/**
 * Evaluate the inbound mention decision using the shared SDK helper. Returns
 * the decision the webhook handler uses to skip or proceed.
 */
export function resolveCliqMentionDecision(
  parsed: ParsedCliqInbound,
  account: ResolvedCliqAccount,
  policy: CliqMentionPolicyInput = {},
): InboundMentionDecision {
  const facts = resolveCliqMentionFacts(parsed, account, {
    isReplyToBot: isReplyToBot(parsed, account),
    isQuoteOfBot: isReplyToBot(parsed, account),
  });
  return resolveInboundMentionDecision({
    facts,
    policy: {
      isGroup: parsed.isGroup,
      requireMention: policy.requireMention ?? parsed.isGroup,
      allowedImplicitMentionKinds:
        policy.allowImplicitMentionKinds ?? ["reply_to_bot", "quoted_bot"],
      allowTextCommands: policy.allowTextCommands ?? false,
      hasControlCommand: policy.hasControlCommand ?? false,
      commandAuthorized: policy.commandAuthorized ?? false,
    },
  });
}

/**
 * Read the request body as JSON. Rejects payloads larger than `maxBytes`.
 *
 * As a forgiving fallback, a body whose `Content-Type` is
 * `application/x-www-form-urlencoded` (or that fails to parse as JSON but
 * looks like a Deluge `parameters:`-style form-urlencoded body such as
 * `handler=mention&message=...`) is normalized into the equivalent JSON
 * object. This lets the webhook accept both the documented raw-JSON body
 * (`body: payload.toString()` in Deluge) and the form-encoded body that
 * Deluge's `parameters:` key produces. The raw-JSON shape is canonical;
 * the form-encoded path is a tolerance fallback only.
 */
export async function readJsonBody(
  req: Pick<IncomingMessage, "on" | "removeAllListeners" | "destroy"> & {
    headers?: IncomingMessage["headers"];
  },
  maxBytes = 1024 * 1024,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  return await new Promise((resolve) => {
    let resolved = false;
    const done = (
      result: { ok: true; value: unknown } | { ok: false; error: string },
    ) => {
      if (resolved) return;
      resolved = true;
      req.removeAllListeners();
      resolve(result);
    };
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        done({ ok: false, error: "payload too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) {
        done({ ok: false, error: "empty payload" });
        return;
      }
      try {
        done({ ok: true, value: JSON.parse(raw) });
      } catch {
        const normalized = normalizeFormUrlencodedBody(raw, req.headers);
        if (normalized !== undefined) {
          done({ ok: true, value: normalized });
          return;
        }
        done({
          ok: false,
          error:
            "body is not valid JSON and could not be normalized as a Deluge form-urlencoded payload; use `body: payload.toString()` with a `Content-Type: application/json` header in the Deluge handler",
        });
      }
    });
    req.on("error", (err: Error) => {
      done({ ok: false, error: err.message });
    });
  });
}

/**
 * Detect a Deluge `parameters:`-style form-urlencoded body and convert it
 * to the equivalent JSON object the webhook parser expects. Returns
 * `undefined` when the body does not look form-urlencoded or cannot be
 * decoded. This is a tolerance fallback — the canonical body shape is raw
 * JSON (Deluge `body: payload.toString()`).
 */
export function normalizeFormUrlencodedBody(
  raw: string,
  headers?: IncomingMessage["headers"],
): unknown | undefined {
  const contentType = headers?.["content-type"];
  const ct = Array.isArray(contentType) ? contentType[0] : contentType;
  const isFormCt =
    typeof ct === "string" &&
    ct.toLowerCase().includes("application/x-www-form-urlencoded");
  // Only attempt form-decoding when the content-type signals it, OR when
  // the raw body clearly looks form-encoded (key=value&...) but is not
  // JSON. This avoids misinterpreting arbitrary non-JSON text.
  const looksFormEncoded =
    raw.includes("=") &&
    !raw.trimStart().startsWith("{") &&
    !raw.trimStart().startsWith("[");
  if (!isFormCt && !looksFormEncoded) return undefined;
  try {
    const params = new URLSearchParams(raw);
    const obj: Record<string, unknown> = {};
    for (const [key, value] of params.entries()) {
      // The Deluge `parameters:` key posts a single form field whose name
      // is the JSON string itself (e.g. `handler=mention&message=...`).
      // Where a value is itself JSON, unwrap it; otherwise keep the string.
      obj[key] = tryParseJson(value) ?? value;
    }
    return obj;
  } catch {
    return undefined;
  }
}

function tryParseJson(value: string): unknown | undefined {
  const trimmed = value.trim();
  if (
    !trimmed ||
    (trimmed[0] !== "{" && trimmed[0] !== "[" && trimmed[0] !== '"')
  ) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/**
 * Detect a Cliq / SDK "reply session initialization conflicted" error. This
 * is thrown when an inbound message arrives while a previous turn for the
 * same session is still initializing (a Cliq redelivery during the
 * initialization window — the dedupe claim races the first dispatch). A
 * genuine concurrent-turn conflict is transient; surfacing it to Cliq as a
 * 5xx triggers an immediate retry which trips the same conflict again → a
 * retry storm. The webhook acks these with 200 so Cliq stops retrying (the
 * dedupe layer already serialized the redeliveries).
 */
export function isCliqSessionConflictError(err: unknown): boolean {
  const msg =
    typeof err === "object" && err && "message" in err
      ? String((err as { message?: unknown }).message ?? "")
      : String(err);
  return /reply session initialization conflicted/i.test(msg);
}

/**
 * Dispatch a parsed inbound Cliq message into the OpenClaw inbound pipeline
 * via `runtime.channel.inbound.run`. Builds the normalized turn context from
 * the legacy `runtime.channel.reply.*` + `runtime.channel.routing.*` helpers
 * and hands delivery back to the `CliqClient`.
 */
export async function dispatchCliqInbound(params: {
  runtime: CliqRuntime;
  cfg: OpenClawConfig;
  account: ResolvedCliqAccount;
  parsed: ParsedCliqInbound;
  onError?: (err: unknown, info: { kind: string }) => void;
  /**
   * Optional client override (tests). Production callers resolve the client
   * through {@link resolveCliqClient} from the shared registry so the OAuth
   * token cache is reused across requests.
   */
   client?: Pick<
     CliqClient,
     | "sendMessage"
     | "sendCard"
     | "editMessage"
     | "resolveChannelChatId"
     | "listChatMessages"
     | "deleteMessage"
     | "downloadAttachment"
    >;
}): Promise<void> {
  const { runtime, cfg, account, parsed, onError } = params;
  const peerKind = parsed.isGroup ? "group" : "dm";
  const peerId = parsed.isGroup
    ? (parsed.channelUniqueName ?? parsed.chatId)
    : `dm:${parsed.senderId}`;

  const route = runtime.channel.routing.resolveAgentRoute({
    cfg,
    channel: "cliq",
    accountId: account.accountId ?? undefined,
    peer: { kind: peerKind, id: peerId },
  });

  // Build the outbound response target. The prefix encodes chat type so the
  // outbound `sendText`/`sendMedia` path (which only sees `ctx.to`) can decide
  // `userids` + /bots/{botId}/message (DM) vs channelsbyname (channel) without
  // a chatType field:
  //   - DM            → `user:<senderId>`    (delivered via `userids`)
  //   - group/channel → `channel:<channelUniqueName>` (preferred — the
  //                     channelsbyname endpoint needs the unique name in the
  //                     URL path), falling back to `chat:<chatId>` when the
  //                     inbound payload carried no unique name (a rare edge
  //                     case where the channel send will likely fail).
  const responseTarget = parsed.isGroup
    ? parsed.channelUniqueName
      ? `channel:${parsed.channelUniqueName}`
      : `chat:${parsed.chatId}`
    : `user:${parsed.senderId}`;
  const fromLabel = parsed.isGroup
    ? (parsed.channelName ?? `channel:${parsed.channelUniqueName}`)
    : (parsed.senderName ?? `user:${parsed.senderId}`);

  const storePath = runtime.channel.session.resolveStorePath(
    (cfg as { session?: { store?: unknown } })?.session?.store,
    { agentId: route.agentId },
  );
  const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const previousTimestamp = runtime.channel.session.readSessionUpdatedAt?.({
    storePath,
    sessionKey: route.sessionKey,
  });
  // Strip the bot @handle from the text the agent sees so the agent doesn't
  // echo it back and so command detection operates on the clean instruction.
  const cleanText = stripCliqMentions(parsed.text, account);
  // Stop / abort intent (issue #51): recognize `stop` / `/stop` / `esc` +
  // common localized equivalents and let the SDK's fast-abort dispatch path
  // cancel the in-flight run for this session + send the "Stopped." reply,
  // instead of queueing another agent turn. We mark the turn as an authorized
  // text command (`CommandSource: "text"` + `CommandAuthorized: true`) so the
  // SDK's abort authorization gate (`resolveCommandSenderAuthorization`)
  // honors it; the SDK re-detects the abort via the shared
  // `isAbortRequestText` and does the actual run cancellation + reply.
  const isAbort = isCliqAbortIntent(cleanText, account.botName);

  // The inbound `From` is the originating conversation id: the sender for
  // DMs, the group for group/channel messages. Setting `From` to
  // `cliq:group:<uniqueName>` for groups lets the runtime's
  // `extractExplicitGroupId` resolve the channel unique name so the `groups`
  // adapter (per-group `requireMention` + tool policy) can look up
  // `channels.cliq.groups` entries. `GroupChannel`/`GroupSubject` carry the
  // display name as a fallback for Deluge payloads that omit the unique name.
  const groupIdForCtx = parsed.isGroup
    ? (parsed.channelUniqueName ?? parsed.chatId)
    : parsed.senderId;
  const fromField = parsed.isGroup
    ? `cliq:group:${groupIdForCtx}`
    : `cliq:${parsed.senderId}`;
  const groupLabel = parsed.isGroup
    ? (parsed.channelName ?? parsed.channelUniqueName ?? parsed.chatId)
    : undefined;

  const client = params.client ?? resolveCliqClient(account);
  const deliverTo = parsed.isGroup
    ? (parsed.channelUniqueName ?? parsed.chatId)
    : parsed.senderId;

  // Confirm gate — cancel short-circuit (Phase 3). When the inbound message
  // is a Cancel button click (sentinel posted by `invoke.bot`), post the
  // cancelled reply and return WITHOUT dispatching the agent. The user
  // explicitly declined the gated action; no agent turn runs.
  if (parsed.confirmAction === "cancel") {
    try {
      await client.sendMessage({
        to: deliverTo,
        text: account.thinking.cancelledText ?? DEFAULT_CLIQ_CANCELLED_TEXT,
        isDm: !parsed.isGroup,
      });
    } catch (err) {
      onError?.(err, { kind: "confirm-cancel-reply" });
    }
    return;
  }

  // Confirm gate — sensitive action prompt (Phase 3). When the gate is armed
  // (`thinking.mode === "card"` + `thinking.confirm` set) and the cleaned
  // inbound text is sensitive (and this is NOT a confirm re-dispatch or an
  // abort intent), post a `prompt`-theme Message Card with Confirm / Cancel
  // buttons and return WITHOUT dispatching the agent. The user must tap
  // Confirm (which re-posts the original message with a sentinel) to run the
  // action. A failed confirm-card post is swallowed + reported and falls
  // through to a normal dispatch (the gate is a UX guardrail, not a security
  // boundary — the agent's own tool / permission policy still applies).
  if (
    isSensitiveInbound(parsed, account) &&
    !isAbort &&
    parsed.confirmAction !== "confirm"
  ) {
    const buttons = buildConfirmCardButtons({
      botId: account.botId,
      originalText: cleanText,
      confirmLabel: account.thinking.confirmLabel,
      cancelLabel: account.thinking.cancelLabel,
    });
    if (buttons) {
      try {
        await client.sendCard({
          to: deliverTo,
          text: account.thinking.confirmText ?? DEFAULT_CLIQ_CONFIRM_TEXT,
          isDm: !parsed.isGroup,
          theme: "prompt",
          buttons: [buttons.confirm, buttons.cancel],
        });
        return;
      } catch (err) {
        onError?.(err, { kind: "confirm-card-post" });
        // Fall through to a normal dispatch (best-effort gate).
      }
    }
  }

  // Inbound quote / reply context (issue #49): when the message is a reply to
  // or quote of another message, carry the referenced message's id + text +
  // sender into the agent context. The parser already extracted whatever the
  // Deluge handler forwarded (often just the parent message id). When only an
  // id is present and a user-context refresh token is configured (reading chat
  // messages needs a user-consented scope the `client_credentials` grant
  // cannot obtain), best-effort fetch the parent text via the chat-messages
  // list endpoint. A fetch failure degrades to "no quote text" and never
  // breaks the turn. The resolved text is then prepended to the agent envelope
  // body so the agent sees what the user is replying to.
  const replyTo = await resolveCliqReplyToContext(parsed.replyTo, {
    client,
    chatId: parsed.chatId || undefined,
    canReadChatMessages: Boolean(account.refreshToken),
    onError: (err, info) => onError?.(err, info),
  });
  const quoteBlock =
    replyTo && (replyTo.text || replyTo.senderName)
      ? formatCliqReplyToBlock(replyTo)
      : "";
  const bodyText = quoteBlock ? `${quoteBlock}\n\n${cleanText}` : cleanText;
  const body = runtime.channel.reply.formatAgentEnvelope({
    channel: "Cliq",
    from: fromLabel,
    timestamp: parsed.timestamp ? Date.parse(parsed.timestamp) : undefined,
    previousTimestamp,
    envelope: envelopeOptions,
    body: bodyText,
  });

  // Inbound media (issue #48): when the message carries a file attachment
  // (image / file / voice), download each via the Cliq Files API and write it
  // to a per-turn temp directory, then attach the local paths to the inbound
  // context as `MediaPath`/`MediaUrl`/`MediaType` (+ the plural arrays) so the
  // runtime media-understanding pipeline can hand them to the agent (audio is
  // transcribed by the configured media-understanding provider). A per-file
  // download failure is swallowed + reported via `onError` so the turn still
  // dispatches with whatever attachments did download — a failed fetch never
  // breaks the agent turn. Voice (`audio/*`) entries are marked
  // `transcribed: false`; the runtime handles transcription.
  //
  // Issue #84: a Cliq bot Message handler delivers `attachments` as bare
  // file-name strings (no file id). Before downloading, best-effort resolve
  // the file id via the chat-messages list endpoint (scope `Messages.READ`,
  // refresh-token grant — same constraint as the quote/reply fetch). A failed
  // or no-op resolution degrades to "no media for that attachment" and never
  // breaks the turn; the file name still surfaces in the body.
  let inboundMedia: CliqInboundMediaFacts[] = [];
  if (parsed.attachments.length > 0) {
    const resolvedAttachments = await resolveInboundAttachmentFileIds({
      attachments: parsed.attachments,
      client,
      chatId: parsed.chatId || undefined,
      canReadChatMessages: Boolean(account.refreshToken),
      onError: (err, info) => onError?.(err, { kind: info.kind }),
    });
    const prepared = await prepareInboundMedia({
      attachments: resolvedAttachments,
      client,
      messageId: parsed.messageId || undefined,
      onError: (err, info) => onError?.(err, { kind: info.kind }),
    });
    inboundMedia = prepared.media;
  }
  const mediaPaths = inboundMedia
    .map((m) => m.path)
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  const mediaTypes = inboundMedia
    .map((m) => m.contentType)
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  const mediaFields: Record<string, unknown> =
    mediaPaths.length > 0
      ? {
          MediaPath: mediaPaths[0],
          MediaUrl: mediaPaths[0],
          MediaType: mediaTypes[0],
          MediaPaths: mediaPaths,
          MediaUrls: mediaPaths,
          MediaTypes:
            mediaTypes.length === mediaPaths.length
              ? mediaTypes
              : mediaPaths.map((_, i) => mediaTypes[i] ?? "application/octet-stream"),
        }
      : {};

  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: cleanText,
    CommandBody: cleanText,
    From: fromField,
    To: `cliq:${responseTarget}`,
    SessionKey: route.sessionKey,
    AccountId: account.accountId ?? undefined,
    ChatType: parsed.isGroup ? "channel" : "direct",
    ConversationLabel: fromLabel,
    SenderName: parsed.senderName,
    SenderId: parsed.senderId,
    SenderUsername: parsed.senderEmail,
    GroupChannel: groupLabel,
    GroupSubject: groupLabel,
    WasMentioned: parsed.isGroup ? parsed.isMention : undefined,
    Provider: "cliq",
    Surface: "cliq",
    MessageSid: parsed.messageId,
    MessageSidFull: parsed.messageId,
    ReplyToId: replyTo?.messageId ?? parsed.threadId,
    ReplyToIdFull: replyTo?.messageId ?? parsed.threadId,
    ReplyToMessageId: replyTo?.messageId,
    ReplyToText: replyTo?.text,
    ReplyToSenderId: replyTo?.senderId,
    ReplyToSenderName: replyTo?.senderName,
    OriginatingChannel: "cliq",
    OriginatingTo: `cliq:${responseTarget}`,
    ...mediaFields,
    // Cliq Form submission (Phase 3): surface the raw structured field map +
    // form name on the inbound context so an agent tool or downstream flow
    // can read them as structured data, not just the synthesized body text.
    ...(parsed.formValues
      ? { FormValues: parsed.formValues, ...(parsed.formName ? { FormName: parsed.formName } : {}) }
      : {}),
    // Mark a stop-intent turn as an authorized text command so the SDK's
    // fast-abort path cancels the in-flight run + sends the "Stopped." reply.
    ...(isAbort ? cliqAbortCtxFields() : {}),
  });
  // Instant acknowledgement / "thinking" placeholder (issue #47): when
  // opted in (`thinking.mode` is `"placeholder"` OR `"card"`), streaming
  // preview is OFF (live-edit already shows progress otherwise), and a
  // `refreshToken` is configured (editing a message needs the user-context
  // token), post a lightweight placeholder message immediately so the user
  // sees the bot is working, then have the deliver callback edit that
  // placeholder into the final reply (no duplicate message). `placeholder`
  // mode posts plain text (`💭 …`); `card` mode posts a v3 Message Card
  // status indicator (a `modern-inline` card titled `Generating…`) via
  // `sendCard` — a real card on `apiVersion: "v3"`, degrading to plain text
  // on v2. The placeholder post is swallowed on failure so a rejected post
  // never breaks or delays the agent turn (the deliver then just sends a
  // fresh message as usual). DMs and channel posts both support this; the
  // group case carries no chatId in the send response, so
  // `createLiveEditDeliver` resolves it lazily on the first edit (cached per
  // account).
  let initialDraft: { messageId: string; chatId?: string } | undefined;
  // Animated "thinking" placeholder (issue #86): held so the reply deliver
  // and the no-reply cleanup can stop a late frame edit before the final
  // edit-into-reply. `null` when no animation is running.
  let thinkingAnimation: ThinkingAnimation | null = null;
  if (
    (account.thinking?.mode === "placeholder" ||
      account.thinking?.mode === "card") &&
    !account.blockStreaming &&
    account.refreshToken &&
    !isAbort
  ) {
    try {
      const cardMode = account.thinking?.mode === "card";
      const placeholderText = account.thinking?.text
        ?? (cardMode ? "Generating…" : "💭 …");
      // `card` mode posts a v3 Message Card status indicator (a
      // `modern-inline` card) instead of plain text — a richer "generating…"
      // cue than the `💭 …` string. On v2 (or when the v3 card renderer
      // yields no payload) `sendCard` degrades to the same plain-text
      // bot-message send as `sendMessage`, so `card` mode is a no-op upgrade
      // on v2. The card becomes the `initialDraft` the live-edit flow
      // replaces: edit-into-reply when the edit API accepts a card→text swap,
      // or delete + fresh send on edit failure (the existing fallback). DM
      // cards post as the bot (v3 bot-message endpoint, `Webhooks.CREATE`);
      // channel cards post as the authenticated user (`Channels.CREATE` —
      // both need the refresh-token grant, which the gate above already
      // requires for the edit path).
      //
      // Phase transitions (issue #78): in `card` mode the card is first
      // posted with the "thinking" phase title (`thinkingText`, default
      // `💭 thinking…`), then edited in place to the "generating" phase
      // title (`placeholderText`, default `Generating…`) right before the
      // agent turn dispatches — giving the user a visible phase progression
      // as the turn runs. The final reply is the "done" phase, handled by
      // the live-edit deliver's edit-into-reply. The thinking→generating
      // edit is best-effort (swallowed on failure) so a phase transition
      // never breaks the turn; the chat id is resolved lazily for group
      // posts (the card send response carries no chatId).
      const ref = cardMode
        ? await client.sendCard({
            to: deliverTo,
            text: account.thinking?.thinkingText ?? "💭 thinking…",
            isDm: !parsed.isGroup,
            theme: "modern-inline",
          })
        : await client.sendMessage({
            to: deliverTo,
            text: placeholderText,
            isDm: !parsed.isGroup,
          });
      if (ref.messageId) {
        initialDraft = { messageId: ref.messageId, chatId: ref.chatId };
        // Card mode: transition the status card thinking → generating
        // before dispatching the agent turn.
        if (cardMode) {
          await editStatusCardPhase({
            client,
            draft: initialDraft,
            to: deliverTo,
            isDm: !parsed.isGroup,
            text: placeholderText,
            onError: (err, info) => onError?.(err, info),
          });
        }
        // Animated "thinking" placeholder (issue #86): cycle the placeholder
        // through text frames on an interval while the turn runs. Stopped the
        // moment the reply (or failure text) arrives so a late frame edit can
        // never clobber the reply. The interval is hard-floored and the total
        // duration capped (see `thinking-animate.ts`). A failed frame edit
        // stops the animation but never breaks the turn. Only runs when the
        // preconditions for the placeholder are already met (a message id, a
        // refreshToken, streaming preview off) — the gate above enforces those.
        if (account.thinking?.animate && account.thinking.animate !== "off") {
          thinkingAnimation = startThinkingAnimation({
            client,
            draft: initialDraft,
            to: deliverTo,
            isDm: !parsed.isGroup,
            mode: account.thinking.animate,
            frames: account.thinking.animateFrames,
            intervalMs: account.thinking.animateIntervalMs,
            onError: (err, info) => onError?.(err, info),
          });
        }
      }
    } catch (err) {
      // Swallow + log: a failed placeholder post must never break the turn.
      onError?.(err, { kind: "thinking-placeholder" });
    }
  }
  // Live-edit-in-place: when block streaming is opted in for the account,
  // the buffered block dispatcher delivers the agent's reply as progressive
  // blocks. Instead of sending each block as a separate message, edit a
  // single draft message in place as the reply grows (overflowing to a new
  // message at the 5000-char cap). When block streaming is off (default),
  // the single final reply is chunked and sent (the live-edit loop's
  // disabled path). When `initialDraft` is set (thinking placeholder), the
  // first deliver EDITS that placeholder into the reply instead of sending
  // a new message. See `live-edit.ts` for chatId-resolution caveats.
  const deliver = createLiveEditDeliver({
    client,
    to: deliverTo,
    isDm: !parsed.isGroup,
    enabled: account.blockStreaming,
    initialDraft,
  });
  const handleOnError =
    onError ??
    ((err: unknown, info: { kind: string }) => {
      // eslint-disable-next-line no-console
      console.error(`[cliq] ${info.kind} reply failed: ${String(err)}`);
    });

  // When a thinking placeholder was posted, clean it up if the agent turn
  // ended WITHOUT touching it (the dispatcher flushed no blocks — e.g. the
  // turn threw, or the model produced no reply). An untouched placeholder
  // would otherwise linger as a stray `💭 …`. Always EDIT the placeholder
  // into a user-visible notice (never delete — Zoho rejects DELETE for bot
  // messages with HTTP 400 `message_delete_failed`, leaving the placeholder
  // orphaned). The cleanup runs in a `finally` so a throwing `inbound.run`
  // still cleans up. A failed cleanup is swallowed + reported — it must
  // never break or delay the turn.
  const cleanupStrayPlaceholder = async (): Promise<void> => {
    // Stop the animation first so a late frame edit cannot clobber the
    // cleanup edit (or race with the reply deliver).
    thinkingAnimation?.stop();
    if (!initialDraft) return;
    if (getLiveEditPlaceholderConsumed(deliver)) return;
    const chatId =
      initialDraft.chatId ??
      (!parsed.isGroup ? undefined : await client.resolveChannelChatId(deliverTo).catch(() => undefined));
    if (!chatId) {
      // No chat id to edit with — best-effort skip. The placeholder
      // may linger, but we cannot safely address it without a chat id.
      return;
    }
    const noticeText =
      account.thinking?.failureText ?? "⚠️ Couldn't process that message.";
    try {
      await client.editMessage({
        chatId,
        messageId: initialDraft.messageId,
        text: noticeText,
      });
    } catch (err) {
      onError?.(err, { kind: "thinking-placeholder-cleanup" });
    }
  };

  try {
    await runtime.channel.inbound.run({
      channel: "cliq",
      accountId: account.accountId ?? undefined,
      raw: parsed,
      adapter: {
        ingest: (raw) => ({
          id: raw.messageId,
          timestamp: raw.timestamp ? Date.parse(raw.timestamp) : undefined,
          rawText: raw.text,
          raw,
        }),
        resolveTurn: () => ({
          cfg,
          channel: "cliq",
          accountId: account.accountId ?? undefined,
          agentId: route.agentId,
          routeSessionKey: route.sessionKey,
          storePath,
          ctxPayload,
          recordInboundSession: runtime.channel.session.recordInboundSession,
          dispatchReplyWithBufferedBlockDispatcher:
            runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
          delivery: {
            deliver: async (replyPayload: { text?: string }) => {
              // Stop the animation the moment the reply arrives so a late
              // frame edit cannot clobber the final edit-into-reply.
              thinkingAnimation?.stop();
              await deliver({ text: replyPayload?.text });
            },
            onError: handleOnError,
          },
          record: { createIfMissing: true },
          admission: { kind: "dispatch" },
        }),
      },
    });
  } finally {
    await cleanupStrayPlaceholder();
  }
}
