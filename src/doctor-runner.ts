import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { CLIQ_CAPABILITIES, probeCliqCapability, type CliqCapability, type CliqCapabilityProbeResult } from "./capabilities.js";
import {
  normalizeCliqRouteTarget,
  readEffectiveCliqSection,
  resolveCliqConfig,
  type CliqChatMessageRef,
  type CliqClient,
  type CliqDirectoryEntry,
  type ResolvedCliqAccount,
} from "./client.js";
import { collectCliqPreviewWarnings } from "./doctor.js";
import { probeCliqStatus } from "./status.js";
import { resolveCliqClient } from "./runtime-api.js";
import { runCliqWebhookPreflight, type CliqPreflightReport } from "./webhook-preflight.js";

export const CLIQ_DOCTOR_SCHEMA_VERSION = 1 as const;
export const CLIQ_DOCTOR_EXIT = {
  healthy: 0,
  degraded: 1,
  failed: 2,
  invalid: 3,
} as const;

export type CliqDoctorStageStatus = "pass" | "warn" | "fail" | "skipped";
export type CliqDoctorOutcome = "healthy" | "degraded" | "failed" | "invalid";
export type CliqDoctorMode = "read_only" | "outbound_test" | "roundtrip";
export type CliqDoctorTargetKind = "dm" | "group";

export type CliqDoctorStageId =
  | "config"
  | "runtime"
  | "oauth"
  | "capabilities"
  | "bot_handlers"
  | "public_webhook"
  | "discovery"
  | "outbound_test"
  | "roundtrip";

export interface CliqDoctorStage {
  id: CliqDoctorStageId;
  label: string;
  status: CliqDoctorStageStatus;
  evidence: string[];
  remediation: string[];
  boundary?: string;
}

export interface CliqDoctorCorrelation {
  nonce: string;
  targetKind: CliqDoctorTargetKind;
  requestObserved: boolean;
  replyObserved: boolean;
}

export interface CliqDoctorReport {
  schemaVersion: typeof CLIQ_DOCTOR_SCHEMA_VERSION;
  command: "cliq doctor";
  mode: CliqDoctorMode;
  accountId: string;
  startedAt: string;
  completedAt: string;
  outcome: CliqDoctorOutcome;
  exitCode: number;
  readOnly: boolean;
  invocationError?: string;
  correlation?: CliqDoctorCorrelation;
  stages: CliqDoctorStage[];
}

export interface CliqDoctorOptions {
  accountId?: string;
  outboundTest?: boolean;
  roundtrip?: boolean;
  target?: string;
  targetKind?: CliqDoctorTargetKind;
  confirmed?: boolean;
  timeoutMs?: number;
  json?: boolean;
  invocationError?: string;
}

export interface CliqDoctorBotInspectionResult {
  status: Exclude<CliqDoctorStageStatus, "skipped">;
  evidence: string[];
  remediation?: string[];
}

export interface CliqDoctorClient {
  getAccessToken(scope?: string): Promise<string>;
  getRefreshedAccessToken(): Promise<string>;
  getApiBase(): string;
  listUsers(maxItems?: number): Promise<CliqDirectoryEntry[]>;
  listChannels(maxItems?: number): Promise<CliqDirectoryEntry[]>;
  sendMessage(options: { to: string; text: string; isDm?: boolean }): Promise<{ messageId?: string; chatId?: string }>;
  resolveChannelChatId(channelUniqueName: string): Promise<string | undefined>;
  listChatMessages(chatId: string, options?: { limit?: number }): Promise<CliqChatMessageRef[]>;
}

export interface CliqDoctorDeps {
  getClient: (account: ResolvedCliqAccount) => CliqDoctorClient;
  probeStatus: (account: ResolvedCliqAccount) => Promise<{ ok: boolean; reason: string }>;
  probeCapability: (
    capability: CliqCapability,
    apiBase: string,
    token: string,
  ) => Promise<CliqCapabilityProbeResult>;
  runPreflight: (options: { url: string; secret: string | undefined }) => Promise<CliqPreflightReport>;
  inspectBot?: (options: {
    account: ResolvedCliqAccount;
    publicWebhookUrl: string | undefined;
  }) => Promise<CliqDoctorBotInspectionResult>;
  randomUUID: () => string;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => Date;
  nowMs: () => number;
  pollIntervalMs: number;
}

const STAGE_LABELS: Record<CliqDoctorStageId, string> = {
  config: "Config schema and secret resolution",
  runtime: "Runtime lifecycle, status, and route registration",
  oauth: "OAuth grants",
  capabilities: "Required API capability probes",
  bot_handlers: "Bot state, visibility, and handlers",
  public_webhook: "Public webhook preflight",
  discovery: "Directory, user, and channel discovery",
  outbound_test: "Consented outbound test",
  roundtrip: "Nonce-correlated inbound, agent, and reply roundtrip",
};

