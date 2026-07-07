import { describe, it, expect, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareInboundMedia,
  resolveInboundAttachmentFileIds,
  mediaKindFromMime,
  sanitizeFileName,
  type CliqInboundAttachment,
} from "./inbound-media.js";

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

describe("sanitizeFileName", () => {
  it("strips path separators and trims underscore/dash edges", () => {
    expect(sanitizeFileName("photo.png")).toBe("photo.png");
    // Path separators are neutralized so the name cannot escape the media dir.
    expect(sanitizeFileName("../../etc/passwd")).toBe(".._.._etc_passwd");
    expect(sanitizeFileName("__leading")).toBe("leading");
    expect(sanitizeFileName("trailing__")).toBe("trailing");
    expect(sanitizeFileName("")).toBe("attachment");
    expect(sanitizeFileName(undefined)).toBe("attachment");
  });
});

describe("prepareInboundMedia", () => {
  it("downloads, writes, and returns media facts with a per-file path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cliq-media-unit-"));
    try {
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
        mediaDir: dir,
        messageId: "m1",
      });
      expect(downloadAttachment).toHaveBeenCalledTimes(2);
      expect(media).toHaveLength(2);
      expect(paths).toHaveLength(2);
      expect(media[0].contentType).toBe("image/png");
      expect(media[0].kind).toBe("image");
      expect(media[0].transcribed).toBeUndefined();
      expect(media[0].messageId).toBe("m1");
      expect(media[1].contentType).toBe("audio/mpeg");
      expect(media[1].kind).toBe("audio");
      expect(media[1].transcribed).toBe(false);
      // Bytes actually on disk.
      const buf = await readFile(paths[0]);
      expect(Array.from(buf)).toEqual([10, 20, 30]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("swallows a per-file download failure and continues with the rest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cliq-media-unit-"));
    try {
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
        mediaDir: dir,
        onError: (err, info) => {
          reported.push(info);
          expect(String(err)).toContain("nope");
        },
      });
      expect(calls).toEqual(["bad", "good"]);
      expect(media).toHaveLength(1);
      expect(paths).toHaveLength(1);
      expect(reported).toEqual([{ kind: "inbound-media-download", fileId: "bad" }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses the response Content-Type over the payload mime when both are present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cliq-media-unit-"));
    try {
      const downloadAttachment = vi.fn(async () => ({
        bytes: new Uint8Array([0]),
        contentType: "image/webp",
      }));
      const { media } = await prepareInboundMedia({
        attachments: [{ fileId: "f", mimeType: "application/octet-stream" }],
        client: { downloadAttachment },
        mediaDir: dir,
      });
      expect(media[0].contentType).toBe("image/webp");
      expect(media[0].kind).toBe("image");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips a name-only attachment (no fileId) without a download attempt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cliq-media-unit-"));
    try {
      const downloadAttachment = vi.fn(async () => ({
        bytes: new Uint8Array([0]),
        contentType: "image/png",
      }));
      const reported: { kind: string; fileId: string }[] = [];
      const { media, paths } = await prepareInboundMedia({
        attachments: [{ fileName: "2020_03.png" }],
        client: { downloadAttachment },
        mediaDir: dir,
        onError: (err, info) => {
          reported.push(info);
          expect(String(err)).toMatch(/no resolvable file id/);
        },
      });
      expect(downloadAttachment).not.toHaveBeenCalled();
      expect(media).toHaveLength(0);
      expect(paths).toHaveLength(0);
      expect(reported).toEqual([{ kind: "inbound-media-no-fileid", fileId: "" }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
