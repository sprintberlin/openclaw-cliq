import {
  createChatChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import type {
  ChannelPlugin,
  OpenClawConfig,
} from "openclaw/plugin-sdk/channel-core";
import {
  CliqClient,
  chunkMessage,
  resolveCliqConfig,
  type CliqChannelConfig,
  type ResolvedCliqAccount,
} from "./client.js";
import {
  buildCliqMentionRegexes,
  stripCliqMentions,
} from "./mentions.js";

export { resolveCliqConfig, CliqClient, chunkMessage, type CliqChannelConfig, type ResolvedCliqAccount } from "./client.js";
export { buildCliqMentionRegexes, stripCliqMentions } from "./mentions.js";

const CHANNEL_ID = "cliq" as const;

function readSection(cfg: OpenClawConfig): CliqChannelConfig {
  const channels = (cfg as unknown as { channels?: Record<string, unknown> }).channels;
  return (channels?.["cliq"] as CliqChannelConfig | undefined) ?? {};
}

function listAccountIds(cfg: OpenClawConfig): string[] {
  const channels = (cfg as unknown as { channels?: Record<string, unknown> }).channels;
  const section = channels?.["cliq"];
  if (!section || typeof section !== "object") return [];
  const accounts = (section as { accounts?: Record<string, unknown> }).accounts;
  if (!accounts || typeof accounts !== "object") return [];
  return Object.keys(accounts);
}

function resolveAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedCliqAccount {
  return resolveCliqConfig(cfg, accountId);
}

function inspectAccount(cfg: OpenClawConfig, _accountId?: string | null) {
  const section = readSection(cfg);
  const hasCore = Boolean(section.clientId && section.clientSecret && section.botId);
  return {
    enabled: hasCore,
    configured: hasCore,
    tokenStatus: section.clientSecret ? ("available" as const) : ("missing" as const),
    accountId: _accountId ?? null,
  };
}

function applyAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  input: Record<string, unknown>;
}): OpenClawConfig {
  const { cfg, input } = params;
  const next = structuredClone(cfg) as unknown as {
    channels?: Record<string, Record<string, unknown>>;
  };
  if (!next.channels) next.channels = {};
  if (!next.channels["cliq"]) next.channels["cliq"] = {};
  const section = next.channels["cliq"];
  const target: Record<string, unknown> = section;
  const writeField = (key: string) => {
    if (input[key] !== undefined) target[key] = input[key];
  };
  writeField("clientId");
  writeField("clientSecret");
  writeField("botId");
  writeField("botName");
  writeField("webhookSecret");
  if (Array.isArray(input.allowFrom)) target["allowFrom"] = input.allowFrom;
  return next as unknown as OpenClawConfig;
}

function resolveAccountFromCtx(cfg: OpenClawConfig, accountId?: string | null): ResolvedCliqAccount {
  return resolveCliqConfig(cfg, accountId ?? null);
}

/**
 * Resolve a Cliq account from a mention-adapter call without throwing. The
 * `ChannelMentionAdapter` contract passes `cfg` as `OpenClawConfig | undefined`
 * and the channel may be unconfigured; in that case there is nothing to strip.
 */
function resolveAccountSafe(
  cfg: OpenClawConfig | undefined,
  accountId?: string | null,
): ResolvedCliqAccount | null {
  if (!cfg) return null;
  try {
    return resolveCliqConfig(cfg, accountId ?? null);
  } catch {
    return null;
  }
}

export const cliqPlugin: ChannelPlugin<ResolvedCliqAccount> = createChatChannelPlugin<ResolvedCliqAccount>({
  base: {
    id: CHANNEL_ID,
    meta: {
      id: CHANNEL_ID,
      label: "Zoho Cliq",
      selectionLabel: "Zoho Cliq",
      docsPath: "channels/cliq",
      blurb: "Connect OpenClaw to Zoho Cliq.",
    },
    capabilities: {
      chatTypes: ["direct", "group"],
      media: false,
      reply: true,
      edit: false,
      reactions: false,
    },
    config: {
      listAccountIds,
      resolveAccount,
      inspectAccount,
      isConfigured: (account) => Boolean(account.clientId && account.clientSecret && account.botId),
    },
    setup: {
      applyAccountConfig,
    },
    mentions: {
      stripRegexes: ({ cfg, ctx }) => {
        const account = resolveAccountSafe(cfg, ctx?.AccountId);
        if (!account) return [];
        return buildCliqMentionRegexes(account);
      },
      stripPatterns: ({ cfg, ctx }) => {
        const account = resolveAccountSafe(cfg, ctx?.AccountId);
        if (!account?.botName) return [];
        return [`@${account.botName}`];
      },
      stripMentions: ({ text, cfg, ctx }) => {
        const account = resolveAccountSafe(cfg, ctx?.AccountId);
        if (!account) return text ?? "";
        return stripCliqMentions(text ?? "", account);
      },
    },
  },

  security: {
    dm: {
      channelKey: "cliq",
      resolvePolicy: (account) => account.dmPolicy,
      resolveAllowFrom: (account) => account.allowFrom,
      defaultPolicy: "allowlist",
    },
  },

  threading: { topLevelReplyToMode: "reply" },

  outbound: {
    base: {
      deliveryMode: "direct",
      textChunkLimit: 5000,
      chunker: (text, limit) => chunkMessage(text, limit),
    },
    attachedResults: {
      channel: CHANNEL_ID,
      sendText: async (ctx) => {
        const account = resolveAccountFromCtx(ctx.cfg, ctx.accountId);
        const client = new CliqClient(
          account.clientId,
          account.clientSecret,
          account.botId,
        );
        const result = await client.sendMessage({
          to: ctx.to,
          text: ctx.text,
        });
        return {
          messageId: result.messageId ?? "unknown",
          to: ctx.to,
        };
      },
    },
  },
});
