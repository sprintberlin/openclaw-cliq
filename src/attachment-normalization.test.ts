import { describe, expect, it } from "vitest";
import {
  extractCliqFileIdFromUrl,
  normalizeCliqAttachment,
  normalizeCliqAttachments,
} from "./attachment-normalization.js";

describe("Cliq attachment normalization", () => {
  it("keeps the observed voice-message name-only form unresolved", () => {
    expect(
      normalizeCliqAttachments(["voice-sample.wav"]),
    ).toEqual([{ fileName: "voice-sample.wav" }]);
  });

  it("extracts IDs and metadata from nested Zoho/Deluge variants", () => {
    expect(
      normalizeCliqAttachment({
        attachment: {
          data: {
            file_id: "voice-file-1",
            file_name: "voice-sample.wav",
            mime_type: "audio/wav",
          },
        },
      }),
    ).toEqual({
      fileId: "voice-file-1",
      downloadUrl: undefined,
      fileName: "voice-sample.wav",
      mimeType: "audio/wav",
      caption: undefined,
      bytes: undefined,
    });
  });

  it("extracts a Files-API id from absolute and relative download URLs", () => {
    expect(
      extractCliqFileIdFromUrl("https://cliq.zoho.eu/api/v2/files/a%20b?download=true"),
    ).toBe("a b");
    expect(extractCliqFileIdFromUrl("/api/v2/files/f-2")).toBe("f-2");
  });

  it("retains a non-Files API URL for the origin-checked client downloader", () => {
    expect(
      normalizeCliqAttachment({
        file: {
          name: "voice.wav",
          content_type: "audio/wav",
          download_url: "https://cliq.zoho.eu/api/v2/attachments/download?token=opaque",
        },
      }),
    ).toMatchObject({
      fileName: "voice.wav",
      mimeType: "audio/wav",
      downloadUrl: "https://cliq.zoho.eu/api/v2/attachments/download?token=opaque",
    });
  });

  it("does not treat an unrelated wrapper id as a file id", () => {
    expect(
      normalizeCliqAttachment({ id: "message-id", file: { name: "voice.wav" } }),
    ).toEqual({
      fileId: undefined,
      downloadUrl: undefined,
      fileName: "voice.wav",
      mimeType: undefined,
      caption: undefined,
      bytes: undefined,
    });
  });
});
