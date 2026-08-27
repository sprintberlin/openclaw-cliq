export const CLIQ_SETUP_REPORT_SCHEMA_VERSION = 1 as const;

export type CliqSetupSectionId =
  | "config"
  | "oauth"
  | "bot"
  | "handlers"
  | "lifecycle"
  | "webhook"
  | "admission"
  | "delivery";

export type CliqSetupSectionStatus =
  | "pass"
  | "in_sync"
  | "created"
  | "conflict"
  | "ready"
  | "restart_required"
  | "isolated"
  | "organization_wide"
  | "blocked"
  | "not_run"
  | "cancelled"
  | "failed";

export type CliqSetupOutcome = "ready" | "action_required" | "blocked";

export interface CliqSetupSection {
  id: CliqSetupSectionId;
  status: CliqSetupSectionStatus;
  detail: string;
}

export interface CliqSetupCompatibility {
  installedVersion: string | null;
  supportedVersions: string[];
  status: "supported" | "unsupported" | "unknown";
}

export interface CliqSetupReport {
  schemaVersion: typeof CLIQ_SETUP_REPORT_SCHEMA_VERSION;
  command: "cliq setup";
  accountId: string;
  outcome: CliqSetupOutcome;
  nextAction: string | null;
  compatibility: CliqSetupCompatibility;
  requiredEnvironment: string[];
  sections: CliqSetupSection[];
  notes: string[];
}

export interface CliqSetupReportInput {
  accountId?: string;
  compatibility?: CliqSetupCompatibility;
  configValid: boolean;
  oauth: "pass" | "blocked" | "not_run";
  bot: "in_sync" | "created" | "blocked" | "not_run";
  handlers: "in_sync" | "created" | "conflict" | "blocked" | "not_run";
  lifecycle: "ready" | "restart_required";
  webhook: "pass" | "blocked" | "not_run";
  admission: "isolated" | "organization_wide";
  delivery: "pass" | "cancelled" | "failed" | "not_requested";
  requiredEnvironment?: string[];
  notes?: string[];
}

const SECTION_ORDER: CliqSetupSectionId[] = [
  "config",
  "oauth",
  "bot",
  "handlers",
  "lifecycle",
  "webhook",
  "admission",
  "delivery",
];

function redact(text: string): string {
  return text
    .replace(/(clientSecret|webhookSecret|refreshToken|access_token|authorization_code)\s*[=:]\s*\S+/gi, "$1=<redacted>")
    .replace(/\b1000\.[A-Za-z0-9._-]+/g, "<redacted>");
}

function nextActionFor(input: CliqSetupReportInput): string | null {
  if (input.compatibility?.status === "unsupported") {
    return `Install a supported OpenClaw version (${input.compatibility.supportedVersions.join(", ")}) before starting the Cliq gateway.`;
  }
  if (!input.configValid) {
    return "Fix the generated Cliq config until `openclaw config validate` succeeds, then rerun setup.";
  }
  if (input.oauth === "blocked") {
    return "Correct the Zoho OAuth self-client credentials and rerun setup from the credential step.";
  }
  if (input.bot === "blocked" || input.handlers === "blocked") {
    return "Inspect the redacted bot/handler dry-run, then rerun setup if you want to create or repair resources.";
  }
  if (input.webhook === "blocked") {
    return "Repair the public HTTPS webhook (DNS, TLS, reverse proxy, route, or shared secret) and rerun setup.";
  }
  if (input.lifecycle === "restart_required") {
    return "Restart the OpenClaw gateway so it loads the generated Cliq config (`systemctl --user restart openclaw-gateway.service` or the equivalent for this host).";
  }
  if (input.delivery === "failed") {
    return "Inspect the redacted first-contact failure and rerun setup if you want to retry the optional message test.";
  }
  return null;
}

function outcomeFor(input: CliqSetupReportInput, nextAction: string | null): CliqSetupOutcome {
  if (
    input.compatibility?.status === "unsupported" ||
    !input.configValid ||
    input.oauth === "blocked" ||
    input.bot === "blocked" ||
    input.handlers === "blocked" ||
    input.webhook === "blocked"
  ) {
    return "blocked";
  }
  return nextAction ? "action_required" : "ready";
}

