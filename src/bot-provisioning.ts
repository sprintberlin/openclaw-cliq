import { resolveCliqInternalBotId, type CliqBotIdLister } from "./bot-id.js";
import {
  CLIQ_INBOUND_HANDLER_TYPES,
  extractDelugeStringAssignment,
  fingerprintCliqSecret,
  type CliqInboundHandlerType,
} from "./handler-consistency.js";

/**
 * Idempotent bot/handler provisioning (issue #94).
 *
 * The planning half is deliberately **read-only**: it resolves the configured
 * unique name through the shared resolver (`src/bot-id.ts`, issue #149), reads
 * each handler back, and classifies what a mutation *would* have to do. No
 * request in this module changes Zoho state.
 *
 * Two rules come from live rollouts and are encoded as types, not comments:
 *
 * - **A matching unique name is not proof of ownership.** "Bot exists,
 *   handlers exist, URL matches, secret does NOT" is its own conflict
 *   (`secret_mismatch`), never "already configured, nothing to do" — that
 *   exact state shipped a deployment whose real inbound would have been 401
 *   while the preflight was green.
 * - **Absence of evidence is never consent.** An unreadable or unrecognised
 *   handler is `blocked` / `unrecognised_script`, so a hand-written handler is
 *   never silently overwritten.
 *
 * Every string this module produces is fingerprint-only: handler bodies, the
 * configured secret, and OAuth material never reach the plan (#113).
 */

export type CliqProvisionedHandlerType = CliqInboundHandlerType | "welcome_handler";

export type CliqHandlerPlanAction = "none" | "create" | "repair" | "blocked";

export type CliqHandlerPlanConflict =
  | "secret_mismatch"
  | "url_mismatch"
  | "unrecognised_script"
  | "stale_script"
  | "unreadable"
  | "missing";

export type CliqProvisioningStatus =
  | "in_sync"
  | "changes_required"
  | "conflict"
  | "blocked";

export interface CliqHandlerPlanItem {
  type: CliqProvisionedHandlerType;
  action: CliqHandlerPlanAction;
  conflict?: CliqHandlerPlanConflict;
  /** Redacted, human-readable justification. Never contains a secret. */
  reason: string;
  /** True when applying this item would mutate Zoho-held state. */
  requiresConfirmation: boolean;
}

export interface CliqProvisioningPlan {
  status: CliqProvisioningStatus;
  botId?: string;
  configuredUniqueName: string;
  items: CliqHandlerPlanItem[];
  /** Redacted lines suitable for CLI output and JSON reports. */
  evidence: string[];
}

export interface CliqProvisioningReader {
  listBots: CliqBotIdLister;
  readHandlerScript(
    handlerType: string,
    botId?: string,
  ): Promise<{ script?: string; error?: string }>;
}

/**
 * Render the Deluge handler script for one inbound handler type.
 *
 * The Message and Mention scripts must NOT be byte-identical: the Mention
 * Handler does not receive the `attachments` parameter, and a Mention script
 * that references it fails Zoho's validation with
 * `execution_handler_update_failed` — a script-validity fault, not a
 * transient error. The payload is posted with `body:` (raw JSON) rather than
 * `parameters:`, which would form-encode it and break the webhook.
 */
/**
 * Build the Deluge body for one provisioned bot handler.
 *
 * ## Why the handler returns its `eventId` (issue #231)
 *
 * The script used to end with a bare `response = Map(); return response;`, so
 * **every** execution row in the Zoho Bot execution log read `output: "{}"`.
 * A successful post, a rejected webhook, a transport failure and a handler
 * that returned before `invokeUrl` were therefore indistinguishable in the
 * only log Zoho exposes. The 2026-09-05 forward incident had four executions,
 * two agent turns and two missing turns, and `{}` could not explain the
 * difference (issue #227).
 *
 * Echoing the generated `eventId` makes each Zoho execution row correlatable
 * with the gateway's own `evt:` identity, which turns "did this execution
 * become a turn?" into a lookup instead of a guess.
 *
 * Deliberately NOT captured here: the `invokeUrl` HTTP status. Assigning the
 * invoke result would introduce a new Deluge construct into both handlers,
 * and an invalid symbol fails validation with `execution_handler_update_failed`
 * — which is permanent and not safely retryable (see
 * {@link CLIQ_SCRIPT_VALIDITY_FAILURE}; the Mention Handler already proved
 * this with `attachments`). `eventId` is already declared and used in every
 * variant, so echoing it adds no new symbol and cannot fail validation.
 * Richer status reporting is left to the verified schema rollout (#228).
 *
 * The payload and the response never carry the message text, the webhook
 * secret or any token.
 */
