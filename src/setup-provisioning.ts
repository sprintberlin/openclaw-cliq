import {
  applyCliqHandlerProvisioning,
  planCliqHandlerProvisioning,
  type CliqProvisioningApplyReport,
  type CliqProvisioningPlan,
} from "./bot-provisioning.js";
import type { CliqBotIdLister } from "./bot-id.js";
import type { CliqBotRecord } from "./client.js";

/**
 * Setup-facing orchestration for issue #94.
 *
 * Composes the read-only planner and the confirmation-gated apply step into
 * the flow `openclaw setup` needs, and adds the one piece neither half owns:
 * creating the bot itself when it does not exist yet.
 *
 * Ordering matters. Zoho derives a bot's `unique_name` from its display name
 * rather than accepting one, so a freshly created bot can come back with a
 * name that does not match `channels.cliq.botId`. Provisioning handlers onto
 * such a bot would configure something the runtime never addresses, so that
 * case blocks instead of proceeding.
 */

export interface CliqBotProvisioningService {
  listBots: CliqBotIdLister;
  createBot(
    name: string,
  ): Promise<{ ok: true; bot: CliqBotRecord } | { ok: false; code: string; status?: number }>;
  readHandlerScript(
    handlerType: string,
    botId?: string,
  ): Promise<{ script?: string; error?: string }>;
  createHandler(
    handlerType: string,
    botId: string,
    script: string,
  ): Promise<{ ok: boolean; code?: string; detail?: string }>;
  updateHandler(
    handlerType: string,
    botId: string,
    script: string,
  ): Promise<{ ok: boolean; code?: string; detail?: string }>;
}

export interface CliqProvisioningRunResult {
  plan: CliqProvisioningPlan;
  apply?: CliqProvisioningApplyReport;
  createdBot: boolean;
}

async function botExists(
  service: CliqBotProvisioningService,
  uniqueName: string,
): Promise<boolean> {
  const listed = await service.listBots();
  if (!Array.isArray(listed)) return false;
  return listed.some(
    (record) => record.unique_name?.trim().toLowerCase() === uniqueName.trim().toLowerCase(),
  );
}

export async function provisionCliqBotAndHandlers(params: {
  account: { botId: string; botName?: string; webhookSecret?: string };
  publicWebhookUrl?: string;
  dryRun: boolean;
  confirmed: boolean;
  /** Include the optional Welcome handler (only when the greeting is opted in). */
  includeWelcome?: boolean;
  service: CliqBotProvisioningService;
}): Promise<CliqProvisioningRunResult> {
  const uniqueName = params.account.botId.trim();
  const mayMutate = !params.dryRun && params.confirmed;
  let createdBot = false;
  let createdBotId: string | undefined;

  if (!(await botExists(params.service, uniqueName))) {
    if (!mayMutate) {
      // Report the intent without touching Zoho. The handler planner would
      // only be able to say "the bot could not be resolved", which hides the
      // actionable fact that the bot itself is what is missing.
      return {
        createdBot: false,
        plan: {
          status: params.dryRun ? "changes_required" : "blocked",
          configuredUniqueName: uniqueName,
          items: [],
          evidence: [
            `no bot with unique name "${uniqueName}" exists yet; it would be created before its handlers are provisioned`,
          ],
        },
        apply: params.dryRun
          ? undefined
          : { ok: false, applied: false, results: [] },
      };
    }
    const created = await params.service.createBot(
      params.account.botName?.trim() || uniqueName,
    );
    if (!created.ok) {
      return {
        createdBot: false,
        plan: {
          status: "blocked",
          configuredUniqueName: uniqueName,
          items: [],
          evidence: [`the bot could not be created (Zoho reported ${created.code})`],
        },
      };
    }
    const derived = created.bot.unique_name?.trim().toLowerCase() ?? "";
    if (derived !== uniqueName.toLowerCase()) {
      // Zoho derives unique_name from the display name; a mismatch means the
      // runtime would address a different bot than the one just created.
      return {
        createdBot: true,
        plan: {
          status: "blocked",
          botId: created.bot.id,
          configuredUniqueName: uniqueName,
          items: [],
          evidence: [
            `Zoho derived the unique name "${derived}" from the bot display name, which does not match the configured "${uniqueName}"; update channels.cliq.botId before provisioning handlers`,
          ],
        },
      };
    }
    createdBot = true;
    createdBotId = created.bot.id;
  }

  const listBots: CliqBotIdLister = createdBotId
    ? async (maxItems) => {
        const listed = await params.service.listBots(maxItems);
        if (!Array.isArray(listed)) {
          return [{ id: createdBotId, unique_name: uniqueName }];
        }
        if (listed.some((record) => record.id === createdBotId)) return listed;
        return [{ id: createdBotId, unique_name: uniqueName }, ...listed];
      }
    : params.service.listBots;

  const plan = await planCliqHandlerProvisioning({
    account: params.account,
    publicWebhookUrl: params.publicWebhookUrl,
    includeWelcome: params.includeWelcome,
    reader: {
      listBots,
      readHandlerScript: params.service.readHandlerScript,
    },
  });
  if (params.dryRun) return { plan, createdBot };

  const apply = await applyCliqHandlerProvisioning({
    plan,
    account: params.account,
    publicWebhookUrl: params.publicWebhookUrl,
    confirmed: params.confirmed,
    writer: {
      createHandler: params.service.createHandler,
      updateHandler: params.service.updateHandler,
      readHandlerScript: params.service.readHandlerScript,
    },
  });
  return { plan, apply, createdBot };
}
