import { describe, expect, it, vi } from "vitest";
import {
  buildCliqHandlerScript,
  planCliqHandlerProvisioning,
  type CliqProvisioningReader,
} from "./bot-provisioning.js";


const URL_OK = "https://cliq.example.com/cliq/webhook";
const SECRET = "config-secret";

function script(
  secret = SECRET,
  url = URL_OK,
  extra = 'payload.put("eventId", eventId);\nresponse.put("eventId", eventId);',
): string {
  return `webhookUrl = "${url}";\nwebhookSecret = "${secret}";\npayload = Map();\n${extra}`;
}

function reader(overrides: Partial<CliqProvisioningReader> = {}): CliqProvisioningReader {
  return {
    listBots: vi.fn(async () => [{ id: "b-464329000000074001", unique_name: "franzi" }]),
    readHandlerScript: vi.fn(async () => ({ script: script() })),
    ...overrides,
  };
}

function plan(params: {
  reader?: CliqProvisioningReader;
  secret?: string;
  url?: string;
} = {}) {
  return planCliqHandlerProvisioning({
    account: { botId: "franzi", webhookSecret: params.secret ?? SECRET },
    publicWebhookUrl: params.url ?? URL_OK,
    reader: params.reader ?? reader(),
  });
}

describe("buildCliqHandlerScript", () => {
  it("emits a message handler that forwards attachments as raw JSON", () => {
    const body = buildCliqHandlerScript({
      handlerType: "message_handler",
      webhookUrl: URL_OK,
      webhookSecret: SECRET,
    });
    expect(body).toContain('payload.put("handler", "message")');
    expect(body).toContain("attachments");
    expect(body).toContain("body   : payload.toString()");
    expect(body).toContain('headers.put("Content-Type", "application/json")');
    expect(body).not.toContain("parameters");
    expect(body).toContain('eventId = zoho.currenttime.toString("yyyyMMddHHmmss") + "-" + randomNumber(100000,999999) + randomNumber(100000,999999)');
    expect(body).toContain('payload.put("eventId", eventId)');
    const eventIdLine = body.indexOf('payload.put("eventId"');
    const invokeUrl = body.indexOf("invokeUrl");
    expect(eventIdLine).toBeGreaterThan(-1);
    expect(invokeUrl).toBeGreaterThan(eventIdLine);
  });

  describe("correlated execution output (issue #231)", () => {
    const handlerTypes = [
      "message_handler",
      "mention_handler",
      "welcome_handler",
    ] as const;

    it.each(handlerTypes)("%s returns its eventId instead of a bare {}", (handlerType) => {
      const body = buildCliqHandlerScript({
        handlerType,
        webhookUrl: URL_OK,
        webhookSecret: SECRET,
      });
      // Without the echo every Zoho execution row reads `output: "{}"`, so a
      // delivered message and a handler that returned before `invokeUrl` are
      // indistinguishable in the only log Zoho exposes.
      expect(body).toContain('response.put("eventId", eventId);');
      const responseMap = body.indexOf("response = Map();");
      const echo = body.indexOf('response.put("eventId"');
      const ret = body.indexOf("return response;");
      expect(responseMap).toBeGreaterThan(-1);
      expect(echo).toBeGreaterThan(responseMap);
      expect(ret).toBeGreaterThan(echo);
    });

    it.each(handlerTypes)(
      "%s echoes only the eventId — never the secret, payload, or message",
      (handlerType) => {
        const body = buildCliqHandlerScript({
          handlerType,
          webhookUrl: URL_OK,
          webhookSecret: SECRET,
        });
        const responseLines = body
          .split("\n")
          .filter((line) => line.startsWith("response.put("));
        expect(responseLines).toEqual(['response.put("eventId", eventId);']);
      },
    );

    it("introduces no new Deluge symbol beyond the already-used eventId", () => {
      // `execution_handler_update_failed` is permanent and not safely
      // retryable, so the echo must reuse a variable every handler already
      // declares rather than capturing the invokeUrl result.
      for (const handlerType of handlerTypes) {
        const body = buildCliqHandlerScript({
          handlerType,
          webhookUrl: URL_OK,
          webhookSecret: SECRET,
        });
        expect(body).toContain("eventId = zoho.currenttime");
        expect(body).not.toMatch(/=\s*invokeUrl/);
        expect(body).not.toContain("statusCode");
      }
    });
  });

  it("omits attachments from the mention handler, which Zoho does not provide", () => {
    const body = buildCliqHandlerScript({
      handlerType: "mention_handler",
      webhookUrl: URL_OK,
      webhookSecret: SECRET,
    });
    expect(body).toContain('payload.put("handler", "mention")');
    expect(body).not.toContain("attachments");
    expect(body).toContain('payload.put("eventId"');
  });

  it("never produces byte-identical message and mention scripts", () => {
    const message = buildCliqHandlerScript({
      handlerType: "message_handler",
      webhookUrl: URL_OK,
      webhookSecret: SECRET,
    });
    const mention = buildCliqHandlerScript({
      handlerType: "mention_handler",
      webhookUrl: URL_OK,
      webhookSecret: SECRET,
    });
    expect(message).not.toBe(mention);
  });

  it("emits a welcome handler that forwards the newuser flag", () => {
    const body = buildCliqHandlerScript({
      handlerType: "welcome_handler",
      webhookUrl: URL_OK,
      webhookSecret: SECRET,
    });
    expect(body).toContain('payload.put("handler", "welcome")');
    expect(body).toContain("newuser");
    expect(body).not.toContain("attachments");
    expect(body).toContain('payload.put("eventId"');
  });
});

