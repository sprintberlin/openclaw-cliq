import { promises as fs } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CliqClient } from "./client.js";

/**
 * A parsed inbound file attachment (image / file / voice) extracted from a
 * Cliq Deluge webhook payload. `fileId` is the value the Cliq Files API
 * (`GET /api/v2/files/{FILE_ID}`) downloads; `mimeType` and `fileName` are
 * best-effort from the message object; `caption` is the optional comment a
 * user may attach to a file share.
 */
export interface CliqInboundAttachment {
  fileId: string;
  fileName?: string;
  mimeType?: string;
  caption?: string;
}

/** Coarse media kind a channel reports to the agent context. */
export type CliqInboundMediaKind =
  | "image"
  | "video"
  | "audio"
  | "document"
  | "unknown";

/**
 * Media facts handed to the OpenClaw inbound context. This mirrors the SDK's
 * internal `InboundMediaFacts` shape (`path` / `url` / `contentType` / `kind`
 * / `transcribed` / `messageId`) — kept as a local structural type so we do
 * not import an internal SDK symbol. `path` is a local file path the runtime
 * media-understanding pipeline reads from; `url` is unused for Cliq (the file
 * is fetched behind the bot token, not a public URL) but the field is kept for
 * shape compatibility.
 */
export interface CliqInboundMediaFacts {
  path?: string;
  url?: string;
  contentType?: string;
  kind?: CliqInboundMediaKind;
  transcribed?: boolean;
  messageId?: string;
}

/** Derive the coarse media kind from a MIME type (defensive — empty → unknown). */
export function mediaKindFromMime(mimeType?: string): CliqInboundMediaKind {
  if (!mimeType) return "unknown";
  const m = mimeType.toLowerCase().split(";")[0].trim();
  if (!m) return "unknown";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (
    m === "application/pdf" ||
    m.startsWith("text/") ||
    m.includes("document") ||
    m.includes("spreadsheet") ||
    m.includes("presentation") ||
    m === "application/zip"
  ) {
    return "document";
  }
  return "unknown";
}

/** Sanitize an arbitrary user-supplied file name into a safe on-disk basename. */
export function sanitizeFileName(name?: string): string {
  if (!name) return "attachment";
  const base = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[_-]+|[_-]+$/g, "");
  const trimmed = base.slice(0, 64);
  return trimmed || "attachment";
}

const MIME_TO_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/ogg": ".ogg",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "application/json": ".json",
  "text/csv": ".csv",
  "application/zip": ".zip",
};

/**
 * Pick a sensible file extension from a MIME type, falling back to the
 * extension of the original file name (when the MIME type is unknown / generic).
 * Returns `""` (no extension) when neither yields one.
 */
function inferExt(mimeType?: string, fileName?: string): string {
  if (mimeType) {
    const m = mimeType.toLowerCase().split(";")[0].trim();
    if (MIME_TO_EXT[m]) return MIME_TO_EXT[m];
  }
  if (fileName) {
    const dot = fileName.lastIndexOf(".");
    if (dot >= 0 && dot < fileName.length - 1) {
      const ext = fileName.slice(dot).toLowerCase();
      if (/^\.[a-z0-9]{1,8}$/.test(ext)) return ext;
    }
  }
  return "";
}

export interface PrepareInboundMediaParams {
  attachments: CliqInboundAttachment[];
  client: Pick<CliqClient, "downloadAttachment">;
  /** Directory to write downloaded attachments into (must already exist). */
  mediaDir: string;
  /** The inbound message id (attached to each media fact for correlation). */
  messageId?: string;
  /** Per-attachment failure sink — never throws; a failed download degrades to no media for that attachment. */
  onError?: (err: unknown, info: { kind: string; fileId: string }) => void;
}

export interface PreparedInboundMedia {
  media: CliqInboundMediaFacts[];
  /** Local file paths written this call (for tests / cleanup). */
  paths: string[];
}

/**
 * Download each inbound attachment via the Cliq Files API, write the bytes to
 * `mediaDir`, and build {@link CliqInboundMediaFacts} for each. A per-attachment
 * failure (download rejected, write error) is swallowed and reported via
 * `onError` — the turn always proceeds with whatever attachments did download.
 * Voice (`audio/*`) entries are marked `transcribed: false`; the runtime media
 * understanding pipeline (when configured) handles transcription.
 */
export async function prepareInboundMedia(
  params: PrepareInboundMediaParams,
): Promise<PreparedInboundMedia> {
  const media: CliqInboundMediaFacts[] = [];
  const paths: string[] = [];
  for (const attachment of params.attachments) {
    try {
      const fetched = await params.client.downloadAttachment(attachment.fileId);
      const contentType = fetched.contentType ?? attachment.mimeType;
      const kind = mediaKindFromMime(contentType);
      const ext = inferExt(contentType, attachment.fileName);
      const baseName = sanitizeFileName(attachment.fileName);
      const fileName = `${baseName}-${randomUUID()}${ext}`;
      const filePath = join(params.mediaDir, fileName);
      await fs.writeFile(filePath, fetched.bytes);
      paths.push(filePath);
      media.push({
        path: filePath,
        contentType,
        kind,
        transcribed: kind === "audio" ? false : undefined,
        messageId: params.messageId,
      });
    } catch (err) {
      params.onError?.(err, {
        kind: "inbound-media-download",
        fileId: attachment.fileId,
      });
    }
  }
  return { media, paths };
}
