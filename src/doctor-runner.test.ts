import { describe, it, expect, vi } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { CLIQ_CAPABILITIES } from "./capabilities.js";
import {
  CLIQ_DOCTOR_EXIT,
  CLIQ_DOCTOR_SCHEMA_VERSION,
  formatCliqDoctorReport,
  redactCliqDoctorText,
  runCliqDoctor,
  type CliqDoctorClient,
  type CliqDoctorDeps,
  type CliqDoctorOptions,
  type CliqDoctorReport,
  type CliqDoctorStageId,
} from "./doctor-runner.js";
import type { CliqPreflightReport } from "./webhook-preflight.js";

const WEBHOOK_URL = "https://cliq.example.com/cliq/webhook";
const CLIENT_SECRET = "client-secret-value";
const WEBHOOK_SECRET = "webhook-secret-value";
const REFRESH_TOKEN = "refresh-token-value";

function cfgWith(section: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): OpenClawConfig {
  return {
    session: { dmScope: "per-channel-peer" },
    ...extra,
    channels: {
      cliq: {
        clientId: "client-id",
        clientSecret: CLIENT_SECRET,
        botId: "openclaw-bot",
        botName: "OpenClaw",
        webhookSecret: WEBHOOK_SECRET,
        refreshToken: REFRESH_TOKEN,
        publicWebhookUrl: WEBHOOK_URL,
        dmPolicy: "allowlist",
        allowFrom: ["user-1"],
        thinking: { mode: "off" },
        ...section,
      },
    },
  } as unknown as OpenClawConfig;
}

function passingPreflight(): CliqPreflightReport {
  return {
    ok: true,
    url: WEBHOOK_URL,
    nonce: "preflight-nonce",
    dispatched: false,
    stages: [
      { id: "url", label: "URL syntax and HTTPS", status: "pass", detail: "https and /cliq/webhook" },
      { id: "reachability", label: "Public DNS, TLS, and transport", status: "pass", detail: "healthy" },
      { id: "method", label: "Route reachability", status: "pass", detail: "405 on GET" },
      { id: "secret", label: "Webhook secret enforcement", status: "pass", detail: "401 without a secret" },
      { id: "probe", label: "Authenticated non-dispatching probe", status: "pass", detail: "nonce echoed" },
    ],
  };
}

function createClient(overrides: Partial<CliqDoctorClient> = {}): CliqDoctorClient {
  return {
    getAccessToken: vi.fn(async () => "cc-token"),
    getRefreshedAccessToken: vi.fn(async () => "rt-token"),
    getApiBase: () => "https://cliq.zoho.eu",
    listUsers: vi.fn(async () => [{ kind: "user" as const, id: "user-1" }]),
    listChannels: vi.fn(async () => [{ kind: "group" as const, id: "chan-1", handle: "general" }]),
    sendMessage: vi.fn(async () => ({ messageId: "m-1", chatId: "CT_1" })),
    resolveChannelChatId: vi.fn(async () => "CT_group"),
    listChatMessages: vi.fn(async () => []),
    ...overrides,
  };
}

function createDeps(overrides: Partial<CliqDoctorDeps> = {}): Partial<CliqDoctorDeps> {
  const client = overrides.getClient ? undefined : createClient();
  let nowMs = 0;
  return {
    getClient: () => client!,
    probeStatus: vi.fn(async () => ({ ok: true, reason: "ok" })),
    probeCapability: vi.fn(async (capability) => ({
      capabilityId: capability.id,
      scope: capability.scope,
      status: "ok" as const,
      httpStatus: 200,
    })),
    runPreflight: vi.fn(async () => passingPreflight()),
    randomUUID: () => "nonce-1234",
    sleep: async (milliseconds) => {
      nowMs += milliseconds;
    },
    now: () => new Date("2026-08-27T10:00:00.000Z"),
    nowMs: () => nowMs,
    pollIntervalMs: 1,
    ...overrides,
  };
}

function stageOf(report: CliqDoctorReport, id: CliqDoctorStageId) {
  const found = report.stages.find((item) => item.id === id);
  if (!found) throw new Error(`stage ${id} missing`);
  return found;
}

async function runDefault(
  cfg: OpenClawConfig = cfgWith(),
  deps: Partial<CliqDoctorDeps> = createDeps(),
  options: CliqDoctorOptions = {},
): Promise<CliqDoctorReport> {
  return runCliqDoctor(cfg, options, deps);
}

const ALL_STAGES: CliqDoctorStageId[] = [
  "config",
  "runtime",
  "oauth",
  "capabilities",
  "bot_handlers",
  "public_webhook",
  "discovery",
  "outbound_test",
  "roundtrip",
];

