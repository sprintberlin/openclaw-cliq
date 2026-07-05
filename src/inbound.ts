import { resolveInboundMentionDecision } from "openclaw/plugin-sdk/channel-mention-gating";
import type {
  InboundMentionDecision,
  InboundMentionFacts,
  InboundImplicitMentionKind,
} from "openclaw/plugin-sdk/channel-mention-gating";
import type { IncomingMessage } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { ResolvedCliqAccount } from "./client.js";
import { markdownToCliq } from "./markdown.js";
import { stripCliqMentions } from "./mentions.js";
import { resolveCliqClient } from "./runtime-api.js";

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
  params?: {
    message?: { text?: string; id?: string };
    user?: { id?: string; name?: string };
    channel?: { id?: string; name?: string; unique_name?: string };
    chat?: { id?: string };
  };
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
  threadId?: string;
  handler: string;
}

const WEBHOOK_SECRET_HEADER = "x-cliq-webhook-secret";

/**
 * Verify the shared webhook secret. Returns true when no secret is configured
 * (optional-but-recommended) or when the header matches.
 */
export function verifyWebhookSecret(
  req: Pick<IncomingMessage, "headers">,
  expectedSecret: string | undefined,
): boolean {
  if (!expectedSecret) return true;
  const provided =
    req.headers[WEBHOOK_SECRET_HEADER] ??
    req.headers["x-webhook-secret"] ??
    req.headers["authorization"];
  if (provided === undefined || provided === null) return false;
  const providedStr = Array.isArray(provided) ? provided[0] : String(provided);
  if (!providedStr) return false;
  return (
    providedStr === expectedSecret ||
    providedStr === `Bearer ${expectedSecret}`
  );
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
  return { text, messageId, time };
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
  const user = payload.user;
  if (!text || !user?.id) return null;

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
    handler.includes("mention") || hasBotMention || (isGroup && false);

  return {
    text,
    messageId: messageId || "",
    timestamp: time || new Date().toISOString(),
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
    threadId: payload.thread?.id,
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
 * Evaluate the inbound mention decision using the shared SDK helper. Returns
 * the decision the webhook handler uses to skip or proceed.
 */
export function resolveCliqMentionDecision(
  parsed: ParsedCliqInbound,
  account: ResolvedCliqAccount,
  policy: CliqMentionPolicyInput = {},
): InboundMentionDecision {
  const facts = resolveCliqMentionFacts(parsed, account, {
    isReplyToBot: false,
    isQuoteOfBot: false,
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
  // `userids` (DM) vs `chatid` (group) without a chatType field:
  //   - DM            → `user:<senderId>`    (delivered via `userids`)
  //   - group/channel → `chat:<chatId>` or `channel:<channelUniqueName>` (via `chatid`)
  const responseTarget = parsed.isGroup
    ? parsed.chatId
      ? `chat:${parsed.chatId}`
      : `channel:${parsed.channelUniqueName}`
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
  const body = runtime.channel.reply.formatAgentEnvelope({
    channel: "Cliq",
    from: fromLabel,
    timestamp: parsed.timestamp ? Date.parse(parsed.timestamp) : undefined,
    previousTimestamp,
    envelope: envelopeOptions,
    body: cleanText,
  });

  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: cleanText,
    CommandBody: cleanText,
    From: `cliq:${parsed.senderId}`,
    To: `cliq:${responseTarget}`,
    SessionKey: route.sessionKey,
    AccountId: account.accountId ?? undefined,
    ChatType: parsed.isGroup ? "channel" : "direct",
    ConversationLabel: fromLabel,
    SenderName: parsed.senderName,
    SenderId: parsed.senderId,
    SenderUsername: parsed.senderEmail,
    WasMentioned: parsed.isGroup ? parsed.isMention : undefined,
    Provider: "cliq",
    Surface: "cliq",
    MessageSid: parsed.messageId,
    MessageSidFull: parsed.messageId,
    ReplyToId: parsed.threadId,
    ReplyToIdFull: parsed.threadId,
    OriginatingChannel: "cliq",
    OriginatingTo: `cliq:${responseTarget}`,
  });

  const client = resolveCliqClient(account);
  const deliverTo = parsed.isGroup
    ? (parsed.channelUniqueName ?? parsed.chatId)
    : parsed.senderId;
  const deliver = async (payload: { text?: string; mediaUrl?: string }) => {
    const text = payload.text;
    if (!text) return;
    await client.sendMessage({
      to: deliverTo,
      text: markdownToCliq(text),
      isDm: !parsed.isGroup,
    });
  };
  const handleOnError =
    onError ??
    ((err: unknown, info: { kind: string }) => {
      // eslint-disable-next-line no-console
      console.error(`[cliq] ${info.kind} reply failed: ${String(err)}`);
    });

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
            await deliver({ text: replyPayload?.text });
          },
          onError: handleOnError,
        },
        record: { createIfMissing: true },
        admission: { kind: "dispatch" },
      }),
    },
  });
}