const STAGE_ORDER = Object.keys(STAGE_LABELS) as CliqDoctorStageId[];

const defaultDeps: CliqDoctorDeps = {
  getClient: (account) => resolveCliqClient(account) as CliqClient,
  probeStatus: async (account) => probeCliqStatus(account),
  probeCapability: (capability, apiBase, token) =>
    probeCliqCapability(capability, apiBase, token),
  runPreflight: ({ url, secret }) => runCliqWebhookPreflight({ url, secret }),
  randomUUID,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now: () => new Date(),
  nowMs: () => Date.now(),
  pollIntervalMs: 2_000,
};

function stage(
  id: CliqDoctorStageId,
  status: CliqDoctorStageStatus,
  evidence: string[],
  remediation: string[] = [],
  boundary?: string,
): CliqDoctorStage {
  return {
    id,
    label: STAGE_LABELS[id],
    status,
    evidence,
    remediation,
    ...(boundary ? { boundary } : {}),
  };
}

function skipped(id: CliqDoctorStageId, reason: string): CliqDoctorStage {
  return stage(id, "skipped", [reason]);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readPublicWebhookUrl(cfg: OpenClawConfig, accountId?: string): string | undefined {
  const effective = readEffectiveCliqSection(cfg, accountId ?? null).section as
    | (Record<string, unknown> & { publicWebhookUrl?: unknown })
    | undefined;
  return readString(effective?.publicWebhookUrl);
}

function isMultiUserDmConfig(cfg: OpenClawConfig, accountId?: string): boolean {
  const section = readEffectiveCliqSection(cfg, accountId ?? null).section;
  if (!section) return false;
  const policy = section.dmPolicy ?? "allowlist";
  const allowFrom = section.allowFrom ?? [];
  return policy === "open" || policy === "pairing" || allowFrom.includes("*") || allowFrom.length > 1;
}

function readDmScope(cfg: OpenClawConfig): string {
  const raw = (cfg as unknown as { session?: { dmScope?: unknown } }).session?.dmScope;
  return readString(raw) ?? "main";
}

function collectOperationalWarnings(cfg: OpenClawConfig, accountId?: string): string[] {
  const warnings: string[] = [];
  const effective = readEffectiveCliqSection(cfg, accountId ?? null).section;
  if (isMultiUserDmConfig(cfg, accountId) && readDmScope(cfg) === "main") {
    warnings.push(
      "session.dmScope resolves to main while multiple Cliq DM senders can be admitted; conversations can share context and the latest delivery route",
    );
  }
  if (effective?.ackPolicy === "immediate") {
    warnings.push(
      "ackPolicy is immediate: a crash after acknowledgement loses the message, and on OpenClaw 2026.8.1-beta.3 every post-ack turn can fail with GatewayDrainingError",
    );
  }
  return warnings;
}

function sensitiveValues(account: ResolvedCliqAccount | null): string[] {
  if (!account) return [];
  return [account.clientSecret, account.webhookSecret, account.refreshToken]
    .filter((value): value is string => Boolean(value && value.length >= 4));
}

export function redactCliqDoctorText(text: string, values: readonly string[] = []): string {
  let redacted = text;
  for (const value of values) redacted = redacted.split(value).join("<redacted>");
  redacted = redacted
    .replace(/(access_token|refresh_token|client_secret|authorization_code|auth_code)(\s*[=:]\s*)["']?[^\s,"'}]+/gi, "$1$2<redacted>")
    .replace(/(webhook[_-]?secret|webhookSecret|handler secret|secret)(\s*(?:[=:]|\bis\b)\s*)["']?[^\s,"'}]+/gi, "$1$2<redacted>")
    .replace(/(Zoho-oauthtoken|Bearer)\s+[^\s,"'}]+/gi, "$1 <redacted>")
    .replace(/(x-cliq-webhook-secret\s*[=:]\s*)[^\s,"'}]+/gi, "$1<redacted>");
  return redacted;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("roundtrip correlation request timed out")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function safeError(err: unknown, values: readonly string[]): string {
  const message = redactCliqDoctorText(err instanceof Error ? err.message : String(err), values);
  const status = message.match(/\((\d{3})\)/)?.[1];
  const code = message.match(/\b(invalid_client|invalid_code|invalid_grant|invalid_scope|oauthtoken_scope_invalid|GatewayDrainingError|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT)\b/i)?.[1];
  if (status && code) return `request failed with HTTP ${status} (${code})`;
  if (status) return `request failed with HTTP ${status}`;
  if (code) return `request failed (${code})`;
  if (/timeout|timed out|aborted/i.test(message)) return "request timed out";
  if (/network|fetch failed|socket|connect/i.test(message)) return "network request failed";
  return "request failed; sensitive response details were omitted";
}

function validateOptions(options: CliqDoctorOptions): string | null {
  if (options.invocationError) return options.invocationError;
  if (options.outboundTest && options.roundtrip) {
    return "choose either --outbound-test or --roundtrip, not both";
  }
  const destructive = Boolean(options.outboundTest || options.roundtrip);
  if (destructive && !options.target) return "--target is required for an outbound test or roundtrip";
  if (destructive && !options.targetKind) return "--kind dm|group is required for an outbound test or roundtrip";
  if (destructive && !options.confirmed) return "--confirm is required before sending a diagnostic message";
  if (!destructive && (options.target || options.targetKind || options.confirmed)) {
    return "--target, --kind, and --confirm require --outbound-test or --roundtrip";
  }
  if (options.timeoutMs !== undefined && !options.roundtrip) {
    return "--timeout is only valid with --roundtrip";
  }
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1_000 || options.timeoutMs > 600_000)) {
    return "--timeout must be between 1 and 600 seconds";
  }
  return null;
}

function modeOf(options: CliqDoctorOptions): CliqDoctorMode {
  return options.roundtrip ? "roundtrip" : options.outboundTest ? "outbound_test" : "read_only";
}

function outcomeOf(stages: readonly CliqDoctorStage[]): Exclude<CliqDoctorOutcome, "invalid"> {
  if (stages.some((item) => item.status === "fail")) return "failed";
  if (
    stages.some((item) => item.status === "warn") ||
    stages.some((item) => item.id === "bot_handlers" && item.status === "skipped")
  ) {
    return "degraded";
  }
  return "healthy";
}

function exitCodeOf(outcome: CliqDoctorOutcome): number {
  return CLIQ_DOCTOR_EXIT[outcome];
}

function invalidReport(
  options: CliqDoctorOptions,
  reason: string,
  now: Date,
): CliqDoctorReport {
  return {
    schemaVersion: CLIQ_DOCTOR_SCHEMA_VERSION,
    command: "cliq doctor",
    mode: modeOf(options),
    accountId: options.accountId ?? "default",
    startedAt: now.toISOString(),
    completedAt: now.toISOString(),
    outcome: "invalid",
    exitCode: CLIQ_DOCTOR_EXIT.invalid,
    readOnly: true,
    invocationError: reason,
    stages: STAGE_ORDER.map((id) => skipped(id, "not run: invalid invocation")),
  };
}

function scopedStaticWarnings(cfg: OpenClawConfig, accountId?: string): string[] {
  if (!accountId || accountId === "default") {
    return collectCliqPreviewWarnings({ cfg, doctorFixCommand: "openclaw doctor --fix" });
  }
  const effective = readEffectiveCliqSection(cfg, accountId).section;
  if (!effective) return [];
  const scopedCfg = {
    ...(cfg as unknown as Record<string, unknown>),
    channels: { cliq: effective },
  } as unknown as OpenClawConfig;
  return collectCliqPreviewWarnings({
    cfg: scopedCfg,
    doctorFixCommand: "openclaw doctor --fix",
  });
}

function buildConfigStage(
  cfg: OpenClawConfig,
  accountId: string | undefined,
): { result: CliqDoctorStage; account: ResolvedCliqAccount | null } {
  const effective = readEffectiveCliqSection(cfg, accountId ?? null).section;
  if (!effective) {
    return {
      result: stage(
        "config",
        "fail",
        ["channels.cliq is absent"],
        ["Run `openclaw setup` and configure the Zoho Cliq channel."],
        "config",
      ),
      account: null,
    };
  }
  let account: ResolvedCliqAccount;
  try {
    account = resolveCliqConfig(cfg, accountId ?? null);
  } catch (err) {
    return {
      result: stage(
        "config",
        "fail",
        [safeError(err, [])],
        ["Resolve clientId, clientSecret, and botId, including any referenced secret provider, then rerun the doctor."],
        "secret_resolution",
      ),
      account: null,
    };
  }
  const warnings = [
    ...scopedStaticWarnings(cfg, accountId),
    ...collectOperationalWarnings(cfg, accountId),
  ].map((warning) => warning.replace(/^- channels\.cliq:\s*/, ""));
  const evidence = [
    "the channel section resolved through the plugin's own config resolver (manifest schema validation happens at gateway load)",
    "clientSecret resolved without exposing its value",
    account.webhookSecret
      ? "webhookSecret resolved without exposing its value"
      : "webhookSecret is unavailable",
    account.refreshToken
      ? "refreshToken resolved without exposing its value"
      : "refreshToken is not configured",
    `session.dmScope=${readDmScope(cfg)}`,
    ...warnings,
  ];
  return {
    result: stage(
      "config",
      warnings.length > 0 ? "warn" : "pass",
      evidence,
      warnings.length > 0
        ? [
            "Review each warning before production use; use session.dmScope=per-channel-peer for multi-user DMs and ackPolicy=after_dispatch on affected OpenClaw versions.",
          ]
        : [],
    ),
    account,
  };
}

async function buildRuntimeStage(
  account: ResolvedCliqAccount | null,
  deps: CliqDoctorDeps,
  values: readonly string[],
): Promise<CliqDoctorStage> {
  if (!account) return skipped("runtime", "not run: config and secret resolution failed");
  try {
    const status = await deps.probeStatus(account);
    if (!status.ok) {
      return stage(
        "runtime",
        "fail",
        [safeError(status.reason, values), "passive webhook lifecycle expects POST /cliq/webhook"],
        ["Verify the gateway is running with the Cliq plugin enabled, then inspect `openclaw status` and gateway logs."],
        "runtime_status",
      );
    }
    return stage(
      "runtime",
      "pass",
      [
        "channel status OAuth probe passed",
        "the plugin defines a passive webhook lifecycle for /cliq/webhook",
        "this stage cannot inspect the running gateway's route table; the public-webhook stage verifies live route registration",
      ],
    );
  } catch (err) {
    return stage(
      "runtime",
      "fail",
      [safeError(err, values)],
      ["Verify the gateway lifecycle and account status, then rerun the doctor."],
      "runtime_status",
    );
  }
}

async function buildOAuthStage(
  account: ResolvedCliqAccount | null,
  client: CliqDoctorClient | null,
  values: readonly string[],
): Promise<CliqDoctorStage> {
  if (!account || !client) return skipped("oauth", "not run: config and secret resolution failed");
  const evidence: string[] = [];
  try {
    await client.getAccessToken("ZohoCliq.Webhooks.CREATE");
    evidence.push("client_credentials grant passed for ZohoCliq.Webhooks.CREATE");
  } catch (err) {
    return stage(
      "oauth",
      "fail",
      [safeError(err, values)],
      ["Verify clientId, clientSecret, oauthBase, Zoho data center, and the Webhooks.CREATE consent."],
      "oauth_client_credentials",
    );
  }
  if (!account.refreshToken) {
    evidence.push("refresh_token grant skipped because no refreshToken is configured");
    return stage(
      "oauth",
      "warn",
      evidence,
      ["Configure a user-context refreshToken from README §3c for channel posts, edits, and optional rich features."],
      "oauth_refresh_token",
    );
  }
  try {
    await client.getRefreshedAccessToken();
    evidence.push("refresh_token grant passed");
    return stage("oauth", "pass", evidence);
  } catch (err) {
    evidence.push(safeError(err, values));
    return stage(
      "oauth",
      "fail",
      evidence,
      ["Regenerate the user-context refresh token with the combined capability profile and verify the OAuth data center."],
      "oauth_refresh_token",
    );
  }
}

async function buildCapabilitiesStage(
  account: ResolvedCliqAccount | null,
  client: CliqDoctorClient | null,
  deps: CliqDoctorDeps,
  values: readonly string[],
  sendExercised: boolean,
): Promise<CliqDoctorStage> {
  if (!account || !client) return skipped("capabilities", "not run: config and secret resolution failed");
  const probeable = CLIQ_CAPABILITIES.filter((capability) => capability.probePath);
  const unprobeable = CLIQ_CAPABILITIES.filter((capability) => !capability.probePath);
  const evidence: string[] = [];
  const remediation: string[] = [];
  let failed = false;
  let warned = false;
  for (const capability of probeable) {
    try {
      const token = capability.grantType === "refresh_token"
        ? await client.getRefreshedAccessToken()
        : await client.getAccessToken(capability.scope);
      const result = await deps.probeCapability(capability, client.getApiBase(), token);
      if (result.status === "ok") {
        evidence.push(`${capability.id}=pass (${capability.scope})`);
      } else if (result.status === "missing_scope") {
        evidence.push(`${capability.id}=fail (missing scope)`);
        remediation.push(capability.missingHint);
        if (capability.optional) warned = true;
        else failed = true;
      } else {
        evidence.push(`${capability.id}=warn (${safeError(result.error ?? "probe error", values)})`);
        remediation.push(`Retry the read-only ${capability.label} probe after checking API reachability and quota.`);
        warned = true;
      }
    } catch (err) {
      evidence.push(`${capability.id}=fail (${safeError(err, values)})`);
      remediation.push(capability.missingHint);
      if (capability.optional) warned = true;
      else failed = true;
    }
  }
  const unprobeableRequired = unprobeable.filter((capability) => !capability.optional);
  const unprobeableOptional = unprobeable.filter((capability) => capability.optional);
  if (unprobeableRequired.length > 0) {
    evidence.push(
      sendExercised
        ? `${unprobeableRequired.length} required capabilities have no read-only probe; their scopes are exercised by the requested send stage instead: ${unprobeableRequired.map((capability) => capability.id).join(", ")}`
        : `${unprobeableRequired.length} REQUIRED capabilities have no safe read-only API probe and remain unverified here (their scopes are only exercised by a real send): ${unprobeableRequired.map((capability) => capability.id).join(", ")}`,
    );
    if (!sendExercised) {
      remediation.push(
        "Use --outbound-test (and --roundtrip) to exercise the send scopes that have no read-only probe.",
      );
    }
  }
  if (unprobeableOptional.length > 0) {
    evidence.push(
      `${unprobeableOptional.length} optional capabilities have no safe read-only API probe and were not exercised: ${unprobeableOptional.map((capability) => capability.id).join(", ")}`,
    );
  }
  return stage(
    "capabilities",
    failed ? "fail" : warned || (unprobeableRequired.length > 0 && !sendExercised) ? "warn" : "pass",
    evidence,
    remediation,
    failed ? "api_capability" : undefined,
  );
}

async function buildBotStage(
  account: ResolvedCliqAccount | null,
  publicWebhookUrl: string | undefined,
  deps: CliqDoctorDeps,
  values: readonly string[],
): Promise<CliqDoctorStage> {
  if (!account) return skipped("bot_handlers", "not run: config and secret resolution failed");
  if (!deps.inspectBot) {
    return skipped(
      "bot_handlers",
      "bot/handler inspection subsystem is unavailable; bot existence, active state, visibility, handler URL, JSON transport, and Zoho-held webhook-secret equality were not guessed",
    );
  }
  try {
    const result = await deps.inspectBot({ account, publicWebhookUrl });
    return stage(
      "bot_handlers",
      result.status,
      result.evidence.map((item) => redactCliqDoctorText(item, values)),
      result.remediation?.map((item) => redactCliqDoctorText(item, values)) ?? [],
      result.status === "fail" ? "zoho_bot_or_handler" : undefined,
    );
  } catch (err) {
    return stage(
      "bot_handlers",
      "fail",
      [safeError(err, values)],
      ["Verify Bots.READ access, inspect Message/Mention handlers read-only, and compare their URL and secret with the loaded config."],
      "zoho_bot_or_handler",
    );
  }
}

async function buildPublicWebhookStage(
  account: ResolvedCliqAccount | null,
  publicWebhookUrl: string | undefined,
  deps: CliqDoctorDeps,
  values: readonly string[],
): Promise<CliqDoctorStage> {
  if (!account) return skipped("public_webhook", "not run: config and secret resolution failed");
  if (!publicWebhookUrl) {
    return stage(
      "public_webhook",
      "warn",
      ["publicWebhookUrl is not configured; no DNS, TLS, route, or secret-enforcement request was sent"],
      ["Set channels.cliq.publicWebhookUrl to the public HTTPS /cliq/webhook URL and rerun the doctor."],
      "public_url",
    );
  }
  try {
    const report = await deps.runPreflight({ url: publicWebhookUrl, secret: account.webhookSecret });
    const evidence = report.stages.map(
      (item) => `${item.id}=${item.status}: ${redactCliqDoctorText(item.detail, values)}`,
    );
    const failedStage = report.stages.find((item) => item.status === "fail");
    const warnedStage = report.stages.find((item) => item.status === "warn");
    return stage(
      "public_webhook",
      report.ok ? "pass" : failedStage ? "fail" : "warn",
      evidence,
      report.ok
        ? []
        : ["Apply the remediation named by the first failed preflight boundary, then rerun `openclaw cliq doctor`."],
      failedStage?.id ?? warnedStage?.id,
    );
  } catch (err) {
    return stage(
      "public_webhook",
      "fail",
      [safeError(err, values)],
      ["Verify public DNS, TLS, reverse-proxy forwarding, /cliq/webhook registration, and shared-secret enforcement."],
      "public_transport",
    );
  }
}

async function buildDiscoveryStage(
  account: ResolvedCliqAccount | null,
  client: CliqDoctorClient | null,
  values: readonly string[],
): Promise<CliqDoctorStage> {
  if (!account || !client) return skipped("discovery", "not run: config and secret resolution failed");
  const evidence: string[] = [];
  const remediation: string[] = [];
  let failed = false;
  try {
    const users = await client.listUsers(1);
    evidence.push(`user directory read passed; returned ${users.length} entry in the one-item diagnostic page`);
  } catch (err) {
    failed = true;
    evidence.push(`user directory read failed: ${safeError(err, values)}`);
    remediation.push("Grant ZohoCliq.Users.READ and verify the /api/v2/users endpoint.");
  }
  try {
    const channels = await client.listChannels(1);
    evidence.push(`channel directory read passed; returned ${channels.length} entry in the one-item diagnostic page`);
  } catch (err) {
    failed = true;
    evidence.push(`channel directory read failed: ${safeError(err, values)}`);
    remediation.push("Grant ZohoCliq.Channels.READ and verify the /api/v2/channels endpoint.");
  }
  return stage(
    "discovery",
    failed ? "fail" : "pass",
    evidence,
    remediation,
    failed ? "directory_discovery" : undefined,
  );
}

function priorFailure(stages: readonly CliqDoctorStage[]): CliqDoctorStage | undefined {
  return stages.find((item) => item.status === "fail");
}

function roundtripPolicyEvidence(cfg: OpenClawConfig, target: string): string {
  const cliq = (cfg as unknown as { channels?: { cliq?: Record<string, unknown> } }).channels?.cliq;
  const groups = cliq?.groups;
  const groupConfig = groups && typeof groups === "object"
    ? (groups as Record<string, unknown>)[target] ?? (groups as Record<string, unknown>)["*"]
    : undefined;
  return groupConfig
    ? "configured group admission/tool policy remains active for the roundtrip agent turn"
    : "no target-specific group tool policy was found; the normal agent policy remains active";
}

async function buildOutboundStage(
  cfg: OpenClawConfig,
  options: CliqDoctorOptions,
  account: ResolvedCliqAccount | null,
  client: CliqDoctorClient | null,
  deps: CliqDoctorDeps,
  previousStages: readonly CliqDoctorStage[],
  values: readonly string[],
): Promise<{
  result: CliqDoctorStage;
  nonce?: string;
  chatId?: string;
  kickoffMessageId?: string;
  requestMarker?: string;
  replyMarker?: string;
}> {
  if (!options.outboundTest && !options.roundtrip) {
    return { result: skipped("outbound_test", "not requested; default doctor mode performs no sends") };
  }
  if (!account || !client || !options.target || !options.targetKind) {
    return {
      result: stage(
        "outbound_test",
        "fail",
        ["required account or target information is unavailable"],
        ["Fix the earlier diagnostic boundary and rerun with an explicit target and confirmation."],
        "outbound_precondition",
      ),
    };
  }
  const failed = priorFailure(previousStages);
  if (failed) {
    return {
      result: stage(
        "outbound_test",
        "fail",
        [`send was not attempted because ${failed.id} failed`],
        ["Fix the earlier failed stage before sending a diagnostic message."],
        "outbound_precondition",
      ),
    };
  }
  const publicStage = previousStages.find((item) => item.id === "public_webhook");
  if (options.roundtrip && publicStage?.status !== "pass") {
    return {
      result: stage(
        "outbound_test",
        "fail",
        ["roundtrip challenge was not sent because the public webhook preflight did not pass"],
        ["Configure and pass the public webhook stage before requesting a roundtrip."],
        "outbound_precondition",
      ),
    };
  }
  const normalized = normalizeCliqRouteTarget(
    `${options.targetKind === "dm" ? "cliq:dm:" : "cliq:channel:"}${options.target}`,
  );
  if (!normalized) {
    return {
      result: stage(
        "outbound_test",
        "fail",
        ["the selected target could not be normalized"],
        ["Choose a directory-resolved user id for DM or channel unique name for group."],
        "target_selection",
      ),
    };
  }
  const nonce = deps.randomUUID();
  const requestMarker = `OPENCLAW_CLIQ_ROUNDTRIP_REQUEST ${nonce}`;
  const replyMarker = `OPENCLAW_CLIQ_ROUNDTRIP_REPLY ${nonce}`;
  const challengeLine = `${requestMarker} — reply with exactly this line and nothing else: ${replyMarker}`;
  const text = options.roundtrip
    ? `[OpenClaw Cliq doctor roundtrip ${nonce}]\n${options.targetKind === "group" ? "Mention the bot and send exactly" : "Send exactly"}:\n${challengeLine}`
    : `[OpenClaw Cliq doctor outbound test ${nonce}] No reply is required.`;
  try {
    const sent = await client.sendMessage({
      to: normalized.to,
      text,
      isDm: normalized.isDm,
    });
    const chatId = sent.chatId ?? (normalized.isDm
      ? undefined
      : await client.resolveChannelChatId(normalized.to));
    const evidence = [
      `clearly labeled diagnostic message sent to the confirmed ${options.targetKind} target`,
      sent.messageId ? "Zoho returned a redacted message identifier" : "Zoho accepted the send without a message identifier",
    ];
    if (options.roundtrip) evidence.push(roundtripPolicyEvidence(cfg, normalized.to));
    return {
      result: stage("outbound_test", "pass", evidence),
      nonce,
      chatId,
      kickoffMessageId: sent.messageId,
      requestMarker,
      replyMarker,
    };
  } catch (err) {
    return {
      result: stage(
        "outbound_test",
        "fail",
        [safeError(err, values)],
        ["Verify the selected target, required send scope, bot visibility/membership, and OAuth grant."],
        "cliq_outbound",
      ),
    };
  }
}

async function buildRoundtripStage(
  options: CliqDoctorOptions,
  client: CliqDoctorClient | null,
  deps: CliqDoctorDeps,
  outbound: Awaited<ReturnType<typeof buildOutboundStage>>,
  values: readonly string[],
): Promise<{ result: CliqDoctorStage; correlation?: CliqDoctorCorrelation }> {
  if (!options.roundtrip) {
    return { result: skipped("roundtrip", "not requested; use --roundtrip with explicit target selection and --confirm") };
  }
  if (
    outbound.result.status !== "pass" ||
    !client ||
    !outbound.nonce ||
    !outbound.requestMarker ||
    !outbound.replyMarker
  ) {
    return {
      result: skipped("roundtrip", "not run: the consented roundtrip challenge was not sent"),
    };
  }
  if (!outbound.chatId) {
    return {
      result: stage(
        "roundtrip",
        "fail",
        [
          "the challenge was sent, but no chat id could be resolved for read-only correlation",
          options.targetKind === "dm"
            ? "the DM send response carried no chat id, which the v2/v3 bot-message endpoints only return via message_details"
            : "the channel unique name did not resolve to a chat id",
        ],
        options.targetKind === "dm"
          ? [
              "Rerun the roundtrip as a group target, or verify the DM send path returns message_details (apiVersion dmPost v3) so the chat id is available.",
            ]
          : [
              "Grant ZohoCliq.Channels.READ and verify the channel unique name resolves to a chat id.",
            ],
        "roundtrip_correlation",
      ),
      correlation: {
        nonce: outbound.nonce,
        targetKind: options.targetKind!,
        requestObserved: false,
        replyObserved: false,
      },
    };
  }
  const roundtripEvidence = [
    "the nonce request was observed in Cliq, so the Zoho handler delivered it to the inbound webhook",
    "a later message whose entire body is the nonce reply was observed in Cliq, so the agent turn, configured policy, and outbound reply all completed",
    "chat text is the only correlation signal available to a read-only diagnostic; inspect gateway logs for the same nonce to attribute an individual hop",
  ];
  const timeoutMs = options.timeoutMs ?? 120_000;
  const deadline = deps.nowMs() + timeoutMs;
  let requestObserved = false;
  let pollTimedOut = false;
  while (true) {
    const budget = deadline - deps.nowMs();
    if (budget <= 0) break;
    try {
      const messages = await withTimeout(
        client.listChatMessages(outbound.chatId, { limit: 100 }),
        budget,
      );
      const relevant = messages.filter((message) => message.messageId !== outbound.kickoffMessageId);
      requestObserved ||= relevant.some((message) => message.text?.includes(outbound.requestMarker!));
      const replyObserved = relevant.some((message) => {
        const text = message.text?.trim();
        return text === outbound.replyMarker;
      });
      if (replyObserved) {
        return {
          result: stage(
            "roundtrip",
            "pass",
            roundtripEvidence,
          ),
          correlation: {
            nonce: outbound.nonce,
            targetKind: options.targetKind!,
            requestObserved: true,
            replyObserved: true,
          },
        };
      }
    } catch (err) {
      if (err instanceof Error && err.message === "roundtrip correlation request timed out") {
        pollTimedOut = true;
        break;
      }
      return {
        result: stage(
          "roundtrip",
          "fail",
          [safeError(err, values)],
          ["Verify ZohoCliq.Messages.READ and the resolved chat id, then rerun the roundtrip."],
          "roundtrip_correlation",
        ),
        correlation: {
          nonce: outbound.nonce,
          targetKind: options.targetKind!,
          requestObserved,
          replyObserved: false,
        },
      };
    }
    const remaining = deadline - deps.nowMs();
    if (remaining <= 0) break;
    await deps.sleep(Math.min(deps.pollIntervalMs, remaining));
  }
  const timeoutEvidence = pollTimedOut
    ? ["the final correlation read did not return before the roundtrip deadline"]
    : [];
  return {
    result: stage(
      "roundtrip",
      "fail",
      requestObserved
        ? [
            "the nonce-bearing inbound request appeared in Cliq, but the exact agent reply did not appear before timeout",
            ...timeoutEvidence,
          ]
        : [
            "the nonce-bearing user request did not appear in Cliq before timeout",
            ...timeoutEvidence,
          ],
      requestObserved
        ? ["Inspect gateway agent-turn, CRM/tool-policy, and outbound Cliq logs for the nonce; the failure is after user delivery."]
        : ["Confirm the user sent the exact request through the real bot DM or group @mention and inspect the Zoho handler execution log."],
      requestObserved ? "agent_policy_or_outbound_reply" : "zoho_handler_or_inbound_webhook",
    ),
    correlation: {
      nonce: outbound.nonce,
      targetKind: options.targetKind!,
      requestObserved,
      replyObserved: false,
    },
  };
}

export async function runCliqDoctor(
  cfg: OpenClawConfig,
  options: CliqDoctorOptions = {},
  dependencyOverrides: Partial<CliqDoctorDeps> = {},
): Promise<CliqDoctorReport> {
  const deps: CliqDoctorDeps = { ...defaultDeps, ...dependencyOverrides };
  const startedAt = deps.now();
  const invocationError = validateOptions(options);
  if (invocationError) return invalidReport(options, invocationError, startedAt);
  const accountId = options.accountId ?? "default";
  const stages: CliqDoctorStage[] = [];
  const config = buildConfigStage(cfg, options.accountId);
  stages.push(config.result);
  const values = sensitiveValues(config.account);
  const client = config.account ? deps.getClient(config.account) : null;
  stages.push(await buildRuntimeStage(config.account, deps, values));
  stages.push(await buildOAuthStage(config.account, client, values));
  stages.push(await buildCapabilitiesStage(
    config.account,
    client,
    deps,
    values,
    Boolean(options.outboundTest || options.roundtrip),
  ));
  const publicWebhookUrl = readPublicWebhookUrl(cfg, options.accountId);
  stages.push(await buildBotStage(config.account, publicWebhookUrl, deps, values));
  stages.push(await buildPublicWebhookStage(config.account, publicWebhookUrl, deps, values));
  stages.push(await buildDiscoveryStage(config.account, client, values));
  const outbound = await buildOutboundStage(
    cfg,
    options,
    config.account,
    client,
    deps,
    stages,
    values,
  );
  stages.push(outbound.result);
  const roundtrip = await buildRoundtripStage(options, client, deps, outbound, values);
  stages.push(roundtrip.result);
  const outcome = outcomeOf(stages);
  return {
    schemaVersion: CLIQ_DOCTOR_SCHEMA_VERSION,
    command: "cliq doctor",
    mode: modeOf(options),
    accountId,
    startedAt: startedAt.toISOString(),
    completedAt: deps.now().toISOString(),
    outcome,
    exitCode: exitCodeOf(outcome),
    readOnly: modeOf(options) === "read_only",
    ...(roundtrip.correlation ? { correlation: roundtrip.correlation } : {}),
    stages,
  };
}

export function formatCliqDoctorReport(report: CliqDoctorReport): string[] {
  const icon: Record<CliqDoctorStageStatus, string> = {
    pass: "PASS",
    warn: "WARN",
    fail: "FAIL",
    skipped: "SKIP",
  };
  const lines = [
    `Cliq doctor (${report.mode}, account ${report.accountId})`,
  ];
  if (report.invocationError) lines.push(`Invalid invocation: ${report.invocationError}`);
  for (const item of report.stages) {
    lines.push(`[${icon[item.status]}] ${item.label}`);
    for (const evidence of item.evidence) lines.push(`  ${evidence}`);
    if (item.boundary) lines.push(`  Boundary: ${item.boundary}`);
    for (const remediation of item.remediation) lines.push(`  Remediation: ${remediation}`);
  }
  lines.push(`Result: ${report.outcome} (exit ${report.exitCode})`);
  return lines;
}
