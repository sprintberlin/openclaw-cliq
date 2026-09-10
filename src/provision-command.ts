import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { mutateConfigFile } from "openclaw/plugin-sdk/config-mutation";
import {
  applyCliqCredentials,
  applyCliqDataCenter,
  applyCliqPublicWebhookUrl,
  prepareCliqSecretsForPersistence,
} from "./setup-wizard.js";
import { findCliqDataCenterById, getDefaultCliqDataCenter } from "./region.js";
import { validateWebhookUrl } from "./webhook-preflight.js";
import { provisionCliqBotAndHandlers, type CliqProvisioningRunResult } from "./setup-provisioning.js";
import { resolveCliqConfig, type CliqClient } from "./client.js";
import { resolveCliqClient } from "./runtime-api.js";

export interface CliqProvisionCommandOptions {
  cfg: OpenClawConfig;
  accountId?: string;
  clientId?: string;
  botId?: string;
  botName?: string;
  /** Secret values are env/stdin only, never accepted as CLI flags. */
  clientSecret?: string;
  webhookSecret?: string;
  refreshToken?: string;
  dataCenter?: string;
  publicWebhookUrl?: string;
  provisionHandlers?: boolean;
  yes?: boolean;
  preflight?: (params: { url: string; secret?: string }) => Promise<{ ok: boolean; detail: string }>;
}

export interface CliqProvisionCommandDeps {
  provision: typeof provisionCliqBotAndHandlers;
  resolveClient: (account: ReturnType<typeof resolveCliqConfig>) => CliqClient;
  mutateConfigFile: (
    options: { mutate: (draft: OpenClawConfig) => void; writeOptions: { skipOutputLogs: boolean } },
  ) => Promise<unknown>;
  writeLine: (line: string) => void;
  writeError: (line: string) => void;
}

const defaultDeps: CliqProvisionCommandDeps = {
  provision: provisionCliqBotAndHandlers,
  resolveClient: resolveCliqClient,
  mutateConfigFile,
  writeLine: (line) => process.stdout.write(`${line}\n`),
  writeError: (line) => process.stderr.write(`${line}\n`),
};

const ENV = {
  clientId: "CLIQ_CLIENT_ID",
  clientSecret: "CLIQ_CLIENT_SECRET",
  webhookSecret: "CLIQ_WEBHOOK_SECRET",
  refreshToken: "CLIQ_REFRESH_TOKEN",
} as const;

function readSection(cfg: OpenClawConfig): Record<string, unknown> {
  const root = cfg as unknown as { channels?: { cliq?: Record<string, unknown> } };
  return root.channels?.cliq ?? {};
}

function value(input: string | undefined, env: string, existing: unknown): string | undefined {
  return input?.trim() || process.env[env]?.trim() || (typeof existing === "string" && existing.trim() ? existing.trim() : undefined);
}

function planLine(result: CliqProvisioningRunResult): string[] {
  return [
    `Handler plan: ${result.plan.status}.`,
    ...result.plan.evidence.map((item) => `- ${item}`),
    ...(result.apply?.results.map((item) => `- ${item.type}: ${item.detail}`) ?? []),
  ];
}

function serviceFromClient(client: CliqClient) {
  return {
    listBots: (maxItems?: number) => client.listBots(maxItems),
    createBot: (name: string) => client.createBot(name),
    readHandlerScript: (type: string, botId?: string) => client.readBotHandlerScript(type, botId),
    createHandler: (type: string, botId: string, script: string) => client.createBotHandler(botId, type, script),
    updateHandler: (type: string, botId: string, script: string) => client.updateBotHandler(botId, type, script),
  };
}

/**
 * Non-interactive counterpart of the setup wizard: it reuses its config
 * assembly helpers and the canonical provisioning service, while keeping all
 * mutations behind --yes. Without --yes it only inspects Zoho and prints a
 * redacted plan, then exits non-zero so automation cannot mistake it for apply.
 */
