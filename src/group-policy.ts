/**
 * Group tool-policy + mention-requirement adapter for the Cliq channel.
 *
 * Mirrors the bundled Telegram/Discord `groups` adapter: per-group
 * `requireMention` toggles and per-group / per-sender tool allow+deny policy,
 * read from `channels.cliq.groups` and `channels.cliq.groupPolicy` in
 * `openclaw.json`. The heavy lifting (config lookup, `toolsBySender`
 * matching, wildcard `*` defaults) is delegated to the SDK's shared
 * `resolveChannelGroupRequireMention` / `resolveChannelGroupToolsPolicy`
 * helpers so Cliq matches every other channel's semantics exactly.
 *
 * Group identity: a Cliq "group" is a channel (the bot is posted into via
 * `channelsbyname/<unique_name>`). The stable group id is therefore the
 * channel **unique name**. The inbound path sets `From: cliq:group:<uniqueName>`
 * for group messages so the runtime's `extractExplicitGroupId` resolves it,
 * and also fills `GroupChannel`/`GroupSubject` with the channel display name
 * as a fallback for Deluge payloads that omit the unique name.
 */
import type {
  ChannelGroupAdapter,
  ChannelGroupContext,
} from "openclaw/plugin-sdk/channel-runtime";
import {
  resolveChannelGroupRequireMention,
  resolveChannelGroupToolsPolicy,
  type GroupToolPolicyConfig,
} from "openclaw/plugin-sdk/channel-policy";

const CHANNEL_ID = "cliq" as const;

/**
 * Resolve the group id used to look up `channels.cliq.groups` entries. Cliq
 * groups are keyed by channel unique name. Prefer the explicit `groupId`
 * (extracted from `ctx.From` by the runtime), then `groupChannel`/`groupSpace`
 * (display-name fallbacks for payloads that only carry a name).
 */
export function resolveCliqGroupId(
  params: ChannelGroupContext,
): string | null {
  const fromGroupId = params.groupId?.trim();
  if (fromGroupId) return fromGroupId;
  const fromChannel = params.groupChannel?.trim();
  if (fromChannel) return fromChannel;
  const fromSpace = params.groupSpace?.trim();
  if (fromSpace) return fromSpace;
  return null;
}

/**
 * Resolve whether a group turn requires an explicit @mention of the bot.
 * Delegates to the SDK's shared `resolveChannelGroupRequireMention` so the
 * precedence (per-group `requireMention` → `*` default → `true`) matches
 * every other channel. Returns `undefined` when no group id can be resolved,
 * letting the runtime apply its own default.
 */
export function resolveCliqGroupRequireMention(
  params: ChannelGroupContext,
): boolean | undefined {
  const groupId = resolveCliqGroupId(params);
  if (!groupId) return undefined;
  return resolveChannelGroupRequireMention({
    cfg: params.cfg,
    channel: CHANNEL_ID,
    groupId,
    accountId: params.accountId,
    // Cliq channel unique names are case-insensitive handles — match
    // group-config keys case-insensitively so operators don't have to mirror
    // Cliq's casing exactly.
    groupIdCaseInsensitive: true,
  });
}

/**
 * Resolve the per-group / per-sender tool policy (allow / alsoAllow / deny).
 * Delegates to the SDK's shared `resolveChannelGroupToolsPolicy` so
 * `toolsBySender` keyed by `channel:cliq:<senderId>`, `id:<senderId>`,
 * `name:<display>`, etc. match every other channel's resolution. Returns
 * `undefined` when no group id can be resolved (no policy applies).
 */
export function resolveCliqGroupToolPolicy(
  params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
  const groupId = resolveCliqGroupId(params);
  if (!groupId) return undefined;
  const candidates: string[] = [];
  if (params.groupChannel && params.groupChannel !== groupId) {
    candidates.push(params.groupChannel);
  }
  if (params.groupSpace && params.groupSpace !== groupId) {
    candidates.push(params.groupSpace);
  }
  return resolveChannelGroupToolsPolicy({
    cfg: params.cfg,
    channel: CHANNEL_ID,
    groupId,
    groupIdCandidates: candidates,
    accountId: params.accountId,
    groupIdCaseInsensitive: true,
    messageProvider: CHANNEL_ID,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
  });
}

export const cliqGroupsAdapter: ChannelGroupAdapter = {
  resolveRequireMention: resolveCliqGroupRequireMention,
  resolveToolPolicy: resolveCliqGroupToolPolicy,
};
