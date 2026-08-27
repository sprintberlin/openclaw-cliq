import { describe, it, expect } from "vitest";
import {
  runCliqWebhookPreflightCommand,
  type CliqWebhookPreflightCommandDeps,
} from "./webhook-preflight-command.js";

function deps(overrides: Partial<CliqWebhookPreflightCommandDeps> = {}): CliqWebhookPreflightCommandDeps {
  return {
    runPreflight: async ({ url }) => ({
      ok: true,
      url,
      nonce: "n",
      dispatched: false,
      stages: [
        { id: "url", label: "URL", status: "pass", detail: "ok" },
      ],
    }),
    persistVerification: async () => ({ written: false, reason: "test stub" }),
    writeLine: () => {},
    ...overrides,
  };
}

describe("cliq webhook-preflight command (issue #96)", () => {
  it("runs the reusable preflight and returns exit code 0 on success", async () => {
    const calls: unknown[] = [];
    const code = await runCliqWebhookPreflightCommand(
      { url: "https://x.example/cliq/webhook", secret: "s" },
      deps({
        runPreflight: async (options) => {
          calls.push(options);
          return {
            ok: true,
            url: options.url,
            nonce: "n",
            dispatched: false,
            stages: [],
          };
        },
      }),
    );
    expect(code).toBe(0);
    expect(calls).toEqual([
      { url: "https://x.example/cliq/webhook", secret: "s" },
    ]);
  });

  it("returns exit code 1 when inbound is not ready", async () => {
    const code = await runCliqWebhookPreflightCommand(
      { url: "https://x.example/cliq/webhook", secret: "s" },
      deps({
        runPreflight: async ({ url }) => ({
          ok: false,
          url,
          nonce: "n",
          dispatched: false,
          stages: [
            { id: "method", label: "Route", status: "fail", detail: "404" },
          ],
        }),
      }),
    );
    expect(code).toBe(1);
  });

  it("emits stable JSON when --json is selected", async () => {
    const lines: string[] = [];
    const code = await runCliqWebhookPreflightCommand(
      { url: "https://x.example/cliq/webhook", secret: "s", json: true },
      deps({ writeLine: (line) => lines.push(line) }),
    );
    expect(code).toBe(0);
    expect(JSON.parse(lines.join("\n"))).toEqual(
      expect.objectContaining({ ok: true, dispatched: false }),
    );
  });

  it("emits the human-readable staged report by default", async () => {
    const lines: string[] = [];
    await runCliqWebhookPreflightCommand(
      { url: "https://x.example/cliq/webhook", secret: "s" },
      deps({ writeLine: (line) => lines.push(line) }),
    );
    expect(lines.join("\n")).toContain("Cliq webhook preflight");
    expect(lines.join("\n")).toContain("URL");
  });

  it("does not require a secret but reports the resulting incomplete preflight", async () => {
    let receivedSecret: string | null = null;
    await runCliqWebhookPreflightCommand(
      { url: "https://x.example/cliq/webhook" },
      deps({
        runPreflight: async (options) => {
          receivedSecret = options.secret ?? null;
          return {
            ok: false,
            url: options.url,
            nonce: "n",
            dispatched: false,
            stages: [],
          };
        },
      }),
    );
    expect(receivedSecret).toBeNull();
  });
});