function detailFor(id: CliqSetupSectionId, input: CliqSetupReportInput): string {
  switch (id) {
    case "config":
      return input.configValid
        ? "generated Cliq config passed OpenClaw schema validation"
        : "generated Cliq config failed OpenClaw schema validation";
    case "oauth":
      return input.oauth === "pass"
        ? "OAuth credentials are present and stored as configured SecretRef or interpolation values"
        : input.oauth === "blocked"
          ? "OAuth credentials could not be used"
          : "OAuth credentials were not collected";
    case "bot":
      return input.bot === "in_sync"
        ? "existing bot was preserved"
        : input.bot === "created"
          ? "bot was created after explicit confirmation"
          : input.bot === "blocked"
            ? "bot inspection could not complete"
            : "bot inspection was not run";
    case "handlers":
      return input.handlers === "in_sync"
        ? "existing handlers were preserved"
        : input.handlers === "created"
          ? "handlers were created after explicit confirmation"
          : input.handlers === "conflict"
            ? "existing handlers differ and were left unchanged without confirmation"
            : input.handlers === "blocked"
              ? "handler inspection could not complete"
              : "handler inspection was not run";
    case "lifecycle":
      return input.lifecycle === "ready"
        ? "the running gateway already has this config"
        : "the generated config will be written after setup returns; restart the gateway to load it";
    case "webhook":
      return input.webhook === "pass"
        ? "public webhook preflight passed"
        : input.webhook === "blocked"
          ? "public webhook is unreachable or unauthenticated"
          : "public webhook was not checked";
    case "admission":
      return input.admission === "isolated"
        ? "DM admission is isolated by allowlist, pairing, or disabled policy"
        : "organization-wide admission was explicitly acknowledged";
    case "delivery":
      return input.delivery === "pass"
        ? "optional first-contact DM was sent"
        : input.delivery === "cancelled"
          ? "optional first-contact DM was cancelled"
          : input.delivery === "failed"
            ? "optional first-contact DM failed"
            : "optional first-contact DM was not requested";
  }
}

function statusFor(id: CliqSetupSectionId, input: CliqSetupReportInput): CliqSetupSectionStatus {
  switch (id) {
    case "config":
      return input.configValid ? "pass" : "blocked";
    case "oauth":
      return input.oauth;
    case "bot":
      return input.bot;
    case "handlers":
      return input.handlers === "created" ? "created" : input.handlers;
    case "lifecycle":
      return input.lifecycle;
    case "webhook":
      return input.webhook;
    case "admission":
      return input.admission;
    case "delivery":
      return input.delivery === "pass"
        ? "pass"
        : input.delivery === "cancelled"
          ? "cancelled"
          : input.delivery === "failed"
            ? "failed"
            : "not_run";
  }
}

export function buildCliqSetupReport(input: CliqSetupReportInput): CliqSetupReport {
  const nextAction = nextActionFor(input);
  const notes = (input.notes ?? []).map(redact);
  return {
    schemaVersion: CLIQ_SETUP_REPORT_SCHEMA_VERSION,
    command: "cliq setup",
    accountId: input.accountId ?? "default",
    outcome: outcomeFor(input, nextAction),
    nextAction,
    compatibility: input.compatibility ?? {
      installedVersion: null,
      supportedVersions: [],
      status: "unknown",
    },
    requiredEnvironment: [...(input.requiredEnvironment ?? [])],
    sections: SECTION_ORDER.map((id) => ({
      id,
      status: statusFor(id, input),
      detail: detailFor(id, input),
    })),
    notes,
  };
}

export function formatCliqSetupReport(report: CliqSetupReport): string[] {
  const lines = [`Cliq setup (${report.accountId}): ${report.outcome}`];
  lines.push(
    report.compatibility.installedVersion
      ? `OpenClaw ${report.compatibility.installedVersion}: ${report.compatibility.status}`
      : "Installed OpenClaw version: unknown",
  );
  for (const section of report.sections) {
    lines.push(`[${section.status}] ${section.id}: ${section.detail}`);
  }
  for (const note of report.notes) lines.push(`Note: ${note}`);
  if (report.requiredEnvironment.length > 0) {
    lines.push(`Provide these environment variables to the gateway service: ${report.requiredEnvironment.join(", ")}.`);
  }
  if (report.nextAction) lines.push(`Next: ${report.nextAction}`);
  return lines;
}

export function redactCliqSetupText(text: string): string {
  return redact(text);
}