export async function runCliqProvisionCommand(
  options: CliqProvisionCommandOptions,
  deps: CliqProvisionCommandDeps = defaultDeps,
): Promise<number> {
  const section = readSection(options.cfg);
  const clientId = value(options.clientId, ENV.clientId, section.clientId);
  const clientSecret = value(options.clientSecret, ENV.clientSecret, section.clientSecret);
  const botId = options.botId?.trim() || (typeof section.botId === "string" ? section.botId.trim() : undefined);
  const webhookSecret = value(options.webhookSecret, ENV.webhookSecret, section.webhookSecret);
  const refreshToken = value(options.refreshToken, ENV.refreshToken, section.refreshToken);
  const publicWebhookUrl = options.publicWebhookUrl?.trim() || (typeof section.publicWebhookUrl === "string" ? section.publicWebhookUrl.trim() : undefined);
  const missing = [
    !clientId ? "clientId (--client-id or $CLIQ_CLIENT_ID)" : undefined,
    !clientSecret ? "clientSecret ($CLIQ_CLIENT_SECRET or stdin)" : undefined,
    !botId ? "botId (--bot-id)" : undefined,
    !webhookSecret ? "webhookSecret ($CLIQ_WEBHOOK_SECRET or stdin)" : undefined,
    options.provisionHandlers && !publicWebhookUrl ? "publicWebhookUrl (--public-webhook-url)" : undefined,
  ].filter((item): item is string => Boolean(item));
  if (missing.length) {
    deps.writeError(`Missing required inputs: ${missing.join(", ")}.`);
    return 2;
  }
  if (publicWebhookUrl) {
    const validation = validateWebhookUrl(publicWebhookUrl);
    if (!validation.ok) {
      deps.writeError(`Invalid publicWebhookUrl: ${validation.reason}.`);
      return 2;
    }
  }
  if (options.dataCenter && !findCliqDataCenterById(options.dataCenter)) {
    deps.writeError(`Unknown --data-center "${options.dataCenter}".`);
    return 2;
  }

  const dc = options.dataCenter ? findCliqDataCenterById(options.dataCenter)! : getDefaultCliqDataCenter();
  let generated = applyCliqDataCenter(options.cfg, dc.id);
  generated = applyCliqCredentials(generated, {
    clientId,
    clientSecret,
    botId,
    botName: options.botName?.trim() || (typeof section.botName === "string" ? section.botName : undefined),
    webhookSecret,
    refreshToken,
  });
  generated = applyCliqPublicWebhookUrl(generated, publicWebhookUrl);
  const account = resolveCliqConfig(generated, options.accountId ?? null);
  let provisioning: CliqProvisioningRunResult | undefined;
  if (options.provisionHandlers) {
    const client = deps.resolveClient(account);
    provisioning = await deps.provision({
      account,
      publicWebhookUrl,
      dryRun: !options.yes,
      confirmed: options.yes === true,
      service: serviceFromClient(client),
    });
  }

  const plan = [
    "Cliq non-interactive provisioning plan:",
    `- config: ${clientId ? "clientId set" : "clientId missing"}; clientSecret set; botId ${botId}; webhookSecret set`,
    `- data center: ${dc.id}`,
    `- public webhook: ${publicWebhookUrl ?? "not configured"}`,
    ...(provisioning ? planLine(provisioning) : ["- handlers: not requested"]),
  ];
  for (const line of plan) deps.writeLine(line);

  if (!options.yes) {
    deps.writeError("Dry run only: no config, bot, or handler was written. Re-run with --yes to apply this plan.");
    return 1;
  }
  // The runtime client above needs the resolved literals, but `openclaw.json`
  // must never hold a typed-in credential (issue #92). Persist the same
  // canonical env-backed SecretRefs the interactive wizard writes, so the
  // headless path is not a security regression against the guided one.
  const persisted = prepareCliqSecretsForPersistence({
    originalCfg: options.cfg,
    generatedCfg: generated,
  });
  try {
    await deps.mutateConfigFile({
      writeOptions: { skipOutputLogs: true },
      mutate: (draft) => {
        const next = persisted as unknown as Record<string, unknown>;
        for (const key of Object.keys(draft as unknown as Record<string, unknown>)) {
          delete (draft as unknown as Record<string, unknown>)[key];
        }
        Object.assign(draft as unknown as Record<string, unknown>, structuredClone(next));
      },
    });
  } catch {
    deps.writeError("Could not atomically write the Cliq config; no config changes were persisted.");
    return 1;
  }
  deps.writeLine("Cliq config written atomically.");
  const envNames: string[] = [];
  if (clientSecret) envNames.push(ENV.clientSecret);
  if (webhookSecret) envNames.push(ENV.webhookSecret);
  if (refreshToken) envNames.push(ENV.refreshToken);
  if (envNames.length) {
    deps.writeLine(
      `Secrets were stored as env-backed SecretRefs, not literals. Provide these to the gateway service: ${envNames.join(", ")}.`,
    );
  }
  if (options.preflight && publicWebhookUrl) {
    const result = await options.preflight({ url: publicWebhookUrl, secret: webhookSecret });
    deps.writeLine(`Webhook preflight: ${result.detail}`);
    if (!result.ok) return 1;
  }
  deps.writeLine("Restart the OpenClaw gateway so it loads the generated Cliq config.");
  return provisioning?.apply && !provisioning.apply.ok ? 1 : 0;
}
