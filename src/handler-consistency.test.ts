import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkCliqHandlerConsistency,
  createCliqHandlerScriptReader,
  extractDelugeStringAssignment,
  fingerprintCliqSecret,
  proposeCliqHandlerUrlAdoption,
} from "./handler-consistency.js";
import { formatCliqPreflightReport } from "./webhook-preflight.js";

const HOOK_URL = "https://agent.example.com/cliq/webhook";
const SECRET = "configured-secret-value";

function script(secret = SECRET, url = HOOK_URL): string {
  return `webhookUrl = "${url}";\nwebhookSecret = "${secret}";\npayload = Map();`;
}

function handlers(messageScript: string, mentionScript = messageScript) {
  return [
    { type: "message_handler", script: messageScript },
    { type: "mention_handler", script: mentionScript },
  ];
}

describe("checkCliqHandlerConsistency (issue #124)", () => {
  it("passes when both handler secrets and URLs match config", () => {
    const result = checkCliqHandlerConsistency({
      handlers: handlers(script()),
      configSecret: SECRET,
      expectedWebhookUrl: HOOK_URL,
    });

    expect(result.status).toBe("pass");
    expect(result.detail).toContain(fingerprintCliqSecret(SECRET));
    expect(result.detail).not.toContain(SECRET);
  });

  it("fails and names the handler when config and handler secrets differ", () => {
    const handlerSecret = "zoho-held-different-secret";
    const result = checkCliqHandlerConsistency({
      handlers: handlers(script(handlerSecret), script()),
      configSecret: SECRET,
      expectedWebhookUrl: HOOK_URL,
    });

    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/message handler holds a different webhook secret/i);
    expect(result.detail).toContain(fingerprintCliqSecret(SECRET));
    expect(result.detail).toContain(fingerprintCliqSecret(handlerSecret));
    expect(result.detail).not.toContain(SECRET);
    expect(result.detail).not.toContain(handlerSecret);
  });

  it("fails when the two handlers hold different secrets", () => {
    const result = checkCliqHandlerConsistency({
      handlers: handlers(script("message-secret"), script("mention-secret")),
      configSecret: SECRET,
      expectedWebhookUrl: HOOK_URL,
    });

    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/handlers do not agree with each other/i);
    expect(result.detail).toMatch(/message handler=sha256:/i);
    expect(result.detail).toMatch(/mention handler=sha256:/i);
  });

  it("fails and names the handler when its webhook URL differs", () => {
    const oldUrl = "https://old-agent.example.com/cliq/webhook";
    const result = checkCliqHandlerConsistency({
      handlers: handlers(script(SECRET, oldUrl), script()),
      configSecret: SECRET,
      expectedWebhookUrl: HOOK_URL,
    });

    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/message handler posts to/i);
    expect(result.detail).toContain(oldUrl);
    expect(result.detail).toContain(HOOK_URL);
  });

  it("skips when Bots.READ could not read the handlers", () => {
    const result = checkCliqHandlerConsistency({
      handlers: [
        { type: "message_handler", error: "HTTP 403 — missing ZohoCliq.Bots.READ" },
        { type: "mention_handler", error: "HTTP 403 — missing ZohoCliq.Bots.READ" },
      ],
      configSecret: SECRET,
      expectedWebhookUrl: HOOK_URL,
    });

    expect(result.status).toBe("skipped");
    expect(result.detail).toMatch(/could not be (completely )?compared/i);
    expect(result.detail).toMatch(/Bots\.READ/i);
  });

  it("skips when the handler scripts use an unrecognised shape", () => {
    const result = checkCliqHandlerConsistency({
      handlers: handlers(`secret = zoho.vault.get("hook");\nurl = "${HOOK_URL}";`),
      configSecret: SECRET,
      expectedWebhookUrl: HOOK_URL,
    });

    expect(result.status).toBe("skipped");
    expect(result.detail).toMatch(/unrecognised|recognisable/i);
    expect(result.detail).not.toContain(SECRET);
  });

  it("skips when no botId is configured", () => {
    const reader = createCliqHandlerScriptReader({
      account: { botId: "" },
      readHandlerScript: vi.fn(),
      listBots: vi.fn(async () => []),
    });

    expect(reader).toBeNull();
  });

  it("resolves a configured unique name to the internal bot id before reading handlers (issue #149)", async () => {
    const readHandlerScript = vi.fn(
      async (_type: string, _botId?: string) => ({ script: script() }),
    );
    const listBots = vi.fn(async () => [
      { id: "b-464329000000074001", unique_name: "franzi" },
    ]);
    const reader = createCliqHandlerScriptReader({
      account: { botId: "franzi" },
      readHandlerScript,
      listBots,
    });

    const first = await reader!();
    const second = await reader!();
    expect(first.every((record) => typeof record.script === "string")).toBe(true);
    expect(second.every((record) => typeof record.script === "string")).toBe(true);
    expect(readHandlerScript).toHaveBeenCalledTimes(4);
    for (const call of readHandlerScript.mock.calls) {
      expect(call[1]).toBe("b-464329000000074001");
    }
    expect(listBots).toHaveBeenCalledTimes(1);
  });

  it("passes an already-internal bot id straight through without a lookup", async () => {
    const readHandlerScript = vi.fn(
      async (_type: string, _botId?: string) => ({ script: script() }),
    );
    const listBots = vi.fn(async () => []);
    const reader = createCliqHandlerScriptReader({
      account: { botId: "b-464329000000074001" },
      readHandlerScript,
      listBots,
    });

    await reader!();
    expect(listBots).not.toHaveBeenCalled();
    expect(readHandlerScript.mock.calls[0][1]).toBe("b-464329000000074001");
  });

  it("degrades to a skipped comparison, never a pass, when the bot id cannot be resolved", async () => {
    const readHandlerScript = vi.fn(async () => ({ script: script() }));
    const reader = createCliqHandlerScriptReader({
      account: { botId: "franzi" },
      readHandlerScript,
      listBots: vi.fn(async () => []),
    });

    const records = await reader!();
    expect(readHandlerScript).not.toHaveBeenCalled();
    expect(records).toHaveLength(2);
    expect(records[0].error).toMatch(/unique name/i);
    const diagnostic = checkCliqHandlerConsistency({
      handlers: records,
      configSecret: SECRET,
      expectedWebhookUrl: HOOK_URL,
    });
    expect(diagnostic.status).toBe("skipped");
  });

  it("never leaks a raw Zoho body when bot id resolution fails", async () => {
    const leaked = '{"webhookSecret":"live-secret","access_token":"tok-123"}';
    const reader = createCliqHandlerScriptReader({
      account: { botId: "franzi" },
      readHandlerScript: vi.fn(async () => ({ script: script() })),
      listBots: vi.fn(async () => {
        throw new Error(`GET /api/v3/bots failed (500): ${leaked}`);
      }),
    });

    const records = await reader!();
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain("live-secret");
    expect(serialized).not.toContain("tok-123");
    expect(serialized).not.toContain(leaked);
  });

  it("skips when the configured secret is unavailable", () => {
    const result = checkCliqHandlerConsistency({
      handlers: handlers(script()),
      configSecret: undefined,
      expectedWebhookUrl: HOOK_URL,
    });

    expect(result.status).toBe("skipped");
    expect(result.detail).toMatch(/no webhookSecret/i);
  });

  it("accepts equivalent URLs with a trailing slash", () => {
    const result = checkCliqHandlerConsistency({
      handlers: handlers(script(SECRET, `${HOOK_URL}/`)),
      configSecret: SECRET,
      expectedWebhookUrl: HOOK_URL,
    });

    expect(result.status).toBe("pass");
  });

  it("extracts only a line-level quoted Deluge assignment", () => {
    expect(extractDelugeStringAssignment(script(), "webhookSecret")).toBe(SECRET);
    expect(
      extractDelugeStringAssignment(`// webhookSecret = "fake";\nvalue = "x";`, "webhookSecret"),
    ).toBeNull();
    expect(extractDelugeStringAssignment("webhookSecret = zoho.vault.get();", "webhookSecret")).toBeNull();
  });

  it("reads Message and Mention handlers without leaking thrown error text", async () => {
    const leaked = "secret leaked from a thrown Zoho body";
    const readHandlerScript = vi.fn(async (type: string) => {
      if (type === "message_handler") return { script: script() };
      throw new Error(leaked);
    });
    const reader = createCliqHandlerScriptReader({
      account: { botId: "b-1" },
      readHandlerScript,
      listBots: vi.fn(async () => []),
    });

    const result = await reader!();
    expect(readHandlerScript).toHaveBeenCalledTimes(2);
    expect(result[0]).toEqual({ type: "message_handler", script: script(), error: undefined });
    expect(result[1]).toEqual({
      type: "mention_handler",
      error: "the handler read threw an unexpected error",
    });
    expect(JSON.stringify(result[1])).not.toContain(leaked);
    const diagnostic = checkCliqHandlerConsistency({
      handlers: result,
      configSecret: SECRET,
      expectedWebhookUrl: HOOK_URL,
    });
    expect(diagnostic.status).toBe("skipped");
    expect(diagnostic.detail).not.toContain(SECRET);
    expect(diagnostic.detail).not.toContain(leaked);
  });

  it("warns that a green preflight with a skipped check does not prove Zoho has the same secret", () => {
    const lines = formatCliqPreflightReport({
      ok: true,
      url: HOOK_URL,
      nonce: "n",
      dispatched: false,
      stages: [
        {
          id: "handler_secret",
          label: "Zoho handler secret and URL consistency",
          status: "skipped",
          detail: "not read",
        },
      ],
    });

    expect(lines.join("\n")).toMatch(/does NOT prove Zoho holds the same webhook secret/i);
    const readme = readFileSync(join(new URL(".", import.meta.url).pathname, "..", "README.md"), "utf8");
    expect(readme).toMatch(/does \*\*not\*\* prove Zoho holds/i);
  });
});

