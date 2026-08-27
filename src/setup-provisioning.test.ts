import { describe, expect, it, vi } from "vitest";
import {
  provisionCliqBotAndHandlers,
  type CliqBotProvisioningService,
} from "./setup-provisioning.js";
import type { CliqBotRecord } from "./client.js";

const URL_OK = "https://cliq.example.com/cliq/webhook";
const SECRET = "config-secret";

function service(overrides: Partial<CliqBotProvisioningService> = {}): CliqBotProvisioningService {
  return {
    listBots: vi.fn(async () => [{ id: "b-1", unique_name: "franzi" }]),
    createBot: vi.fn(async () => ({
      ok: true as const,
      bot: { id: "b-1", unique_name: "franzi", name: "Franzi" },
    })),
    readHandlerScript: vi.fn(async () => ({
      script: `webhookUrl = "${URL_OK}";\nwebhookSecret = "${SECRET}";`,
    })),
    createHandler: vi.fn(async () => ({ ok: true as const })),
    updateHandler: vi.fn(async () => ({ ok: true as const })),
    ...overrides,
  };
}

function run(params: {
  service?: CliqBotProvisioningService;
  dryRun?: boolean;
  confirmed?: boolean;
  botId?: string;
  botName?: string;
} = {}) {
  return provisionCliqBotAndHandlers({
    account: {
      botId: params.botId ?? "franzi",
      botName: params.botName ?? "Franzi",
      webhookSecret: SECRET,
    },
    publicWebhookUrl: URL_OK,
    dryRun: params.dryRun ?? true,
    confirmed: params.confirmed ?? false,
    service: params.service ?? service(),
  });
}

describe("provisionCliqBotAndHandlers", () => {
  it("is read-only in dry-run mode", async () => {
    const api = service();
    const result = await run({ service: api, dryRun: true });
    expect(result.plan.status).toBe("in_sync");
    expect(result.apply).toBeUndefined();
    expect(api.createBot).not.toHaveBeenCalled();
    expect(api.createHandler).not.toHaveBeenCalled();
    expect(api.updateHandler).not.toHaveBeenCalled();
  });

  it("creates an absent bot only after explicit confirmation, then plans its missing handlers", async () => {
    const handlerState = new Map<string, string>();
    const api = service({
      listBots: vi.fn(async () => [] as CliqBotRecord[]),
      createBot: vi.fn(async () => ({
        ok: true as const,
        bot: { id: "b-2", unique_name: "franzi", name: "Franzi" },
      })),
      readHandlerScript: vi.fn(async (type: string) => {
        const script = handlerState.get(type);
        return script ? { script } : { error: "Zoho answered HTTP 404" };
      }),
      createHandler: vi.fn(async (type: string, _id: string, script: string) => {
        handlerState.set(type, script);
        return { ok: true as const };
      }),
    });
    const result = await run({ service: api, dryRun: false, confirmed: true });
    expect(api.createBot).toHaveBeenCalledWith("Franzi");
    expect(api.createHandler).toHaveBeenCalledTimes(2);
    expect(result.createdBot).toBe(true);
    expect(result.apply?.ok).toBe(true);
  });

  it("does not create an absent bot during dry-run", async () => {
    const api = service({ listBots: vi.fn(async () => []) });
    const result = await run({ service: api, dryRun: true });
    expect(api.createBot).not.toHaveBeenCalled();
    expect(result.plan.status).toBe("changes_required");
    expect(result.plan.evidence.join(" ")).toMatch(/bot.*created/i);
  });

  it("does not create an absent bot without confirmation", async () => {
    const api = service({ listBots: vi.fn(async () => []) });
    const result = await run({ service: api, dryRun: false, confirmed: false });
    expect(api.createBot).not.toHaveBeenCalled();
    expect(result.apply?.applied).toBe(false);
  });

  it("blocks bot creation when Zoho derives a different unique name", async () => {
    const api = service({
      listBots: vi.fn(async () => []),
      createBot: vi.fn(async () => ({
        ok: true as const,
        bot: { id: "b-2", unique_name: "franzi-2", name: "Franzi" },
      })),
    });
    const result = await run({ service: api, dryRun: false, confirmed: true });
    expect(result.plan.status).toBe("blocked");
    expect(result.plan.evidence.join(" ")).toMatch(/unique name/i);
    expect(api.createHandler).not.toHaveBeenCalled();
  });

  it("preserves secret-mismatch as a conflict and requires confirmation for repair", async () => {
    const api = service({
      readHandlerScript: vi.fn(async () => ({
        script: `webhookUrl = "${URL_OK}";\nwebhookSecret = "stale-secret";`,
      })),
    });
    const result = await run({ service: api, dryRun: false, confirmed: false });
    expect(result.plan.status).toBe("conflict");
    expect(result.plan.items.every((item) => item.conflict === "secret_mismatch")).toBe(true);
    expect(api.updateHandler).not.toHaveBeenCalled();
    expect(result.apply?.results.every((item) => item.outcome === "skipped_unconfirmed")).toBe(true);
  });
});
