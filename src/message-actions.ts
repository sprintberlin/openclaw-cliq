/**
 * Channel message-action adapter for the shared `message` tool.
 *
 * Lets an agent edit / delete / read its own messages (and explicitly send) on
 * Zoho Cliq through the SDK's unified `message(action=...)` tool surface. The
 * adapter declares which actions Cliq supports, gatekeeps them by what the
 * account is configured to do (channel posts / edits / deletes / reads need a
 * user-context refresh token — see issue #27; DM-only `client_credentials`
 * setups can still `send`), and dispatches `handleAction` calls to the
 * `CliqClient`.
 *
 * chatId resolution: the Cliq chat-message edit/delete/read APIs key off a
 * `chat_id` (`CT_xxx`), NOT off a channel unique name or user id. The agent
 * typically has the `to` route target (a `cliq:channel:<uniqueName>` /
 * `cliq:user:<id>` prefixed string) and a `messageId`. For channels we resolve
 * the chat id once via `CliqClient.resolveChannelChatId` (cached per client);
 * for DMs the agent must supply an explicit `chatId` param (DM chat ids are
 * per-user-pair and cannot be resolved from a bare user id without a prior
 * send). An explicit `chatId` param always wins.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
  ChannelMessageActionDiscoveryContext,
  ChannelMessageActionName,
  ChannelMessageToolDiscovery,
} from "openclaw/plugin-sdk/channel-contract";
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";

import {
  normalizeCliqRouteTarget,
  resolveCliqConfig,
  type ResolvedCliqAccount,
} from "./client.js";
import { markdownToCliq } from "./markdown.js";
import { resolveCliqClient } from "./runtime-api.js";

/** Actions Cliq can perform via the shared `message` tool, in priority order. */
const CLIQ_ACTIONS_ALL: readonly ChannelMessageActionName[] = [
  "send",
  "edit",
  "delete",
  "read",
];

/** Actions that need a user-context refresh token (issue #27). */
const CLIQ_ACTIONS_NEEDING_REFRESH_TOKEN: ReadonlySet<ChannelMessageActionName> =
  new Set<ChannelMessageActionName>(["edit", "delete", "read"]);

function resolveAccountSafe(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedCliqAccount | null {
  try {
    return resolveCliqConfig(cfg, accountId ?? null);
  } catch {
    return null;
  }
}

/**
 * Decide which actions an account exposes. `send` is always available on a
 * configured account (DM sends work via `client_credentials`); the others need
 * a refresh token because they route through the chat-messages API
 * (`ZohoCliq.Messages.UPDATE` / `ZohoCliq.Channels.READ`), which
 * `client_credentials` cannot obtain a usable token for (issue #27).
 */
function resolveCliqActions(account: ResolvedCliqAccount): ChannelMessageActionName[] {
  const out: ChannelMessageActionName[] = ["send"];
  if (account.refreshToken) {
    for (const a of CLIQ_ACTIONS_ALL) {
      if (a === "send") continue;
      out.push(a);
    }
  }
  return out;
}

/**
 * Build a discovery result for the shared `message` tool. Returns `null` when
 * the channel is unconfigured (no account resolves) so the core hides the
 * `message` tool entirely for Cliq — matches the Discord pattern.
 */
function describeCliqMessageTool(
  params: ChannelMessageActionDiscoveryContext,
): ChannelMessageToolDiscovery | null {
  const account = resolveAccountSafe(params.cfg, params.accountId);
  if (!account) return null;
  return {
    actions: resolveCliqActions(account),
    capabilities: [],
    schema: null,
  };
}

function readString(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = params[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function readNumber(
  params: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = params[key];
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
  if (typeof v === "string" && v.trim()) {
    const n = Number(v.trim());
    if (Number.isFinite(n)) return Math.floor(n);
  }
  return undefined;
}

/** Build a successful tool result with a JSON-shaped detail payload. */
function okResult(
  text: string,
  details: Record<string, unknown>,
): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

/** Build a failure tool result (the agent sees the message and can retry). */
function errorResult(message: string): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: `cliq: ${message}` }],
    details: { status: "failed", error: message },
  };
}

