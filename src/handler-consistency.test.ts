import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkCliqHandlerConsistency,
  createCliqHandlerScriptReader,
  extractDelugeStringAssignment,
  fingerprintCliqSecret,
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
    });

    expect(reader).toBeNull();
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
