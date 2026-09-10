import { createHash } from "node:crypto";
import type { ResolvedCliqAccount } from "./client.js";
import { createCliqBotIdResolver, type CliqBotIdLister } from "./bot-id.js";
import {
  CLIQ_HANDLER_SCHEMA_FIELD,
  CLIQ_HANDLER_SCHEMA_VERSION,
  extractDelugePayloadPutStringLiteral,
} from "./handler-schema.js";

/**
 * Zoho-side handler consistency check (issue #124).
 *
 * The webhook preflight authenticates against our own endpoint with the
 * secret from `channels.cliq.webhookSecret`, so it only ever proves that the
 * config agrees with itself. The value that actually decides whether inbound
 * works is the copy hardcoded in the bot's Deluge handler — that is what Zoho
 * sends. When the two diverge every real message dies with `401` while the
 * diagnostic designed to catch exactly that reports all stages green.
 *
 * This module compares the *config* secret with the secret each handler
 * script carries, plus the handler's `webhookUrl` against the public URL.
 *
 * **Fingerprints, never values.** The handler script is a live credential
 * (issue #113 documents that `Bots.READ` can read it back at all); a
 * diagnostic must not widen that exposure by printing it into terminal
 * scrollback, CI logs, or a JSON report. Comparison therefore happens on
 * short SHA-256 prefixes, which are enough to tell an operator "these differ"
 * without disclosing either side.
 *
 * **Absence is never a pass.** Extraction is a regex over the documented
 * script template (README §5), so a hand-written handler that stores the
 * secret differently, a missing `Bots.READ` grant, or an unreadable bot all
 * degrade to `skipped` with the reason. Reporting `pass` for "we could not
 * look" would recreate the very false assurance this check exists to remove.
 */

/** Outcome of the consistency check. Deliberately has no `warn`. */
export type CliqHandlerConsistencyStatus = "pass" | "fail" | "skipped";

/** The bot handler types that forward inbound messages to the webhook. */
export const CLIQ_INBOUND_HANDLER_TYPES = ["message_handler", "mention_handler"] as const;

export type CliqInboundHandlerType = (typeof CLIQ_INBOUND_HANDLER_TYPES)[number];

/**
 * One handler as read back from `GET /api/v3/bots/<botId>/handlers/<type>`.
 * `script` is the raw Deluge body; `error` explains why it could not be read.
 * A record must carry exactly one of the two.
 */
export interface CliqHandlerScriptRecord {
  type: string;
  script?: string | null;
  error?: string;
  /**
   * Stable error code from Zoho's handler-read response, when available.
   * Keep this separate from `error`: the latter is deliberately redacted,
   * human-readable diagnostic text and must never contain the response body.
   */
  errorCode?: string;
  /** HTTP status from the handler-read response, when available. */
  errorStatus?: number;
}

export interface CliqHandlerConsistencyResult {
  status: CliqHandlerConsistencyStatus;
  /** Human-readable, fingerprint-only summary. Never contains a secret. */
  detail: string;
  /**
   * Why a handler could not be read, when that is the limiting evidence.
   * This lets doctor offer a targeted repair instead of treating every 4xx as
   * a missing OAuth consent.
   */
  readProblem?: CliqHandlerReadProblem;
}

export type CliqHandlerReadProblem =
  | "handler_not_provisioned"
  | "missing_scope"
  | "unreadable";

/**
 * Classify a reduced, non-secret handler-read failure.
 *
 * `execution_handler_not_found` is a normal new-bot state: Cliq has no
 * stored handler to read yet. It must not be diagnosed as a `Bots.READ`
 * consent problem merely because the endpoint uses an HTTP 400 response.
 */
export function classifyCliqHandlerReadProblem(
  handler: Pick<CliqHandlerScriptRecord, "error" | "errorCode" | "errorStatus">,
): CliqHandlerReadProblem {
  const code = handler.errorCode?.trim().toLowerCase();
  if (code === "execution_handler_not_found") return "handler_not_provisioned";
  if (handler.errorStatus === 401 || code === "oauthtoken_scope_invalid" || code?.includes("scope")) {
    return "missing_scope";
  }
  return "unreadable";
}

function describeHandlerReadFailure(handler: CliqHandlerScriptRecord): string {
  const label = describeHandler(handler.type);
  switch (classifyCliqHandlerReadProblem(handler)) {
    case "handler_not_provisioned":
      return `${label} is not provisioned yet (Zoho returned execution_handler_not_found)`;
    case "missing_scope":
      return `${label} could not be read (${handler.error ?? "Zoho rejected the handler read as unauthorized"})`;
    case "unreadable":
      return `${label} could not be read (${handler.error ?? "no script body was returned"})`;
  }
}

