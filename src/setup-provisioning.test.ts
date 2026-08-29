import { describe, expect, it, vi } from "vitest";
import {
  provisionCliqBotAndHandlers,
  type CliqBotProvisioningService,
} from "./setup-provisioning.js";
import { evaluateCliqScopeSet, SETUP_SCOPE_STRING } from "./capabilities.js";
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
      script: `webhookUrl = "${URL_OK}";\nwebhookSecret = "${SECRET}";\npayload.put("eventId", eventId);`,
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

describe("provisionCliqBotAndHandlers — capability evidence is required (issue #93)", () => {
  it("never creates a bot when the bot listing failed rather than proving absence", async () => {
    // A missing Bots.READ consent used to look exactly like "no such bot",
    // so a token holding only Bots.CREATE created a duplicate bot per run.
    const api = service({
      listBots: vi.fn(async () => ({
        kind: "missing_scope" as const,
        detail: "Zoho refused the bot read with HTTP 403",
        status: 403,
      })),
    });
    const result = await run({ service: api, dryRun: false, confirmed: true });
    expect(api.createBot).not.toHaveBeenCalled();
    expect(result.createdBot).toBe(false);
    expect(result.plan.status).toBe("blocked");
    expect(result.plan.evidence.join(" ")).toMatch(/ZohoCliq\.Bots\.READ/);
  });

  it("blocks bot creation when the granted scope set has no Bots.CREATE", async () => {
    const api = service({ listBots: vi.fn(async () => []) });
    const result = await provisionCliqBotAndHandlers({
      account: { botId: "franzi", botName: "Franzi", webhookSecret: SECRET },
      publicWebhookUrl: URL_OK,
      dryRun: false,
      confirmed: true,
      capabilities: evaluateCliqScopeSet(
        "ZohoCliq.Bots.READ,ZohoCliq.Bots.UPDATE",
      ),
      service: api,
    });
    expect(api.createBot).not.toHaveBeenCalled();
    expect(result.plan.status).toBe("blocked");
    expect(result.plan.evidence.join(" ")).toContain("ZohoCliq.Bots.CREATE");
  });

  it("blocks handler provisioning when the granted scope set has no Bots.UPDATE", async () => {
    const api = service();
    const result = await provisionCliqBotAndHandlers({
      account: { botId: "franzi", botName: "Franzi", webhookSecret: SECRET },
      publicWebhookUrl: URL_OK,
      dryRun: false,
      confirmed: true,
      capabilities: evaluateCliqScopeSet("ZohoCliq.Bots.READ"),
      service: api,
    });
    expect(api.createHandler).not.toHaveBeenCalled();
    expect(api.updateHandler).not.toHaveBeenCalled();
    expect(result.plan.status).toBe("blocked");
    expect(result.plan.evidence.join(" ")).toContain("ZohoCliq.Bots.UPDATE");
  });

  it("allows provisioning when the required scopes are consented", async () => {
    const api = service({ listBots: vi.fn(async () => []) });
    const result = await provisionCliqBotAndHandlers({
      account: { botId: "franzi", botName: "Franzi", webhookSecret: SECRET },
      publicWebhookUrl: URL_OK,
      dryRun: false,
      confirmed: true,
      capabilities: evaluateCliqScopeSet(SETUP_SCOPE_STRING),
      service: api,
    });
    expect(api.createBot).toHaveBeenCalled();
    expect(result.plan.status).not.toBe("blocked");
  });

  it("does not fabricate a bot record when the post-create listing fails", async () => {
    let created = false;
    const api = service({
      listBots: vi.fn(async () => {
        if (!created) return [];
        return { kind: "http" as const, detail: "Zoho answered HTTP 500", status: 500 };
      }),
      createBot: vi.fn(async () => {
        created = true;
        return { ok: true as const, bot: { id: "b-2", unique_name: "franzi", name: "Franzi" } };
      }),
    });
    const result = await run({ service: api, dryRun: false, confirmed: true });
    expect(api.createHandler).not.toHaveBeenCalled();
    expect(result.plan.status).toBe("blocked");
  });
});
