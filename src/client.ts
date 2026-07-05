import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { withSendRetry, type RetryOptions } from "./send-retry.js";
import {
  getCliqDefaultLogger,
  truncateForLog,
  type CliqLogger,
} from "./logger.js";

const EU_API_BASE = "https://cliq.zoho.eu";
const EU_OAUTH_BASE = "https://accounts.zoho.eu";

const MESSAGE_CHAR_LIMIT = 5000;

export interface CliqChannelConfig {
  clientId?: string;
  clientSecret?: string;
  botId?: string;
  botName?: string;
  webhookSecret?: string;
  allowFrom?: string[];
  dmPolicy?: string;
  /**
   * Additional sender ids / names / emails whose inbound messages are
   * silently dropped as "self" (never dispatched to an agent). Use this to
   * ignore the bot's own alternate identity (e.g. its Zoho user id when the
   * webhook delivers a zuid that differs from `botId`) and other Cliq bots
   * in the same workspace that must not trigger this agent (bot-to-bot
   * loop prevention). The bot's own `botId` and `botName` are always
   * treated as self implicitly; this list is for *additional* identities.
   */
  selfSenderIds?: string[];
  /**
   * When the webhook acknowledges Cliq relative to the inbound dispatch.
   * - `"after_dispatch"` (default): await `runtime.channel.inbound.run`
   *   before sending HTTP 200. A crash mid-dispatch means Cliq never sees
   *   the 200 and redelivers (no lost message). On dispatch error the
   *   webhook returns 500 so Cliq redelivers.
   * - `"immediate"`: fire-and-forget (legacy behavior). Faster, but a
   *   crash between ack and dispatch completion loses the message. Use only
   *   when the Cliq/Deluge `invokeUrl` timeout is tighter than the agent
   *   round-trip and you accept the lost-message risk.
   */
  ackPolicy?: "after_dispatch" | "immediate";
  /**
   * Streaming preview configuration. The SDK coalesces agent output into
   * progressive "block" deliveries (separate messages) rather than waiting
   * for the full reply, when block streaming is enabled. Plugin-channel
   * live-edit-in-place (editing a single message as the draft grows) is not
   * exposed by the SDK; block streaming is the available progressive-delivery
   * mechanism.
   * - `preview: "on"` opts this account into block streaming (the SDK's
   *   `agents.defaults.blockStreamingDefault` must also permit it).
   * - `preview: "off"` (default) keeps the legacy single-final-reply behavior.
   */
  streaming?: { preview?: "on" | "off" };
  /**
   * Optional user-context OAuth **refresh token** obtained once via the
   * self-client `authorization_code` flow (see README §3). When set, the
   * client mints access tokens via `grant_type=refresh_token` for the
   * outbound paths that require a *user-consented* token — channel posts
   * (`ZohoCliq.Channels.UPDATE`) and message edits
   * (`ZohoCliq.Messages.UPDATE`) — because the `client_credentials` grant
   * cannot obtain a usable token for those scopes (Zoho issues a token
   * that reports the scope but rejects it on use with
   * `oauthtoken_scope_invalid`). Bot DMs (`ZohoCliq.Webhooks.CREATE`)
   * keep using `client_credentials`. When unset, behavior is unchanged
   * (client_credentials for everything; channel posts / edits will fail
   * at the API with a scope error — i.e. DM-only setups keep working).
   */
  refreshToken?: string;
}

export interface ResolvedCliqAccount {
  accountId: string | null;
  clientId: string;
  clientSecret: string;
  botId: string;
  botName?: string;
  webhookSecret?: string;
  allowFrom: string[];
  dmPolicy: string | undefined;
  ackPolicy: "after_dispatch" | "immediate";
  selfSenderIds: string[];
  /** Whether progressive (block-streaming) reply delivery is opted-in for this account. */
  blockStreaming: boolean;
  /**
   * Optional user-context refresh token (see `CliqChannelConfig.refreshToken`).
   * When set, channel posts + message edits mint access tokens via the
   * refresh-token grant; otherwise those paths fall back to
   * `client_credentials` (which only works for bot DMs).
   */
  refreshToken?: string;
}

export function resolveCliqConfig(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedCliqAccount {
  const section = (cfg.channels as Record<string, CliqChannelConfig | undefined> | undefined)?.[
    "cliq"
  ];
  const clientId = section?.clientId;
  const clientSecret = section?.clientSecret;
  const botId = section?.botId;
  if (!clientId) throw new Error("cliq: clientId is required");
  if (!clientSecret) throw new Error("cliq: clientSecret is required");
  if (!botId) throw new Error("cliq: botId is required");
  const ackPolicyRaw = section?.ackPolicy;
  const ackPolicy: "after_dispatch" | "immediate" =
    ackPolicyRaw === "immediate" ? "immediate" : "after_dispatch";
  const blockStreaming = section?.streaming?.preview === "on";
  return {
    accountId: accountId ?? null,
    clientId,
    clientSecret,
    botId,
    botName: section?.botName,
    webhookSecret: section?.webhookSecret,
    allowFrom: section?.allowFrom ?? [],
    dmPolicy: section?.dmPolicy,
    ackPolicy,
    selfSenderIds: section?.selfSenderIds ?? [],
    blockStreaming,
    refreshToken: section?.refreshToken,
  };
}

export function chunkMessage(text: string, limit = MESSAGE_CHAR_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let end = Math.min(cursor + limit, text.length);
    if (end < text.length) {
      const lastBreak = text.lastIndexOf("\n", end);
      if (lastBreak > cursor) end = lastBreak;
    }
    chunks.push(text.slice(cursor, end));
    cursor = end;
  }
  return chunks;
}

