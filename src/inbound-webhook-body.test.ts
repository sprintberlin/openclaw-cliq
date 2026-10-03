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

function multipartBody(
  boundary: string,
  payload: unknown,
  file: Buffer,
  payloadName = 'name="payload"',
  fileName = 'filename="voice-sample.wav"',
  lineEnding = "\r\n",
): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}${lineEnding}Content-Disposition: form-data; ${payloadName}${lineEnding}Content-Type: application/json${lineEnding}${lineEnding}${JSON.stringify(payload)}${lineEnding}`,
    ),
    Buffer.from(
      `--${boundary}${lineEnding}Content-Disposition: form-data; name="file"; ${fileName}${lineEnding}Content-Type: audio/wav${lineEnding}${lineEnding}`,
    ),
    file,
    Buffer.from(`${lineEnding}--${boundary}--${lineEnding}`),
  ]);
}

describe("Cliq multipart webhook body", () => {
  it("reconstructs a generated Deluge map sent as individual multipart fields under application/json", async () => {
    const boundary = "YSdQFera-DPm-67LPHVlBKJ-u8z09Zv";
    const fields: Array<[string, string]> = [
      ["handler", "message"],
      ["handlerSchema", "v4"],
      ["message", "Hallo"],
      ["user", JSON.stringify({ id: "20098819618", email: "user@example.test" })],
      ["chat", JSON.stringify({ id: "CT_dm", chat_type: "bot" })],
      ["eventId", "20260916165333-458069207458"],
      ["attachments", "[]"],
    ];
    const body = Buffer.from(
      fields.map(([name, value]) => [
        `--${boundary}\r\n`,
        `Content-Disposition: form-data; name="${name}"\r\n`,
        "Content-Type: text/plain; charset=UTF-8\r\n",
        "Content-Transfer-Encoding: 8bit\r\n",
        "\r\n",
        `${value}\r\n`,
      ].join("")).join("") + `--${boundary}--\r\n`,
    );
    const request = new FakeRequest({ "content-type": "application/json" });
    const pending = readCliqWebhookBody(request as never);
    request.emit("data", body.subarray(0, 663));
    request.emit("data", body.subarray(663));
    request.emit("end");
    const result = await pending;

    expect(result).toEqual({
      ok: true,
      value: {
        handler: "message",
        handlerSchema: "v4",
        message: "Hallo",
        user: { id: "20098819618", email: "user@example.test" },
        chat: { id: "CT_dm", chat_type: "bot" },
        eventId: "20260916165333-458069207458",
        attachments: [],
      },
      attachments: [],
      repaired: undefined,
    });
  });

  it("accepts a Deluge multipart body whose payload part has no Content-Disposition header", async () => {
    const boundary = "z5wrc7EOqrgWBilrODmsZENijLCo5sxmXE";
    const payload = {
      handler: "message",
      handlerSchema: "v4",
      message: "Hallo",
      user: { id: "20098819618" },
      chat: { id: "CT_dm" },
    };
    const body = Buffer.from(
      `--${boundary}