export function buildCliqHandlerScript(params: {
  handlerType: CliqProvisionedHandlerType;
  webhookUrl: string;
  webhookSecret: string;
}): string {
  const discriminator = params.handlerType === "message_handler"
    ? "message"
    : params.handlerType === "mention_handler"
      ? "mention"
      : "welcome";
  if (params.handlerType === "welcome_handler") {
    return [
      `webhookUrl = "${params.webhookUrl}";`,
      `webhookSecret = "${params.webhookSecret}";`,
      "",
      "payload = Map();",
      'payload.put("handler", "welcome");',
      'payload.put("user", user);',
      'payload.put("newuser", newuser);',
      'eventId = zoho.currenttime.toString("yyyyMMddHHmmss") + "-" + randomNumber(100000,999999) + randomNumber(100000,999999);',
      'payload.put("eventId", eventId);',
      "",
      "headers = Map();",
      'headers.put("Content-Type", "application/json");',
      'headers.put("x-cliq-webhook-secret", webhookSecret);',
      "",
      "invokeUrl",
      "[",
      "    url    : webhookUrl",
      "    type   : POST",
      "    body   : payload.toString()",
      "    headers: headers",
      "];",
      "",
      "response = Map();",
      'response.put("eventId", eventId);',
      "return response;",
      "",
    ].join("\n");
  }
  const attachments =
    params.handlerType === "message_handler"
      ? 'if (attachments != null)\n{\n    payload.put("attachments", attachments);\n}\n'
      : "";
  return [
    `webhookUrl = "${params.webhookUrl}";`,
    `webhookSecret = "${params.webhookSecret}";`,
    "",
    "payload = Map();",
    `payload.put("handler", "${discriminator}");`,
    'payload.put("message", message);',
    'payload.put("user", user);',
    'payload.put("chat", chat);',
    'eventId = zoho.currenttime.toString("yyyyMMddHHmmss") + "-" + randomNumber(100000,999999) + randomNumber(100000,999999);',
    'payload.put("eventId", eventId);',
    attachments,
    "headers = Map();",
    'headers.put("Content-Type", "application/json");',
    'headers.put("x-cliq-webhook-secret", webhookSecret);',
    "",
    "invokeUrl",
    "[",
    "    url    : webhookUrl",
    "    type   : POST",
    "    body   : payload.toString()",
    "    headers: headers",
    "];",
    "",
    "response = Map();",
    'response.put("eventId", eventId);',
    "return response;",
    "",
  ].join("\n");
}

/**
 * Zoho's generic create failure. Live rollouts showed the Message Handler
 * accepting a full script while the Mention Handler answered `operation_failed`
 * for the same strategy; creating a minimal handler and then `PATCH`ing the
 * real script succeeded immediately. The fallback is deliberately keyed to
 * this one code so an unrelated failure (a scope problem, say) is reported
 * rather than retried through a different path.
 */
const CLIQ_GENERIC_CREATE_FAILURE = "operation_failed";

/**
 * `execution_handler_update_failed` is NOT reliably transient: the Mention
 * Handler does not expose `attachments`, so a script referencing it fails
 * validation on every attempt. Retrying alone never fixes it.
 */
const CLIQ_SCRIPT_VALIDITY_FAILURE = "execution_handler_update_failed";