describe("cliq doctor — report contract (issue #97)", () => {
  it("produces one structured stage-by-stage report covering every diagnostic stage", async () => {
    const report = await runDefault();
    expect(report.stages.map((item) => item.id)).toEqual(ALL_STAGES);
    for (const item of report.stages) {
      expect(["pass", "warn", "fail", "skipped"]).toContain(item.status);
      expect(item.evidence.length).toBeGreaterThan(0);
      expect(item.label.length).toBeGreaterThan(0);
    }
  });

  it("emits the documented optional keys with their documented shapes", async () => {
    const invalid = await runDefault(cfgWith(), createDeps(), { outboundTest: true });
    expect(typeof invalid.invocationError).toBe("string");
    expect(invalid).not.toHaveProperty("correlation");

    const client = createClient({ listChatMessages: vi.fn(async () => []) });
    const roundtrip = await runDefault(cfgWith(), createDeps({ getClient: () => client }), {
      roundtrip: true,
      target: "user-1",
      targetKind: "dm",
      confirmed: true,
      timeoutMs: 1_000,
    });
    const parsed = JSON.parse(JSON.stringify(roundtrip)) as CliqDoctorReport;
    expect(Object.keys(parsed.correlation!).sort()).toEqual(
      ["nonce", "replyObserved", "requestObserved", "targetKind"].sort(),
    );
    expect(typeof parsed.correlation!.nonce).toBe("string");
    expect(parsed.correlation!.targetKind).toBe("dm");
    expect(typeof parsed.correlation!.requestObserved).toBe("boolean");
    expect(typeof parsed.correlation!.replyObserved).toBe("boolean");
    expect(typeof stageOf(parsed, "roundtrip").boundary).toBe("string");
    expect(parsed).not.toHaveProperty("invocationError");
  });

  it("emits a stable JSON shape for machine consumers", async () => {
    const report = await runDefault();
    const parsed = JSON.parse(JSON.stringify(report)) as CliqDoctorReport;
    expect(parsed.schemaVersion).toBe(CLIQ_DOCTOR_SCHEMA_VERSION);
    expect(parsed.command).toBe("cliq doctor");
    expect(parsed.mode).toBe("read_only");
    expect(parsed.readOnly).toBe(true);
    expect(parsed.accountId).toBe("default");
    expect(parsed.startedAt).toBe("2026-08-27T10:00:00.000Z");
    expect(parsed.completedAt).toBe("2026-08-27T10:00:00.000Z");
    expect(Object.keys(parsed).sort()).toEqual(
      [
        "accountId",
        "command",
        "completedAt",
        "exitCode",
        "mode",
        "outcome",
        "readOnly",
        "schemaVersion",
        "stages",
        "startedAt",
      ].sort(),
    );
    for (const item of parsed.stages) {
      expect(Object.keys(item).sort()).toEqual(
        expect.arrayContaining(["evidence", "id", "label", "remediation", "status"]),
      );
    }
  });

  it("renders a human-readable staged report by default", () => {
    const lines = formatCliqDoctorReport({
      schemaVersion: CLIQ_DOCTOR_SCHEMA_VERSION,
      command: "cliq doctor",
      mode: "read_only",
      accountId: "default",
      startedAt: "t",
      completedAt: "t",
      outcome: "degraded",
      exitCode: 1,
      readOnly: true,
      stages: [
        {
          id: "config",
          label: "Config schema and secret resolution",
          status: "warn",
          evidence: ["something"],
          remediation: ["fix it"],
          boundary: "config",
        },
      ],
    });
    const text = lines.join("\n");
    expect(text).toContain("Cliq doctor (read_only, account default)");
    expect(text).toContain("[WARN] Config schema and secret resolution");
    expect(text).toContain("Boundary: config");
    expect(text).toContain("Remediation: fix it");
    expect(text).toContain("Result: degraded (exit 1)");
  });
});

describe("cliq doctor — exit codes", () => {
  it("returns healthy with exit 0 when every available stage passes and the send stages exercise the unprobeable scopes", async () => {
    const report = await runDefault(
      cfgWith(),
      createDeps({
        inspectBot: vi.fn(async () => ({ status: "pass" as const, evidence: ["bot and handlers verified"] })),
      }),
      { outboundTest: true, target: "user-1", targetKind: "dm", confirmed: true },
    );
    expect(report.outcome).toBe("healthy");
    expect(report.exitCode).toBe(CLIQ_DOCTOR_EXIT.healthy);
  });

  it("returns degraded in default read-only mode because the send scopes stay unverified", async () => {
    const report = await runDefault(
      cfgWith(),
      createDeps({
        inspectBot: vi.fn(async () => ({ status: "pass" as const, evidence: ["bot and handlers verified"] })),
      }),
    );
    expect(report.outcome).toBe("degraded");
    expect(stageOf(report, "capabilities").status).toBe("warn");
  });

  it("returns degraded while bot/handler inspection is unavailable", async () => {
    const report = await runDefault();
    expect(report.outcome).toBe("degraded");
    expect(report.exitCode).toBe(CLIQ_DOCTOR_EXIT.degraded);
  });

  it("returns degraded with exit 1 when a stage warns", async () => {
    const report = await runDefault(cfgWith({ refreshToken: undefined }));
    expect(report.outcome).toBe("degraded");
    expect(report.exitCode).toBe(CLIQ_DOCTOR_EXIT.degraded);
  });

  it("returns failed with exit 2 when a stage fails", async () => {
    const report = await runDefault(
      cfgWith(),
      createDeps({ probeStatus: vi.fn(async () => ({ ok: false, reason: "probe timeout after 8000ms" })) }),
    );
    expect(report.outcome).toBe("failed");
    expect(report.exitCode).toBe(CLIQ_DOCTOR_EXIT.failed);
  });

  it("returns invalid with exit 3 for an unusable invocation and runs nothing", async () => {
    const probeStatus = vi.fn(async () => ({ ok: true, reason: "ok" }));
    const report = await runDefault(cfgWith(), createDeps({ probeStatus }), {
      outboundTest: true,
      target: "user-1",
      targetKind: "dm",
    });
    expect(report.outcome).toBe("invalid");
    expect(report.exitCode).toBe(CLIQ_DOCTOR_EXIT.invalid);
    expect(report.invocationError).toContain("--confirm");
    expect(report.stages.every((item) => item.status === "skipped")).toBe(true);
    expect(probeStatus).not.toHaveBeenCalled();
  });

  it("rejects combining --outbound-test with --roundtrip", async () => {
    const report = await runDefault(cfgWith(), createDeps(), {
      outboundTest: true,
      roundtrip: true,
      target: "user-1",
      targetKind: "dm",
      confirmed: true,
    });
    expect(report.invocationError).toContain("not both");
    expect(report.exitCode).toBe(CLIQ_DOCTOR_EXIT.invalid);
  });

  it("rejects a target or confirmation without a send mode", async () => {
    const report = await runDefault(cfgWith(), createDeps(), { target: "user-1" });
    expect(report.invocationError).toContain("--outbound-test");
    expect(report.exitCode).toBe(CLIQ_DOCTOR_EXIT.invalid);
  });

  it("rejects an out-of-range roundtrip timeout", async () => {
    const report = await runDefault(cfgWith(), createDeps(), {
      roundtrip: true,
      target: "user-1",
      targetKind: "dm",
      confirmed: true,
      timeoutMs: 900_000,
    });
    expect(report.invocationError).toContain("--timeout");
    expect(report.exitCode).toBe(CLIQ_DOCTOR_EXIT.invalid);
  });
});

