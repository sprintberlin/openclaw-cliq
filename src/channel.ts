import {
  createChatChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import type {
  OpenClawConfig,
} from "openclaw/plugin-sdk/channel-core";
import {
  chunkMessage,
  loadCliqMediaAttachment,
  normalizeCliqRouteTarget,
  resolveCliqConfig,
  type ResolvedCliqAccount,
} from "./client.js";
import { CliqSendError } from "./send-retry.js";
import {
  buildCliqMentionRegexes,
  stripCliqMentions,
} from "./mentions.js";
import { markdownToCliq } from "./markdown.js";
import { resolveCliqClient } from "./runtime-api.js";
import { cliqHeartbeatAdapter } from "./heartbeat.js";
import { cliqStatusAdapter, type CliqStatusProbe } from "./status.js";
import { cliqDirectoryAdapter } from "./directory.js";
import { cliqDoctorAdapter } from "./doctor.js";
import { cliqSetupWizard } from "./setup-wizard.js";
import { inspectCliqAccount } from "./account-inspect.js";
import { cliqMessageActions } from "./message-actions.js";
import { cliqGroupsAdapter } from "./group-policy.js";
import { cliqAgentPromptAdapter } from "./agent-prompt.js";
import { cliqOutboundPresentation } from "./outbound-presentation.js";
import { cliqCommandsAdapter } from "./commands.js";
import { cliqThreadingAdapter } from "./threading.js";
import { cliqSecretsAdapter } from "./secret-contract.js";
import { cliqMessagingAdapter } from "./messaging.js";
import { cliqLifecycleAdapter } from "./lifecycle.js";
import {
  CLIQ_PAIRING_APPROVED_MESSAGE,
  CLIQ_PAIRING_ID_LABEL,
  notifyCliqPairingApproval,
} from "./pairing.js";

export { resolveCliqConfig, CliqClient, chunkMessage, loadCliqMediaAttachment, normalizeCliqRouteTarget, readEffectiveCliqSection, CLIQ_DEFAULT_ACCOUNT_ID, type CliqChannelConfig, type ResolvedCliqAccount, type CliqMediaAttachment, type NormalizedCliqTarget, type CliqDirectoryEntry, type CliqUserRecord, type CliqChannelRecord, type CliqReactionGuidanceConfig, type EffectiveCliqSection } from "./client.js";
export { buildCliqMentionRegexes, stripCliqMentions } from "./mentions.js";
export { markdownToCliq } from "./markdown.js";
export { cliqHeartbeatAdapter, probeCliqHeartbeat, type CliqHeartbeatProbeResult } from "./heartbeat.js";
export { cliqStatusAdapter, probeCliqStatus, resolveCliqStatusAccount, type CliqStatusProbe } from "./status.js";
export { cliqDirectoryAdapter, applyCliqDirectoryQueryAndLimit } from "./directory.js";
export { cliqDoctorAdapter, collectCliqPreviewWarnings, collectCliqMutableAllowlistWarnings } from "./doctor.js";
export {
  cliqSetupWizard,
  isCliqChannelConfigured,
  promptCliqCredentials,
  applyCliqCredentials,
  CLIQ_ENV_VARS,
  type CliqSetupCredentials,
} from "./setup-wizard.js";
export {
  inspectCliqAccount,
  CLIQ_OAUTH_SCOPES,
  CLIQ_API_BASE,
  CLIQ_OAUTH_BASE,
  type CliqCredentialStatus,
  type InspectedCliqAccount,
  type InspectedCliqAccountConfig,
} from "./account-inspect.js";
export {
  cliqOutboundPresentation,
  renderCliqPresentation,
  sendCliqPayload,
  isCliqCardChannelData,
  type CliqRenderedCard,
  type CliqOutboundPresentation,
} from "./outbound-presentation.js";
export {
  CLIQ_PAIRING_APPROVED_MESSAGE,
  CLIQ_PAIRING_ID_LABEL,
  issueCliqPairingChallenge,
  buildCliqSenderIdLine,
  notifyCliqPairingApproval,
} from "./pairing.js";
export {
  cliqMessageActions,
  describeCliqMessageTool,
  resolveCliqActions,
  resolveChatIdForAction,
  handleFormSend,
  CLIQ_ACTIONS_ALL,
  type CliqClientLike,
} from "./message-actions.js";
export {
  cliqGroupsAdapter,
  resolveCliqGroupRequireMention,
  resolveCliqGroupToolPolicy,
  resolveCliqGroupId,
} from "./group-policy.js";
export {
  cliqAgentPromptAdapter,
  resolveCliqMessageToolHints,
  resolveCliqInboundFormattingHints,
  resolveCliqReactionGuidance,
} from "./agent-prompt.js";
export {
  cliqCommandsAdapter,
  cliqCommandButton,
  buildCliqCommandsListChannelData,
  buildCliqModelsMenuChannelData,
  buildCliqModelsProviderChannelData,
  buildCliqModelsAddProviderChannelData,
  buildCliqModelsListChannelData,
  buildCliqModelBrowseChannelData,
  CLIQ_COMMANDS_MODELS_PAGE_SIZE,
} from "./commands.js";
export {
  cliqThreadingAdapter,
  resolveCliqReplyToMode,
  buildCliqThreadingToolContext,
  resolveCliqReplyTransport,
  resolveCliqCurrentChannelId,
} from "./threading.js";
export {
  cliqMessagingAdapter,
  parseCliqTarget,
  normalizeCliqMessagingTarget,
  resolveCliqInboundConversation,
  resolveCliqDeliveryTarget,
  resolveCliqSessionConversation,
  resolveCliqSessionTarget,
  inferCliqTargetChatType,
  resolveCliqOutboundSessionRoute,
  formatCliqTargetDisplay,
  looksLikeCliqTargetId,
  type ParsedCliqTarget,
} from "./messaging.js";
export {
  cliqSecretsAdapter,
  cliqSecretTargetRegistryEntries,
  collectCliqRuntimeConfigAssignments,
} from "./secret-contract.js";
export {
  resolveCliqSecretString,
} from "./secret-resolve.js";
export {
  collectCliqSecurityAuditFindings,
  cliqSecurityAuditCollector,
  type CliqSecurityAuditFinding,
} from "./security-audit.js";
export {
  cliqLegacyConfigRules,
  normalizeCliqCompatibilityConfig,
  repairCliqConfig,
  detectCliqLegacyStateMigrations,
} from "./legacy-state-migrations.js";
export {
  cliqLifecycleAdapter,
  runCliqStartupMaintenance,
  onCliqAccountConfigChanged,
  onCliqAccountRemoved,
} from "./lifecycle.js";
export {
  presentationToCliqCard,
  cliqButtonFromPortable,
  cliqButtonFromOption,
  simpleButtonsToCliqButtons,
  CLIQ_PRESENTATION_CAPABILITIES,
  CLIQ_MAX_BUTTONS_PER_MESSAGE,
  CLIQ_MAX_BUTTON_LABEL_LENGTH,
  type CliqButton,
  type CliqPresentationCapabilities,
  type PortableButton,
  type PortableOption,
  type PortablePresentation,
  type PortableBlock,
} from "./presentation.js";
export {
  renderCliqFormCards,
  readFormParam,
  CLIQ_FORM_MAX_BUTTONS_PER_CARD,
  type CliqFormInput,
  type CliqFormFieldInput,
  type CliqFormCardSpec,
} from "./forms-render.js";

const CHANNEL_ID = "cliq" as const;

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

function inspectAccount(cfg: OpenClawConfig, accountId?: string | null) {
  return inspectCliqAccount({ cfg, accountId });
}

function applyAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  input: Record<string, unknown>;
}): OpenClawConfig {
  const { cfg, accountId, input } = params;
  const next = structuredClone(cfg) as unknown as {
    channels?: Record<string, Record<string, unknown>>;
  };
  if (!next.channels) next.channels = {};
  if (!next.channels["cliq"]) next.channels["cliq"] = {};
  const section = next.channels["cliq"];
  // Non-default accountIds write into `accounts.<accountId>` so multiple Cliq
  // bots/accounts coexist (each with its own clientId/clientSecret/botId).
  // The default / unnamed account writes to the top-level section (the
  // single-account convention; backward compatible with existing configs).
  const isPerAccount = accountId && accountId !== "default";
  const target: Record<string, unknown> = isPerAccount
    ? (() => {
        const sec = section as Record<string, unknown>;
        if (!sec.accounts) sec.accounts = {};
        const accts = sec.accounts as Record<string, Record<string, unknown>>;
        if (!accts[accountId]) accts[accountId] = {};
        return accts[accountId];
      })()
    : section;
  const writeField = (key: string) => {
    if (input[key] !== undefined) target[key] = input[key];
  };
  writeField("clientId");
  writeField("clientSecret");
  writeField("botId");
  writeField("botName");
  writeField("webhookSecret");
  writeField("refreshToken");
  if (Array.isArray(input.allowFrom)) target["allowFrom"] = input.allowFrom;
  if (Array.isArray(input.selfSenderIds)) target["selfSenderIds"] = input.selfSenderIds;
  if (input.streaming !== undefined) target["streaming"] = input.streaming;
  if (input.thinking !== undefined) target["thinking"] = input.thinking;
  if (input.welcome !== undefined) target["welcome"] = input.welcome;
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

export const cliqPlugin = createChatChannelPlugin<ResolvedCliqAccount, CliqStatusProbe>({
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
      media: true,
      reply: true,
      edit: true,
      reactions: true,
      blockStreaming: true,
    },
    streaming: {
      // Coalesce defaults consumed by the SDK's block-streaming resolver
      // (getChannelPlugin(id)?.streaming?.blockStreamingCoalesceDefaults).
      // Tuned for Cliq's 5000-char message limit: min 800 chars before a
      // block flushes (avoids tiny fragments), 1s idle coalesce window
      // (balances perceived responsiveness against API chatter). Operators
      // opt an account in via `channels.cliq.streaming.preview: "on"`.
      blockStreamingCoalesceDefaults: { minChars: 800, idleMs: 1_000 },
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
    heartbeat: cliqHeartbeatAdapter,
    status: cliqStatusAdapter,
    directory: cliqDirectoryAdapter,
    doctor: cliqDoctorAdapter,
    setupWizard: cliqSetupWizard,
    actions: cliqMessageActions,
    groups: cliqGroupsAdapter,
    agentPrompt: cliqAgentPromptAdapter,
    commands: cliqCommandsAdapter,
    secrets: cliqSecretsAdapter,
    messaging: cliqMessagingAdapter,
    lifecycle: cliqLifecycleAdapter,
  },

  security: {
    dm: {
      channelKey: "cliq",
      resolvePolicy: (account) => account.dmPolicy,
      resolveAllowFrom: (account) => account.allowFrom,
      defaultPolicy: "allowlist",
    },
  },

  threading: cliqThreadingAdapter,

  pairing: {
    text: {
      idLabel: CLIQ_PAIRING_ID_LABEL,
      message: CLIQ_PAIRING_APPROVED_MESSAGE,
      notify: ({ cfg, id, message }) =>
        notifyCliqPairingApproval({ cfg, id, message }),
    },
  },

  outbound: {
    base: {
      deliveryMode: "direct",
      textChunkLimit: 5000,
      chunker: (text, limit) => chunkMessage(text, limit),
      ...cliqOutboundPresentation,
    },
    attachedResults: {
      channel: CHANNEL_ID,
      sendText: async (ctx) => {
        const account = resolveAccountFromCtx(ctx.cfg, ctx.accountId);
        const client = resolveCliqClient(account);
        const target = normalizeCliqRouteTarget(ctx.to);
        const richText = markdownToCliq(ctx.text);
        try {
          const result = await client.sendMessage({
            to: target.to,
            isDm: target.isDm,
            text: richText,
          });
          return {
            messageId: result.messageId ?? "unknown",
            to: ctx.to,
          };
        } catch (err) {
          // Fall back rich→plain on a formatting-rejected 400: retry once
          // with the raw agent text (no markdown→cliq conversion). Only this
          // error kind is recoverable; transient ones are already retried
          // inside the client, and fatal ones must surface to the caller.
          if (err instanceof CliqSendError && err.kind === "format_rejected" && ctx.text !== richText) {
            const result = await client.sendMessage({
              to: target.to,
              isDm: target.isDm,
              text: ctx.text,
            });
            return {
              messageId: result.messageId ?? "unknown",
              to: ctx.to,
            };
          }
          throw err;
        }
      },
      sendMedia: async (ctx) => {
        const account = resolveAccountFromCtx(ctx.cfg, ctx.accountId);
        const client = resolveCliqClient(account);
        if (!ctx.mediaUrl) {
          throw new Error("cliq: sendMedia requires ctx.mediaUrl");
        }
        const attachment = await loadCliqMediaAttachment({
          mediaUrl: ctx.mediaUrl,
          mediaReadFile: ctx.mediaReadFile,
          mediaAccess: ctx.mediaAccess,
        });
        const target = normalizeCliqRouteTarget(ctx.to);
        const result = await client.sendMediaMessage({
          to: target.to,
          isDm: target.isDm,
          text: ctx.text ? markdownToCliq(ctx.text) : undefined,
          attachment,
        });
        return {
          messageId: result.messageId ?? "unknown",
          to: ctx.to,
        };
      },
    },
  },
});
