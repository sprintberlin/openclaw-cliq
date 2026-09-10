import { describe, expect, it, vi } from "vitest";
import { runCliqProvisionCommand, type CliqProvisionCommandDeps } from "./provision-command.js";

function runDeps() {
  const lines: string[] = [];
  const errors: string[] = [];
  const provision = vi.fn(async () => ({
    createdBot: false,
    plan: { status: "changes_required" as const, configuredUniqueName: "aura", items: [], evidence: ["would create bot"] },
  }));
  const mutateConfigFile = vi.fn(async () => {});
  const deps: CliqProvisionCommandDeps = {
    provision,
    resolveClient: vi.fn(() => ({})) as never,
    mutateConfigFile,
    writeLine: (line) => lines.push(line),
    writeError: (line) => errors.push(line),
  };
  return { deps, lines, errors, provision, mutateConfigFile };
}

const ENV_NAMES = ["CLIQ_CLIENT_ID", "CLIQ_CLIENT_SECRET", "CLIQ_WEBHOOK_SECRET", "CLIQ_REFRESH_TOKEN"] as const;

function withEnv(values: Partial<Record<(typeof ENV_NAMES)[number], string>>, fn: () => Promise<void>) {
  const original = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  return fn().finally(() => {
    for (const name of ENV_NAMES) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  });
}

describe("cliq provision command (issue #246)", () => {
  it("uses env-backed secrets and produces a no-write dry-run by default", async () => {
    await withEnv({ CLIQ_CLIENT_ID: "cid", CLIQ_CLIENT_SECRET: "client-secret", CLIQ_WEBHOOK_SECRET: "webhook-secret" }, async () => {
      const { deps, lines, errors, provision, mutateConfigFile } = runDeps();
      const code = await runCliqProvisionCommand(
        { cfg: { channels: { cliq: {} } } as never, botId: "aura", provisionHandlers: true, publicWebhookUrl: "https://x.example.com/cliq/webhook" },
        deps,
      );
      expect(code).toBe(1);
      expect(provision).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true, confirmed: false }));
      expect(mutateConfigFile).not.toHaveBeenCalled();
      expect(lines.join("\n")).not.toContain("client-secret");
      expect(lines.join("\n")).not.toContain("webhook-secret");
      expect(errors.join("\n")).toMatch(/Dry run only/);
    });
  });

  it("aggregates all missing required inputs at once", async () => {
    const { deps, errors } = runDeps();
    const code = await runCliqProvisionCommand(
      { cfg: { channels: { cliq: {} } } as never, provisionHandlers: true },
      deps,
    );
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("clientId");
    expect(errors.join("\n")).toContain("clientSecret");
    expect(errors.join("\n")).toContain("botId");
    expect(errors.join("\n")).toContain("webhookSecret");
    expect(errors.join("\n")).toContain("publicWebhookUrl");
  });

  it("only persists config after explicit --yes and finishes with supplied preflight", async () => {
    await withEnv({ CLIQ_CLIENT_ID: "cid", CLIQ_CLIENT_SECRET: "client-secret", CLIQ_WEBHOOK_SECRET: "webhook-secret" }, async () => {
      const { deps, lines, mutateConfigFile } = runDeps();
      const preflight = vi.fn(async () => ({ ok: true, detail: "all green" }));
      const code = await runCliqProvisionCommand(
        {
          cfg: { channels: { cliq: {} } } as never,
          botId: "aura",
          publicWebhookUrl: "https://x.example.com/cliq/webhook",
          yes: true,
          preflight,
        },
        deps,
      );
      expect(code).toBe(0);
      expect(mutateConfigFile).toHaveBeenCalledOnce();
      expect(preflight).toHaveBeenCalledWith({ url: "https://x.example.com/cliq/webhook", secret: "webhook-secret" });
      expect(lines.join("\n")).toContain("Cliq config written atomically.");
      expect(lines.join("\n")).toContain("Webhook preflight: all green");
    });
  });

  it("persists secrets as env-backed SecretRefs, never as literals in openclaw.json", async () => {
    await withEnv(
      {
        CLIQ_CLIENT_ID: "cid",
        CLIQ_CLIENT_SECRET: "client-secret-literal",
        CLIQ_WEBHOOK_SECRET: "webhook-secret-literal",
        CLIQ_REFRESH_TOKEN: "refresh-token-literal",
      },
      async () => {
        const { deps, lines } = runDeps();
        let written: Record<string, unknown> = {};
        deps.mutateConfigFile = async ({ mutate }) => {
          const draft = { channels: { cliq: {} } } as never;
          mutate(draft);
          written = draft as unknown as Record<string, unknown>;
        };
        const code = await runCliqProvisionCommand(
          {
            cfg: { channels: { cliq: {} } } as never,
            botId: "aura",
            publicWebhookUrl: "https://x.example.com/cliq/webhook",
            yes: true,
          },
          deps,
        );
        expect(code).toBe(0);

        const serialized = JSON.stringify(written);
        expect(serialized).not.toContain("client-secret-literal");
        expect(serialized).not.toContain("webhook-secret-literal");
        expect(serialized).not.toContain("refresh-token-literal");

        const cliq = (written.channels as Record<string, Record<string, unknown>>).cliq;
        for (const [field, envId] of [
          ["clientSecret", "CLIQ_CLIENT_SECRET"],
          ["webhookSecret", "CLIQ_WEBHOOK_SECRET"],
          ["refreshToken", "CLIQ_REFRESH_TOKEN"],
        ] as const) {
          expect(cliq[field]).toEqual({ source: "env", provider: "default", id: envId });
        }
        // Non-secret fields still persist as plain values.
        expect(cliq.botId).toBe("aura");
        expect(cliq.clientId).toBe("cid");
        expect(lines.join("\n")).toContain("CLIQ_CLIENT_SECRET");
      },
    );
  });

  it("preserves an operator-authored SecretRef instead of overwriting it", async () => {
    const ref = { source: "env", provider: "vaultish", id: "CUSTOM_CLIQ_SECRET" };
    await withEnv({ CLIQ_CLIENT_ID: "cid", CLIQ_WEBHOOK_SECRET: "webhook-secret-literal" }, async () => {
      const { deps } = runDeps();
      let written: Record<string, unknown> = {};
      deps.mutateConfigFile = async ({ mutate }) => {
        const draft = { channels: { cliq: {} } } as never;
        mutate(draft);
        written = draft as unknown as Record<string, unknown>;
      };
      const code = await runCliqProvisionCommand(
        {
          cfg: { channels: { cliq: { clientSecret: ref } } } as never,
          botId: "aura",
          clientSecret: "flag-provided-secret",
          publicWebhookUrl: "https://x.example.com/cliq/webhook",
          yes: true,
        },
        deps,
      );
      expect(code).toBe(0);
      expect(JSON.stringify(written)).not.toContain("flag-provided-secret");
    });
  });

  it("does not persist config if atomic mutation fails", async () => {
    await withEnv({ CLIQ_CLIENT_ID: "cid", CLIQ_CLIENT_SECRET: "client-secret", CLIQ_WEBHOOK_SECRET: "webhook-secret" }, async () => {
      const { deps, errors } = runDeps();
      deps.mutateConfigFile = async () => { throw new Error("write failed"); };
      const code = await runCliqProvisionCommand(
        { cfg: { channels: { cliq: {} } } as never, botId: "aura", yes: true },
        deps,
      );
      expect(code).toBe(1);
      expect(errors.join("\n")).toMatch(/no config changes were persisted/i);
    });
  });
});
