import {
  checkCliqWebhookRoute,
  formatCliqRouteCheckReport,
  type CliqRouteCheckReport,
} from "./webhook-route-check.js";

export interface CliqWebhookRouteCommandOptions {
  url?: string;
  port?: number;
  json?: boolean;
}

export interface CliqWebhookRouteCommandDeps {
  runCheck: (options: {
    url?: string;
    port?: number;
  }) => Promise<CliqRouteCheckReport>;
  writeLine: (line: string) => void;
}

const defaultDeps: CliqWebhookRouteCommandDeps = {
  runCheck: ({ url, port }) => checkCliqWebhookRoute({ url, port }),
  writeLine: (line) => {
    console.log(line);
  },
};

export async function runCliqWebhookRouteCommand(
  options: CliqWebhookRouteCommandOptions,
  deps: CliqWebhookRouteCommandDeps = defaultDeps,
): Promise<number> {
  const port =
    options.port !== undefined && Number.isFinite(options.port)
      ? options.port
      : undefined;
  const report = await deps.runCheck({ url: options.url, port });

  if (options.json) {
    deps.writeLine(JSON.stringify(report, null, 2));
  } else {
    for (const line of formatCliqRouteCheckReport(report)) deps.writeLine(line);
  }

  return report.ok ? 0 : 1;
}
