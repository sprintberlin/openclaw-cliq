const { saveMediaBufferMock } = vi.hoisted(() => ({
  saveMediaBufferMock: vi.fn(async (
    _buffer: Buffer,
    contentType?: string,
    _subdir?: string,
    _maxBytes?: number,
    originalFilename?: string,
  ) => ({
    id: `mock-${originalFilename ?? "file"}`,
    path: `/mocked/media-store/inbound/${originalFilename ?? "file"}`,
    size: 4,
    contentType,
  })),
}));

vi.mock("openclaw/plugin-sdk/media-store", () => ({
  saveMediaBuffer: saveMediaBufferMock,
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  prepareInboundMedia,
  resolveInboundAttachmentFileIds,
  mediaKindFromMime,
  type CliqInboundAttachment,
} from "./inbound-media.js";

vi.mock("openclaw/plugin-sdk/media-store", () => ({
  saveMediaBuffer: saveMediaBufferMock,
}));

beforeEach(() => {
  saveMediaBufferMock.mockClear();
});

describe("mediaKindFromMime", () => {
  it("classifies image/video/audio and falls back to document/unknown", () => {
    expect(mediaKindFromMime("image/png")).toBe("image");
    expect(mediaKindFromMime("image/jpeg; charset=binary")).toBe("image");
    expect(mediaKindFromMime("video/mp4")).toBe("video");
    expect(mediaKindFromMime("audio/mpeg")).toBe("audio");
    expect(mediaKindFromMime("application/pdf")).toBe("document");
    expect(mediaKindFromMime("text/plain")).toBe("document");
    expect(mediaKindFromMime("application/octet-stream")).toBe("unknown");
    expect(mediaKindFromMime("")).toBe("unknown");
    expect(mediaKindFromMime(undefined)).toBe("unknown");
  });
});

describe("prepareInboundMedia", () => {
  it("downloads, stages via saveMediaBuffer, and returns media facts", async () => {
    const downloadAttachment = vi.fn(async (fileId: string) => ({
      bytes: new Uint8Array([10, 20, 30]),
      contentType: fileId === "voice-1" ? "audio/mpeg" : "image/png",
    }));
    const attachments: CliqInboundAttachment[] = [
      { fileId: "img-1", fileName: "photo.png", mimeType: "image/png" },
      { fileId: "voice-1", fileName: "voice.mp3", mimeType: "audio/mpeg" },
    ];
    const { media, paths } = await prepareInboundMedia({
      attachments,
      client: { downloadAttachment },
      messageId: "m1",
    });
    expect(downloadAttachment).toHaveBeenCalledTimes(2);
    expect(saveMediaBufferMock).toHaveBeenCalledTimes(2);
    // First call: image
    expect(saveMediaBufferMock.mock.calls[0][0]).toBeInstanceOf(Buffer);
    expect(saveMediaBufferMock.mock.calls[0][1]).toBe("image/png");
    expect(saveMediaBufferMock.mock.calls[0][2]).toBe("inbound");
    expect(saveMediaBufferMock.mock.calls[0][4]).toBe("photo.png");
    // Second call: audio
    expect(saveMediaBufferMock.mock.calls[1][1]).toBe("audio/mpeg");
    expect(saveMediaBufferMock.mock.calls[1][4]).toBe("voice.mp3");
    expect(media).toHaveLength(2);
    expect(paths).toHaveLength(2);
    expect(media[0].contentType).toBe("image/png");
    expect(media[0].kind).toBe("image");
    expect(media[0].transcribed).toBeUndefined();
    expect(media[0].messageId).toBe("m1");
    expect(media[0].path).toBe("/mocked/media-store/inbound/photo.png");
    expect(media[1].contentType).toBe("audio/mpeg");
    expect(media[1].kind).toBe("audio");
    expect(media[1].transcribed).toBe(false);
  });

  it("swallows a per-file download failure and continues with the rest", async () => {
    const calls: string[] = [];
    const downloadAttachment = vi.fn(async (fileId: string) => {
      calls.push(fileId);
      if (fileId === "bad") throw new Error("nope");
      return { bytes: new Uint8Array([1]), contentType: "image/png" };
    });
    const reported: { kind: string; fileId: string }[] = [];
    const { media, paths } = await prepareInboundMedia({
      attachments: [
        { fileId: "bad", fileName: "x.png" },
        { fileId: "good", fileName: "y.png" },
      ],
      client: { downloadAttachment },
      onError: (err, info) => {
        reported.push(info);
        expect(String(err)).toContain("nope");
      },
    });
    expect(calls).toEqual(["bad", "good"]);
    expect(media).toHaveLength(1);
    expect(paths).toHaveLength(1);
    expect(reported).toEqual([{ kind: "inbound-media-download", fileId: "bad" }]);
    // saveMediaBuffer called only for the successful download.
    expect(saveMediaBufferMock).toHaveBeenCalledTimes(1);
  });

  it("uses the response Content-Type over the payload mime when both are present", async () => {
    const downloadAttachment = vi.fn(async () => ({
      bytes: new Uint8Array([0]),
      contentType: "image/webp",
    }));
    const { media } = await prepareInboundMedia({
      attachments: [{ fileId: "f", mimeType: "application/octet-stream" }],
      client: { downloadAttachment },
    });
    expect(media[0].contentType).toBe("image/webp");
    expect(media[0].kind).toBe("image");
    // saveMediaBuffer receives the response content-type.
    expect(saveMediaBufferMock.mock.calls[0][1]).toBe("image/webp");
  });

  it("falls back to the attachment mimeType when the download has no content-type", async () => {
    const downloadAttachment = vi.fn(async () => ({
      bytes: new Uint8Array([0]),
      contentType: undefined,
    }));
    const { media } = await prepareInboundMedia({
      attachments: [{ fileId: "f", mimeType: "image/gif" }],
      client: { downloadAttachment },
    });
    expect(media[0].contentType).toBe("image/gif");
    // saveMediaBuffer receives the resolved contentType (fetched ?? attachment).
    expect(saveMediaBufferMock.mock.calls[0][1]).toBe("image/gif");
  });

  it("skips a name-only attachment (no fileId) without a download attempt", async () => {
    const downloadAttachment = vi.fn(async () => ({
      bytes: new Uint8Array([0]),
      contentType: "image/png",
    }));
    const reported: { kind: string; fileId: string }[] = [];
    const { media, paths } = await prepareInboundMedia({
      attachments: [{ fileName: "2020_03.png" }],
      client: { downloadAttachment },
      onError: (err, info) => {
        reported.push(info);
        expect(String(err)).toMatch(/no resolvable file id/);
      },
    });
    expect(downloadAttachment).not.toHaveBeenCalled();
    expect(saveMediaBufferMock).not.toHaveBeenCalled();
    expect(media).toHaveLength(0);
    expect(paths).toHaveLength(0);
    expect(reported).toEqual([{ kind: "inbound-media-no-fileid", fileId: "" }]);
  });
});

describe("resolveInboundAttachmentFileIds (issue #84)", () => {
  it("resolves a name-only attachment's fileId by matching the file name", async () => {
    const listChatMessages = vi.fn(async () => [
      {
        messageId: "m-text",
        chatId: "CT_dm",
        text: "hi",
      },
      {
        messageId: "m-file",
        chatId: "CT_dm",
        file: { id: "fileid-1", name: "2020_03.png", type: "image/png" },
      },
    ]);
    const out = await resolveInboundAttachmentFileIds({
      attachments: [{ fileName: "2020_03.png" }],
      client: { listChatMessages },
      chatId: "CT_dm",
      canReadChatMessages: true,
    });
    expect(listChatMessages).toHaveBeenCalledWith("CT_dm", { limit: 50 });
    expect(out).toEqual([
      {
        fileName: "2020_03.png",
        fileId: "fileid-1",
        mimeType: "image/png",
      },
    ]);
  });

  it("falls back to the most recent file message when no name matches", async () => {
    const listChatMessages = vi.fn(async () => [
      { messageId: "m", chatId: "CT_dm", file: { id: "latest-id", name: "other.png" } },
    ]);
    const out = await resolveInboundAttachmentFileIds({
      attachments: [{ fileName: "mystery.png" }],
      client: { listChatMessages },
      chatId: "CT_dm",
      canReadChatMessages: true,
    });
    expect(out[0].fileId).toBe("latest-id");
  });

  it("is a no-op when all attachments already have a fileId (no API call)", async () => {
    const listChatMessages = vi.fn(async () => []);
    const out = await resolveInboundAttachmentFileIds({
      attachments: [{ fileId: "f1", fileName: "a.png" }],
      client: { listChatMessages },
      chatId: "CT_dm",
      canReadChatMessages: true,
    });
    expect(listChatMessages).not.toHaveBeenCalled();
    expect(out[0].fileId).toBe("f1");
  });

  it("is a no-op without a refresh token (canReadChatMessages false)", async () => {
    const listChatMessages = vi.fn(async () => []);
    const out = await resolveInboundAttachmentFileIds({
      attachments: [{ fileName: "a.png" }],
      client: { listChatMessages },
      chatId: "CT_dm",
      canReadChatMessages: false,
    });
    expect(listChatMessages).not.toHaveBeenCalled();
    expect(out[0].fileId).toBeUndefined();
  });

  it("is a no-op without a chatId", async () => {
    const listChatMessages = vi.fn(async () => []);
    const out = await resolveInboundAttachmentFileIds({
      attachments: [{ fileName: "a.png" }],
      client: { listChatMessages },
      chatId: undefined,
      canReadChatMessages: true,
    });
    expect(listChatMessages).not.toHaveBeenCalled();
    expect(out[0].fileId).toBeUndefined();
  });

  it("degrades to name-only when the fetch throws (never breaks)", async () => {
    const listChatMessages = vi.fn(async () => {
      throw new Error("api down");
    });
    const reported: { kind: string }[] = [];
    const out = await resolveInboundAttachmentFileIds({
      attachments: [{ fileName: "a.png" }],
      client: { listChatMessages },
      chatId: "CT_dm",
      canReadChatMessages: true,
      onError: (err, info) => {
        reported.push(info);
        expect(String(err)).toMatch(/api down/);
      },
    });
    expect(out[0].fileId).toBeUndefined();
    expect(reported).toEqual([{ kind: "inbound-media-fileid-fetch" }]);
  });

  it("degrades to name-only when no file message is found", async () => {
    const listChatMessages = vi.fn(async () => [
      { messageId: "m", chatId: "CT_dm", text: "just text" },
    ]);
    const out = await resolveInboundAttachmentFileIds({
      attachments: [{ fileName: "a.png" }],
      client: { listChatMessages },
      chatId: "CT_dm",
      canReadChatMessages: true,
    });
    expect(out[0].fileId).toBeUndefined();
  });
});