export function isRetryableCliqProvisioningFailure(code: string | undefined): boolean {
  if (!code) return false;
  if (code === CLIQ_SCRIPT_VALIDITY_FAILURE) return false;
  return /timeout|rate_limit|temporarily|internal_error/i.test(code);
}

export type CliqHandlerApplyOutcome =
  | "created"
  | "created_via_patch_fallback"
  | "repaired"
  | "failed"
  | "skipped_unconfirmed"
  | "skipped_blocked"
  | "skipped_in_sync";

export interface CliqHandlerApplyResult {
  type: CliqProvisionedHandlerType;
  outcome: CliqHandlerApplyOutcome;
  /** Redacted explanation. Never contains a script body or secret. */
  detail: string;
  /** Whether the handler was read back and matched the intended values. */
  verified?: boolean;
  retryable?: boolean;
}

export interface CliqProvisioningApplyReport {
  ok: boolean;
  applied: boolean;
  results: CliqHandlerApplyResult[];
}

export interface CliqProvisioningWriter {
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
  readHandlerScript(
    handlerType: string,
    botId?: string,
  ): Promise<{ script?: string; error?: string }>;
}

/** A syntactically valid placeholder used only by the create-then-PATCH fallback. */
function minimalHandlerScript(): string {
  return ["response = Map();", "return response;", ""].join("\n");
}

