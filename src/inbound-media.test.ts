import { describe, it, expect, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareInboundMedia,
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
});
