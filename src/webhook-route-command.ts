import {
  checkCliqWebhookRoute,
  formatCliqRouteCheckReport,
  type CliqRouteCheckReport,
} from "./webhook-route-check.js";

export interface CliqWebhookRouteCommandOptions {
  url?: string;
  /**
   * Gateway port when no explicit URL is given. An unusable value is an
   * error, never a silent fallback to the default port — reporting a
   * different gateway as healthy is exactly the failure mode this command
   * exists to eliminate.
   */
  port?: number;
  json?: boolean;
}

export interface CliqWebhookRouteCommandDeps {
  runCheck: (options: {
    url?: string;
    port?: number;
  }) => Promise<CliqRouteCheckReport>;
  writeLine: (line: string) => void;
  writeError?: (line: string) => void;
}

const defaultDeps: CliqWebhookRouteCommandDeps = {
  runCheck: ({ url, port }) => checkCliqWebhookRoute({ url, port }),
  // Write straight to the streams rather than through console.*: the host CLI
  // rebinds console output to stderr for plugin commands, which would make
  // `--json` unpipeable (`… --json | jq` would see nothing).
  writeLine: (line) => {
    process.stdout.write(`${line}\n`);
  },
  writeError: (line) => {
    process.stderr.write(`${line}\n`);
  },
};

export async function runCliqWebhookRouteCommand(
  options: CliqWebhookRouteCommandOptions,
  deps: CliqWebhookRouteCommandDeps = defaultDeps,
): Promise<number> {
  let port: number | undefined;
  if (options.port !== undefined) {
    if (
      !Number.isInteger(options.port) ||
      options.port < 1 ||
      options.port > 65535
    ) {
      (deps.writeError ?? deps.writeLine)(
        `Invalid --port: expected an integer between 1 and 65535, got "${options.port}".`,
      );
      return 2;
    }
    port = options.port;
  }
  const report = await deps.runCheck({ url: options.url, port });

  if (options.json) {
    deps.writeLine(JSON.stringify(report, null, 2));
  } else {
    for (const line of formatCliqRouteCheckReport(report)) deps.writeLine(line);
  }

  return report.ok ? 0 : 1;
}
