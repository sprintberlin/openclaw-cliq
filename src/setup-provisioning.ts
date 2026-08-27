import {
  applyCliqHandlerProvisioning,
  planCliqHandlerProvisioning,
  type CliqProvisioningApplyReport,
  type CliqProvisioningPlan,
} from "./bot-provisioning.js";
import type { CliqBotIdLister } from "./bot-id.js";
import { isCliqBotReadFailure, type CliqBotRecord } from "./client.js";
import {
  getCapabilityById,
  type CliqScopeSetEvaluation,
} from "./capabilities.js";

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

/**
 * Three-valued bot lookup.
 *
 * A failed listing is `"unknown"`, never `"absent"`. Collapsing the two is
 * what let a token without `ZohoCliq.Bots.READ` (but with `Bots.CREATE`)
 * conclude "no such bot" and create a duplicate on every setup run — the
 * exact opposite of idempotent.
 */
async function lookupBot(
  service: CliqBotProvisioningService,
  uniqueName: string,
): Promise<{ state: "exists" | "absent" } | { state: "unknown"; reason: string }> {
  let listed: Awaited<ReturnType<CliqBotIdLister>>;
  try {
    listed = await service.listBots();
  } catch {
    return { state: "unknown", reason: "the bot listing threw an unexpected error" };
  }
  if (isCliqBotReadFailure(listed)) {
    const readHint = getCapabilityById("bot_read")?.missingHint;
    return {
      state: "unknown",
      reason:
        listed.kind === "missing_scope"
          ? `the bot listing was refused, so the bot's existence is unknown. ${readHint ?? ""}`.trim()
          : `the bot listing did not complete (${listed.detail}), so the bot's existence is unknown`,
    };
  }
  if (!Array.isArray(listed)) {
    return { state: "unknown", reason: "the bot listing returned an unrecognised response" };
  }
  return listed.some(
    (record) => record.unique_name?.trim().toLowerCase() === uniqueName.trim().toLowerCase(),
  )
    ? { state: "exists" }
    : { state: "absent" };
}

export async function provisionCliqBotAndHandlers(params: {
  account: { botId: string; botName?: string; webhookSecret?: string };
  publicWebhookUrl?: string;
  dryRun: boolean;
  confirmed: boolean;
  /** Include the optional Welcome handler (only when the greeting is opted in). */
  includeWelcome?: boolean;
  /**
   * Granted-scope evaluation for the account, when available.
   *
   * The gate is deliberately one-directional: a *missing* scope blocks the
   * mutation, but a *present* scope never authorises it on its own — Zoho
   * issues tokens that echo scopes the API later rejects (learning 070), so
   * the real API result still decides.
   */
  capabilities?: CliqScopeSetEvaluation;
  service: CliqBotProvisioningService;
}): Promise<CliqProvisioningRunResult> {
  const uniqueName = params.account.botId.trim();
  const mayMutate = !params.dryRun && params.confirmed;
  let createdBot = false;
  let createdBotId: string | undefined;

  const blockedPlan = (evidence: string[]): CliqProvisioningRunResult => ({
    createdBot: false,
    plan: {
      status: "blocked",
      configuredUniqueName: uniqueName,
      items: [],
      evidence,
    },
    apply: params.dryRun ? undefined : { ok: false, applied: false, results: [] },
  });

  // Handler provisioning writes Zoho-held code, so a known-missing
  // Bots.UPDATE consent must block before anything is planned rather than
  // surfacing later as a raw oauthtoken_scope_invalid.
  if (mayMutate && params.capabilities) {
    const botUpdate = getCapabilityById("bot_update")!;
    if (!params.capabilities.granted.includes(botUpdate.scope)) {
      return blockedPlan([botUpdate.missingHint]);
    }
  }

  const lookup = await lookupBot(params.service, uniqueName);
  if (lookup.state === "unknown") {
    return blockedPlan([lookup.reason]);
  }

  if (lookup.state === "absent") {
    if (mayMutate && params.capabilities && !params.capabilities.canCreateBots) {
      // #110: Bots.READ + Bots.UPDATE is silently insufficient to create a
      // bot; name the actual missing scope instead of relaying a generic
      // 401 from Zoho.
      return blockedPlan([getCapabilityById("bot_create")!.missingHint]);
    }
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
        // A read failure after the create is still a read failure: pass it
        // through so the planner blocks, instead of fabricating a record and
        // planning handlers against unverified state.
        if (!Array.isArray(listed)) return listed;
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
