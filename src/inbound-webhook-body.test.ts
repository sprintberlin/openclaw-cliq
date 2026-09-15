import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  parseCliqMultipartBody,
  readCliqWebhookBody,
} from "./inbound-webhook-body.js";

class FakeRequest extends EventEmitter {
  headers: Record<string, string>;
  destroyed = false;

  constructor(headers: Record<string, string>) {
    super();
    this.headers = headers;
  }

  destroy() {
    this.destroyed = true;
  }

  removeAllListeners() {
    super.removeAllListeners();
    return this;
  }
}

function multipartBody(boundary: string, payload: unknown, file: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="payload"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(payload)}\r\n`,
    ),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice-sample.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
    ),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

describe("Cliq multipart webhook body", () => {
  it("keeps generated-handler JSON and binary voice bytes together", async () => {
    const boundary = "cliq-test-boundary";
    const file = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 1, 2, 13, 10]);
    const payload = {
      handler: "message",
      handlerSchema: "v4",
      message: "",
      user: { id: "u1" },
      chat: { id: "CT_dm" },
      attachments: ["voice-sample.wav"],
    };
    const body = multipartBody(boundary, payload, file);
    const request = new FakeRequest({
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(body.length),
    });
    const pending = readCliqWebhookBody(request as never);
    request.emit("data", body);
    request.emit("end");
    const result = await pending;

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(payload);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments?.[0]).toMatchObject({
      fileName: "voice-sample.wav",
      mimeType: "audio/wav",
    });
    expect(Buffer.from(result.attachments?.[0]?.bytes ?? [])).toEqual(file);
  });

  it.each<Record<string, string>>([{}, { "content-type": "application/json" }])(
    "detects the generated Deluge multipart body when Content-Type is missing or wrong: %j",
    async (headers) => {
      const boundary = "ZohoDelugeBoundary123";
      const file = Buffer.from("voice-bytes");
      const payload = {
        handler: "message",
        handlerSchema: "v4",
        message: "hello",
        user: { id: "u1" },
        chat: { id: "CT_dm" },
        attachments: ["voice.wav"],
      };
      const body = multipartBody(boundary, payload, file);
      const request = new FakeRequest(headers);
      const pending = readCliqWebhookBody(request as never);
      request.emit("data", body);
      request.emit("end");
      const result = await pending;

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual(payload);
      expect(Buffer.from(result.attachments?.[0]?.bytes ?? [])).toEqual(file);
    },
  );

  it("promotes a sniffed Deluge multipart body to the attachment-size limit", async () => {
    const boundary = "missing-content-type-big-file";
    const file = Buffer.alloc(1024 * 1024 + 4096, 1);
    const body = multipartBody(
      boundary,
      {
        handler: "message",
        handlerSchema: "v4",
        message: "file",
        user: { id: "u1" },
        chat: { id: "CT_dm" },
        attachments: ["voice-sample.wav"],
      },
      file,
    );
    const request = new FakeRequest({});
    const pending = readCliqWebhookBody(request as never);
    request.emit("data", body);
    request.emit("end");
    const result = await pending;

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachments?.[0]?.bytes?.byteLength).toBe(file.length);
  });

  it("does not grant the multipart size limit to an unrelated dashed body", async () => {
    const body = Buffer.concat([
      Buffer.from(
        "--not-multipart\r\nContent-Disposition: form-data; name=\"other\"\r\n\r\n",
      ),
      Buffer.alloc(1024 * 1024 + 1, 1),
      Buffer.from("\r\n--not-multipart--\r\n"),
    ]);
    const request = new FakeRequest({});
    const pending = readCliqWebhookBody(request as never);
    request.emit("data", body);
    await expect(pending).resolves.toEqual({ ok: false, error: "payload too large" });
    expect(request.destroyed).toBe(true);
  });

  it("rejects multipart input without the JSON payload part", () => {
    const boundary = "missing-payload";
    const body = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.wav"\r\n\r\nx\r\n--${boundary}--\r\n`,
    );
    expect(parseCliqMultipartBody(body, boundary)).toHaveLength(1);
  });

  it("fails the request when multipart input omits its JSON payload part", async () => {
    const boundary = "missing-payload-request";
    const body = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.wav"\r\n\r\nx\r\n--${boundary}--\r\n`,
    );
    const request = new FakeRequest({
      "content-type": `multipart/form-data; boundary=${boundary}`,
    });
    const pending = readCliqWebhookBody(request as never);
    request.emit("data", body);
    request.emit("end");
    await expect(pending).resolves.toEqual({
      ok: false,
      error: "invalid Cliq multipart payload",
    });
  });

  it("rejects multipart bodies larger than the configured maximum", async () => {
    const request = new FakeRequest({
      "content-type": "multipart/form-data; boundary=bounded",
    });
    const pending = readCliqWebhookBody(request as never, 4);
    request.emit("data", Buffer.from("12345"));
    const result = await pending;
    expect(result).toEqual({ ok: false, error: "payload too large" });
    expect(request.destroyed).toBe(true);
  });

  it("keeps the historical 1 MiB limit for ordinary JSON bodies", async () => {
    const request = new FakeRequest({ "content-type": "application/json" });
    const pending = readCliqWebhookBody(request as never);
    const bigJson = `{"pad":"${"x".repeat(1024 * 1024)}"}`;
    request.emit("data", Buffer.from(bigJson));
    request.emit("end");
    const result = await pending;
    expect(result).toEqual({ ok: false, error: "payload too large" });
    expect(request.destroyed).toBe(true);
  });

  it("allows a multipart body above 1 MiB under the file aggregate limit", async () => {
    const boundary = "big-file";
    const file = Buffer.alloc(1024 * 1024 + 4096, 1);
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name=\"payload\"\r\nContent-Type: application/json\r\n\r\n{\"handler\":\"message\",\"message\":\"hi\"}\r\n`,
      ),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"big.bin\"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      file,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const request = new FakeRequest({
      "content-type": `multipart/form-data; boundary=${boundary}`,
    });
    const pending = readCliqWebhookBody(request as never);
    request.emit("data", body);
    request.emit("end");
    const result = await pending;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachments?.[0]?.bytes?.byteLength).toBe(file.length);
  });
});