function mostSpecificHandlerReadProblem(
  handlers: readonly CliqHandlerScriptRecord[],
): CliqHandlerReadProblem | undefined {
  const problems = handlers
    .filter((handler) => handler.error || typeof handler.script !== "string" || handler.script.length === 0)
    .map(classifyCliqHandlerReadProblem);
  if (problems.includes("handler_not_provisioned")) return "handler_not_provisioned";
  if (problems.includes("missing_scope")) return "missing_scope";
  return problems.includes("unreadable") ? "unreadable" : undefined;
}

/**
 * Static declaration coverage for inbound content shapes that the normal
 * diagnostic send API cannot create. `declared_unexercised` intentionally
 * does not mean a live Cliq reply or forward was delivered: it says only that
 * the read-back Deluge script names the payload fields the inbound parser can
 * consume. A real client must create those native relationships.
 */
export type CliqHandlerContentShapeCoverageStatus =
  | "declared_unexercised"
  | "uncovered"
  | "unknown";

export interface CliqHandlerContentShapeCoverage {
  status: CliqHandlerContentShapeCoverageStatus;
  /** Field names and coverage state only. Never contains a handler body or values. */
  detail: string;
}

const CLIQ_REPLY_CONTEXT_PAYLOAD_FIELDS = [
  "reply_to",
  "parent",
  "parent_message",
  "quoted",
  "quoted_message",
  "reply_to_message",
] as const;

const CLIQ_FORWARD_CONTEXT_PAYLOAD_FIELDS = [
  "forwarded_message",
  "forwardedMessage",
  "forwarded",
  "forward",
  "forwarded_content",
  "original_message",
  "originalMessage",
] as const;

const CLIQ_BASE_INBOUND_PAYLOAD_FIELDS = [
  "handler",
  "message",
  "user",
  "chat",
  "eventId",
] as const;

/**
 * Read the literal keys a Deluge handler puts into the outbound webhook map.
 * This is deliberately a narrow template check: dynamically-computed keys or
 * unknown Deluge constructs are not treated as coverage. A false positive
 * would turn absent evidence into an undeserved green diagnostic.
 */
function extractDelugePayloadPutKeys(script: string): Set<string> {
  const keys = new Set<string>();
  const pattern = /^[ \t]*payload\.put\(\s*"([^"\n]+)"\s*,/gm;
  for (const match of script.matchAll(pattern)) {
    if (match[1]) keys.add(match[1]);
  }
  return keys;
}

function describeDeclaredFields(keys: Set<string>, fields: readonly string[]): string {
  const declared = fields.filter((field) => keys.has(field));
  return declared.length > 0 ? declared.join(", ") : "none";
}

/**
 * Report which inbound content shapes a Zoho-held script *declares* it will
 * forward. The doctor can automatically roundtrip ordinary multiline text,
 * but posting a bot message cannot synthesize a native Cliq reply/quote or a
 * forward. Keep those paths visibly unexercised instead of inferring coverage
 * from secret/URL equality or from a plain-text roundtrip.
 */
export function inspectCliqHandlerContentShapeCoverage(
  handlers: readonly CliqHandlerScriptRecord[],
): CliqHandlerContentShapeCoverage {
  if (handlers.length === 0) {
    return {
      status: "unknown",
      detail: "no inbound handler scripts were read, so reply/quote and forwarded-message field declarations are unknown",
    };
  }

  const unreadable: string[] = [];
  const declarations: Array<{
    label: string;
    base: string;
    reply: string;
    forward: string;
    hasReply: boolean;
    hasForward: boolean;
  }> = [];

  for (const handler of handlers) {
    const label = describeHandler(handler.type);
    if (handler.error || typeof handler.script !== "string" || handler.script.length === 0) {
      unreadable.push(label);
      continue;
    }
    const keys = extractDelugePayloadPutKeys(handler.script);
    const reply = describeDeclaredFields(keys, CLIQ_REPLY_CONTEXT_PAYLOAD_FIELDS);
    const forward = describeDeclaredFields(keys, CLIQ_FORWARD_CONTEXT_PAYLOAD_FIELDS);
    declarations.push({
      label,
      base: describeDeclaredFields(keys, CLIQ_BASE_INBOUND_PAYLOAD_FIELDS),
      reply,
      forward,
      hasReply: reply !== "none",
      hasForward: forward !== "none",
    });
  }

  if (unreadable.length > 0) {
    return {
      status: "unknown",
      detail: `reply/quote and forwarded-message field declarations are unknown because ${unreadable.join(" and ")} could not be read`,
    };
  }

  const detail = declarations
    .map(
      (item) =>
        `${item.label} declares base fields [${item.base}], reply/quote fields [${item.reply}], and forwarded-message fields [${item.forward}]`,
    )
    .join("; ");
  const everyShapeDeclared = declarations.length > 0 && declarations.every(
    (item) => item.hasReply && item.hasForward,
  );
  if (everyShapeDeclared) {
    return {
      status: "declared_unexercised",
      detail: `${detail}. Those declarations are static only: the doctor does not claim native reply/quote or forward delivery without a real-client check`,
    };
  }
  return {
    status: "uncovered",
    detail: `${detail}. Missing fields are an explicit coverage gap: the normal bot send API cannot synthesize native Cliq reply/quote or forward metadata`,
  };
}

