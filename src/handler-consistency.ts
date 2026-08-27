import { createHash } from "node:crypto";
import type { ResolvedCliqAccount } from "./client.js";

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
}

export interface CliqHandlerConsistencyResult {
  status: CliqHandlerConsistencyStatus;
  /** Human-readable, fingerprint-only summary. Never contains a secret. */
  detail: string;
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
      skips.push(
        `${label} could not be read (${handler.error ?? "no script body was returned"})`,
      );
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
    const compared = matched.length > 0
      ? ` ${matched.join(" and ")} matched, but equality cannot be claimed for every inbound path.`
      : "";
    return {
      status: "skipped",
      detail: `the Zoho-held webhook secret could not be completely compared: ${skips.join("; ")}.${compared}`,
    };
  }
  return {
    status: "pass",
    detail: `${matched.join(" and ")} carry the same webhook secret as the config (${configFingerprint})${
      options.expectedWebhookUrl ? " and post to the configured public webhook URL" : ""
    }.`,
  };
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
  readHandlerScript: (handlerType: string) => Promise<{ script?: string; error?: string }>;
}): (() => Promise<CliqHandlerScriptRecord[]>) | null {
  if (!params.account.botId) return null;
  return async () => {
    const records: CliqHandlerScriptRecord[] = [];
    for (const type of CLIQ_INBOUND_HANDLER_TYPES) {
      try {
        const result = await params.readHandlerScript(type);
        records.push({ type, script: result.script, error: result.error });
      } catch {
        // The message is deliberately generic: a thrown error can carry a
        // response body, and handler bodies contain the live secret (#113).
        records.push({ type, error: "the handler read threw an unexpected error" });
      }
    }
    return records;
  };
}
