import { promises as fs } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CliqChatMessageRef, CliqClient } from "./client.js";

/**
 * A parsed inbound file attachment (image / file / voice) extracted from a
 * Cliq Deluge webhook payload. `fileId` is the value the Cliq Files API
 * (`GET /api/v2/files/{FILE_ID}`) downloads; `mimeType` and `fileName` are
 * best-effort from the message object; `caption` is the optional comment a
 * user may attach to a file share.
 *
 * A Cliq **bot Message handler** delivers `attachments` as an array of bare
 * file-name strings (no id, no MIME) — see issue #84. Such an entry is parsed
 * with `fileId` unset and `fileName` only; the file id is recovered best-effort
 * via {@link resolveInboundAttachmentFileIds} (a chat-messages lookup) before
 * download. A name-only entry that cannot be resolved still surfaces its name
 * to the agent (body `<file: <name>>`) so the turn is useful instead of empty.
 */
export interface CliqInboundAttachment {
  fileId?: string;
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
 *
 * A name-only attachment (no `fileId`, e.g. a bot-handler `attachments` string
 * that could not be resolved to a file id) is skipped without a download
 * attempt and reported as `kind: "inbound-media-no-fileid"` so the caller can
 * observe it; the turn still dispatches with whatever attachments did resolve.
 */
export async function prepareInboundMedia(
  params: PrepareInboundMediaParams,
): Promise<PreparedInboundMedia> {
  const media: CliqInboundMediaFacts[] = [];
  const paths: string[] = [];
  for (const attachment of params.attachments) {
    const fileId = attachment.fileId?.trim();
    if (!fileId) {
      params.onError?.(
        new Error(`cliq: attachment "${attachment.fileName ?? "?"}" has no resolvable file id`),
        { kind: "inbound-media-no-fileid", fileId: "" },
      );
      continue;
    }
    try {
      const fetched = await params.client.downloadAttachment(fileId);
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
        fileId,
      });
    }
  }
  return { media, paths };
}

/**
 * Best-effort resolve the Cliq file id for name-only attachments (entries a
 * bot Message handler delivered as bare file-name strings — see issue #84).
 * The uploaded file exists as a `type: "file"` message in the chat, so
 * `GET /api/v2/chats/{chatId}/messages` (scope `ZohoCliq.Messages.READ`,
 * user-context refresh-token grant) returns it with its
 * `content.file.{id,name,type}`. Each name-only attachment is matched by file
 * name (fallback: the most recent `type:"file"` message) and enriched with a
 * real `fileId` so {@link prepareInboundMedia} can download it.
 *
 * Never throws — a fetch failure or no-match degrades to "no media for that
 * attachment" (the name still surfaces to the agent). Only runs when at least
 * one attachment is name-only, a `chatId` is present, and a refresh token is
 * configured (the chat-messages read needs a user-consented scope the
 * `client_credentials` grant cannot obtain). Time-boxed by the
 * `recentMessagesLimit` window (default 50).
 */
export async function resolveInboundAttachmentFileIds(params: {
  attachments: CliqInboundAttachment[];
  client: {
    listChatMessages: (
      chatId: string,
      opts?: { limit?: number },
    ) => Promise<CliqChatMessageRef[]>;
  };
  chatId?: string;
  /** When false, the fetch is skipped (no refresh token configured). */
  canReadChatMessages: boolean;
  /** Cap on the recent-messages window fetched for matching (default 50). */
  recentMessagesLimit?: number;
  onError?: (err: unknown, info: { kind: string }) => void;
}): Promise<CliqInboundAttachment[]> {
  const hasNameOnly = params.attachments.some((a) => !a.fileId?.trim());
  if (!hasNameOnly) return params.attachments;
  if (!params.canReadChatMessages) return params.attachments;
  const chatId = params.chatId?.trim();
  if (!chatId) return params.attachments;

  let messages: CliqChatMessageRef[];
  try {
    messages = await params.client.listChatMessages(chatId, {
      limit: params.recentMessagesLimit ?? 50,
    });
  } catch (err) {
    params.onError?.(err, { kind: "inbound-media-fileid-fetch" });
    return params.attachments;
  }

  // Index file messages by name for O(1) name matching; track the most
  // recent file message as a fallback when a name does not match.
  const byName = new Map<string, CliqChatMessageRef>();
  let latestFile: CliqChatMessageRef | undefined;
  for (const m of messages) {
    const file = m.file;
    if (!file?.id) continue;
    const name = file.name?.trim();
    if (name && !byName.has(name)) byName.set(name, m);
    if (!latestFile) latestFile = m;
  }

  return params.attachments.map((a) => {
    if (a.fileId?.trim()) return a;
    const name = a.fileName?.trim();
    const matched = name ? byName.get(name) : undefined;
    const ref = matched ?? latestFile;
    const fileId = ref?.file?.id?.trim();
    if (!fileId) return a;
    return {
      ...a,
      fileId,
      fileName: a.fileName ?? ref?.file?.name,
      mimeType: a.mimeType ?? ref?.file?.type,
    };
  });
}
