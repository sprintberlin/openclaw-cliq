import {
  formatCliqPreflightReport,
  runCliqWebhookPreflight,
  type CliqPreflightReport,
} from "./webhook-preflight.js";

/**
 * CLI surface for the public webhook preflight (issue #96).
 *
 * Kept separate from `src/webhook-preflight.ts` so the preflight itself stays
 * a pure, dependency-injected library that the staged doctor (#97) can call
 * directly. This module only owns argument shape, output rendering, and the
 * exit code.
 *
 * Exit codes: `0` when inbound Cliq is reachable and authenticated, `1`
 * otherwise, so the command is usable as a deployment gate in CI or a
 * provisioning script.
 */

export interface CliqWebhookPreflightCommandOptions {
  /** Full public webhook URL. */
  url: string;
  /** The configured `webhookSecret`, when available. */
  secret?: string;
  /** Emit the machine-readable report instead of the human-readable one. */
  json?: boolean;
}

export interface CliqWebhookPreflightCommandDeps {
  runPreflight: (options: {
    url: string;
    secret: string | undefined;
  }) => Promise<CliqPreflightReport>;
  writeLine: (line: string) => void;
}

const defaultDeps: CliqWebhookPreflightCommandDeps = {
  runPreflight: ({ url, secret }) => runCliqWebhookPreflight({ url, secret }),
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
  });

  if (options.json) {
    deps.writeLine(JSON.stringify(report, null, 2));
  } else {
    for (const line of formatCliqPreflightReport(report)) deps.writeLine(line);
  }

  return report.ok ? 0 : 1;
}