export interface SendMessageOptions {
  to: string;
  text: string;
  isDm?: boolean;
}

export interface CliqMediaAttachment {
  bytes: Uint8Array;
  fileName: string;
  mimeType?: string;
}

export interface LoadCliqMediaAttachmentOptions {
  mediaUrl: string;
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  mediaAccess?: { readFile?: (filePath: string) => Promise<Buffer> } | null;
  fetchImpl?: typeof fetch;
}

function inferFileNameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const base = u.pathname.split("/").filter(Boolean).pop();
    if (base) return decodeURIComponent(base);
  } catch {
    // not a URL; fall through to path handling
  }
  const parts = url.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || "attachment";
}

function inferFileNameFromPath(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || "attachment";
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", pdf: "application/pdf",
  txt: "text/plain", json: "application/json", csv: "text/csv",
  zip: "application/zip", mp3: "audio/mpeg", mp4: "video/mp4",
  webm: "video/webm", mov: "video/quicktime", wav: "audio/wav",
  ogg: "audio/ogg", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function inferMimeFromExt(fileName: string): string | undefined {
  const ext = fileName.split(".").pop()?.toLowerCase();
  if (!ext) return undefined;
  return MIME_BY_EXT[ext];
}

export async function loadCliqMediaAttachment(
  opts: LoadCliqMediaAttachmentOptions,
): Promise<CliqMediaAttachment> {
  const url = opts.mediaUrl;
  const isHttp = /^https?:\/\//i.test(url);
  if (isHttp) {
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    const res = await fetchImpl(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`cliq: media fetch failed (${res.status}): ${body}`);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    const ct = res.headers.get("content-type") ?? undefined;
    const fileName = inferFileNameFromUrl(url);
    const mimeType = ct && ct !== "application/octet-stream" ? ct : (inferMimeFromExt(fileName) ?? ct);
    return { bytes: buf, fileName, mimeType };
  }
  const readFile = opts.mediaReadFile ?? opts.mediaAccess?.readFile;
  if (!readFile) {
    throw new Error(`cliq: cannot read local media "${url}" — no mediaReadFile/mediaAccess.readFile provided`);
  }
  const buffer = await readFile(url);
  const bytes = new Uint8Array(buffer.byteLength);
  bytes.set(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
  const fileName = inferFileNameFromPath(url);
  const mimeType = inferMimeFromExt(fileName);
  return { bytes, fileName, mimeType };
}

export interface SendMediaMessageOptions {
  to: string;
  text?: string;
  isDm?: boolean;
  attachment: CliqMediaAttachment;
}

export interface NormalizedCliqTarget {
  to: string;
  isDm: boolean;
}

/** A raw Zoho Cliq user record as returned by `GET /api/v2/users`. */
export interface CliqUserRecord {
  id?: string;
  user_id?: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  name?: string;
  display_name?: string;
  [key: string]: unknown;
}

/** A raw Zoho Cliq channel record as returned by `GET /api/v2/channels`. */
export interface CliqChannelRecord {
  id?: string;
  channel_id?: string;
  chat_id?: string;
  name?: string;
  unique_name?: string;
  display_name?: string;
  [key: string]: unknown;
}

/** A normalized directory entry derived from a raw Cliq user/channel record. */
export interface CliqDirectoryEntry {
  kind: "user" | "group";
  id: string;
  name?: string;
  handle?: string;
  raw?: unknown;
}

/** Pull a string id from a Cliq user record (tolerates `id` / `user_id`). */
function readCliqUserId(rec: CliqUserRecord): string | undefined {
  return rec.id ?? rec.user_id ?? undefined;
}

/** Pull a display name from a Cliq user record (tolerates several fields). */
function readCliqUserName(rec: CliqUserRecord): string | undefined {
  const parts = [
    rec.first_name,
    rec.last_name,
  ].filter((p): p is string => Boolean(p && p.trim()));
  if (parts.length) return parts.join(" ").trim();
  return rec.display_name ?? rec.name ?? rec.email ?? undefined;
}

/** Pull a string id from a Cliq channel record (tolerates `id` / `channel_id`). */
function readCliqChannelId(rec: CliqChannelRecord): string | undefined {
  return rec.id ?? rec.channel_id ?? undefined;
}

/** Pull a display name from a Cliq channel record. */
function readCliqChannelName(rec: CliqChannelRecord): string | undefined {
  return rec.display_name ?? rec.name ?? rec.unique_name ?? undefined;
}

/**
 * Pull a chat id (`CT_xxx`) from a Cliq channel record. The channelsbyname
 * GET returns the channel as a top-level object OR wrapped under a
 * `channel` key (varies by API version); we tolerate both, plus the
 * `id` / `channel_id` / `chat_id` field-name variance.
 */
function readCliqChannelChatId(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const obj = data as Record<string, unknown>;
  const rec = (obj.channel && typeof obj.channel === "object"
    ? (obj.channel as CliqChannelRecord)
    : (obj as CliqChannelRecord));
  return rec.chat_id ?? rec.id ?? rec.channel_id ?? undefined;
}

/** A normalized reference to a chat message (the editable id pair). */
export interface CliqChatMessageRef {
  messageId: string;
  chatId: string;
  text?: string;
}

/**
 * Parse a `GET /api/v2/chats/{chatId}/messages` response into a list of
 * message refs. The response shape is `{ messages: [...] }` (or a bare
 * array in some API versions); each entry is parsed defensively for
 * `message_id` / `id` and `chat_id`, plus an optional `text` (used to
 * disambiguate when the message id alone does not match). Records missing
 * a resolvable id are skipped, never thrown on.
 */
function parseCliqChatMessages(data: unknown): CliqChatMessageRef[] {
  if (!data || typeof data !== "object") return [];
  const obj = data as Record<string, unknown>;
  const list = obj.messages ?? obj.data ?? data;
  if (!Array.isArray(list)) return [];
  const refs: CliqChatMessageRef[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const messageId =
      typeof rec.message_id === "string" ? rec.message_id
        : typeof rec.id === "string" ? rec.id
        : undefined;
    const chatId =
      typeof rec.chat_id === "string" ? rec.chat_id
        : typeof rec.chatId === "string" ? rec.chatId
        : undefined;
    if (!messageId || !chatId) continue;
    const text = typeof rec.text === "string" ? rec.text : undefined;
    refs.push({ messageId, chatId, text });
  }
  return refs;
}



/**
 * Normalize an OpenClaw route target (`ctx.to`) into a raw Zoho Cliq id plus a
 * DM flag. The inbound path encodes the chat type in the target prefix:
 *   - `cliq:user:<id>` / `cliq:dm:<id>`  → DM, deliver via `userids` to /bots/{botId}/message
 *   - `cliq:chat:<id>`                   → group/channel, deliver via channelsbyname
 *   - `cliq:channel:<uniqueName>`        → group/channel, deliver via channelsbyname
 * The `to` for a non-DM target MUST be the channel unique name (the
 * channelsbyname endpoint keys off it in the URL path); a bare chat id is
 * only a fallback when the inbound payload carried no unique name. Targets
 * without the `cliq:` prefix are treated as group/channel ids so raw ids
 * stored in older sessions keep working (defaulting to channelsbyname).
 */
export function normalizeCliqRouteTarget(to: string): NormalizedCliqTarget {
  if (!to) return { to, isDm: false };
  const m = /^cliq:([a-z]+):(.+)$/i.exec(to);
  if (!m) return { to, isDm: false };
  const kind = m[1].toLowerCase();
  const id = m[2];
  if (kind === "user" || kind === "dm") {
    return { to: id, isDm: true };
  }
  return { to: id, isDm: false };
}

/**
 * Parse a Cliq bot-message / chat-message API response into a message ref.
 *
 * The bot-message send response is inconsistent: a top-level `{ id }` for
 * channel posts, or a nested `{ message_details: { "<userId>": { chat_id,
 * message_id } } }` for bot DMs. The chat-message edit response echoes
 * neither reliably. We parse defensively, extracting `messageId` (from
 * `id`, `message_id`, or `message_details[<any>].message_id`) and `chatId`
 * (from `message_details[<any>].chat_id`), never throwing on a malformed
 * body — the caller treats a missing id as "send succeeded but no ref".
 */
function parseCliqMessageRef(body: string): { messageId?: string; chatId?: string } {
  if (!body) return {};
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return {};
  }
  if (!data || typeof data !== "object") return {};
  const obj = data as Record<string, unknown>;
  const topId = typeof obj.id === "string" ? obj.id : undefined;
  const topMessageId =
    typeof obj.message_id === "string" ? obj.message_id : undefined;
  const topChatId =
    typeof obj.chat_id === "string" ? obj.chat_id : undefined;
  let nestedChatId: string | undefined;
  let nestedMessageId: string | undefined;
  const details = obj.message_details;
  if (details && typeof details === "object") {
    for (const value of Object.values(details as Record<string, unknown>)) {
      if (value && typeof value === "object") {
        const entry = value as Record<string, unknown>;
        if (typeof entry.chat_id === "string") nestedChatId = entry.chat_id;
        if (typeof entry.message_id === "string") nestedMessageId = entry.message_id;
      }
    }
  }
  return {
    messageId: topMessageId ?? nestedMessageId ?? topId,
    chatId: nestedChatId ?? topChatId,
  };
}

export class CliqClient {
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();
  private readonly retryOptions: Required<RetryOptions>;
  private readonly logger: CliqLogger;
  /**
   * Cache of resolved channel unique name → chat id (`CT_xxx`). The mapping
   * is stable for the lifetime of a channel, so it is cached per client
   * (and therefore per account) to avoid a `GET /channelsbyname/{name}`
   * round-trip on every group/channel send. Used by live-edit streaming to
   * address the chat-message edit API with a valid chat id instead of the
   * channel unique name (which the edit endpoint rejects).
   */
  private readonly channelChatIdCache = new Map<string, string>();

  /**
   * Cache key under which the user-context (refresh-token) access token is
   * stored. A refresh-token access token is NOT scoped per-request — it
   * carries whatever scopes were consented at the authorization-code grant
   * — so it is cached as a single shared entry, not one per scope.
   */
  private static readonly REFRESH_TOKEN_KEY = "__refresh_token__";

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly botId: string,
    private readonly apiBase = EU_API_BASE,
    private readonly oauthBase = EU_OAUTH_BASE,
    retryOptions?: RetryOptions,
    logger?: CliqLogger,
    private readonly refreshToken?: string,
  ) {
    const base = retryOptions ?? {};
    this.retryOptions = {
      maxAttempts: base.maxAttempts ?? 3,
      baseDelayMs: base.baseDelayMs ?? 500,
      maxDelayMs: base.maxDelayMs ?? 8_000,
      sleep: base.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
      random: base.random ?? Math.random,
    };
    // Fall back to the module-level default logger (console, or the gateway
    // `api.logger` injected via `setCliqDefaultLogger` at registration). A
    // caller-supplied logger always wins so tests can capture exact calls.
    this.logger = logger ?? getCliqDefaultLogger();
  }

  async getAccessToken(scope = "ZohoCliq.Webhooks.CREATE"): Promise<string> {
    const now = Date.now();
    const cached = this.tokens.get(scope);
    if (cached && now < cached.expiresAt - 60_000) {
      return cached.token;
    }
    const url = new URL(`${this.oauthBase}/oauth/v2/token`);
    url.searchParams.set("grant_type", "client_credentials");
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("client_secret", this.clientSecret);
    url.searchParams.set("scope", scope);
    this.logger.debug?.(`[cliq] oauth: requesting access token (scope=${scope})`);
    const res = await fetch(url, { method: "POST" });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      this.logger.error?.(
        `[cliq] oauth: token request failed status=${res.status} scope=${scope} body=${truncateForLog(body)}`,
      );
      throw new Error(`cliq: OAuth token request failed (${res.status}): ${body}`);
    }
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) {
      this.logger.error?.(`[cliq] oauth: response missing access_token (scope=${scope})`);
      throw new Error("cliq: OAuth response did not include access_token");
    }
    this.tokens.set(scope, {
      token: data.access_token,
      expiresAt: now + (data.expires_in ?? 3600) * 1000,
    });
    this.logger.debug?.(
      `[cliq] oauth: access token acquired (scope=${scope} expires_in=${data.expires_in ?? 3600}s)`,
    );
    return data.access_token;
  }

  /**
   * Mint an access token via the user-context `refresh_token` grant. Used by
   * the outbound paths that require a user-consented token (channel posts
   * via `ZohoCliq.Channels.UPDATE` and message edits via
   * `ZohoCliq.Messages.UPDATE`) — the `client_credentials` grant cannot
   * obtain a usable token for those scopes (Zoho issues a token whose
   * response reports the scope, but the API rejects it with
   * `oauthtoken_scope_invalid`). A refresh-token access token carries all
   * scopes consented at the authorization-code grant, so it is cached as a
   * single shared entry (not per-scope) and reused for both the channel and
   * edit paths. Throws if no `refreshToken` is configured.
   */
  async getRefreshedAccessToken(): Promise<string> {
    if (!this.refreshToken) {
      throw new Error(
        "cliq: no refreshToken configured — channel posts and message edits require a user-context token (see README §3)",
      );
    }
    const now = Date.now();
    const cached = this.tokens.get(CliqClient.REFRESH_TOKEN_KEY);
    if (cached && now < cached.expiresAt - 60_000) {
      return cached.token;
    }
    const url = new URL(`${this.oauthBase}/oauth/v2/token`);
    url.searchParams.set("grant_type", "refresh_token");
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("client_secret", this.clientSecret);
    url.searchParams.set("refresh_token", this.refreshToken);
    this.logger.debug?.(`[cliq] oauth: refreshing user-context access token`);
    const res = await fetch(url, { method: "POST" });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      this.logger.error?.(
        `[cliq] oauth: refresh token request failed status=${res.status} body=${truncateForLog(body)}`,
      );
      throw new Error(`cliq: OAuth refresh token request failed (${res.status}): ${body}`);
    }
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) {
      this.logger.error?.(`[cliq] oauth: refresh response missing access_token`);
      throw new Error("cliq: OAuth refresh response did not include access_token");
    }
    this.tokens.set(CliqClient.REFRESH_TOKEN_KEY, {
      token: data.access_token,
      expiresAt: now + (data.expires_in ?? 3600) * 1000,
    });
    this.logger.debug?.(
      `[cliq] oauth: refreshed access token acquired (expires_in=${data.expires_in ?? 3600}s)`,
    );
    return data.access_token;
  }

  /**
   * Resolve the access token for an outbound send/edit. When a
   * `refreshToken` is configured AND the operation requires a user-context
   * scope (channel posts / edits), use the refresh-token grant; otherwise
   * fall back to `client_credentials` (the DM path and the no-refreshToken
   * DM-only setup).
   */
  private resolveOutboundToken(scope: string, needsUserContext: boolean): Promise<string> {
    return needsUserContext && this.refreshToken
      ? this.getRefreshedAccessToken()
      : this.getAccessToken(scope);
  }

  async sendMessage(opts: SendMessageOptions): Promise<{ messageId?: string; chatId?: string }> {
    const isDm = Boolean(opts.isDm);
    // DMs use the bot-message endpoint (scope ZohoCliq.Webhooks.CREATE).
    // Channel posts use the channelsbyname endpoint with the channel unique
    // name in the path and the bot identity as a `bot_unique_name` query
    // param (scope ZohoCliq.Channels.UPDATE). The bot-message endpoint
    // rejects `chatid` ("'chatid' is an extra key in the JSON Object"), so
    // group sends MUST NOT go through /bots/{botId}/message. See issue #26.
    // The Channels.UPDATE scope CANNOT be obtained via client_credentials
    // (Zoho issues a token that reports the scope but rejects it on use with
    // `oauthtoken_scope_invalid`); a user-context refresh token is required
    // for channel posts. See issue #27. When no refreshToken is configured,
    // the channel path falls back to client_credentials (which will fail at
    // the API — i.e. DM-only setups keep working unchanged).
    const scope = isDm ? "ZohoCliq.Webhooks.CREATE" : "ZohoCliq.Channels.UPDATE";
    const needsUserContext = !isDm;
    const token = await this.resolveOutboundToken(scope, needsUserContext);
    const targetKind = isDm ? "dm" : "channel";
    let url: string;
    const payload: Record<string, unknown> = { text: opts.text };
    if (isDm) {
      url = `${this.apiBase}/api/v2/bots/${encodeURIComponent(this.botId)}/message`;
      payload.userids = opts.to;
    } else {
      url = `${this.apiBase}/api/v2/channelsbyname/${encodeURIComponent(opts.to)}/message?bot_unique_name=${encodeURIComponent(this.botId)}`;
    }
    this.logger.info?.(
      `[cliq] send: ${targetKind} id=${opts.to} textLen=${opts.text.length}`,
    );
    let attempt = 0;
    const res = await withSendRetry(
      async () => {
        attempt++;
        const r = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Zoho-oauthtoken ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
        const body = await r.text().catch(() => "");
        if (r.ok) {
          const ref = parseCliqMessageRef(body);
          this.logger.info?.(
            `[cliq] send ok: status=${r.status} ${targetKind} id=${opts.to} messageId=${ref.messageId ?? "-"} attempt=${attempt}`,
          );
        } else {
          this.logger.warn?.(
            `[cliq] send non-2xx: status=${r.status} ${targetKind} id=${opts.to} attempt=${attempt} body=${truncateForLog(body)}`,
          );
        }
        return { status: r.status, body, headers: r.headers };
      },
      this.retryOptions,
    );
    return parseCliqMessageRef(res.body);
  }

  async sendMediaMessage(opts: SendMediaMessageOptions): Promise<{ messageId?: string }> {
    const isDm = Boolean(opts.isDm);
    const scope = isDm ? "ZohoCliq.Webhooks.CREATE" : "ZohoCliq.Channels.UPDATE";
    const needsUserContext = !isDm;
    const token = await this.resolveOutboundToken(scope, needsUserContext);
    const form = new FormData();
    if (opts.text) form.set("text", opts.text);
    let url: string;
    if (isDm) {
      url = `${this.apiBase}/api/v2/bots/${encodeURIComponent(this.botId)}/message`;
      form.set("userids", opts.to);
    } else {
      // Channel media post: channelsbyname endpoint (see sendMessage/issue #26).
      url = `${this.apiBase}/api/v2/channelsbyname/${encodeURIComponent(opts.to)}/message?bot_unique_name=${encodeURIComponent(this.botId)}`;
    }
    const mimeType = opts.attachment.mimeType ?? "application/octet-stream";
    // Copy into a standalone ArrayBuffer so the Blob does not capture a shared
    // Node Buffer pool (which would include unrelated adjacent allocations).
    const standalone = new Uint8Array(opts.attachment.bytes.byteLength);
    standalone.set(opts.attachment.bytes);
    const blob = new Blob([standalone], { type: mimeType });
    form.set("attachments", blob, opts.attachment.fileName);
    const targetKind = opts.isDm ? "dm" : "channel";
    this.logger.info?.(
      `[cliq] send media: ${targetKind} id=${opts.to} fileName=${opts.attachment.fileName} bytes=${opts.attachment.bytes.byteLength}${opts.text ? ` textLen=${opts.text.length}` : ""}`,
    );
    let attempt = 0;
    const res = await withSendRetry(
      async () => {
        attempt++;
        const r = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Zoho-oauthtoken ${token}` },
          body: form,
        });
        const body = await r.text().catch(() => "");
        if (r.ok) {
          const parsed = JSON.parse(body || "{}") as { id?: string };
          this.logger.info?.(
            `[cliq] send media ok: status=${r.status} ${targetKind} id=${opts.to} messageId=${parsed.id ?? "-"} attempt=${attempt}`,
          );
        } else {
          this.logger.warn?.(
            `[cliq] send media non-2xx: status=${r.status} ${targetKind} id=${opts.to} attempt=${attempt} body=${truncateForLog(body)}`,
          );
        }
        return { status: r.status, body, headers: r.headers };
      },
      this.retryOptions,
    );
    const data = JSON.parse(res.body || "{}") as { id?: string };
    return { messageId: data.id };
  }

  /**
   * Edit an existing chat message in place via the Cliq chat-messages API:
   * `PUT /api/v2/chats/{chatId}/messages/{messageId}` with body `{ text }`.
   * The text MUST already be in Cliq-native formatting (the caller runs
   * `markdownToCliq`); this method does not re-format. Requires the
   * `ZohoCliq.Messages.UPDATE` scope (minted + cached per-scope, separate
   * from the webhook bot-message token).
   *
   * Used as the building block for live-edit streaming previews and for the
   * future message-action adapter (edit/delete). Carries the same
   * transient/fatal/format classification + retry as `sendMessage`.
   *
   * Returns `{ messageId, chatId }` for symmetry with `sendMessage` (the
   * Cliq edit response does not always echo the id, so we fall back to the
   * caller-supplied ids).
   */
  async editMessage(opts: {
    chatId: string;
    messageId: string;
    text: string;
  }): Promise<{ messageId?: string; chatId?: string }> {
    // The Messages.UPDATE scope cannot be obtained via client_credentials
    // (same oauthtoken_scope_invalid failure as Channels.UPDATE); a
    // user-context refresh token is required for edits. See issue #27.
    const token = await this.resolveOutboundToken(
      "ZohoCliq.Messages.UPDATE",
      true,
    );
    const url = `${this.apiBase}/api/v2/chats/${encodeURIComponent(opts.chatId)}/messages/${encodeURIComponent(opts.messageId)}`;
    this.logger.info?.(
      `[cliq] edit: chatId=${opts.chatId} messageId=${opts.messageId} textLen=${opts.text.length}`,
    );
    let attempt = 0;
    const res = await withSendRetry(
      async () => {
        attempt++;
        const r = await fetch(url, {
          method: "PUT",
          headers: {
            Authorization: `Zoho-oauthtoken ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ text: opts.text }),
        });
        const body = await r.text().catch(() => "");
        if (r.ok) {
          this.logger.info?.(
            `[cliq] edit ok: status=${r.status} chatId=${opts.chatId} messageId=${opts.messageId} attempt=${attempt}`,
          );
        } else {
          this.logger.warn?.(
            `[cliq] edit non-2xx: status=${r.status} chatId=${opts.chatId} messageId=${opts.messageId} attempt=${attempt} body=${truncateForLog(body)}`,
          );
        }
        return { status: r.status, body, headers: r.headers };
      },
      this.retryOptions,
    );
    const parsed = parseCliqMessageRef(res.body);
    return {
      messageId: parsed.messageId ?? opts.messageId,
      chatId: parsed.chatId ?? opts.chatId,
    };
  }

  /**
   * Delete an existing chat message via the Cliq chat-messages API:
   * `DELETE /api/v2/chats/{chatId}/messages/{messageId}`. Like `editMessage`,
   * this requires the `ZohoCliq.Messages.UPDATE` scope, which cannot be
   * obtained via `client_credentials` — a user-context refresh token is
   * required (see issue #27). Returns `true` on a 2xx (Cliq returns 204 No
   * Content on success); throws on a non-2xx with the response body for
   * diagnostics. Carries the same transient/fatal retry as `sendMessage`
   * (429/5xx retried with backoff; 4xx fatal).
   */
  async deleteMessage(opts: {
    chatId: string;
    messageId: string;
  }): Promise<boolean> {
    const token = await this.resolveOutboundToken(
      "ZohoCliq.Messages.UPDATE",
      true,
    );
    const url = `${this.apiBase}/api/v2/chats/${encodeURIComponent(opts.chatId)}/messages/${encodeURIComponent(opts.messageId)}`;
    this.logger.info?.(
      `[cliq] delete: chatId=${opts.chatId} messageId=${opts.messageId}`,
    );
    let attempt = 0;
    const res = await withSendRetry(
      async () => {
        attempt++;
        const r = await fetch(url, {
          method: "DELETE",
          headers: { Authorization: `Zoho-oauthtoken ${token}` },
        });
        const body = await r.text().catch(() => "");
        if (r.ok) {
          this.logger.info?.(
            `[cliq] delete ok: status=${r.status} chatId=${opts.chatId} messageId=${opts.messageId} attempt=${attempt}`,
          );
        } else {
          this.logger.warn?.(
            `[cliq] delete non-2xx: status=${r.status} chatId=${opts.chatId} messageId=${opts.messageId} attempt=${attempt} body=${truncateForLog(body)}`,
          );
        }
        return { status: r.status, body, headers: r.headers };
      },
      this.retryOptions,
    );
    return res.status >= 200 && res.status < 300;
  }

  /**
   * Fetch an authenticated JSON document from the Cliq REST API using the
   * user-context (refresh-token) access token. Used by endpoints that need a
   * user-consented scope the `client_credentials` grant cannot obtain
   * (e.g. reading chat messages — `ZohoCliq.Messages.UPDATE` / channel
   * context). Throws if no `refreshToken` is configured (the refresh-token
   * grant is the only way to mint a usable token for these endpoints).
   */
  private async getJsonUserContext(path: string): Promise<unknown> {
    const token = await this.getRefreshedAccessToken();
    const url = `${this.apiBase}${path}`;
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`cliq: GET ${path} failed (${res.status}): ${body}`);
    }
    return res.json();
  }

  /**
   * Resolve a Zoho Cliq channel unique name (the handle used in the
   * channelsbyname send URL) to its underlying chat id (`CT_xxx`) — the id
   * the chat-message edit API (`PUT /api/v2/chats/{chatId}/messages/...`)
   * requires. A channel POST's bot-message send response returns only a
   * top-level `{ id }` (the message id), NOT the chat id, so live-edit
   * streaming for group/channel posts must resolve the chat id separately.
   *
   * The mapping is cached per client (per account) — a channel's chat id is
   * stable. Returns `undefined` when the channel cannot be resolved (not
   * found, API error, or the record carries no resolvable id); the caller
   * (live-edit) treats that as "no editable chat id" and degrades to a new
   * message per block. Never throws so a directory/resolve failure cannot
   * break an agent turn.
   */
  async resolveChannelChatId(channelUniqueName: string): Promise<string | undefined> {
    const key = channelUniqueName;
    const cached = this.channelChatIdCache.get(key);
    if (cached) return cached;
    const path = `/api/v2/channelsbyname/${encodeURIComponent(channelUniqueName)}`;
    let data: unknown;
    try {
      data = await this.getJson(path, "ZohoCliq.Channels.READ");
    } catch (err) {
      this.logger.warn?.(
        `[cliq] resolveChannelChatId: GET ${path} failed (${String(err)})`,
      );
      return undefined;
    }
    const chatId = readCliqChannelChatId(data);
    if (chatId) {
      this.channelChatIdCache.set(key, chatId);
      this.logger.debug?.(
        `[cliq] resolveChannelChatId: ${channelUniqueName} -> ${chatId}`,
      );
    } else {
      this.logger.warn?.(
        `[cliq] resolveChannelChatId: no chat id in record for ${channelUniqueName}`,
      );
    }
    return chatId;
  }

  /**
   * Fetch the most recent messages of a chat (`GET /api/v2/chats/{chatId}/messages`).
   * Used by live-edit streaming to recover the editable chat-message ref for a
   * just-sent channel post when the direct chat-id edit fails — the bot-message
   * send `id` is not always the same as the chat-message `message_id` the edit
   * API expects, so listing recent messages and matching by id/text recovers
   * the canonical `{ chat_id, message_id }` (the bernesto reference pattern).
   *
   * Requires a user-context refresh token (chat-message reads need a
   * user-consented scope the `client_credentials` grant cannot obtain, same
   * constraint as channel posts + edits). Throws if no refresh token is
   * configured or the API rejects the request; the live-edit caller wraps the
   * call in try/catch and degrades to a new message on failure.
   */
  async listChatMessages(
    chatId: string,
    opts: { limit?: number } = {},
  ): Promise<CliqChatMessageRef[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    const path = `/api/v2/chats/${encodeURIComponent(chatId)}/messages?from=0&limit=${limit}`;
    const data = await this.getJsonUserContext(path);
    return parseCliqChatMessages(data);
  }

  /**
   * Add a reaction (emoji) to a chat message via the Cliq reactions API:
   * `POST /api/v2/chats/{chatId}/messages/{messageId}/reactions` with body
   * `{ emoji_code }`. Requires the `ZohoCliq.messageactions.CREATE` scope
   * (a user-context scope the `client_credentials` grant cannot obtain a
   * usable token for — same constraint as channel posts + edits, see issue
   * #27), so the path routes through the refresh-token grant when one is
   * configured and falls back to `client_credentials` otherwise (which will
   * fail at the API — DM-only setups keep working). Returns `true` on 2xx.
   *
   * `emoji` may be a Zomoji shortcode (e.g. `:smile:`) or a unicode emoji
   * character (e.g. `😄`); both are accepted by the Cliq API verbatim.
   */
  async addMessageReaction(opts: {
    chatId: string;
    messageId: string;
    emoji: string;
  }): Promise<boolean> {
    const token = await this.resolveOutboundToken(
      "ZohoCliq.messageactions.CREATE",
      true,
    );
    const url = `${this.apiBase}/api/v2/chats/${encodeURIComponent(opts.chatId)}/messages/${encodeURIComponent(opts.messageId)}/reactions`;
    this.logger.info?.(
      `[cliq] react add: chatId=${opts.chatId} messageId=${opts.messageId}`,
    );
    let attempt = 0;
    const res = await withSendRetry(
      async () => {
        attempt++;
        const r = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Zoho-oauthtoken ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ emoji_code: opts.emoji }),
        });
        const body = await r.text().catch(() => "");
        if (r.ok) {
          this.logger.info?.(
            `[cliq] react add ok: status=${r.status} chatId=${opts.chatId} messageId=${opts.messageId} attempt=${attempt}`,
          );
        } else {
          this.logger.warn?.(
            `[cliq] react add non-2xx: status=${r.status} chatId=${opts.chatId} messageId=${opts.messageId} attempt=${attempt} body=${truncateForLog(body)}`,
          );
        }
        return { status: r.status, body, headers: r.headers };
      },
      this.retryOptions,
    );
    return res.status >= 200 && res.status < 300;
  }

  /**
   * Remove a reaction (emoji) from a chat message via the Cliq reactions
   * API: `DELETE /api/v2/chats/{chatId}/messages/{messageId}/reactions` with
   * body `{ emoji_code }`. Like `addMessageReaction`, this requires the
   * `ZohoCliq.messageactions.CREATE` scope (the delete endpoint reuses the
   * CREATE scope per the Cliq REST docs) and a user-context refresh token.
   * Returns `true` on 2xx.
   */
  async removeMessageReaction(opts: {
    chatId: string;
    messageId: string;
    emoji: string;
  }): Promise<boolean> {
    const token = await this.resolveOutboundToken(
      "ZohoCliq.messageactions.CREATE",
      true,
    );
    const url = `${this.apiBase}/api/v2/chats/${encodeURIComponent(opts.chatId)}/messages/${encodeURIComponent(opts.messageId)}/reactions`;
    this.logger.info?.(
      `[cliq] react remove: chatId=${opts.chatId} messageId=${opts.messageId}`,
    );
    let attempt = 0;
    const res = await withSendRetry(
      async () => {
        attempt++;
        const r = await fetch(url, {
          method: "DELETE",
          headers: {
            Authorization: `Zoho-oauthtoken ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ emoji_code: opts.emoji }),
        });
        const body = await r.text().catch(() => "");
        if (r.ok) {
          this.logger.info?.(
            `[cliq] react remove ok: status=${r.status} chatId=${opts.chatId} messageId=${opts.messageId} attempt=${attempt}`,
          );
        } else {
          this.logger.warn?.(
            `[cliq] react remove non-2xx: status=${r.status} chatId=${opts.chatId} messageId=${opts.messageId} attempt=${attempt} body=${truncateForLog(body)}`,
          );
        }
        return { status: r.status, body, headers: r.headers };
      },
      this.retryOptions,
    );
    return res.status >= 200 && res.status < 300;
  }

  /**
   * Fetch an authenticated JSON document from the Cliq REST API. Used by the
   * directory listing endpoints (`/api/v2/users`, `/api/v2/channels`) which
   * are read-only GETs scoped to `ZohoCliq.Users.READ` / `ZohoCliq.Channels.READ`.
   * Throws on a non-2xx with the response body for diagnostics.
   */
  private async getJson(path: string, scope: string): Promise<unknown> {
    const token = await this.getAccessToken(scope);
    const url = `${this.apiBase}${path}`;
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`cliq: GET ${path} failed (${res.status}): ${body}`);
    }
    return res.json();
  }

  /**
   * List Zoho Cliq users (organization peers) for the directory. Paginates
   * via the `from`/`limit` query params (Cliq's max page size is 200) up to
   * `maxItems`, then returns normalized entries. The raw record is kept on
   * `raw` for callers that need extra fields. Never throws on a malformed
   * record — it is skipped.
   */
  async listUsers(maxItems = 500): Promise<CliqDirectoryEntry[]> {
    const entries: CliqDirectoryEntry[] = [];
    const pageSize = 200;
    let from = 0;
    while (entries.length < maxItems) {
      const limit = Math.min(pageSize, maxItems - entries.length);
      const path = `/api/v2/users?from=${from}&limit=${limit}`;
      const json = (await this.getJson(path, "ZohoCliq.Users.READ")) as {
        users?: CliqUserRecord[];
      } | CliqUserRecord[];
      const recs = Array.isArray(json) ? json : json?.users ?? [];
      if (recs.length === 0) break;
      for (const rec of recs) {
        const id = readCliqUserId(rec);
        if (!id) continue;
        entries.push({
          kind: "user",
          id,
          name: readCliqUserName(rec),
          raw: rec,
        });
      }
      if (recs.length < limit) break;
      from += recs.length;
    }
    return entries;
  }

  /**
   * List Zoho Cliq channels (group chats the bot/user can see) for the
   * directory. Paginates like `listUsers`. Channel ids become directory
   * entries of kind `group`; `unique_name` (when present) is exposed as the
   * `handle` so routing can target either `cliq:chat:<id>` or
   * `cliq:channel:<unique_name>`.
   */
  async listChannels(maxItems = 500): Promise<CliqDirectoryEntry[]> {
    const entries: CliqDirectoryEntry[] = [];
    const pageSize = 200;
    let from = 0;
    while (entries.length < maxItems) {
      const limit = Math.min(pageSize, maxItems - entries.length);
      const path = `/api/v2/channels?from=${from}&limit=${limit}`;
      const json = (await this.getJson(path, "ZohoCliq.Channels.READ")) as {
        channels?: CliqChannelRecord[];
      } | CliqChannelRecord[];
      const recs = Array.isArray(json) ? json : json?.channels ?? [];
      if (recs.length === 0) break;
      for (const rec of recs) {
        const id = readCliqChannelId(rec);
        if (!id) continue;
        entries.push({
          kind: "group",
          id,
          name: readCliqChannelName(rec),
          handle: rec.unique_name ?? undefined,
          raw: rec,
        });
      }
      if (recs.length < limit) break;
      from += recs.length;
    }
    return entries;
  }
}
