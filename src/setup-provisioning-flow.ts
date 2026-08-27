import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { WizardPrompter } from "openclaw/plugin-sdk/setup";
import { resolveCliqConfig, type CliqClient, type ResolvedCliqAccount } from "./client.js";
import { resolveCliqClient } from "./runtime-api.js";
import {
  provisionCliqBotAndHandlers,
  type CliqProvisioningRunResult,
} from "./setup-provisioning.js";

export interface CliqSetupProvisioningDeps {
  resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => ResolvedCliqAccount;
  resolveClient: (account: ResolvedCliqAccount) => CliqClient;
  provision: typeof provisionCliqBotAndHandlers;
}

const defaultDeps: CliqSetupProvisioningDeps = {
  resolveAccount: resolveCliqConfig,
  resolveClient: resolveCliqClient,
  provision: provisionCliqBotAndHandlers,
};

function serviceFromClient(client: CliqClient) {
  return {
    listBots: (maxItems?: number) => client.listBots(maxItems),
    createBot: (name: string) => client.createBot(name),
    readHandlerScript: (type: string, botId?: string) =>
      client.readBotHandlerScript(type, botId),
    createHandler: (type: string, botId: string, script: string) =>
      client.createBotHandler(botId, type, script),
    updateHandler: (type: string, botId: string, script: string) =>
      client.updateBotHandler(botId, type, script),
  };
}

function safeEvidence(line: string, values: readonly string[]): string {
  let safe = line;
  for (const value of values) {
    if (!value) continue;
    safe = safe.split(value).join("<redacted>");
  }
  return safe.replace(
    /(webhook[_-]?secret|webhookSecret|access[_-]?token)(\s*(?:[=:]|\bis\b)\s*)[^\s,]+/gi,
    "$1$2<redacted>",
  );
}

function describeRun(result: CliqProvisioningRunResult): string {
  const lines = [
    `plan status: ${result.plan.status}`,
    ...result.plan.evidence,
  ];
  if (result.apply) {
    lines.push(
      ...result.apply.results.map((item) => `${item.type}: ${item.detail}`),
    );
  }
  return lines.join("\n");
}

/**
 * Setup integration for the provisioning service. The dry-run always executes
 * first and is displayed before the mutation question. A conflicting
 * existing handler — including URL-match/secret-mismatch — therefore cannot
 * be repaired merely because the operator entered setup; it needs a separate
 * explicit confirmation whose default is false.
 */
export async function runCliqSetupProvisioning(params: {
  cfg: OpenClawConfig;
  publicWebhookUrl?: string;
  prompter: Pick<WizardPrompter, "confirm" | "note">;
  accountId?: string;
  /** Provision the optional Welcome handler too (greeting opted in). */
  includeWelcome?: boolean;
  deps?: Partial<CliqSetupProvisioningDeps>;
}): Promise<CliqProvisioningRunResult> {
  const deps = { ...defaultDeps, ...params.deps };
  const account = deps.resolveAccount(params.cfg, params.accountId ?? null);
  const client = deps.resolveClient(account);
  const service = serviceFromClient(client);
  const values = [account.webhookSecret, account.clientSecret, account.refreshToken]
    .filter((value): value is string => typeof value === "string" && value.length > 0);

  const dryRun = await deps.provision({
    account,
    publicWebhookUrl: params.publicWebhookUrl,
    dryRun: true,
    confirmed: false,
    includeWelcome: params.includeWelcome,
    service,
  });
  await params.prompter.note(
    describeRun(dryRun)
      .split("\n")
      .map((line) => safeEvidence(line, values))
      .join("\n"),
    "Zoho Cliq bot/handler provisioning dry-run",
  );

  if (dryRun.plan.status === "in_sync" || dryRun.plan.status === "blocked") {
    return dryRun;
  }
  let confirmed = false;
  try {
    confirmed = await params.prompter.confirm({
      message:
        dryRun.plan.status === "conflict"
          ? "Replace the divergent Zoho bot handler code shown in the redacted dry-run?"
          : "Create the missing Zoho Cliq bot/handler resources shown in the dry-run?",
      initialValue: false,
    });
  } catch {
    return dryRun;
  }
  if (!confirmed) return dryRun;

  const applied = await deps.provision({
    account,
    publicWebhookUrl: params.publicWebhookUrl,
    dryRun: false,
    confirmed: true,
    includeWelcome: params.includeWelcome,
    service,
  });
  await params.prompter.note(
    describeRun(applied)
      .split("\n")
      .map((line) => safeEvidence(line, values))
      .join("\n"),
    "Zoho Cliq bot/handler provisioning",
  );
  return applied;
}