/**
 * Resolve the chat id for an edit/delete/read action. Resolution order:
 *   1. Explicit `chatId` param (agent-supplied) — always wins.
 *   2. `to` route target prefixed `cliq:channel:` / `cliq:chat:` → resolve
 *      the channel unique name → chat id via `CliqClient.resolveChannelChatId`
 *      (cached per client).
 *   3. `to` prefixed `cliq:user:` / `cliq:dm:` → no resolution path (DM chat
 *      ids are per-user-pair); returns `undefined` and the caller surfaces a
 *      "chatId required" error to the agent.
 *   4. Bare `to` with no prefix → treated as a channel unique name (matches
 *      the outbound `normalizeCliqRouteTarget` default).
 *
 * Never throws — a resolution failure becomes an agent-visible error so the
 * model can supply the missing `chatId` and retry.
 */
async function resolveChatIdForAction(
  client: Pick<CliqClientLike, "resolveChannelChatId">,
  params: Record<string, unknown>,
): Promise<string | undefined> {
  const explicit = readString(params, "chatId");
  if (explicit) return explicit;
  const to = readString(params, "to") ?? readString(params, "channelId");
  if (!to) return undefined;
  const target = normalizeCliqRouteTarget(to);
  if (target.isDm) return undefined; // DM chat ids cannot be resolved from a user id
  return (await client.resolveChannelChatId(target.to)) ?? undefined;
}

/** Minimal slice of CliqClient the actions adapter depends on. */
interface CliqClientLike {
  sendMessage(opts: {
    to: string;
    text: string;
    isDm?: boolean;
  }): Promise<{ messageId?: string; chatId?: string }>;
  editMessage(opts: {
    chatId: string;
    messageId: string;
    text: string;
  }): Promise<{ messageId?: string; chatId?: string }>;
  deleteMessage(opts: {
    chatId: string;
    messageId: string;
  }): Promise<boolean>;
  listChatMessages(
    chatId: string,
    opts?: { limit?: number },
  ): Promise<
    { messageId: string; chatId: string; text?: string }[]
  >;
  resolveChannelChatId(channelUniqueName: string): Promise<string | undefined>;
}

async function handleSend(
  client: CliqClientLike,
  params: Record<string, unknown>,
): Promise<AgentToolResult<unknown>> {
  const to = readString(params, "to") ?? readString(params, "channelId");
  const message = readString(params, "message");
  if (!to) return errorResult("`to` (channel target) is required for send.");
  if (!message) return errorResult("`message` (text) is required for send.");
  const target = normalizeCliqRouteTarget(to);
  const rich = markdownToCliq(message);
  try {
    const result = await client.sendMessage({
      to: target.to,
      isDm: target.isDm,
      text: rich,
    });
    return okResult(
      `Sent message to ${to}${result.messageId ? ` (messageId=${result.messageId})` : ""}.`,
      {
        action: "send",
        to,
        messageId: result.messageId ?? null,
        chatId: result.chatId ?? null,
      },
    );
  } catch (err) {
    return errorResult(`send failed: ${String(err)}`);
  }
}

async function handleEdit(
  client: CliqClientLike,
  params: Record<string, unknown>,
): Promise<AgentToolResult<unknown>> {
  const messageId = readString(params, "messageId");
  const message = readString(params, "message");
  if (!messageId) return errorResult("`messageId` is required for edit.");
  if (!message) return errorResult("`message` (new text) is required for edit.");
  const chatId = await resolveChatIdForAction(client, params);
  if (!chatId) {
    return errorResult(
      "`chatId` could not be resolved — pass `chatId` explicitly (DM chat ids are per-user-pair and cannot be resolved from a user id).",
    );
  }
  const rich = markdownToCliq(message);
  try {
    const result = await client.editMessage({ chatId, messageId, text: rich });
    return okResult(
      `Edited message ${messageId} in chat ${chatId}.`,
      {
        action: "edit",
        chatId,
        messageId,
        chatIdResolved: result.chatId ?? chatId,
        messageIdResolved: result.messageId ?? messageId,
      },
    );
  } catch (err) {
    return errorResult(`edit failed: ${String(err)}`);
  }
}

