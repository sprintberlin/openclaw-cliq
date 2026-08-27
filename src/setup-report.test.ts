import { describe, it, expect } from "vitest";
import {
  buildCliqSetupReport,
  formatCliqSetupReport,
  type CliqSetupReportInput,
} from "./setup-report.js";

const BASE: CliqSetupReportInput = {
  accountId: "default",
  configValid: true,
  oauth: "pass",
  bot: "in_sync",
  handlers: "in_sync",
  lifecycle: "restart_required",
  webhook: "pass",
  admission: "isolated",
  delivery: "not_requested",
  notes: [],
};

describe("guided setup final report (issue #92)", () => {
  it("covers every required subsystem in a stable machine-readable schema", () => {
    const report = buildCliqSetupReport(BASE);
    expect(report.schemaVersion).toBe(1);
    expect(report.sections.map((s) => s.id)).toEqual([
      "config", "oauth", "bot", "handlers", "lifecycle", "webhook", "admission", "delivery",
    ]);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    expect(report.outcome).toBe("action_required");
    expect(report.nextAction).toMatch(/restart/i);
    expect(report.requiredEnvironment).toEqual([]);
    expect(report.compatibility.status).toBe("unknown");
  });

  it("blocks an unsupported installed OpenClaw version with an actionable result", () => {
    const report = buildCliqSetupReport({
      ...BASE,
      lifecycle: "ready",
      compatibility: {
        installedVersion: "2025.1.0",
        supportedVersions: ["2026.7.1-2"],
        status: "unsupported",
      },
    });
    expect(report.outcome).toBe("blocked");
    expect(report.nextAction).toMatch(/supported OpenClaw version/i);
    expect(formatCliqSetupReport(report).join("\n")).toContain(
      "OpenClaw 2025.1.0: unsupported",
    );
  });

  it("reports a fresh completed setup as ready", () => {
    const report = buildCliqSetupReport({ ...BASE, lifecycle: "ready", delivery: "pass" });
    expect(report.outcome).toBe("ready");
    expect(report.nextAction).toBeNull();
  });

  it("makes a partial setup resumable with the first concrete next action", () => {
    const report = buildCliqSetupReport({
      ...BASE,
      oauth: "blocked",
      bot: "not_run",
      handlers: "not_run",
      webhook: "not_run",
      notes: ["Zoho rejected the OAuth credentials."],
    });
    expect(report.outcome).toBe("blocked");
    expect(report.nextAction).toMatch(/OAuth/i);
    expect(report.sections.find((s) => s.id === "bot")?.status).toBe("not_run");
  });

  it("preserves an in-sync rerun and does not request destructive replacement", () => {
    const report = buildCliqSetupReport({ ...BASE, lifecycle: "ready" });
    expect(report.sections.find((s) => s.id === "bot")?.status).toBe("in_sync");
    expect(report.sections.find((s) => s.id === "handlers")?.status).toBe("in_sync");
    expect(formatCliqSetupReport(report).join(" ")).not.toMatch(/replace|overwrite/i);
  });

  it("reports an unavailable public endpoint without losing completed work", () => {
    const report = buildCliqSetupReport({ ...BASE, webhook: "blocked", lifecycle: "ready" });
    expect(report.outcome).toBe("blocked");
    expect(report.nextAction).toMatch(/public HTTPS webhook/i);
    expect(report.sections.find((s) => s.id === "config")?.status).toBe("pass");
  });

  it("treats a cancelled optional message test as skipped, not failed", () => {
    const report = buildCliqSetupReport({ ...BASE, lifecycle: "ready", delivery: "cancelled" });
    expect(report.outcome).toBe("ready");
    expect(report.sections.find((s) => s.id === "delivery")?.status).toBe("cancelled");
  });

  it("never includes credential values in human or JSON output", () => {
    const secret = "live-secret-never-print";
    const report = buildCliqSetupReport({ ...BASE, notes: [`clientSecret=${secret}`] });
    const printed = JSON.stringify(report) + formatCliqSetupReport(report).join("\n");
    expect(printed).not.toContain(secret);
    expect(printed).toContain("<redacted>");
  });
});