describe("cliq webhook-preflight persists the verification (issue #106)", () => {
  const URL_OK = "https://host.example.com/cliq/webhook";

  type PersistCall = {
    targetUrl: string;
    configuredUrl: string | undefined;
    outcome: "pass" | "fail";
    suppressed: boolean;
    foreignSecret: boolean;
  };

  function capture(): { calls: PersistCall[]; persist: CliqWebhookPreflightCommandDeps["persistVerification"] } {
    const calls: PersistCall[] = [];
    return {
      calls,
      persist: async (params) => {
        calls.push(params);
        return { written: true, reason: "recorded", at: "2026-08-27T09:00:00.000Z" };
      },
    };
  }

  it("records a passing run against the configured URL", async () => {
    const { calls, persist } = capture();
    const code = await runCliqWebhookPreflightCommand(
      { url: URL_OK, secret: "s", configuredUrl: URL_OK },
      deps({ persistVerification: persist }),
    );
    expect(code).toBe(0);
    expect(calls).toEqual([
      {
        targetUrl: URL_OK,
        configuredUrl: URL_OK,
        outcome: "pass",
        suppressed: false,
        foreignSecret: false,
      },
    ]);
  });

  it("flags a --secret run so a foreign secret cannot record a verification", async () => {
    const { calls, persist } = capture();
    await runCliqWebhookPreflightCommand(
      { url: URL_OK, secret: "other", configuredUrl: URL_OK, foreignSecret: true },
      deps({ persistVerification: persist }),
    );
    expect(calls[0]?.foreignSecret).toBe(true);
  });

  it("preserves the previous state when the run was inconclusive rather than failed", async () => {
    const { calls, persist } = capture();
    const lines: string[] = [];
    const code = await runCliqWebhookPreflightCommand(
      { url: URL_OK, configuredUrl: URL_OK },
      deps({
        persistVerification: persist,
        writeLine: (line) => lines.push(line),
        runPreflight: async ({ url }) => ({
          ok: false,
          url,
          nonce: "n",
          dispatched: false,
          stages: [
            { id: "url", label: "URL", status: "pass", detail: "ok" },
            { id: "secret", label: "Secret", status: "warn", detail: "429 rate limited" },
            { id: "probe", label: "Probe", status: "skipped", detail: "not reached" },
          ],
        }),
      }),
    );
    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(lines.join("\n")).toMatch(/inconclusive/i);
  });

  it("never lets a config-write failure break the preflight verdict", async () => {
    const lines: string[] = [];
    const code = await runCliqWebhookPreflightCommand(
      { url: URL_OK, configuredUrl: URL_OK },
      deps({
        writeLine: (line) => lines.push(line),
        persistVerification: async () => {
          throw new Error("config file is read-only");
        },
        runPreflight: async ({ url }) => ({
          ok: false,
          url,
          nonce: "n",
          dispatched: false,
          stages: [{ id: "method", label: "Route", status: "fail", detail: "404" }],
        }),
      }),
    );
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("config file is read-only");
  });

  it("records a failing run so a stale verification cannot survive", async () => {
    const { calls, persist } = capture();
    const code = await runCliqWebhookPreflightCommand(
      { url: URL_OK, secret: "s", configuredUrl: URL_OK },
      deps({
        persistVerification: persist,
        runPreflight: async ({ url }) => ({
          ok: false,
          url,
          nonce: "n",
          dispatched: false,
          stages: [{ id: "method", label: "Route", status: "fail", detail: "404" }],
        }),
      }),
    );
    expect(code).toBe(1);
    expect(calls[0]?.outcome).toBe("fail");
  });

  it("passes the non-matching URL through so the writer can decline it", async () => {
    const { calls, persist } = capture();
    await runCliqWebhookPreflightCommand(
      { url: "https://third-party.example.com/cliq/webhook", configuredUrl: URL_OK },
      deps({ persistVerification: persist }),
    );
    expect(calls[0]?.targetUrl).toBe("https://third-party.example.com/cliq/webhook");
    expect(calls[0]?.configuredUrl).toBe(URL_OK);
  });

  it("marks the run as suppressed when --no-write was given", async () => {
    const { calls, persist } = capture();
    await runCliqWebhookPreflightCommand(
      { url: URL_OK, configuredUrl: URL_OK, write: false },
      deps({ persistVerification: persist }),
    );
    expect(calls[0]?.suppressed).toBe(true);
  });

  it("reports no configured URL as an absent configuredUrl", async () => {
    const { calls, persist } = capture();
    await runCliqWebhookPreflightCommand(
      { url: URL_OK },
      deps({ persistVerification: persist }),
    );
    expect(calls[0]?.configuredUrl).toBeUndefined();
  });

  it("tells the operator what it did or did not write", async () => {
    const lines: string[] = [];
    await runCliqWebhookPreflightCommand(
      { url: URL_OK, configuredUrl: URL_OK },
      deps({
        writeLine: (line) => lines.push(line),
        persistVerification: async () => ({
          written: false,
          reason: "--no-write was given, so the result was not recorded",
        }),
      }),
    );
    expect(lines.join("\n")).toContain("--no-write");
  });

  it("includes the persistence outcome in the JSON report", async () => {
    const lines: string[] = [];
    await runCliqWebhookPreflightCommand(
      { url: URL_OK, configuredUrl: URL_OK, json: true },
      deps({
        writeLine: (line) => lines.push(line),
        persistVerification: async () => ({
          written: true,
          reason: "recorded",
          at: "2026-08-27T09:00:00.000Z",
        }),
      }),
    );
    expect(JSON.parse(lines.join("\n"))).toEqual(
      expect.objectContaining({
        ok: true,
        persistence: expect.objectContaining({ written: true, at: "2026-08-27T09:00:00.000Z" }),
      }),
    );
  });

  it("keeps the exit-code contract when the config writer cannot record a result", async () => {
    const code = await runCliqWebhookPreflightCommand(
      { url: URL_OK, configuredUrl: URL_OK },
      deps({
        persistVerification: async () => ({ written: false, reason: "config file not writable" }),
      }),
    );
    expect(code).toBe(0);
  });
});
