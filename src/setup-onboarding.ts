import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { WizardPrompter } from "openclaw/plugin-sdk/setup";
import {
  inspectCliqBot,
  describeCliqBotInspection,
  resolveCliqSubscriptionState,
  type CliqBotInspection,
  type CliqBotReader,
} from "./bot-inspect.js";
import { resolveCliqConfig, type CliqClient, type ResolvedCliqAccount } from "./client.js";
import { resolveCliqClient } from "./runtime-api.js";
import { promptCliqDirectoryTarget, type CliqResolvedAllowlistEntry } from "./setup-directory.js";
import { sendCliqFirstContactDm } from "./setup-first-contact.js";

export interface CliqSetupOnboardingDeps {
  promptTarget: typeof promptCliqDirectoryTarget;
  resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => ResolvedCliqAccount;
  resolveClient: (account: ResolvedCliqAccount) => CliqClient;
  inspectBot: typeof inspectCliqBot;
}

const defaultDeps: CliqSetupOnboardingDeps = {
  promptTarget: promptCliqDirectoryTarget,
  resolveAccount: resolveCliqConfig,
  resolveClient: resolveCliqClient,
  inspectBot: inspectCliqBot,
};

async function noteSafely(
  prompter: Pick<WizardPrompter, "note">,
  message: string,
  title: string,
): Promise<void> {
  try {
    await prompter.note(message, title);
  } catch {
    return;
  }
}

function readerFromClient(client: CliqClient): CliqBotReader {
  return {
    listBots: (maxItems) => client.listBots(maxItems),
    getBot: (botId) => client.getBot(botId),
    listSubscribers: (botId, maxItems) => client.listBotSubscribers(botId, maxItems),
    readHandlerScript: (handlerType, botId) => client.readBotHandlerScript(handlerType, botId),
  };
}

function subscriptionLine(
  inspection: CliqBotInspection,
  target: CliqResolvedAllowlistEntry,
): string {
  if (!target.resolved) {
    return "subscription state: unknown because the target user could not be resolved through the directory";
  }
  const state = resolveCliqSubscriptionState(inspection, target.id);
  return state.state === "known"
    ? `subscription state: ${state.value}`
    : `subscription state: ${state.reason}`;
}

export interface CliqSetupOnboardingResult {
  status: "completed" | "cancelled" | "blocked";
  firstContact: "sent" | "cancelled" | "failed" | "not_requested";
  nextAction?: string;
}

export async function runCliqSetupOnboarding(params: {
  cfg: OpenClawConfig;
  prompter: Pick<WizardPrompter, "text" | "confirm" | "note">;
  accountId?: string;
  publicWebhookUrl?: string;
  deps?: Partial<CliqSetupOnboardingDeps>;
}): Promise<CliqSetupOnboardingResult> {
  const deps = { ...defaultDeps, ...params.deps };
  let begin: boolean;
  try {
    begin = await params.prompter.confirm({
      message: "Inspect a user/channel target and optionally send one consented first-contact DM now?",
      initialValue: false,
    });
  } catch {
    return {
      status: "cancelled",
      firstContact: "not_requested",
      nextAction: "Rerun setup when you want to inspect targets or send a first-contact message.",
    };
  }
  if (!begin) {
    return {
      status: "cancelled",
      firstContact: "not_requested",
      nextAction: "Rerun setup when you want to inspect targets or send a first-contact message.",
    };
  }
  let account: ResolvedCliqAccount;
  try {
    account = deps.resolveAccount(params.cfg, params.accountId ?? null);
  } catch {
    await noteSafely(
      params.prompter,
      "Bot visibility, subscription state, and first-contact testing are unavailable until the account credentials resolve.",
      "Zoho Cliq onboarding",
    );
    return {
      status: "blocked",
      firstContact: "not_requested",
      nextAction: "Correct the Zoho OAuth credentials, then rerun setup from the credential step.",
    };
  }

  const userTarget = await deps.promptTarget({
    cfg: params.cfg,
    accountId: params.accountId,
    kind: "user",
    prompter: params.prompter,
  });

  if (userTarget) {
    const client = deps.resolveClient(account);
    let inspection: CliqBotInspection;
    try {
      inspection = await deps.inspectBot({
        account,
        publicWebhookUrl: params.publicWebhookUrl,
        reader: readerFromClient(client),
      });
      await noteSafely(
        params.prompter,
        [...describeCliqBotInspection(inspection), subscriptionLine(inspection, userTarget)].join("\n"),
        "Zoho Cliq bot and subscription",
      );
    } catch {
      await noteSafely(
        params.prompter,
        "bot state: unknown\nbot visibility: unknown\nsubscription state: unknown",
        "Zoho Cliq bot and subscription",
      );
    }
    const firstContact = await sendCliqFirstContactDm({
      client,
      target: userTarget,
      prompter: params.prompter,
      sensitiveValues: [
        account.clientId,
        account.clientSecret,
        account.webhookSecret ?? "",
        account.refreshToken ?? "",
      ],
    });
    await promptChannelTarget();
    if (firstContact.sent) return { status: "completed", firstContact: "sent" };
    if (firstContact.reason === "cancelled") {
      return {
        status: "completed",
        firstContact: "cancelled",
        nextAction: "Rerun setup when you want to inspect targets or send a first-contact message.",
      };
    }
    return {
      status: "blocked",
      firstContact: "failed",
      nextAction: "Inspect the redacted first-contact failure and rerun setup if you want to retry the optional message test.",
    };
  }

  await promptChannelTarget();
  return { status: "completed", firstContact: "not_requested" };

  async function promptChannelTarget(): Promise<void> {
    const channelTarget = await deps.promptTarget({
      cfg: params.cfg,
      accountId: params.accountId,
      kind: "group",
      prompter: params.prompter,
    });
    if (!channelTarget) return;
    await noteSafely(
      params.prompter,
      [
        `Channel target: ${channelTarget.label ?? channelTarget.id}${channelTarget.resolved ? "" : " (unresolved)"}.`,
        "Add the bot from the channel's Bots menu before testing. The default group policy requires an @mention;",
        "groupPolicy/group allowlists may deny the channel, while trusted-organization mode deliberately broadens admission.",
      ].join("\n"),
      "Zoho Cliq channel onboarding",
    );
  }
}
