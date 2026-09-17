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
  target?: string;
  kind?: string;
  confirm?: boolean;
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
      target: options.target,
      targetKind,
      confirmed: options.confirm,
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
