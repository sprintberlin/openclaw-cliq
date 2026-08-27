import { describe, expect, it, vi } from "vitest";
import {
  applyCliqHandlerProvisioning,
  isRetryableCliqProvisioningFailure,
  type CliqProvisioningWriter,
} from "./bot-provisioning.js";

const URL_OK = "https://cliq.example.com/cliq/webhook";
const SECRET = "config-secret";
const BOT_ID = "b-464329000000074001";

function writer(overrides: Partial<CliqProvisioningWriter> = {}): CliqProvisioningWriter {
  return {
    createHandler: vi.fn(async () => ({ ok: true as const })),
    updateHandler: vi.fn(async () => ({ ok: true as const })),
    readHandlerScript: vi.fn(async () => ({
      script: `webhookUrl = "${URL_OK}";\nwebhookSecret = "${SECRET}";`,
    })),
    ...overrides,
  };
}

function apply(params: {
  writer?: CliqProvisioningWriter;
  confirmed?: boolean;
  items?: Parameters<typeof applyCliqHandlerProvisioning>[0]["plan"]["items"];
} = {}) {
  return applyCliqHandlerProvisioning({
    plan: {
      status: "changes_required",
      botId: BOT_ID,
      configuredUniqueName: "franzi",
      evidence: [],
      items: params.items ?? [
        {
          type: "message_handler",
          action: "create",
          conflict: "missing",
          reason: "missing",
          requiresConfirmation: true,
        },
      ],
    },
    account: { botId: "franzi", webhookSecret: SECRET },
    publicWebhookUrl: URL_OK,
    confirmed: params.confirmed ?? true,
    writer: params.writer ?? writer(),
  });
}

describe("applyCliqHandlerProvisioning — consent gate", () => {
  it("mutates nothing without explicit confirmation", async () => {
    const w = writer();
    const result = await apply({ writer: w, confirmed: false });
    expect(result.applied).toBe(false);
    expect(w.createHandler).not.toHaveBeenCalled();
    expect(w.updateHandler).not.toHaveBeenCalled();
    expect(result.results[0].outcome).toBe("skipped_unconfirmed");
  });

  it("never mutates a handler whose state could not be read", async () => {
    const w = writer();
    const result = await apply({
      writer: w,
      items: [
        {
          type: "mention_handler",
          action: "blocked",
          conflict: "unreadable",
          reason: "unreadable",
          requiresConfirmation: false,
        },
      ],
    });
    expect(w.createHandler).not.toHaveBeenCalled();
    expect(w.updateHandler).not.toHaveBeenCalled();
    expect(result.results[0].outcome).toBe("skipped_blocked");
  });
});

describe("applyCliqHandlerProvisioning — create and fallback", () => {
  it("creates a missing handler directly when Zoho accepts the full script", async () => {
    const w = writer();
    const result = await apply({ writer: w });
    expect(w.createHandler).toHaveBeenCalledTimes(1);
    expect(w.updateHandler).not.toHaveBeenCalled();
    expect(result.results[0].outcome).toBe("created");
    const [type, botId, script] = (w.createHandler as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(type).toBe("message_handler");
    expect(botId).toBe(BOT_ID);
    expect(script).toContain('payload.put("handler", "message")');
  });

  it("falls back to minimal-create-then-PATCH on the known generic create failure", async () => {
    const w = writer({
      createHandler: vi
        .fn()
        .mockResolvedValueOnce({ ok: false, code: "operation_failed" })
        .mockResolvedValueOnce({ ok: true }),
    });
    const result = await apply({ writer: w });
    expect(w.createHandler).toHaveBeenCalledTimes(2);
    const minimal = (w.createHandler as ReturnType<typeof vi.fn>).mock.calls[1][2] as string;
    const full = (w.createHandler as ReturnType<typeof vi.fn>).mock.calls[0][2] as string;
    expect(minimal.length).toBeLessThan(full.length);
    expect(w.updateHandler).toHaveBeenCalledTimes(1);
    expect(result.results[0].outcome).toBe("created_via_patch_fallback");
    // The fallback must stay observable rather than looking like a plain create.
    expect(result.results[0].detail).toMatch(/fallback/i);
  });

  it("does not use the fallback for an unrelated create failure", async () => {
    const w = writer({
      createHandler: vi.fn(async () => ({ ok: false as const, code: "invalid_oauth_scope" })),
    });
    const result = await apply({ writer: w });
    expect(w.createHandler).toHaveBeenCalledTimes(1);
    expect(w.updateHandler).not.toHaveBeenCalled();
    expect(result.results[0].outcome).toBe("failed");
  });

  it("repairs a diverging handler with PATCH rather than a create", async () => {
    const w = writer();
    const result = await apply({
      writer: w,
      items: [
        {
          type: "mention_handler",
          action: "repair",
          conflict: "secret_mismatch",
          reason: "secret differs",
          requiresConfirmation: true,
        },
      ],
    });
    expect(w.createHandler).not.toHaveBeenCalled();
    expect(w.updateHandler).toHaveBeenCalledTimes(1);
    const script = (w.updateHandler as ReturnType<typeof vi.fn>).mock.calls[0][2] as string;
    expect(script).not.toContain("attachments");
    expect(result.results[0].outcome).toBe("repaired");
  });
});

describe("applyCliqHandlerProvisioning — verification and redaction", () => {
  it("reads the handler back and fails when Zoho did not store the intended values", async () => {
    const w = writer({
      readHandlerScript: vi.fn(async () => ({
        script: `webhookUrl = "${URL_OK}";\nwebhookSecret = "something-else";`,
      })),
    });
    const result = await apply({ writer: w });
    expect(w.readHandlerScript).toHaveBeenCalled();
    expect(result.results[0].verified).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("confirms the read-back when the stored handler matches", async () => {
    const result = await apply();
    expect(result.results[0].verified).toBe(true);
    expect(result.ok).toBe(true);
  });

  it("keeps the secret and script out of every reported string", async () => {
    const w = writer({
      createHandler: vi.fn(async () => ({
        ok: false as const,
        code: "operation_failed",
        detail: `raw body: webhookSecret = "${SECRET}"`,
      })),
      updateHandler: vi.fn(async () => ({ ok: false as const, code: "execution_handler_update_failed" })),
    });
    const result = await apply({ writer: w });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("raw body");
  });
});

describe("isRetryableCliqProvisioningFailure", () => {
  it("does not treat execution_handler_update_failed as retryable", () => {
    expect(isRetryableCliqProvisioningFailure("execution_handler_update_failed")).toBe(false);
  });

  it("surfaces the script-validity explanation for that code", async () => {
    const w = writer({
      updateHandler: vi.fn(async () => ({
        ok: false as const,
        code: "execution_handler_update_failed",
      })),
    });
    const result = await apply({
      writer: w,
      items: [
        {
          type: "mention_handler",
          action: "repair",
          conflict: "secret_mismatch",
          reason: "secret differs",
          requiresConfirmation: true,
        },
      ],
    });
    expect(result.results[0].outcome).toBe("failed");
    expect(result.results[0].detail).toMatch(/script/i);
    expect(result.results[0].retryable).toBe(false);
  });
});