${JSON.stringify(payload)}
--${boundary}--
`,
    );
    const request = new FakeRequest({ "content-type": "application/x-www-form-urlencoded" });
    const pending = readCliqWebhookBody(request as never);
    request.emit("data", body);
    request.emit("end");
    const result = await pending;

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(payload);
  });

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

  it.each([
    { payloadName: "name=payload", fileName: "filename=voice-sample.wav" },
    { payloadName: "name='payload'", fileName: "filename='voice-sample.wav'" },
  ])(
    "accepts non-double-quoted Deluge disposition parameters: $payloadName, $fileName",
    async ({ payloadName, fileName }) => {
      const boundary = "ZohoDelugeUnquotedBoundary";
      const payload = {
        handler: "message",
        handlerSchema: "v4",
        message: "hello",
        user: { id: "u1" },
        chat: { id: "CT_dm" },
        attachments: ["voice.wav"],
      };
      const body = multipartBody(
        boundary,
        payload,
        Buffer.from("voice-bytes"),
        payloadName,
        fileName,
      );
      const request = new FakeRequest({ "content-type": "application/x-www-form-urlencoded" });
      const pending = readCliqWebhookBody(request as never);
      request.emit("data", body);
      request.emit("end");
      const result = await pending;

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual(payload);
      expect(result.attachments?.[0]?.fileName).toBe("voice-sample.wav");
    },
  );

  it.each<Record<string, string>>([
    {},
    { "content-type": "application/x-www-form-urlencoded" },
    { "content-type": "multipart/form-data; boundary=ZohoDelugeLfBoundary" },
  ])(
    "accepts an LF-only Deluge multipart body with missing or wrong Content-Type: %j",
    async (headers) => {
      const boundary = "ZohoDelugeLfBoundary";
      const payload = {
        handler: "message",
        handlerSchema: "v4",
        message: "hello",
        user: { id: "u1" },
        chat: { id: "CT_dm" },
        attachments: ["voice.wav"],
      };
      const file = Buffer.from("voice-bytes");
      const body = multipartBody(
        boundary,
        payload,
        file,
        "name=payload",
        "filename=voice-sample.wav",
        "\n",
      );
      const request = new FakeRequest(headers);
      const pending = readCliqWebhookBody(request as never);
      request.emit("data", body);
      request.emit("end");
      const result = await pending;

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual(payload);
      expect(result.attachments?.[0]?.fileName).toBe("voice-sample.wav");
      expect(Buffer.from(result.attachments?.[0]?.bytes ?? [])).toEqual(file);
    },
  );

  it.each([
    { lineEnding: "\r\n", boundary: "89FM0vgYAmCExqUnkqXjn541NYvwP1pm-" },
    { lineEnding: "\n", boundary: "-l2T2qchoIbw8WVm3pEx2UxuPaE2D-qxQktoj" },
  ])(
    "accepts a Deluge multipart body with no blank line after part headers: $boundary",
    async ({ lineEnding, boundary }) => {
      const payload = {
        handler: "message",
        handlerSchema: "v4",
        message: "hello",
        user: { id: "u1" },
        chat: { id: "CT_dm" },
        attachments: ["voice-sample.wav"],
      };
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}${lineEnding}Content-Disposition: form-data; name=payload${lineEnding}${JSON.stringify(payload)}${lineEnding}`,
        ),
        Buffer.from(
          `--${boundary}${lineEnding}Content-Disposition: form-data; name=file; filename=voice-sample.wav${lineEnding}Content-Type: audio/wav${lineEnding}`,
        ),
        Buffer.from("voice-bytes"),
        Buffer.from(`${lineEnding}--${boundary}--${lineEnding}`),
      ]);
      const request = new FakeRequest({ "content-type": "application/x-www-form-urlencoded" });
      const pending = readCliqWebhookBody(request as never);
      request.emit("data", body);
      request.emit("end");
      const result = await pending;

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual(payload);
      expect(result.attachments?.[0]?.fileName).toBe("voice-sample.wav");
      expect(Buffer.from(result.attachments?.[0]?.bytes ?? []).toString()).toBe("voice-bytes");
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

  it.each(["\r\n", "\n"])(
    "does not grant the multipart size limit to an unrelated dashed body using %j",
    async (lineEnding) => {
      const body = Buffer.concat([
        Buffer.from(
          `--not-multipart${lineEnding}Content-Disposition: form-data; name="other"${lineEnding}${lineEnding}`,
        ),
        Buffer.alloc(1024 * 1024 + 1, 1),
        Buffer.from(`${lineEnding}--not-multipart--${lineEnding}`),
      ]);
      const request = new FakeRequest({});
      const pending = readCliqWebhookBody(request as never);
      request.emit("data", body);
      await expect(pending).resolves.toEqual({ ok: false, error: "payload too large" });
      expect(request.destroyed).toBe(true);
    },
  );

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
    // The rejection names the observed part shape so an unparseable Deluge
    // framing is diagnosable from the log alone; content stays masked.
    await expect(pending).resolves.toEqual({
      ok: false,
      error:
        "multipart payload could not be parsed or reconstructed; parts=[file:file]; firstTextPart=none",
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

describe("Deluge map-literal multipart payload (issue #275)", () => {
  const boundary = "MapLiteralBoundary";
  const file = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 1, 2, 3]);

  function mapLiteralBody(literal: string, fileBytes = file): Buffer {
    return Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="payload"\r\nContent-Type: text/plain\r\n\r\n`,
      ),
      Buffer.from(literal),
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice-note.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
      fileBytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
  }

  it("keeps a map-literal payload and its binary voice bytes together", async () => {
    const literal =
      "{handler=message, handlerSchema=v4, message=, user={id=10000000001, name=Example User}, chat={id=CT_example, type=dm}, eventId=20260919185000-123456789012, attachments=[voice-note.wav]}";
    const request = new FakeRequest({
      "content-type": `multipart/form-data; boundary=${boundary}`,
    });
    const pending = readCliqWebhookBody(request as never);
    request.emit("data", mapLiteralBody(literal));
    request.emit("end");
    const result = await pending;

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      handler: "message",
      handlerSchema: "v4",
      message: "",
      user: { id: "10000000001", name: "Example User" },
      chat: { id: "CT_example", type: "dm" },
      eventId: "20260919185000-123456789012",
      attachments: ["voice-note.wav"],
    });
    expect(Buffer.from(result.attachments?.[0]?.bytes ?? [])).toEqual(file);
    expect(result.attachments?.[0]?.fileName).toBe("voice-note.wav");
  });

  it("rejects an ambiguous map-literal payload without exposing payload or file contents", async () => {
    // A caption comma re-splits into an unknown top-level key; the request
    // must fail closed and the error must contain neither text nor bytes.
    const literal =
      "{handler=message, message=alpha, beta, user={id=42}, chat={id=CT_1}}";
    const request = new FakeRequest({
      "content-type": `multipart/form-data; boundary=${boundary}`,
    });
    const pending = readCliqWebhookBody(request as never);
    request.emit("data", mapLiteralBody(literal, Buffer.from("voice-bytes")));
    request.emit("end");
    const result = await pending;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).not.toContain("alpha");
    expect(result.error).not.toContain("beta");
    expect(result.error).not.toContain("voice-bytes");
  });

  it("keeps ordinary JSON multipart behavior unchanged", async () => {
    const payload = {
      handler: "message",
      handlerSchema: "v4",
      message: "hello",
      user: { id: "u1" },
      chat: { id: "CT_dm" },
      attachments: ["voice-note.wav"],
    };
    const request = new FakeRequest({
      "content-type": `multipart/form-data; boundary=${boundary}`,
    });
    const pending = readCliqWebhookBody(request as never);
    request.emit("data", multipartBody(boundary, payload, file, 'name="payload"', 'filename="voice-note.wav"'));
    request.emit("end");
    const result = await pending;

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(payload);
    expect(Buffer.from(result.attachments?.[0]?.bytes ?? [])).toEqual(file);
  });
});

describe("v5 flat scalar field parts (issue #275)", () => {
  const flatFieldsBody = (fields: Array<[string, string]>, file: Buffer, boundary = "v5flat") =>
    Buffer.concat([
      Buffer.from(
        fields
          .map(
            ([name, value]) =>
              `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
          )
          .join(""),
      ),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="quittung-ok.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      file,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

  it("reconstructs a payload from flat scalar parts with commas, brackets, quotes and newlines in the caption", async () => {
    const file = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const caption = 'Hier die Quittung, bitte abheften; Liste: [a, b] {x=y} "so" und\nZeile zwei';
    const fields: Array<[string, string]> = [
      ["handler", "message"],
      ["handlerSchema", "v5"],
      ["message", caption],
      ["eventId", "20261003160100-123456789012"],
      ["userId", "10000000001"],
      ["userName", "Gregor Sprint"],
      ["chatId", "CT_flat_dm"],
      ["chatType", "single"],
    ];
    const body = flatFieldsBody(fields, file);
    const request = new FakeRequest({ "content-type": "multipart/form-data; boundary=v5flat" });
    const pending = readCliqWebhookBody(request as never);
    request.emit("data", body);
    request.emit("end");
    const result = await pending;

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      handler: "message",
      handlerSchema: "v5",
      message: caption,
      eventId: "20261003160100-123456789012",
      user: { id: "10000000001", name: "Gregor Sprint" },
      chat: { id: "CT_flat_dm", type: "single" },
      attachments: ["quittung-ok.png"],
    });
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments?.[0]).toMatchObject({
      fileName: "quittung-ok.png",
      mimeType: "image/png",
    });
    expect(Buffer.from(result.attachments?.[0]?.bytes ?? [])).toEqual(file);
  });

  it("rejects flat parts when userId or chatId is missing", async () => {
    const file = Buffer.from("x");
    const body = flatFieldsBody(
      [
        ["handler", "message"],
        ["handlerSchema", "v5"],
        ["message", "hi"],
        ["userId", "10000000001"],
      ],
      file,
    );
    const request = new FakeRequest({ "content-type": "multipart/form-data; boundary=v5flat" });
    const pending = readCliqWebhookBody(request as never);
    request.emit("data", body);
    request.emit("end");
    const result = await pending;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).not.toContain("hi");
  });
});
