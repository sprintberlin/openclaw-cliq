import { describe, expect, it, vi } from "vitest";
import {
  runCliqSetupProvisioning,
  type CliqSetupProvisioningDeps,
} from "./setup-provisioning-flow.js";
import type { CliqProvisioningRunResult } from "./setup-provisioning.js";

const URL_OK = "https://cliq.example.com/cliq/webhook";
const SECRET = "config-secret";

function result(status: CliqProvisioningRunResult["plan"]["status"]): CliqProvisioningRunResult {
  return {
    createdBot: false,
    plan: {
      status,
      botId: "b-1",
      configuredUniqueName: "franzi",
      evidence: [
        status === "conflict"
          ? "message_handler: secret differs (handler sha256:aaa vs config sha256:bbb)"
          : "message_handler: already configured",
      ],
      items: status === "conflict"
        ? [{
            type: "message_handler",
            action: "repair",
            conflict: "secret_mismatch",
            reason: "secret differs",
            requiresConfirmation: true,
          }]
        : [],
    },
  };
}

function deps(runResult: CliqProvisioningRunResult): CliqSetupProvisioningDeps {
  return {
    resolveAccount: vi.fn(() => ({
      accountId: null,
      clientId: "id",
      clientSecret: "secret",
      botId: "franzi",
      botName: "Franzi",
      webhookSecret: SECRET,
      apiBase: "https://cliq.zoho.eu",
      oauthBase: "https://accounts.zoho.eu",
    } as never)),
    resolveClient: vi.fn(() => ({
      listBots: vi.fn(),
      createBot: vi.fn(),
      readBotHandlerScript: vi.fn(),
      createBotHandler: vi.fn(),
      updateBotHandler: vi.fn(),
    } as never)),
    provision: vi.fn(async () => runResult),
  };
}

function prompter(confirmValues: boolean[] = []) {
  const values = [...confirmValues];
  return {
    confirm: vi.fn(async () => values.shift() ?? false),
    note: vi.fn(async () => undefined),
  };
}

describe("runCliqSetupProvisioning", () => {
  it("always performs and displays a read-only dry-run before offering mutation", async () => {
    const d = deps(result("in_sync"));
    const prompt = prompter();
    const output = await runCliqSetupProvisioning({
      cfg: {} as never,
      publicWebhookUrl: URL_OK,
      prompter: prompt as never,
      deps: d,
    });
    expect(d.provision).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true, confirmed: false }));
    expect(prompt.note).toHaveBeenCalled();
    expect(output.plan.status).toBe("in_sync");
    expect(prompt.confirm).not.toHaveBeenCalled();
  });

  it("requires a separate explicit confirmation before repairing a secret-mismatch conflict", async () => {
    const dry = result("conflict");
    const repaired: CliqProvisioningRunResult = {
      ...dry,
      apply: {
        ok: true,
        applied: true,
        results: [{
          type: "message_handler",
          outcome: "repaired",
          detail: "read back with the configured URL and secret",
          verified: true,
        }],
      },
    };
    const d = deps(dry);
    (d.provision as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(dry)
      .mockResolvedValueOnce(repaired);
    const prompt = prompter([true]);
    const output = await runCliqSetupProvisioning({
      cfg: {} as never,
      publicWebhookUrl: URL_OK,
      prompter: prompt as never,
      deps: d,
    });
    expect(prompt.confirm).toHaveBeenCalledWith(expect.objectContaining({ initialValue: false }));
    expect(d.provision).toHaveBeenLastCalledWith(expect.objectContaining({ dryRun: false, confirmed: true }));
    expect(output.apply?.applied).toBe(true);
  });

  it("leaves Zoho unchanged when the operator declines", async () => {
    const d = deps(result("conflict"));
    const prompt = prompter([false]);
    await runCliqSetupProvisioning({
      cfg: {} as never,
      publicWebhookUrl: URL_OK,
      prompter: prompt as never,
      deps: d,
    });
    expect(d.provision).toHaveBeenCalledTimes(1);
  });

  it("does not expose secrets through wizard notes", async () => {
    const leaked = result("conflict");
    leaked.plan.evidence = [`webhookSecret=${SECRET}`];
    const d = deps(leaked);
    const prompt = prompter([false]);
    await runCliqSetupProvisioning({
      cfg: {} as never,
      publicWebhookUrl: URL_OK,
      prompter: prompt as never,
      deps: d,
    });
    const notes = JSON.stringify(prompt.note.mock.calls);
    expect(notes).not.toContain(SECRET);
  });
});
