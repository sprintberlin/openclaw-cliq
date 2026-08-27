import {
  formatCliqPreflightReport,
  runCliqWebhookPreflight,
  type CliqPreflightReport,
} from "./webhook-preflight.js";
import {
  persistCliqInboundVerification,
  type PersistCliqInboundVerificationResult,
} from "./inbound-verification-store.js";
import type { CliqHandlerScriptRecord } from "./handler-consistency.js";

/**
 * CLI surface for the public webhook preflight (issues #96, #106).
 *
 * Kept separate from `src/webhook-preflight.ts` so the preflight itself stays
 * a pure, dependency-injected library that the staged doctor (#97) can call
 * directly. This module owns argument shape, output rendering, the exit code,
 * and — since #106 — handing the verdict to the config writer.
 *
 * Exit codes: `0` when inbound Cliq is reachable and authenticated, `1`
 * otherwise, so the command is usable as a deployment gate in CI or a
 * provisioning script. Recording the result is a *side effect*: a failing
 * config write is reported to the operator but never changes the verdict, and
 * never swallows the diagnostic the operator ran the command for.
 */

export interface CliqWebhookPreflightCommandOptions {
  /** Full public webhook URL. */
  url: string;
  /** The configured `webhookSecret`, when available. */
  secret?: string;
  /** `channels.cliq.publicWebhookUrl`, when this install has one. */
  configuredUrl?: string;
  /** The secret came from `--secret`, not from the configured channel config. */
  foreignSecret?: boolean;
  /** Run as a pure read-only probe and never persist the result. */
  write?: boolean;
  /** User-Agent sent to the public endpoint. */
  userAgent?: string;
  /** Emit the machine-readable report instead of the human-readable one. */
  json?: boolean;
  /**
   * Optional reader of the bot's inbound handler scripts (issue #124).
   * When absent the handler-secret stage reports `skipped`, never `pass`.
   */
  readHandlers?: () => Promise<readonly CliqHandlerScriptRecord[]>;
}

export interface CliqWebhookPreflightCommandDeps {
  runPreflight: (options: {
    url: string;
    secret: string | undefined;
    userAgent?: string;
    readHandlers?: () => Promise<readonly CliqHandlerScriptRecord[]>;
  }) => Promise<CliqPreflightReport>;
  persistVerification?: (params: {
    targetUrl: string;
    configuredUrl: string | undefined;
    outcome: "pass" | "fail";
    suppressed: boolean;
    foreignSecret: boolean;
  }) => Promise<PersistCliqInboundVerificationResult>;
  writeLine: (line: string) => void;
}

const defaultDeps: CliqWebhookPreflightCommandDeps = {
  runPreflight: ({ url, secret, userAgent, readHandlers }) =>
    runCliqWebhookPreflight({ url, secret, userAgent, readHandlers }),
  persistVerification: persistCliqInboundVerification,
  writeLine: (line) => {
    console.log(line);
  },
};

/** Run the preflight command and resolve to a process exit code. */
export async function runCliqWebhookPreflightCommand(
  options: CliqWebhookPreflightCommandOptions,
  deps: CliqWebhookPreflightCommandDeps = defaultDeps,
): Promise<number> {
  const report = await deps.runPreflight({
    url: options.url,
    secret: options.secret,
    userAgent: options.userAgent,
    readHandlers: options.readHandlers,
  });
  const persistVerification = deps.persistVerification ?? persistCliqInboundVerification;
  const failed = report.stages.some((stage) => stage.status === "fail");
  let persistence: PersistCliqInboundVerificationResult;
  if (!report.ok && !failed) {
    persistence = {
      written: false,
      reason: "the preflight was inconclusive, so the previous verification state was preserved",
    };
  } else {
    try {
      persistence = await persistVerification({
        targetUrl: options.url,
        configuredUrl: options.configuredUrl,
        outcome: report.ok ? "pass" : "fail",
        suppressed: options.write === false,
        foreignSecret: options.foreignSecret === true,
      });
    } catch (err) {
      persistence = {
        written: false,
        reason: `could not record the verification result: ${String(err)}`,
      };
    }
  }

  if (options.json) {
    deps.writeLine(JSON.stringify({ ...report, persistence }, null, 2));
  } else {
    for (const line of formatCliqPreflightReport(report)) deps.writeLine(line);
    deps.writeLine(`Config: ${persistence.reason}.`);
  }

  return report.ok ? 0 : 1;
}
