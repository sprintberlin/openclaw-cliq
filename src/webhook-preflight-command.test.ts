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