async function handleDelete(
  client: CliqClientLike,
  params: Record<string, unknown>,
): Promise<AgentToolResult<unknown>> {
  const messageId = readString(params, "messageId");
  if (!messageId) return errorResult("`messageId` is required for delete.");
  const chatId = await resolveChatIdForAction(client, params);
  if (!chatId) {
    return errorResult(
      "`chatId` could not be resolved — pass `chatId` explicitly (DM chat ids are per-user-pair and cannot be resolved from a user id).",
    );
  }
  try {
    const ok = await client.deleteMessage({ chatId, messageId });
    if (!ok) {
      return errorResult(
        `delete rejected for message ${messageId} in chat ${chatId}.`,
      );
    }
    return okResult(
      `Deleted message ${messageId} in chat ${chatId}.`,
      { action: "delete", chatId, messageId },
    );
  } catch (err) {
    return errorResult(`delete failed: ${String(err)}`);
  }
}

async function handleRead(
  client: CliqClientLike,
  params: Record<string, unknown>,
): Promise<AgentToolResult<unknown>> {
  const limit = readNumber(params, "limit");
  const chatId = await resolveChatIdForAction(client, params);
  if (!chatId) {
    return errorResult(
      "`chatId` could not be resolved — pass `chatId` explicitly (DM chat ids are per-user-pair and cannot be resolved from a user id).",
    );
  }
  try {
    const messages = await client.listChatMessages(chatId, {
      limit: limit ?? 50,
    });
    return okResult(
      `Read ${messages.length} message(s) from chat ${chatId}.`,
      {
        action: "read",
        chatId,
        count: messages.length,
        messages: messages.map((m) => ({
          messageId: m.messageId,
          chatId: m.chatId,
          ...(m.text ? { text: m.text } : {}),
        })),
      },
    );
  } catch (err) {
    return errorResult(`read failed: ${String(err)}`);
  }
}

/**
 * The Cliq message-action adapter. `handleAction` resolves the account from
 * `ctx.cfg` + `ctx.accountId`, builds the `CliqClient` via the registry (so
 * OAuth tokens are shared across turns), and dispatches to the per-action
 * handler. It never throws — any unexpected error becomes an agent-visible
 * failure result so the model can recover (retry / give up) rather than
 * crashing the tool call.
 */
export const cliqMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: describeCliqMessageTool,
  supportsAction: ({ action }) =>
    CLIQ_ACTIONS_ALL.includes(action as ChannelMessageActionName),
  resolveExecutionMode: () => "local",
  handleAction: async (ctx: ChannelMessageActionContext) => {
    const account = resolveAccountSafe(ctx.cfg, ctx.accountId);
    if (!account) {
      return errorResult(
        "cliq channel is not configured (missing clientId/clientSecret/botId).",
      );
    }
    const action = ctx.action as ChannelMessageActionName;
    if (
      CLIQ_ACTIONS_NEEDING_REFRESH_TOKEN.has(action) &&
      !account.refreshToken
    ) {
      return errorResult(
        `\`${action}\` requires a user-context refresh token (see README §3); the configured account uses client_credentials only.`,
      );
    }
    const client = resolveCliqClient(account) as unknown as CliqClientLike;
    const params = ctx.params ?? {};
    try {
      switch (action) {
        case "send":
          return await handleSend(client, params);
        case "edit":
          return await handleEdit(client, params);
        case "delete":
        case "unsend":
          return await handleDelete(client, params);
        case "read":
          return await handleRead(client, params);
        default:
          return errorResult(`unsupported action: ${action}`);
      }
    } catch (err) {
      return errorResult(`${action} failed: ${String(err)}`);
    }
  },
};

/** Exported for tests so the pure helpers can be exercised directly. */
export {
  describeCliqMessageTool,
  resolveCliqActions,
  resolveChatIdForAction,
  CLIQ_ACTIONS_ALL,
  type CliqClientLike,
};