describe("cliq doctor — default mode is read-only", () => {
  it("performs no sends, handler updates, config writes, or restarts", async () => {
    const client = createClient();
    const report = await runDefault(cfgWith(), createDeps({ getClient: () => client }));
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(client.listChatMessages).not.toHaveBeenCalled();
    expect(report.readOnly).toBe(true);
    expect(stageOf(report, "outbound_test").status).toBe("skipped");
    expect(stageOf(report, "roundtrip").status).toBe("skipped");
  });

  it("only reads the directory with a minimal read-only page", async () => {
    const client = createClient();
    await runDefault(cfgWith(), createDeps({ getClient: () => client }));
    expect(client.listUsers).toHaveBeenCalledWith(1);
    expect(client.listChannels).toHaveBeenCalledWith(1);
  });
});

describe("cliq doctor — stage 1 config and secret resolution", () => {
  it("fails when the channel section is absent and skips dependent stages", async () => {
    const report = await runDefault({ channels: {} } as unknown as OpenClawConfig, createDeps());
    expect(stageOf(report, "config").status).toBe("fail");
    expect(stageOf(report, "runtime").status).toBe("skipped");
    expect(stageOf(report, "oauth").status).toBe("skipped");
    expect(stageOf(report, "capabilities").status).toBe("skipped");
    expect(stageOf(report, "bot_handlers").status).toBe("skipped");
    expect(stageOf(report, "public_webhook").status).toBe("skipped");
    expect(stageOf(report, "discovery").status).toBe("skipped");
  });

  it("fails when a required secret cannot be resolved", async () => {
    const report = await runDefault(cfgWith({ clientSecret: undefined }), createDeps());
    const config = stageOf(report, "config");
    expect(config.status).toBe("fail");
    expect(config.boundary).toBe("secret_resolution");
    expect(config.remediation.join(" ")).toMatch(/secret provider/i);
  });

  it("warns about a shared main DM session on a multi-user bot (issue #104)", async () => {
    const report = await runDefault(
      cfgWith({ dmPolicy: "open", allowFrom: ["*"] }, { session: { dmScope: "main" } }),
      createDeps(),
    );
    const config = stageOf(report, "config");
    expect(config.status).toBe("warn");
    expect(config.evidence.join(" ")).toMatch(/session\.dmScope resolves to main/);
  });

  it("does not warn about dmScope for a single-sender allowlist bot", async () => {
    const report = await runDefault(
      cfgWith({ dmPolicy: "allowlist", allowFrom: ["only-user"] }, { session: { dmScope: "main" } }),
      createDeps(),
    );
    expect(stageOf(report, "config").evidence.join(" ")).not.toMatch(/session\.dmScope resolves to main/);
  });

  it("warns that ackPolicy immediate risks lost messages and the beta draining failure (issue #122)", async () => {
    const report = await runDefault(cfgWith({ ackPolicy: "immediate" }), createDeps());
    const evidence = stageOf(report, "config").evidence.join(" ");
    expect(evidence).toMatch(/GatewayDrainingError/);
    expect(evidence).toMatch(/runDetachedWebhookWork/);
  });

  it("scopes config warnings to the selected account rather than the top-level section", async () => {
    const cfg = {
      channels: {
        cliq: {
          accounts: {
            team: {
              clientId: "client",
              clientSecret: CLIENT_SECRET,
              botId: "bot",
              botName: "OpenClaw",
              webhookSecret: WEBHOOK_SECRET,
              refreshToken: REFRESH_TOKEN,
              publicWebhookUrl: WEBHOOK_URL,
              dmPolicy: "allowlist",
              allowFrom: ["only-user"],
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
    const report = await runCliqDoctor(cfg, { accountId: "team" }, createDeps());
    const config = stageOf(report, "config");
    expect(report.accountId).toBe("team");
    expect(config.evidence.join(" ")).not.toMatch(/clientId/);
    expect(config.status).toBe("pass");
  });

  it("reuses the existing static doctor warnings rather than reimplementing them", async () => {
    const report = await runDefault(cfgWith({ dmPolicy: "allowlist", allowFrom: [] }), createDeps());
    expect(stageOf(report, "config").evidence.join(" ")).toMatch(/allowFrom is empty/);
  });
});

describe("cliq doctor — stage 2 runtime", () => {
  it("fails and names the runtime boundary when the status probe fails", async () => {
    const report = await runDefault(
      cfgWith(),
      createDeps({ probeStatus: vi.fn(async () => ({ ok: false, reason: "probe timeout after 8000ms" })) }),
    );
    const runtime = stageOf(report, "runtime");
    expect(runtime.status).toBe("fail");
    expect(runtime.boundary).toBe("runtime_status");
    expect(runtime.evidence[0]).toBe("request timed out");
  });

  it("fails when the status probe throws", async () => {
    const report = await runDefault(
      cfgWith(),
      createDeps({ probeStatus: vi.fn(async () => { throw new Error("boom"); }) }),
    );
    expect(stageOf(report, "runtime").status).toBe("fail");
  });

  it("reports the registered webhook route on success", async () => {
    const report = await runDefault();
    expect(stageOf(report, "runtime").evidence.join(" ")).toContain("/cliq/webhook");
  });
});

describe("cliq doctor — stage 3 OAuth grants", () => {
  it("fails when the client_credentials grant fails", async () => {
    const client = createClient({
      getAccessToken: vi.fn(async () => {
        throw new Error(`cliq: OAuth token request failed (401): {"error":"invalid_client","client_secret":"${CLIENT_SECRET}"}`);
      }),
    });
    const report = await runDefault(cfgWith(), createDeps({ getClient: () => client }));
    const oauth = stageOf(report, "oauth");
    expect(oauth.status).toBe("fail");
    expect(oauth.boundary).toBe("oauth_client_credentials");
    expect(JSON.stringify(oauth)).not.toContain(CLIENT_SECRET);
  });

  it("warns and skips the refresh grant when no refresh token is configured", async () => {
    const client = createClient();
    const report = await runDefault(cfgWith({ refreshToken: undefined }), createDeps({ getClient: () => client }));
    const oauth = stageOf(report, "oauth");
    expect(oauth.status).toBe("warn");
    expect(oauth.evidence.join(" ")).toMatch(/refresh_token grant skipped/);
    expect(client.getRefreshedAccessToken).not.toHaveBeenCalled();
  });

  it("fails when the configured refresh grant is rejected", async () => {
    const client = createClient({
      getRefreshedAccessToken: vi.fn(async () => {
        throw new Error("cliq: OAuth refresh token request failed (400): invalid_grant");
      }),
    });
    const report = await runDefault(cfgWith(), createDeps({ getClient: () => client }));
    const oauth = stageOf(report, "oauth");
    expect(oauth.status).toBe("fail");
    expect(oauth.boundary).toBe("oauth_refresh_token");
    expect(oauth.evidence.join(" ")).toContain("invalid_grant");
  });

  it("passes when both applicable grants succeed", async () => {
    const report = await runDefault();
    expect(stageOf(report, "oauth").status).toBe("pass");
  });
});

describe("cliq doctor — stage 4 capability probes", () => {
  it("reuses the shared capability matrix probes instead of reimplementing them", async () => {
    const probeCapability = vi.fn(async (capability) => ({
      capabilityId: capability.id,
      scope: capability.scope,
      status: "ok" as const,
    }));
    const report = await runDefault(cfgWith(), createDeps({ probeCapability }));
    expect(probeCapability).toHaveBeenCalled();
    expect(stageOf(report, "capabilities").status).toBe("warn");
  });

  it("fails when a required capability is missing its scope", async () => {
    const probeCapability = vi.fn(async (capability) => ({
      capabilityId: capability.id,
      scope: capability.scope,
      status: "missing_scope" as const,
      error: capability.missingHint,
    }));
    const report = await runDefault(cfgWith(), createDeps({ probeCapability }));
    const capabilities = stageOf(report, "capabilities");
    expect(capabilities.status).toBe("fail");
    expect(capabilities.boundary).toBe("api_capability");
    expect(capabilities.remediation.length).toBeGreaterThan(0);
  });

  it("warns rather than fails when a probe is inconclusive", async () => {
    const probeCapability = vi.fn(async (capability) => ({
      capabilityId: capability.id,
      scope: capability.scope,
      status: "probe_error" as const,
      error: "Probe returned 429: slow down",
    }));
    const report = await runDefault(cfgWith(), createDeps({ probeCapability }));
    expect(stageOf(report, "capabilities").status).toBe("warn");
  });

  it("warns rather than passing while required send scopes have no read-only probe", async () => {
    const report = await runDefault();
    const capabilities = stageOf(report, "capabilities");
    expect(capabilities.status).toBe("warn");
    expect(capabilities.evidence.join(" ")).toMatch(/REQUIRED capabilities have no safe read-only API probe/);
    expect(capabilities.remediation.join(" ")).toMatch(/--outbound-test/);
  });

  it("reports which capabilities have no safe read-only probe", async () => {
    const report = await runDefault();
    expect(stageOf(report, "capabilities").evidence.join(" ")).toMatch(/no safe read-only API probe/);
  });

  it("skips capability probes when config resolution failed", async () => {
    const report = await runDefault(cfgWith({ botId: undefined }), createDeps());
    expect(stageOf(report, "capabilities").status).toBe("skipped");
  });
});

describe("cliq doctor — stage 5 bot and handler inspection", () => {
  it("skips explicitly when no inspection subsystem is wired, without guessing", async () => {
    const report = await runDefault();
    const bot = stageOf(report, "bot_handlers");
    expect(bot.status).toBe("skipped");
    expect(bot.evidence.join(" ")).toMatch(/were not guessed/);
  });

  it("delegates to the bot/handler inspection subsystem when available", async () => {
    const inspectBot = vi.fn(async () => ({
      status: "pass" as const,
      evidence: ["bot is active and organization-visible", "message and mention handlers post JSON to the configured URL"],
    }));
    const report = await runDefault(cfgWith(), createDeps({ inspectBot }));
    expect(inspectBot).toHaveBeenCalledWith(
      expect.objectContaining({ publicWebhookUrl: WEBHOOK_URL }),
    );
    expect(stageOf(report, "bot_handlers").status).toBe("pass");
  });

  it("fails when the Zoho-held handler secret diverges from config (issue #124)", async () => {
    const inspectBot = vi.fn(async () => ({
      status: "fail" as const,
      evidence: ["message_handler holds a webhook secret that differs from channels.cliq.webhookSecret"],
      remediation: ["Update the Deluge handler secret to match the configured webhookSecret."],
    }));
    const report = await runDefault(cfgWith(), createDeps({ inspectBot }));
    const bot = stageOf(report, "bot_handlers");
    expect(bot.status).toBe("fail");
    expect(bot.boundary).toBe("zoho_bot_or_handler");
  });

  it("fails safely when the inspection subsystem throws, with redacted evidence", async () => {
    const inspectBot = vi.fn(async () => {
      throw new Error(`GET /api/v3/bots failed (403): {"webhookSecret":"${WEBHOOK_SECRET}"}`);
    });
    const report = await runDefault(cfgWith(), createDeps({ inspectBot }));
    const bot = stageOf(report, "bot_handlers");
    expect(bot.status).toBe("fail");
    expect(JSON.stringify(bot)).not.toContain(WEBHOOK_SECRET);
  });

  it("redacts secrets returned by the inspection subsystem", async () => {
    const inspectBot = vi.fn(async () => ({
      status: "warn" as const,
      evidence: [`handler secret is ${WEBHOOK_SECRET}`],
    }));
    const report = await runDefault(cfgWith(), createDeps({ inspectBot }));
    expect(JSON.stringify(stageOf(report, "bot_handlers"))).not.toContain(WEBHOOK_SECRET);
  });

  it("uses the shared inspector from the doctor client when inspectBot is not injected", async () => {
    const client = createClient({
      listBots: vi.fn(async () => [{
        id: "b-1",
        unique_name: "openclaw-bot",
        status: "enabled",
        scope: "organization",
      }]),
      getBot: vi.fn(async () => ({
        id: "b-1",
        unique_name: "openclaw-bot",
        status: "enabled",
        scope: "organization",
        subscriber_count: 1,
      })),
      listBotSubscribers: vi.fn(async () => ({
        subscribers: [{ user_id: "user-1" }],
        complete: true,
      })),
      readBotHandlerScript: vi.fn(async () => ({
        script: 'webhookUrl = "https://cliq.example.com/cliq/webhook";\nwebhookSecret = "webhook-secret-value";\n',
      })),
    });
    const report = await runDefault(cfgWith(), createDeps({ getClient: () => client }));
    const bot = stageOf(report, "bot_handlers");
    expect(bot.status).not.toBe("skipped");
    expect(bot.evidence.join(" ")).toMatch(/organization|active/i);
  });
});

describe("cliq doctor — stage 6 public webhook preflight", () => {
  it("reuses the shared preflight with the configured URL and secret", async () => {
    const runPreflight = vi.fn(async () => passingPreflight());
    const report = await runDefault(cfgWith(), createDeps({ runPreflight }));
    expect(runPreflight).toHaveBeenCalledWith({ url: WEBHOOK_URL, secret: WEBHOOK_SECRET });
    expect(stageOf(report, "public_webhook").status).toBe("pass");
  });

  it("warns without sending a request when no public URL is configured", async () => {
    const runPreflight = vi.fn(async () => passingPreflight());
    const report = await runDefault(cfgWith({ publicWebhookUrl: undefined }), createDeps({ runPreflight }));
    const preflight = stageOf(report, "public_webhook");
    expect(preflight.status).toBe("warn");
    expect(preflight.boundary).toBe("public_url");
    expect(runPreflight).not.toHaveBeenCalled();
  });

  it("identifies the failing preflight boundary", async () => {
    const runPreflight = vi.fn(async () => ({
      ...passingPreflight(),
      ok: false,
      stages: [
        { id: "url" as const, label: "URL", status: "pass" as const, detail: "ok" },
        { id: "reachability" as const, label: "DNS", status: "fail" as const, detail: "DNS did not resolve" },
        { id: "method" as const, label: "Route", status: "skipped" as const, detail: "not reached" },
        { id: "secret" as const, label: "Secret", status: "skipped" as const, detail: "not reached" },
        { id: "probe" as const, label: "Probe", status: "skipped" as const, detail: "not reached" },
      ],
    }));
    const report = await runDefault(cfgWith(), createDeps({ runPreflight }));
    const preflight = stageOf(report, "public_webhook");
    expect(preflight.status).toBe("fail");
    expect(preflight.boundary).toBe("reachability");
  });

  it("degrades to warn on an inconclusive preflight", async () => {
    const runPreflight = vi.fn(async () => ({
      ...passingPreflight(),
      ok: false,
      stages: [
        { id: "url" as const, label: "URL", status: "pass" as const, detail: "ok" },
        { id: "secret" as const, label: "Secret", status: "warn" as const, detail: "429 rate limited" },
      ],
    }));
    const report = await runDefault(cfgWith(), createDeps({ runPreflight }));
    expect(stageOf(report, "public_webhook").status).toBe("warn");
  });

  it("fails safely and redacts when the preflight throws", async () => {
    const runPreflight = vi.fn(async () => {
      throw new Error(`preflight crashed with x-cliq-webhook-secret: ${WEBHOOK_SECRET}`);
    });
    const report = await runDefault(cfgWith(), createDeps({ runPreflight }));
    expect(stageOf(report, "public_webhook").status).toBe("fail");
    expect(JSON.stringify(report)).not.toContain(WEBHOOK_SECRET);
  });
});

describe("cliq doctor — stage 7 discovery", () => {
  it("passes when read-only user and channel discovery succeed", async () => {
    const report = await runDefault();
    expect(stageOf(report, "discovery").status).toBe("pass");
  });

  it("warns and names the discovery boundary when a directory read fails", async () => {
    const client = createClient({
      listUsers: vi.fn(async () => {
        throw new Error("cliq: GET /api/v2/users failed (401): oauthtoken_scope_invalid");
      }),
    });
    const report = await runDefault(cfgWith(), createDeps({ getClient: () => client }));
    const discovery = stageOf(report, "discovery");
    expect(discovery.status).toBe("warn");
    expect(discovery.boundary).toBe("directory_discovery");
    expect(discovery.remediation.join(" ")).toContain("ZohoCliq.Users.READ");
    expect(discovery.evidence.join(" ")).toContain("--target");
  });

  it("reports a channel discovery failure separately", async () => {
    const client = createClient({
      listChannels: vi.fn(async () => {
        throw new Error("cliq: GET /api/v2/channels failed (403): forbidden");
      }),
    });
    const report = await runDefault(cfgWith(), createDeps({ getClient: () => client }));
    expect(stageOf(report, "discovery").remediation.join(" ")).toContain("ZohoCliq.Channels.READ");
  });
});

/**
 * Directory discovery is a convenience aid for picking a target, not a
 * precondition for talking to one the operator already named (issue #146). A
 * v2 directory read that Zoho rejects must degrade the stage instead of
 * blocking an explicitly confirmed, consented send.
 */
describe("cliq doctor — a failed directory read does not block an explicit target", () => {
  const HTTP_400 = 'cliq: GET /api/v2/users failed (400): {"code":"extra_param_found"}';

  function brokenDirectoryClient(overrides: Partial<CliqDoctorClient> = {}): CliqDoctorClient {
    return createClient({
      listUsers: vi.fn(async () => {
        throw new Error(HTTP_400);
      }),
      listChannels: vi.fn(async () => {
        throw new Error('cliq: GET /api/v2/channels failed (400): {"code":"extra_param_found"}');
      }),
      ...overrides,
    });
  }

  it("still sends the consented outbound test to the explicit target", async () => {
    const client = brokenDirectoryClient();
    const report = await runDefault(cfgWith(), createDeps({ getClient: () => client }), {
      outboundTest: true,
      target: "user-1",
      targetKind: "dm",
      confirmed: true,
    });
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(stageOf(report, "outbound_test").status).toBe("pass");
    expect(report.outcome).toBe("degraded");
  });

  it("still completes the consented roundtrip against the explicit target", async () => {
    const client = brokenDirectoryClient({
      listChatMessages: vi.fn(async () => [
        { messageId: "m-2", chatId: "CT_1", text: "OPENCLAW_CLIQ_ROUNDTRIP_REQUEST nonce-1234" },
        { messageId: "m-3", chatId: "CT_1", text: "OPENCLAW_CLIQ_ROUNDTRIP_REPLY nonce-1234" },
      ]),
    });
    const report = await runDefault(cfgWith(), createDeps({ getClient: () => client }), {
      roundtrip: true,
      target: "user-1",
      targetKind: "dm",
      confirmed: true,
      timeoutMs: 3_000,
    });
    expect(stageOf(report, "roundtrip").status).toBe("pass");
  });

  it("still blocks the send when a mandatory earlier stage failed", async () => {
    const client = brokenDirectoryClient();
    const report = await runDefault(
      cfgWith(),
      createDeps({
        getClient: () => client,
        probeStatus: vi.fn(async () => ({ ok: false, reason: "unreachable" })),
      }),
      { outboundTest: true, target: "user-1", targetKind: "dm", confirmed: true },
    );
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(stageOf(report, "outbound_test").boundary).toBe("outbound_precondition");
  });

  it("still requires a passing public webhook preflight for a roundtrip", async () => {
    const client = brokenDirectoryClient();
    const report = await runDefault(
      cfgWith({ publicWebhookUrl: undefined }),
      createDeps({ getClient: () => client }),
      { roundtrip: true, target: "user-1", targetKind: "dm", confirmed: true },
    );
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(stageOf(report, "roundtrip").status).toBe("skipped");
  });
});

describe("cliq doctor — stage 8 consented outbound test", () => {
  const sendOptions: CliqDoctorOptions = {
    outboundTest: true,
    target: "user-1",
    targetKind: "dm",
    confirmed: true,
  };

  it("sends exactly one clearly labeled message to the confirmed target", async () => {
    const client = createClient();
    const report = await runDefault(cfgWith(), createDeps({ getClient: () => client }), sendOptions);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    const call = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.to).toBe("user-1");
    expect(call.isDm).toBe(true);
    expect(call.text).toContain("OpenClaw Cliq doctor outbound test");
    expect(report.mode).toBe("outbound_test");
    expect(report.readOnly).toBe(false);
    expect(stageOf(report, "outbound_test").status).toBe("pass");
  });

  it("does not send when an earlier stage failed", async () => {
    const client = createClient();
    const report = await runDefault(
      cfgWith(),
      createDeps({
        getClient: () => client,
        probeStatus: vi.fn(async () => ({ ok: false, reason: "unreachable" })),
      }),
      sendOptions,
    );
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(stageOf(report, "outbound_test").boundary).toBe("outbound_precondition");
  });

  it("fails with a redacted Cliq boundary when the send is rejected", async () => {
    const client = createClient({
      sendMessage: vi.fn(async () => {
        throw new Error(`cliq: send failed (400): {"clientSecret":"${CLIENT_SECRET}"}`);
      }),
    });
    const report = await runDefault(cfgWith(), createDeps({ getClient: () => client }), sendOptions);
    const outbound = stageOf(report, "outbound_test");
    expect(outbound.status).toBe("fail");
    expect(outbound.boundary).toBe("cliq_outbound");
    expect(JSON.stringify(report)).not.toContain(CLIENT_SECRET);
  });

  it("keeps the roundtrip stage skipped for an outbound-only test", async () => {
    const report = await runDefault(cfgWith(), createDeps(), sendOptions);
    expect(stageOf(report, "roundtrip").status).toBe("skipped");
  });
});

describe("cliq doctor — stage 9 nonce-correlated roundtrip", () => {
  const roundtripOptions: CliqDoctorOptions = {
    roundtrip: true,
    target: "user-1",
    targetKind: "dm",
    confirmed: true,
    timeoutMs: 3_000,
  };

  it("passes when the nonce request and the exact nonce reply are both observed", async () => {
    const client = createClient({
      listChatMessages: vi.fn(async () => [
        { messageId: "m-2", chatId: "CT_1", text: "OPENCLAW_CLIQ_ROUNDTRIP_REQUEST nonce-1234" },
        { messageId: "m-3", chatId: "CT_1", text: "OPENCLAW_CLIQ_ROUNDTRIP_REPLY nonce-1234" },
      ]),
    });
    const report = await runDefault(cfgWith(), createDeps({ getClient: () => client }), roundtripOptions);
    const roundtrip = stageOf(report, "roundtrip");
    expect(roundtrip.status).toBe("pass");
    expect(report.correlation).toEqual({
      nonce: "nonce-1234",
      targetKind: "dm",
      requestObserved: true,
      replyObserved: true,
    });
    expect(report.outcome).toBe("degraded");
  });

  it("blames the inbound boundary when the user request never arrives before timeout", async () => {
    const client = createClient({ listChatMessages: vi.fn(async () => []) });
    const report = await runDefault(cfgWith(), createDeps({ getClient: () => client }), roundtripOptions);
    const roundtrip = stageOf(report, "roundtrip");
    expect(roundtrip.status).toBe("fail");
    expect(roundtrip.boundary).toBe("zoho_handler_or_inbound_webhook");
    expect(report.correlation?.requestObserved).toBe(false);
  });

  it("uses the requested timeout as a deadline instead of rounding it down to the poll interval", async () => {
    let nowMs = 0;
    const sleep = vi.fn(async (milliseconds: number) => {
      nowMs += milliseconds;
    });
    const client = createClient({ listChatMessages: vi.fn(async () => []) });
    await runDefault(
      cfgWith(),
      createDeps({
        getClient: () => client,
        nowMs: () => nowMs,
        pollIntervalMs: 2_000,
        sleep,
      }),
      { ...roundtripOptions, timeoutMs: 5_000 },
    );
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(3, 1_000);
    expect(nowMs).toBe(5_000);
  });

  it("puts the reply instruction inside the copied challenge so the agent turn receives it", async () => {
    const client = createClient({
      listChatMessages: vi.fn(async () => [
        { messageId: "m-2", chatId: "CT_1", text: "OPENCLAW_CLIQ_ROUNDTRIP_REQUEST nonce-1234" },
        { messageId: "m-3", chatId: "CT_1", text: "OPENCLAW_CLIQ_ROUNDTRIP_REPLY nonce-1234" },
      ]),
    });
    await runDefault(cfgWith(), createDeps({ getClient: () => client }), roundtripOptions);
    const sentText = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0].text as string;
    const instructionLine = sentText
      .split("\n")
      .find((line) => line.includes("OPENCLAW_CLIQ_ROUNDTRIP_REQUEST nonce-1234"));
    expect(instructionLine).toContain("OPENCLAW_CLIQ_ROUNDTRIP_REPLY nonce-1234");
  });

  it("does not accept the copied challenge itself as the agent reply", async () => {
    const client = createClient({
      listChatMessages: vi.fn(async () => [
        {
          messageId: "m-2",
          chatId: "CT_1",
          text: "OPENCLAW_CLIQ_ROUNDTRIP_REQUEST nonce-1234 — reply with exactly this line and nothing else: OPENCLAW_CLIQ_ROUNDTRIP_REPLY nonce-1234",
        },
      ]),
    });
    const report = await runDefault(cfgWith(), createDeps({ getClient: () => client }), roundtripOptions);
    const roundtrip = stageOf(report, "roundtrip");
    expect(roundtrip.status).toBe("fail");
    expect(roundtrip.boundary).toBe("agent_policy_or_outbound_reply");
  });

  it("stops at the deadline when a correlation read hangs", async () => {
    let nowMs = 0;
    const client = createClient({
      listChatMessages: vi.fn(() => new Promise<never>(() => {})),
    });
    const report = await runDefault(
      cfgWith(),
      createDeps({
        getClient: () => client,
        nowMs: () => nowMs,
        sleep: async (milliseconds: number) => {
          nowMs += milliseconds;
        },
      }),
      { ...roundtripOptions, timeoutMs: 1_000 },
    );
    const roundtrip = stageOf(report, "roundtrip");
    expect(roundtrip.status).toBe("fail");
    expect(roundtrip.evidence.join(" ")).toMatch(/did not return before the roundtrip deadline/);
  });

  it("blames the agent or outbound reply boundary when only the request is seen", async () => {
    const client = createClient({
      listChatMessages: vi.fn(async () => [
        { messageId: "m-2", chatId: "CT_1", text: "OPENCLAW_CLIQ_ROUNDTRIP_REQUEST nonce-1234" },
      ]),
    });
    const report = await runDefault(cfgWith(), createDeps({ getClient: () => client }), roundtripOptions);
    const roundtrip = stageOf(report, "roundtrip");
    expect(roundtrip.status).toBe("fail");
    expect(roundtrip.boundary).toBe("agent_policy_or_outbound_reply");
    expect(report.correlation).toMatchObject({ requestObserved: true, replyObserved: false });
  });

  it("does not accept another run's nonce as correlation", async () => {
    const client = createClient({
      listChatMessages: vi.fn(async () => [
        { messageId: "m-9", chatId: "CT_1", text: "OPENCLAW_CLIQ_ROUNDTRIP_REPLY other-nonce" },
      ]),
    });
    const report = await runDefault(cfgWith(), createDeps({ getClient: () => client }), roundtripOptions);
    expect(stageOf(report, "roundtrip").status).toBe("fail");
  });

  it("fails when correlation reads are rejected", async () => {
    const client = createClient({
      listChatMessages: vi.fn(async () => {
        throw new Error("cliq: GET /api/v2/chats/CT_1/messages failed (401): oauthtoken_scope_invalid");
      }),
    });
    const report = await runDefault(cfgWith(), createDeps({ getClient: () => client }), roundtripOptions);
    const roundtrip = stageOf(report, "roundtrip");
    expect(roundtrip.status).toBe("fail");
    expect(roundtrip.boundary).toBe("roundtrip_correlation");
  });

  it("refuses to send a roundtrip challenge when the public webhook stage did not pass", async () => {
    const client = createClient();
    const report = await runDefault(
      cfgWith({ publicWebhookUrl: undefined }),
      createDeps({ getClient: () => client }),
      roundtripOptions,
    );
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(stageOf(report, "outbound_test").status).toBe("fail");
    expect(stageOf(report, "roundtrip").status).toBe("skipped");
  });

  it("skips correlation when a roundtrip send fails", async () => {
    const client = createClient({
      sendMessage: vi.fn(async () => {
        throw new Error("send failed");
      }),
    });
    const report = await runDefault(cfgWith(), createDeps({ getClient: () => client }), roundtripOptions);
    expect(stageOf(report, "outbound_test").status).toBe("fail");
    expect(stageOf(report, "roundtrip").status).toBe("skipped");
    expect(client.listChatMessages).not.toHaveBeenCalled();
  });

  it("resolves a group chat id for a group-mention roundtrip", async () => {
    const client = createClient({
      sendMessage: vi.fn(async () => ({ messageId: "m-1" })),
      listChatMessages: vi.fn(async () => [
        { messageId: "m-2", chatId: "CT_group", text: "@OpenClaw OPENCLAW_CLIQ_ROUNDTRIP_REQUEST nonce-1234" },
        { messageId: "m-3", chatId: "CT_group", text: "OPENCLAW_CLIQ_ROUNDTRIP_REPLY nonce-1234" },
      ]),
    });
    const report = await runDefault(cfgWith(), createDeps({ getClient: () => client }), {
      ...roundtripOptions,
      target: "general",
      targetKind: "group",
    });
    expect(client.resolveChannelChatId).toHaveBeenCalledWith("general");
    expect(stageOf(report, "roundtrip").status).toBe("pass");
    expect(report.correlation?.targetKind).toBe("group");
  });

  it("fails when no chat id can be resolved for correlation", async () => {
    const client = createClient({
      sendMessage: vi.fn(async () => ({ messageId: "m-1" })),
      resolveChannelChatId: vi.fn(async () => undefined),
    });
    const report = await runDefault(cfgWith(), createDeps({ getClient: () => client }), {
      ...roundtripOptions,
      target: "general",
      targetKind: "group",
    });
    expect(stageOf(report, "roundtrip").boundary).toBe("roundtrip_correlation");
  });

  it("names the DM send response as the reason a DM roundtrip cannot correlate", async () => {
    const client = createClient({ sendMessage: vi.fn(async () => ({ messageId: "m-1" })) });
    const report = await runDefault(cfgWith(), createDeps({ getClient: () => client }), roundtripOptions);
    const roundtrip = stageOf(report, "roundtrip");
    expect(roundtrip.status).toBe("fail");
    expect(roundtrip.evidence.join(" ")).toMatch(/message_details/);
    expect(client.resolveChannelChatId).not.toHaveBeenCalled();
  });

  it("reports whether a configured group tool policy applied to the roundtrip turn", async () => {
    const report = await runDefault(
      cfgWith({ groups: { general: { requireMention: true } } }),
      createDeps(),
      { ...roundtripOptions, target: "general", targetKind: "group" },
    );
    expect(stageOf(report, "outbound_test").evidence.join(" ")).toMatch(/tool policy remains active/);
  });
});

describe("cliq doctor — redaction", () => {
  it("removes secrets, tokens, and auth codes from arbitrary text", () => {
    expect(redactCliqDoctorText("access_token=abc123", [])).toContain("<redacted>");
    expect(redactCliqDoctorText("refresh_token: xyz", [])).toContain("<redacted>");
    expect(redactCliqDoctorText("Authorization: Zoho-oauthtoken tok", [])).toContain("<redacted>");
    expect(redactCliqDoctorText("authorization_code=authcode", [])).toContain("<redacted>");
    expect(redactCliqDoctorText("code=200", [])).toBe("code=200");
    expect(redactCliqDoctorText("handler secret is zoho-held-value", [])).toContain("<redacted>");
    expect(redactCliqDoctorText(`secret is ${WEBHOOK_SECRET}`, [WEBHOOK_SECRET])).not.toContain(WEBHOOK_SECRET);
  });

  it("never emits configured secrets anywhere in a report", async () => {
    const report = await runDefault();
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(CLIENT_SECRET);
    expect(serialized).not.toContain(WEBHOOK_SECRET);
    expect(serialized).not.toContain(REFRESH_TOKEN);
  });

  it("does not echo sensitive Zoho response bodies", async () => {
    const client = createClient({
      getAccessToken: vi.fn(async () => {
        throw new Error('cliq: OAuth token request failed (401): {"access_token":"leaky","details":"secret"}');
      }),
    });
    const report = await runDefault(cfgWith(), createDeps({ getClient: () => client }));
    expect(JSON.stringify(report)).not.toContain("leaky");
    expect(stageOf(report, "oauth").evidence.join(" ")).toBe("request failed with HTTP 401");
  });
});

describe("cliq doctor — capability evidence honesty (issue #93)", () => {
  it("separates consent-reported capabilities from probed ones", async () => {
    const report = await runDefault();
    const evidence = stageOf(report, "capabilities").evidence.join(" ");
    expect(evidence).toMatch(/bot_create/);
    expect(evidence).toMatch(/consent|granted scope set|not proven/i);
  });

  it("never reports a capability as passing without probe evidence", async () => {
    const report = await runDefault();
    const evidence = stageOf(report, "capabilities").evidence.join(" ");
    // Only capabilities with a real read-only probe may be marked pass.
    const passing = evidence.match(/(\w+)=pass/g) ?? [];
    const probeableIds = CLIQ_CAPABILITIES.filter((c) => c.probePath).map((c) => c.id);
    for (const entry of passing) {
      expect(probeableIds).toContain(entry.replace("=pass", ""));
    }
  });

  it("degrades the bot stage instead of inspecting when bot_read is refused", async () => {
    const probeCapability = vi.fn(async (capability) => ({
      capabilityId: capability.id,
      scope: capability.scope,
      status: capability.id === "bot_read" ? ("missing_scope" as const) : ("ok" as const),
      error: capability.id === "bot_read" ? capability.missingHint : undefined,
    }));
    const report = await runDefault(cfgWith(), createDeps({ probeCapability }));
    const capabilities = stageOf(report, "capabilities");
    expect(capabilities.evidence.join(" ")).toContain("bot_read=fail");
    expect(capabilities.remediation.join(" ")).toContain("ZohoCliq.Bots.READ");
  });
});