function sameWebhookUrl(a: string, b: string): boolean {
  const normalize = (raw: string): string => {
    try {
      const url = new URL(raw);
      return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "")}`;
    } catch {
      return raw.trim().replace(/\/+$/, "");
    }
  };
  return normalize(a) === normalize(b);
}

function label(type: string): string {
  return type.replace(/_/g, " ");
}

function classifyHandler(params: {
  type: CliqProvisionedHandlerType;  read: { script?: string; error?: string };
  configSecret: string;
  expectedUrl: string;
}): CliqHandlerPlanItem {
  const name = label(params.type);
  const { read } = params;
  if (read.error || typeof read.script !== "string" || read.script.length === 0) {
    // A 404 is the one read failure that genuinely means "not provisioned";
    // every other failure leaves the handler state unknown, and unknown must
    // never authorise a write.
    const missing = /404|not[ _]found/i.test(read.error ?? "");
    return missing
      ? {
          type: params.type,
          action: "create",
          conflict: "missing",
          reason: `${name} does not exist on the bot and would be created`,
          requiresConfirmation: true,
        }
      : {
          type: params.type,
          action: "blocked",
          conflict: "unreadable",
          reason: `${name} could not be read (${read.error ?? "no script body was returned"}), so its state is unknown and no change is proposed`,
          requiresConfirmation: false,
        };
  }
  const handlerUrl = extractDelugeStringAssignment(read.script, "webhookUrl");
  const handlerSecret = extractDelugeStringAssignment(read.script, "webhookSecret");
  if (handlerUrl === null || handlerSecret === null) {
    return {
      type: params.type,
      action: "repair",
      conflict: "unrecognised_script",
      reason: `${name} does not declare recognisable webhookUrl/webhookSecret literals, so it looks hand-written and is never replaced without explicit confirmation`,
      requiresConfirmation: true,
    };
  }
  if (!sameWebhookUrl(handlerUrl, params.expectedUrl)) {
    return {
      type: params.type,
      action: "repair",
      conflict: "url_mismatch",
      reason: `${name} posts to a different webhook URL than the configured publicWebhookUrl`,
      requiresConfirmation: true,
    };
  }
  if (handlerSecret !== params.configSecret) {
    // The exact state observed on a real rollout: the bot and handlers looked
    // correct and the URL matched, but Zoho held a different secret, so every
    // real inbound message would have been rejected with 401.
    return {
      type: params.type,
      action: "repair",
      conflict: "secret_mismatch",
      reason: `${name} carries a webhook secret that differs from the configured one (handler ${fingerprintCliqSecret(handlerSecret)} vs config ${fingerprintCliqSecret(params.configSecret)}); a matching URL is not proof this handler belongs to this deployment`,
      requiresConfirmation: true,
    };
  }
  if (!read.script.includes('payload.put("eventId"')) {
    return {
      type: params.type,
      action: "repair",
      conflict: "stale_script",
      reason: `${name} does not forward a per-execution eventId, so repeated identical messages can be dropped by OpenClaw inbound dedupe`,
      requiresConfirmation: true,
    };
  }
  if (!read.script.includes('response.put("eventId"')) {
    // Issue #231: without the echo every Zoho execution row reads
    // `output: "{}"`, so a delivered message and a handler that returned
    // before `invokeUrl` look identical in the only log Zoho exposes.
    return {
      type: params.type,
      action: "repair",
      conflict: "stale_script",
      reason: `${name} does not return its eventId, so its Zoho execution rows stay "{}" and cannot be correlated with gateway logs when a message does not become a turn`,
      requiresConfirmation: true,
    };
  }
  return {
    type: params.type,
    action: "none",
    reason: `${name} already posts to the configured URL with the configured secret`,
    requiresConfirmation: false,
  };
}

function blocked(
  configuredUniqueName: string,
  evidence: string[],
  botId?: string,
): CliqProvisioningPlan {
  return { status: "blocked", botId, configuredUniqueName, items: [], evidence };
}

/**
 * Produce a read-only provisioning plan. Performs no mutation and returns
 * only redacted evidence; applying a plan is a separate, confirmation-gated
 * step.
 */
export async function planCliqHandlerProvisioning(params: {
  account: { botId: string; webhookSecret?: string };
  publicWebhookUrl?: string;
  reader: CliqProvisioningReader;
  includeWelcome?: boolean;
}): Promise<CliqProvisioningPlan> {
  const configuredUniqueName = params.account.botId.trim();
  const configSecret = params.account.webhookSecret?.trim() ?? "";
  const expectedUrl = params.publicWebhookUrl?.trim() ?? "";
  if (!configSecret) {
    return blocked(configuredUniqueName, [
      "no webhookSecret is configured, so there is no value to provision into the Zoho handlers",
    ]);
  }
  if (!expectedUrl) {
    return blocked(configuredUniqueName, [
      "no publicWebhookUrl is configured, so the handler target URL is unknown",
    ]);
  }
  const resolved = await resolveCliqInternalBotId({
    configuredId: configuredUniqueName,
    listBots: params.reader.listBots,
  });
  if (!resolved.ok) {
    return blocked(configuredUniqueName, [resolved.reason]);
  }
  const items: CliqHandlerPlanItem[] = [];
  const handlerTypes: CliqProvisionedHandlerType[] = [
    ...CLIQ_INBOUND_HANDLER_TYPES,
    ...(params.includeWelcome ? (["welcome_handler"] as const) : []),
  ];
  for (const type of handlerTypes) {
    let read: { script?: string; error?: string };
    try {
      read = await params.reader.readHandlerScript(type, resolved.botId);
    } catch {
      read = { error: "the handler read threw an unexpected error" };
    }
    items.push(classifyHandler({ type, read, configSecret, expectedUrl }));
  }
  const status: CliqProvisioningStatus = items.some((item) => item.action === "blocked")
    ? "blocked"
    : items.some((item) => item.conflict && item.conflict !== "missing")
      ? "conflict"
      : items.some((item) => item.action !== "none")
        ? "changes_required"
        : "in_sync";
  return {
    status,
    botId: resolved.botId,
    configuredUniqueName,
    items,
    evidence: items.map((item) => `${item.type}: ${item.reason}`),
  };
}

/**
 * Apply a plan. Mutates Zoho only for items that need it AND only when the
 * caller passes explicit confirmation; a `blocked` item is never written,
 * because unknown handler state must not authorise an overwrite. Every
 * mutation is followed by a read-back so success means "Zoho stored what we
 * intended", not merely "the API returned 2xx".
 */
export async function applyCliqHandlerProvisioning(params: {
  plan: CliqProvisioningPlan;
  account: { botId: string; webhookSecret?: string };
  publicWebhookUrl?: string;
  confirmed: boolean;
  writer: CliqProvisioningWriter;
}): Promise<CliqProvisioningApplyReport> {
  const botId = params.plan.botId;
  const secret = params.account.webhookSecret?.trim() ?? "";
  const url = params.publicWebhookUrl?.trim() ?? "";
  const results: CliqHandlerApplyResult[] = [];
  let applied = false;

  for (const item of params.plan.items) {
    if (item.action === "none") {
      results.push({
        type: item.type,
        outcome: "skipped_in_sync",
        detail: `${label(item.type)} already matches the configured URL and secret`,
      });
      continue;
    }
    if (item.action === "blocked") {
      results.push({
        type: item.type,
        outcome: "skipped_blocked",
        detail: `${label(item.type)} was not changed because its current state could not be read`,
      });
      continue;
    }
    if (!params.confirmed) {
      results.push({
        type: item.type,
        outcome: "skipped_unconfirmed",
        detail: `${label(item.type)} needs an explicit confirmation before Zoho-held code is changed`,
      });
      continue;
    }
    if (!botId || !secret || !url) {
      results.push({
        type: item.type,
        outcome: "failed",
        detail: `${label(item.type)} could not be provisioned because the bot id, secret, or public URL was unavailable`,
        retryable: false,
      });
      continue;
    }

    const script = buildCliqHandlerScript({
      handlerType: item.type,
      webhookUrl: url,
      webhookSecret: secret,
    });
    let outcome: CliqHandlerApplyOutcome | undefined;
    let failureCode: string | undefined;

    if (item.action === "create") {
      const created = await params.writer.createHandler(item.type, botId, script);
      if (created.ok) {
        outcome = "created";
      } else if (created.code === CLIQ_GENERIC_CREATE_FAILURE) {
        // Known Zoho behaviour: full-script create can fail generically while
        // minimal-create followed by PATCH succeeds.
        const minimal = await params.writer.createHandler(item.type, botId, minimalHandlerScript());
        if (minimal.ok) {
          const patched = await params.writer.updateHandler(item.type, botId, script);
          if (patched.ok) outcome = "created_via_patch_fallback";
          else failureCode = patched.code;
        } else {
          failureCode = minimal.code;
        }
      } else {
        failureCode = created.code;
      }
    } else {
      const patched = await params.writer.updateHandler(item.type, botId, script);
      if (patched.ok) outcome = "repaired";
      else failureCode = patched.code;
    }

    if (!outcome) {
      const scriptValidity = failureCode === CLIQ_SCRIPT_VALIDITY_FAILURE;
      results.push({
        type: item.type,
        outcome: "failed",
        detail: scriptValidity
          ? `${label(item.type)} was rejected with ${CLIQ_SCRIPT_VALIDITY_FAILURE}; this usually means the script references a parameter this handler does not receive, so it is a script-validity fault rather than a transient error`
          : `${label(item.type)} could not be provisioned (Zoho reported ${failureCode ?? "an unspecified failure"})`,
        retryable: isRetryableCliqProvisioningFailure(failureCode),
      });
      continue;
    }

    applied = true;
    const readBack = await params.writer.readHandlerScript(item.type, botId);
    const storedUrl = readBack.script
      ? extractDelugeStringAssignment(readBack.script, "webhookUrl")
      : null;
    const storedSecret = readBack.script
      ? extractDelugeStringAssignment(readBack.script, "webhookSecret")
      : null;
    const verified =
      storedUrl !== null &&
      storedSecret !== null &&
      sameWebhookUrl(storedUrl, url) &&
      storedSecret === secret;
    results.push({
      type: item.type,
      outcome,
      detail: verified
        ? `${label(item.type)} was ${outcome === "created_via_patch_fallback" ? "created through the minimal-create-then-PATCH fallback" : outcome} and read back with the configured URL and secret`
        : `${label(item.type)} was written but the read-back did not match the configured URL and secret`,
      verified,
    });
  }

  const ok = results.every(
    (result) => result.outcome !== "failed" && result.verified !== false,
  );
  return { ok, applied, results };
}