export interface CheckCliqHandlerConsistencyOptions {
  /** Handlers read back from Zoho. */
  handlers: readonly CliqHandlerScriptRecord[];
  /** The resolved `channels.cliq.webhookSecret`, if any. */
  configSecret: string | undefined;
  /** The public webhook URL the handlers are expected to POST to. */
  expectedWebhookUrl?: string;
}

/**
 * A short, non-reversible fingerprint of a secret.
 *
 * Twelve hex characters of SHA-256 — enough that two distinct secrets
 * effectively never collide in a diagnostic, while disclosing nothing usable.
 * Truncated *middles* of the real value are deliberately not used: those leak
 * real key material (#113).
 */
export function fingerprintCliqSecret(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12)}`;
}

/**
 * Extract a top-level Deluge string assignment (`name = "value";`) from a
 * handler script.
 *
 * Matches only an assignment at the start of a line so a mention inside a
 * comment or a nested expression cannot be mistaken for the real declaration.
 * Returns `null` when the variable is absent or is not a plain string literal
 * — the caller must treat that as "unrecognised script shape", not as a
 * mismatch.
 */
export function extractDelugeStringAssignment(
  script: string,
  variableName: string,
): string | null {
  const pattern = new RegExp(`^[ \\t]*${variableName}[ \\t]*=[ \\t]*"([^"\\n]*)"[ \\t]*;`, "m");
  const match = pattern.exec(script);
  return match ? (match[1] ?? null) : null;
}

/** Compare two URLs for delivery equivalence (trailing slash / case-insensitive host). */
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

function describeHandler(type: string): string {
  return type.replace(/_/g, " ");
}

/**
 * Compare the Zoho-held handler secrets and URLs against the loaded config.
 *
 * Precedence is deliberate: a *mismatch* is reported even when some other
 * handler was unreadable, because a known-broken handler is the actionable
 * finding. Only when nothing could be compared at all does the check report
 * `skipped`.
 */
