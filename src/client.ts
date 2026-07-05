import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { withSendRetry, type RetryOptions } from "./send-retry.js";

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

/**
 * Normalize an OpenClaw route target (`ctx.to`) into a raw Zoho Cliq id plus a
 * DM flag. The inbound path encodes the chat type in the target prefix:
 *   - `cliq:user:<id>` / `cliq:dm:<id>`  → DM, deliver via `userids`
 *   - `cliq:chat:<id>`                   → group/channel, deliver via `chatid`
 *   - `cliq:channel:<name>`              → group/channel, deliver via `chatid`
 * Targets without the `cliq:` prefix are treated as group/channel ids so raw
 * ids stored in older sessions keep working (defaulting to `chatid`).
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

export class CliqClient {
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  private readonly retryOptions: Required<RetryOptions>;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly botId: string,
    private readonly apiBase = EU_API_BASE,
    private readonly oauthBase = EU_OAUTH_BASE,
    retryOptions?: RetryOptions,
  ) {
    const base = retryOptions ?? {};
    this.retryOptions = {
      maxAttempts: base.maxAttempts ?? 3,
      baseDelayMs: base.baseDelayMs ?? 500,
      maxDelayMs: base.maxDelayMs ?? 8_000,
      sleep: base.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
      random: base.random ?? Math.random,
    };
  }

  async getAccessToken(scope = "ZohoCliq.Webhooks.CREATE"): Promise<string> {
    const now = Date.now();
    if (this.accessToken && now < this.tokenExpiresAt - 60_000) {
      return this.accessToken;
    }
    const url = new URL(`${this.oauthBase}/oauth/v2/token`);
    url.searchParams.set("grant_type", "client_credentials");
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("client_secret", this.clientSecret);
    url.searchParams.set("scope", scope);
    const res = await fetch(url, { method: "POST" });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`cliq: OAuth token request failed (${res.status}): ${body}`);
    }
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) {
      throw new Error("cliq: OAuth response did not include access_token");
    }
    this.accessToken = data.access_token;
    this.tokenExpiresAt = now + (data.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }

  async sendMessage(opts: SendMessageOptions): Promise<{ messageId?: string }> {
    const token = await this.getAccessToken("ZohoCliq.Webhooks.CREATE");
    const url = `${this.apiBase}/api/v2/bots/${encodeURIComponent(this.botId)}/message`;
    const payload: Record<string, unknown> = { text: opts.text };
    if (opts.isDm) {
      payload.userids = opts.to;
    } else {
      payload.chatid = opts.to;
    }
    const res = await withSendRetry(
      async () => {
        const r = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Zoho-oauthtoken ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
        const body = await r.text().catch(() => "");
        return { status: r.status, body, headers: r.headers };
      },
      this.retryOptions,
    );
    const data = JSON.parse(res.body || "{}") as { id?: string };
    return { messageId: data.id };
  }

  async sendMediaMessage(opts: SendMediaMessageOptions): Promise<{ messageId?: string }> {
    const token = await this.getAccessToken("ZohoCliq.Webhooks.CREATE");
    const url = `${this.apiBase}/api/v2/bots/${encodeURIComponent(this.botId)}/message`;
    const form = new FormData();
    if (opts.text) form.set("text", opts.text);
    if (opts.isDm) {
      form.set("userids", opts.to);
    } else {
      form.set("chatid", opts.to);
    }
    const mimeType = opts.attachment.mimeType ?? "application/octet-stream";
    // Copy into a standalone ArrayBuffer so the Blob does not capture a shared
    // Node Buffer pool (which would include unrelated adjacent allocations).
    const standalone = new Uint8Array(opts.attachment.bytes.byteLength);
    standalone.set(opts.attachment.bytes);
    const blob = new Blob([standalone], { type: mimeType });
    form.set("attachments", blob, opts.attachment.fileName);
    const res = await withSendRetry(
      async () => {
        const r = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Zoho-oauthtoken ${token}` },
          body: form,
        });
        const body = await r.text().catch(() => "");
        return { status: r.status, body, headers: r.headers };
      },
      this.retryOptions,
    );
    const data = JSON.parse(res.body || "{}") as { id?: string };
    return { messageId: data.id };
  }
}
