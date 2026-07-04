import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

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
  dmSecurity?: string;
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
  return {
    accountId: accountId ?? null,
    clientId,
    clientSecret,
    botId,
    botName: section?.botName,
    webhookSecret: section?.webhookSecret,
    allowFrom: section?.allowFrom ?? [],
    dmPolicy: section?.dmSecurity,
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

export class CliqClient {
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly botId: string,
    private readonly apiBase = EU_API_BASE,
    private readonly oauthBase = EU_OAUTH_BASE,
  ) {}

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
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`cliq: sendMessage failed (${res.status}): ${body}`);
    }
    const data = (await res.json().catch(() => ({}))) as { id?: string };
    return { messageId: data.id };
  }
}
