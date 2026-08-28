import { describe, it, expect, vi } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import {
  runCliqDoctorCommand,
  type CliqDoctorCommandDeps,
} from "./doctor-command.js";
import {
  CLIQ_DOCTOR_EXIT,
  CLIQ_DOCTOR_SCHEMA_VERSION,
  type CliqDoctorOptions,
  type CliqDoctorReport,
} from "./doctor-runner.js";

const cfg = {} as OpenClawConfig;

function report(overrides: Partial<CliqDoctorReport> = {}): CliqDoctorReport {
  return {
    schemaVersion: CLIQ_DOCTOR_SCHEMA_VERSION,
    command: "cliq doctor",
    mode: "read_only",
    accountId: "default",
    startedAt: "2026-08-27T10:00:00.000Z",
    completedAt: "2026-08-27T10:00:01.000Z",
    outcome: "healthy",
    exitCode: CLIQ_DOCTOR_EXIT.healthy,
    readOnly: true,
    stages: [
      {
        id: "config",
        label: "Config schema and secret resolution",
        status: "pass",
        evidence: ["ok"],
        remediation: [],
      },
    ],
    ...overrides,
  };
}

function deps(overrides: Partial<CliqDoctorCommandDeps> = {}): CliqDoctorCommandDeps {
  return {
    runDoctor: async () => report(),
    writeLine: () => {},
    ...overrides,
  };
}

describe("cliq doctor command (issue #97)", () => {
  it("returns the report exit code", async () => {
    const code = await runCliqDoctorCommand(
      { cfg },
      deps({ runDoctor: async () => report({ outcome: "failed", exitCode: CLIQ_DOCTOR_EXIT.failed }) }),
    );
    expect(code).toBe(CLIQ_DOCTOR_EXIT.failed);
  });

  it("emits the stable JSON report with --json", async () => {
    const lines: string[] = [];
    const code = await runCliqDoctorCommand(
      { cfg, json: true },
      deps({ writeLine: (line) => lines.push(line) }),
    );
    expect(code).toBe(CLIQ_DOCTOR_EXIT.healthy);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({
      schemaVersion: CLIQ_DOCTOR_SCHEMA_VERSION,
      command: "cliq doctor",
      mode: "read_only",
    });
  });

  it("emits the human-readable report by default", async () => {
    const lines: string[] = [];
    await runCliqDoctorCommand({ cfg }, deps({ writeLine: (line) => lines.push(line) }));
    expect(lines.join("\n")).toContain("Cliq doctor (read_only, account default)");
  });

  it("forwards mode, target, confirmation, and timeout options", async () => {
    const received: CliqDoctorOptions[] = [];
    await runCliqDoctorCommand(
      {
        cfg,
        accountId: "team",
        roundtrip: true,
        target: "general",
        kind: "group",
        confirm: true,
        timeout: "45",
      },
      deps({
        runDoctor: async (_cfg, options) => {
          received.push(options);
          return report();
        },
      }),
    );
    expect(received[0]).toMatchObject({
      accountId: "team",
      roundtrip: true,
      target: "general",
      targetKind: "group",
      confirmed: true,
      timeoutMs: 45_000,
    });
  });

  it("rejects an unknown --kind as an invalid invocation", async () => {
    const received: CliqDoctorOptions[] = [];
    const code = await runCliqDoctorCommand(
      { cfg, outboundTest: true, target: "user-1", kind: "channel", confirm: true },
      deps({
        runDoctor: async (_cfg, options) => {
          received.push(options);
          return report({ outcome: "invalid", exitCode: CLIQ_DOCTOR_EXIT.invalid, invocationError: options.invocationError });
        },
      }),
    );
    expect(received[0]?.invocationError).toContain("--kind must be dm or group");
    expect(code).toBe(CLIQ_DOCTOR_EXIT.invalid);
  });

  it("passes an unparsable timeout through so the runner rejects it", async () => {
    const received: CliqDoctorOptions[] = [];
    await runCliqDoctorCommand(
      { cfg, roundtrip: true, target: "user-1", kind: "dm", confirm: true, timeout: "abc" },
      deps({
        runDoctor: async (_cfg, options) => {
          received.push(options);
          return report();
        },
      }),
    );
    expect(Number.isNaN(received[0]?.timeoutMs)).toBe(true);
  });

  it("passes injected doctor dependencies through", async () => {
    const runDoctor = vi.fn(async () => report());
    await runCliqDoctorCommand({ cfg }, deps({ runDoctor }), { pollIntervalMs: 5 });
    expect(runDoctor).toHaveBeenCalledWith(cfg, expect.any(Object), { pollIntervalMs: 5 });
  });

  it("forwards --adopt-handler-url as an explicit repair request (issue #172)", async () => {
    const received: CliqDoctorOptions[] = [];
    await runCliqDoctorCommand(
      { cfg, adoptHandlerUrl: true },
      deps({
        runDoctor: async (_cfg, options) => {
          received.push(options);
          return report({ readOnly: false });
        },
      }),
    );
    expect(received[0]?.adoptHandlerUrl).toBe(true);
  });
});