export function checkCliqHandlerConsistency(
  options: CheckCliqHandlerConsistencyOptions,
): CliqHandlerConsistencyResult {
  const configSecret = options.configSecret?.trim();
  if (!configSecret) {
    return {
      status: "skipped",
      detail:
        "no webhookSecret is configured, so there is no config-side value to compare the Zoho handler scripts against",
    };
  }
  if (options.handlers.length === 0) {
    return {
      status: "skipped",
      detail: "no bot handlers were read back from Zoho, so the handler-held secret is unknown",
    };
  }

  const configFingerprint = fingerprintCliqSecret(configSecret);
  const failures: string[] = [];
  const skips: string[] = [];
  const matched: string[] = [];
  /** handler type -> secret fingerprint, for the handler-vs-handler check. */
  const seenFingerprints = new Map<string, string>();

  for (const handler of options.handlers) {
    const label = describeHandler(handler.type);
    if (handler.error || typeof handler.script !== "string" || handler.script.length === 0) {
      skips.push(describeHandlerReadFailure(handler));
      continue;
    }
    const handlerSecret = extractDelugeStringAssignment(handler.script, "webhookSecret");
    if (handlerSecret === null) {
      skips.push(
        `${label} does not declare a recognisable webhookSecret = "…" literal, so its secret could not be compared (a hand-written handler may store it differently)`,
      );
    } else if (handlerSecret.trim().length === 0) {
      failures.push(
        `${label} carries an empty webhookSecret literal while config has ${configFingerprint} — Zoho will send no secret and every message will be rejected with 401`,
      );
    } else {
      const handlerFingerprint = fingerprintCliqSecret(handlerSecret.trim());
      seenFingerprints.set(handler.type, handlerFingerprint);
      if (handlerFingerprint === configFingerprint) {
        matched.push(label);
      } else {
        failures.push(
          `${label} holds a different webhook secret than the config (handler ${handlerFingerprint} vs config ${configFingerprint}) — Zoho signs with the handler's value, so every inbound message will be rejected with 401`,
        );
      }
    }

    if (options.expectedWebhookUrl) {
      const handlerUrl = extractDelugeStringAssignment(handler.script, "webhookUrl");
      if (handlerUrl === null) {
        skips.push(
          `${label} does not declare a recognisable webhookUrl = "…" literal, so its delivery URL could not be compared`,
        );
      } else if (!sameWebhookUrl(handlerUrl, options.expectedWebhookUrl)) {
        failures.push(
          `${label} posts to ${handlerUrl} but this install's public webhook URL is ${options.expectedWebhookUrl} — Zoho is delivering somewhere else`,
        );
      }
    }

    if (handlerSecret !== null) {
      // A generated handler lives in Zoho independently from the plugin
      // artifact. URL/secret equality alone cannot prove that its payload has
      // the contract this runtime parses. Keep the literal marker check
      // beside the existing targeted eventId diagnostics: `v2` proves a
      // complete generated contract, while the targeted messages remain
      // useful for a known legacy script operators need to recognize. A
      // hand-written handler (no recognisable secret literal) stays on its
      // existing skip path and is never reported as a schema casualty.
      const handlerSchema = extractDelugePayloadPutStringLiteral(
        handler.script,
        CLIQ_HANDLER_SCHEMA_FIELD,
      );
      if (handlerSchema !== CLIQ_HANDLER_SCHEMA_VERSION) {
        const observed = handlerSchema === null
          ? "no recognisable handlerSchema literal"
          : `handlerSchema "${handlerSchema}"`;
        failures.push(
          `${label} carries ${observed}; expected handlerSchema "${CLIQ_HANDLER_SCHEMA_VERSION}". The Zoho-held script is stale even if the plugin was upgraded or the gateway restarted; run openclaw setup or the confirmation-gated handler repair to update it`,
        );
      }
    }

    if (
      handlerSecret !== null &&
      !handler.script.includes('payload.put("eventId"')
    ) {
      failures.push(
        `${label} does not forward a per-execution eventId, so repeated identical messages can be dropped by OpenClaw inbound dedupe`,
      );
    }

    // Issue #231: a handler that does not echo its eventId leaves every Zoho
    // execution row as `output: "{}"`, so a delivered message, a rejected
    // webhook and a handler that returned before `invokeUrl` are
    // indistinguishable in the only execution log Zoho exposes.
    if (
      handlerSecret !== null &&
      !handler.script.includes('response.put("eventId"')
    ) {
      failures.push(
        `${label} does not return its eventId, so its Zoho execution rows stay "{}" and a message that never became an agent turn cannot be correlated with gateway logs`,
      );
    }
  }

  // Two handlers that disagree with each other mean one of them is stale,
  // even in the impossible-to-reach case where neither matched config.
  const distinct = new Set(seenFingerprints.values());
  if (distinct.size > 1) {
    const rendered = [...seenFingerprints.entries()]
      .map(([type, fingerprint]) => `${describeHandler(type)}=${fingerprint}`)
      .join(", ");
    failures.push(
      `the handlers do not agree with each other (${rendered}) — at least one is stale and that path will be rejected with 401`,
    );
  }

  if (failures.length > 0) {
    const trailer = skips.length > 0 ? ` Not compared: ${skips.join("; ")}.` : "";
    return { status: "fail", detail: `${failures.join("; ")}.${trailer}` };
  }
  if (skips.length > 0) {
    const readProblem = mostSpecificHandlerReadProblem(options.handlers);
    const compared = matched.length > 0
      ? ` ${matched.join(" and ")} matched, but equality cannot be claimed for every inbound path.`
      : "";
    return {
      status: "skipped",
      detail: `the Zoho-held webhook secret could not be completely compared: ${skips.join("; ")}.${compared}`,
      readProblem,
    };
  }
  return {
    status: "pass",
    detail: `${matched.join(" and ")} carry the same webhook secret as the config (${configFingerprint})${
      options.expectedWebhookUrl ? " and post to the configured public webhook URL" : ""
    }.`,
  };
}

export type CliqHandlerUrlAdoptionProposal =
  | { ok: true; url: string }
  | { ok: false; reason: string };

function canonicalWebhookUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "")}${url.search}`;
  } catch {
    return raw.trim().replace(/\/+$/, "");
  }
}

function validateAdoptableWebhookUrl(raw: string): CliqHandlerUrlAdoptionProposal {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: `not a valid URL: ${raw}` };
  }
  if (parsed.protocol === "http:") {
    return {
      ok: false,
      reason: "must use https — Zoho Cliq refuses to deliver to a plaintext http endpoint",
    };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, reason: `unsupported protocol ${parsed.protocol} — must be https` };
  }
  if (parsed.pathname.replace(/\/+$/, "") !== "/cliq/webhook") {
    return {
      ok: false,
      reason: `path is "${parsed.pathname}" but the plugin registers "/cliq/webhook"`,
    };
  }
  return { ok: true, url: canonicalWebhookUrl(raw) };
}

/**
 * Propose adopting the Zoho-held handler URL into config (issue #172).
 *
 * A candidate exists only when both inbound handlers can be read, their
 * secret fingerprints match the configured `webhookSecret`, and they agree
 * on exactly one valid HTTPS `/cliq/webhook` URL. Absence, disagreement,
 * or an unrecognised script is never guessed into a URL.
 */
export function proposeCliqHandlerUrlAdoption(options: {
  handlers: readonly CliqHandlerScriptRecord[];
  configSecret: string | undefined;
}): CliqHandlerUrlAdoptionProposal {
  for (const type of CLIQ_INBOUND_HANDLER_TYPES) {
    const handler = options.handlers.find((record) => record.type === type);
    const label = describeHandler(type);
    if (!handler) {
      return {
        ok: false,
        reason: `${label} was not read, so there is no agreed handler URL to adopt`,
      };
    }
    if (handler.error || typeof handler.script !== "string" || handler.script.length === 0) {
      return {
        ok: false,
        reason: `${label} could not be read (${handler.error ?? "no script body was returned"})`,
      };
    }
  }
  const urls = new Map<string, string>();
  for (const type of CLIQ_INBOUND_HANDLER_TYPES) {
    const handler = options.handlers.find((record) => record.type === type)!;
    const label = describeHandler(type);
    const handlerUrl = extractDelugeStringAssignment(handler.script!, "webhookUrl");
    if (handlerUrl === null || handlerUrl.trim().length === 0) {
      return {
        ok: false,
        reason: `${label} does not declare a recognisable webhookUrl = "…" literal, so there is no handler URL to adopt`,
      };
    }
    const validated = validateAdoptableWebhookUrl(handlerUrl);
    if (!validated.ok) return validated;
    urls.set(type, validated.url);
  }
  const secretCheck = checkCliqHandlerConsistency({
    handlers: options.handlers,
    configSecret: options.configSecret,
  });
  if (secretCheck.status !== "pass") {
    return { ok: false, reason: secretCheck.detail };
  }
  const distinct = [...new Set(urls.values())];
  if (distinct.length !== 1) {
    const rendered = [...urls.entries()]
      .map(([type, url]) => `${describeHandler(type)} posts to ${url}`)
      .join(", ");
    return {
      ok: false,
      reason: `the handlers do not agree on a delivery URL (${rendered})`,
    };
  }
  return { ok: true, url: distinct[0]! };
}

/**
 * Build the handler reader the preflight consumes, backed by a live client.
 *
 * Returns `null` when this install has no `botId`: without one there is no
 * bot to inspect, and the preflight must degrade to `skipped` rather than
 * inventing a verdict.
 *
 * Read failures are captured *per handler* rather than thrown, so a bot that
 * has a Message handler but no Mention handler still yields a usable
 * comparison for the handler that does exist.
 */
export function createCliqHandlerScriptReader(params: {
  account: Pick<ResolvedCliqAccount, "botId">;
  readHandlerScript: (
    handlerType: string,
    botId?: string,
  ) => Promise<{
    script?: string;
    error?: string;
    errorCode?: string;
    errorStatus?: number;
  }>;
  listBots: CliqBotIdLister;
}): (() => Promise<CliqHandlerScriptRecord[]>) | null {
  if (!params.account.botId) return null;
  const resolver = createCliqBotIdResolver(params.listBots);
  return async () => {
    const resolved = await resolver.resolve(params.account.botId);
    if (!resolved.ok) {
      return CLIQ_INBOUND_HANDLER_TYPES.map((type) => ({
        type,
        error: `the bot id could not be resolved: ${resolved.reason}`,
      }));
    }
    const records: CliqHandlerScriptRecord[] = [];
    for (const type of CLIQ_INBOUND_HANDLER_TYPES) {
      try {
        const result = await params.readHandlerScript(type, resolved.botId);
        records.push({
          type,
          script: result.script,
          error: result.error,
          errorCode: result.errorCode,
          errorStatus: result.errorStatus,
        });
      } catch {
        records.push({ type, error: "the handler read threw an unexpected error" });
      }
    }
    return records;
  };
}
