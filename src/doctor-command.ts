import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import {
  formatCliqDoctorReport,
  runCliqDoctor,
  type CliqDoctorDeps,
  type CliqDoctorOptions,
} from "./doctor-runner.js";

export interface CliqDoctorCommandOptions {
  cfg: OpenClawConfig;
  accountId?: string;
  outboundTest?: boolean;
  roundtrip?: boolean;
  target?: string;
  kind?: string;
  confirm?: boolean;
  timeout?: string;
  json?: boolean;
  adoptHandlerUrl?: boolean;
}

export interface CliqDoctorCommandDeps {
  runDoctor: (
    cfg: OpenClawConfig,
    options: CliqDoctorOptions,
    deps?: Partial<CliqDoctorDeps>,
  ) => ReturnType<typeof runCliqDoctor>;
  writeLine: (line: string) => void;
}

const defaultDeps: CliqDoctorCommandDeps = {
  runDoctor: (cfg, options, deps) => runCliqDoctor(cfg, options, deps),
  writeLine: (line) => console.log(line),
};

function parseTargetKind(kind: string | undefined): "dm" | "group" | undefined {
  if (kind === undefined) return undefined;
  return kind === "dm" || kind === "group" ? kind : undefined;
}

function parseTimeout(timeout: string | undefined): number | undefined {
  if (timeout === undefined) return undefined;
  const seconds = Number(timeout);
  return Number.isFinite(seconds) ? seconds * 1_000 : Number.NaN;
}

export async function runCliqDoctorCommand(
  options: CliqDoctorCommandOptions,
  commandDeps: CliqDoctorCommandDeps = defaultDeps,
  doctorDeps: Partial<CliqDoctorDeps> = {},
): Promise<number> {
  const targetKind = parseTargetKind(options.kind);
  const invalidKind = options.kind !== undefined && !targetKind;
  const report = await commandDeps.runDoctor(
    options.cfg,
    {
      accountId: options.accountId,
      outboundTest: options.outboundTest,
      roundtrip: options.roundtrip,
      target: options.target,
      targetKind,
      confirmed: options.confirm,
      timeoutMs: parseTimeout(options.timeout),
      json: options.json,
      adoptHandlerUrl: options.adoptHandlerUrl,
      invocationError: invalidKind ? "--kind must be dm or group" : undefined,
    },
    doctorDeps,
  );
  commandDeps.writeLine(
    options.json
      ? JSON.stringify(report, null, 2)
      : formatCliqDoctorReport(report).join("\n"),
  );
  return report.exitCode;
}