describe("proposeCliqHandlerUrlAdoption (issue #172)", () => {
  it("proposes the URL when both handlers agree on one valid HTTPS /cliq/webhook and matching secrets", () => {
    const result = proposeCliqHandlerUrlAdoption({
      handlers: handlers(script()),
      configSecret: SECRET,
    });
    expect(result).toEqual({ ok: true, url: HOOK_URL });
  });

  it("canonicalizes a trailing slash and host case without guessing a different host", () => {
    const result = proposeCliqHandlerUrlAdoption({
      handlers: handlers(
        script(SECRET, "https://AGENT.example.com/cliq/webhook/"),
        script(SECRET, "https://agent.example.com/cliq/webhook"),
      ),
      configSecret: SECRET,
    });
    expect(result).toEqual({ ok: true, url: HOOK_URL });
  });

  it("refuses when the two handlers post to different URLs", () => {
    const other = "https://other.example.com/cliq/webhook";
    const result = proposeCliqHandlerUrlAdoption({
      handlers: handlers(script(SECRET, other), script()),
      configSecret: SECRET,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/do not agree/i);
    expect(result.reason).toContain(other);
    expect(result.reason).toContain(HOOK_URL);
    expect(result.reason).not.toContain(SECRET);
  });

  it("refuses handler URLs that differ by query string", () => {
    const result = proposeCliqHandlerUrlAdoption({
      handlers: handlers(
        script(SECRET, `${HOOK_URL}?source=message`),
        script(SECRET, `${HOOK_URL}?source=mention`),
      ),
      configSecret: SECRET,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/do not agree/i);
  });

  it("refuses when a handler URL is missing or unrecognised", () => {
    const result = proposeCliqHandlerUrlAdoption({
      handlers: handlers(`webhookSecret = "${SECRET}";\npayload = Map();`),
      configSecret: SECRET,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/webhookUrl/i);
    expect(result.reason).not.toContain(SECRET);
  });

  it("refuses an http or non-/cliq/webhook handler URL", () => {
    const http = proposeCliqHandlerUrlAdoption({
      handlers: handlers(script(SECRET, "http://agent.example.com/cliq/webhook")),
      configSecret: SECRET,
    });
    const path = proposeCliqHandlerUrlAdoption({
      handlers: handlers(script(SECRET, "https://agent.example.com/hooks/cliq")),
      configSecret: SECRET,
    });
    expect(http.ok).toBe(false);
    expect(path.ok).toBe(false);
    if (!http.ok) expect(http.reason).toMatch(/https/i);
    if (!path.ok) expect(path.reason).toMatch(/\/cliq\/webhook/);
  });

  it("refuses when handler secret fingerprints do not match the configured webhookSecret", () => {
    const handlerSecret = "zoho-held-different-secret";
    const result = proposeCliqHandlerUrlAdoption({
      handlers: handlers(script(handlerSecret)),
      configSecret: SECRET,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/secret/i);
    expect(result.reason).toContain(fingerprintCliqSecret(SECRET));
    expect(result.reason).toContain(fingerprintCliqSecret(handlerSecret));
    expect(result.reason).not.toContain(SECRET);
    expect(result.reason).not.toContain(handlerSecret);
  });

  it("refuses when only one inbound handler could be read", () => {
    const result = proposeCliqHandlerUrlAdoption({
      handlers: [{ type: "message_handler", script: script() }],
      configSecret: SECRET,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/mention/i);
  });
});
