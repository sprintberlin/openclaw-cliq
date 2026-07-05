import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CliqClient } from "./client.js";
import { setCliqDefaultLogger, truncateForLog } from "./logger.js";

/**
 * Outbound send observability (issue #25). The outbound Cliq API call must be
 * visible in the gateway log: target kind + resolved id + text length on send,
 * HTTP status + message id on success, HTTP status + truncated body on a
 * non-2xx. None of the log lines may carry the OAuth token, clientSecret, or
 * webhook secret, and never the full message text.
 */
describe("CliqClient outbound logging (issue #25)", () => {
  let restoreFetch: (() => void) | null = null;

  beforeEach(() => {
    // The default logger is the console fallback; reset it so a prior test's
    // `setCliqDefaultLogger(null)` cannot leak into these cases. The tests
    // below pass an explicit logger to the constructor, so the default is not
    // consulted — but resetting keeps the surface clean.
    setCliqDefaultLogger(null);
  });

  afterEach(() => {
    if (restoreFetch) {
      restoreFetch();
      restoreFetch = null;
    }
  });

  function mockFetch(opts: {
    oauthStatus?: number;
    oauthBody?: unknown;
    sendStatus?: number;
    sendBody?: string;
  }): void {
    const original = globalThis.fetch;
    const oauthStatus = opts.oauthStatus ?? 200;
    const oauthBody = opts.oauthBody ?? { access_token: "ACCESS_TOKEN_VALUE_xyz", expires_in: 3600 };
    const sendStatus = opts.sendStatus ?? 200;
    const sendBody = opts.sendBody ?? JSON.stringify({ id: "msg-1" });
    globalThis.fetch = (async (url: URL | string) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/oauth/v2/token")) {
        return new Response(JSON.stringify(oauthBody), { status: oauthStatus });
      }
      return new Response(sendBody, { status: sendStatus });
    }) as typeof fetch;
    restoreFetch = () => {
      globalThis.fetch = original;
    };
  }

  it("logs target kind + resolved id + text length on send, then status + messageId on 2xx", async () => {
    const logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    const calls: { level: keyof typeof logger; msg: string }[] = [];
    for (const level of ["debug", "info", "warn", "error"] as const) {
      (logger as Record<string, (m: string) => void>)[level] = (msg: string) => {
        calls.push({ level, msg });
      };
    }
    mockFetch({ sendBody: JSON.stringify({ id: "msg-xyz" }) });

    const client = new CliqClient("id", "secret", "bot", undefined, undefined, {
      maxAttempts: 1,
      baseDelayMs: 1,
      maxDelayMs: 1,
      sleep: async () => {},
      random: () => 0,
    }, logger);

    const result = await client.sendMessage({ to: "user-7", isDm: true, text: "hello world" });
    expect(result.messageId).toBe("msg-xyz");

    // Pre-send log carries kind + id + text length (NOT the text itself).
    const sendLog = calls.find((c) => c.level === "info" && c.msg.includes("[cliq] send:"));
    expect(sendLog).toBeDefined();
    expect(sendLog!.msg).toContain("dm");
    expect(sendLog!.msg).toContain("id=user-7");
    expect(sendLog!.msg).toContain("textLen=11");
    expect(sendLog!.msg).not.toContain("hello world");

    // Success log carries status + messageId.
    const okLog = calls.find((c) => c.level === "info" && c.msg.includes("[cliq] send ok:"));
    expect(okLog).toBeDefined();
    expect(okLog!.msg).toContain("status=200");
    expect(okLog!.msg).toContain("messageId=msg-xyz");

    // The access token value must NEVER appear in any log line (only the
    // word "token" in the oauth flow labels is permitted).
    for (const c of calls) {
      expect(c.msg).not.toContain("ACCESS_TOKEN_VALUE_xyz");
    }
  });

  it("logs status + truncated body on a non-2xx send response", async () => {
    const calls: { level: string; msg: string }[] = [];
    const logger = {
      debug: (m: string) => calls.push({ level: "debug", msg: m }),
      info: (m: string) => calls.push({ level: "info", msg: m }),
      warn: (m: string) => calls.push({ level: "warn", msg: m }),
      error: (m: string) => calls.push({ level: "error", msg: m }),
    };
    // 400 format_rejected → CliqSendError thrown, but the warn line is
    // emitted inside the retry attempt callback before the throw.
    const longBody = "invalid markdown format: " + "x".repeat(800);
    mockFetch({ sendStatus: 400, sendBody: longBody });

    const client = new CliqClient("id", "secret", "bot", undefined, undefined, {
      maxAttempts: 1,
      baseDelayMs: 1,
      maxDelayMs: 1,
      sleep: async () => {},
      random: () => 0,
    }, logger);

    await expect(
      client.sendMessage({ to: "chan-1", isDm: false, text: "**bad**" }),
    ).rejects.toThrow(/cliq: send failed/);

    const warnLog = calls.find((c) => c.level === "warn" && c.msg.includes("[cliq] send non-2xx:"));
    expect(warnLog).toBeDefined();
    expect(warnLog!.msg).toContain("status=400");
    expect(warnLog!.msg).toContain("channel");
    expect(warnLog!.msg).toContain("id=chan-1");
    // Body must be present but truncated (the full 820-byte body must not
    // appear verbatim — it should carry the truncation marker).
    expect(warnLog!.msg).not.toContain("x".repeat(800));
    expect(warnLog!.msg).toContain("…(");
  });

  it("logs OAuth token fetch failures with status + body, without the secret", async () => {
    const calls: { level: string; msg: string }[] = [];
    const logger = {
      debug: (m: string) => calls.push({ level: "debug", msg: m }),
      info: (m: string) => calls.push({ level: "info", msg: m }),
      warn: (m: string) => calls.push({ level: "warn", msg: m }),
      error: (m: string) => calls.push({ level: "error", msg: m }),
    };
    mockFetch({ oauthStatus: 401, oauthBody: { error: "invalid_client" } });

    const client = new CliqClient("id", "CLIENT_SECRET_VALUE_xyz", "bot", undefined, undefined, {
      maxAttempts: 1,
      baseDelayMs: 1,
      maxDelayMs: 1,
      sleep: async () => {},
      random: () => 0,
    }, logger);

    await expect(
      client.sendMessage({ to: "user-1", isDm: true, text: "hi" }),
    ).rejects.toThrow(/OAuth token request failed/);

    const errLog = calls.find((c) => c.level === "error" && c.msg.includes("[cliq] oauth:"));
    expect(errLog).toBeDefined();
    expect(errLog!.msg).toContain("status=401");
    // The client_secret must never appear in any log line.
    for (const c of calls) {
      expect(c.msg).not.toContain("CLIENT_SECRET_VALUE_xyz");
    }
  });

  it("logs edit send/edit status with chatId + messageId", async () => {
    const calls: { level: string; msg: string }[] = [];
    const logger = {
      debug: (m: string) => calls.push({ level: "debug", msg: m }),
      info: (m: string) => calls.push({ level: "info", msg: m }),
      warn: (m: string) => calls.push({ level: "warn", msg: m }),
      error: (m: string) => calls.push({ level: "error", msg: m }),
    };
    mockFetch({
      sendBody: JSON.stringify({ message_id: "m-1", chat_id: "CT_x" }),
    });

    const client = new CliqClient("id", "secret", "bot", undefined, undefined, {
      maxAttempts: 1,
      baseDelayMs: 1,
      maxDelayMs: 1,
      sleep: async () => {},
      random: () => 0,
    }, logger);

    await client.editMessage({ chatId: "CT_chat1", messageId: "m-1", text: "*updated*" });

    const editLog = calls.find((c) => c.level === "info" && c.msg.includes("[cliq] edit:"));
    expect(editLog).toBeDefined();
    expect(editLog!.msg).toContain("chatId=CT_chat1");
    expect(editLog!.msg).toContain("messageId=m-1");
    expect(editLog!.msg).toContain("textLen=9");

    const okLog = calls.find((c) => c.level === "info" && c.msg.includes("[cliq] edit ok:"));
    expect(okLog).toBeDefined();
    expect(okLog!.msg).toContain("status=200");
  });
});

describe("truncateForLog", () => {
  it("returns short bodies verbatim", () => {
    expect(truncateForLog("short")).toBe("short");
  });

  it("truncates long bodies with a byte-count marker", () => {
    const long = "x".repeat(800);
    const out = truncateForLog(long, 100);
    expect(out.length).toBeLessThan(long.length);
    expect(out).toContain("…(800 bytes)");
    expect(out.startsWith("x".repeat(100))).toBe(true);
  });

  it("honors a custom max", () => {
    const out = truncateForLog("0123456789", 5);
    expect(out).toBe("01234…(10 bytes)");
  });
});