describe("planCliqHandlerProvisioning — read-only", () => {
  it("reports no changes when both handlers already carry the configured URL and secret", async () => {
    const result = await plan();
    expect(result.status).toBe("in_sync");
    expect(result.botId).toBe("b-464329000000074001");
    expect(result.items.map((item) => item.action)).toEqual(["none", "none"]);
  });

  it("plans a confirmed repair for a handler that does not echo its eventId (issue #231)", async () => {
    // A handler from before #231: it forwards the eventId but still returns a
    // bare map, so its Zoho execution rows stay "{}".
    const result = await plan({
      reader: reader({
        readHandlerScript: vi.fn(async () => ({
          script: script(SECRET, URL_OK, 'payload.put("eventId", eventId);'),
        })),
      }),
    });
    expect(result.status).toBe("conflict");
    for (const item of result.items) {
      expect(item.action).toBe("repair");
      expect(item.conflict).toBe("stale_script");
      expect(item.requiresConfirmation).toBe(true);
      expect(item.reason).toMatch(/does not return its eventId/i);
    }
    // The reason must stay free of secret material.
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("plans a confirmed repair for a legacy handler with no eventId (issue #196)", async () => {
    const result = await plan({
      reader: reader({
        readHandlerScript: vi.fn(async () => ({ script: script(SECRET, URL_OK, "") })),
      }),
    });
    expect(result.status).toBe("conflict");
    for (const item of result.items) {
      expect(item.action).toBe("repair");
      expect(item.conflict).toBe("stale_script");
      expect(item.requiresConfirmation).toBe(true);
      expect(item.reason).toContain("eventId");
    }
  });

  it("plans a create for a handler Zoho does not have yet", async () => {
    const result = await plan({
      reader: reader({
        readHandlerScript: vi.fn(async (type: string) =>
          type === "mention_handler"
            ? { error: "Zoho answered HTTP 404" }
            : { script: script() },
        ),
      }),
    });
    expect(result.status).toBe("changes_required");
    const mention = result.items.find((item) => item.type === "mention_handler")!;
    expect(mention.action).toBe("create");
    expect(mention.requiresConfirmation).toBe(true);
  });

  it("treats a matching URL with a diverging secret as a first-class conflict, not 'already configured'", async () => {
    const result = await plan({
      reader: reader({
        readHandlerScript: vi.fn(async () => ({ script: script("stale-host-secret", URL_OK) })),
      }),
    });
    expect(result.status).toBe("conflict");
    for (const item of result.items) {
      expect(item.action).toBe("repair");
      expect(item.conflict).toBe("secret_mismatch");
      expect(item.requiresConfirmation).toBe(true);
      expect(item.reason).toMatch(/secret/i);
    }
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("stale-host-secret");
    expect(serialized).not.toContain(SECRET);
  });

  it("reports a diverging webhook URL as its own conflict", async () => {
    const result = await plan({
      reader: reader({
        readHandlerScript: vi.fn(async () => ({
          script: script(SECRET, "https://old-host.example.com/cliq/webhook"),
        })),
      }),
    });
    expect(result.status).toBe("conflict");
    expect(result.items[0].conflict).toBe("url_mismatch");
  });

  it("never plans a silent overwrite of an unrecognised hand-written handler", async () => {
    const result = await plan({
      reader: reader({
        readHandlerScript: vi.fn(async () => ({
          script: "secret = zoho.vault.get(\"cliq\");\ninvokeUrl[];",
        })),
      }),
    });
    expect(result.status).toBe("conflict");
    expect(result.items[0].conflict).toBe("unrecognised_script");
    expect(result.items[0].requiresConfirmation).toBe(true);
  });

  it("blocks instead of guessing when the handler cannot be read at all", async () => {
    const result = await plan({
      reader: reader({
        readHandlerScript: vi.fn(async () => ({
          error: "Zoho refused the read with HTTP 403",
        })),
      }),
    });
    expect(result.status).toBe("blocked");
    expect(result.items[0].action).toBe("blocked");
    expect(result.items[0].conflict).toBe("unreadable");
  });

  it("blocks when the configured bot cannot be resolved to an internal id", async () => {
    const result = await plan({ reader: reader({ listBots: vi.fn(async () => []) }) });
    expect(result.status).toBe("blocked");
    expect(result.botId).toBeUndefined();
    expect(result.evidence.join(" ")).toMatch(/unique name/i);
  });

  it("blocks when no webhook secret or public URL is configured rather than writing an empty one", async () => {
    const noSecret = await plan({ secret: "" });
    expect(noSecret.status).toBe("blocked");
    const noUrl = await plan({ url: "" });
    expect(noUrl.status).toBe("blocked");
  });

  it("never reads a handler with the configured unique name instead of the internal id", async () => {
    const readHandlerScript = vi.fn(
      async (_type: string, _botId?: string) => ({ script: script() }),
    );
    await plan({ reader: reader({ readHandlerScript }) });
    for (const call of readHandlerScript.mock.calls) {
      expect(call[1]).toBe("b-464329000000074001");
    }
  });

  it("keeps handler bodies, secrets, and tokens out of the plan evidence", async () => {
    const leaked = 'webhookSecret = "live-secret"; access_token = "tok-123";';
    const result = await plan({
      reader: reader({
        readHandlerScript: vi.fn(async () => ({ script: leaked })),
      }),
    });
    const serialized = JSON.stringify(result);    expect(serialized).not.toContain("live-secret");
    expect(serialized).not.toContain("tok-123");
    expect(serialized).not.toContain(leaked);
  });
});

describe("planCliqHandlerProvisioning — optional welcome handler", () => {
  it("ignores the welcome handler unless it is explicitly requested", async () => {
    const result = await planCliqHandlerProvisioning({
      account: { botId: "franzi", webhookSecret: SECRET },
      publicWebhookUrl: URL_OK,
      reader: reader(),
    });
    expect(result.items.map((item) => item.type)).toEqual([
      "message_handler",
      "mention_handler",
    ]);
  });

  it("plans the welcome handler when the greeting is opted in", async () => {
    const result = await planCliqHandlerProvisioning({
      account: { botId: "franzi", webhookSecret: SECRET },
      publicWebhookUrl: URL_OK,
      includeWelcome: true,
      reader: reader({
        readHandlerScript: vi.fn(async (type: string) =>
          type === "welcome_handler"
            ? { error: "Zoho answered HTTP 404" }
            : { script: script() },
        ),
      }),
    });
    const welcome = result.items.find((item) => item.type === "welcome_handler")!;
    expect(welcome.action).toBe("create");
    expect(result.status).toBe("changes_required");
  });
});
