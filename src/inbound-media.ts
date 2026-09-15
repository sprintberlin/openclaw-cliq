import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import type { CliqChatMessageRef, CliqClient } from "./client.js";
import type { CliqInboundAttachment } from "./attachment-normalization.js";

/**
 * A parsed inbound file attachment (image / file / voice) extracted from a
 * Cliq Deluge webhook payload. `fileId` is the value the Cliq Files API
 * (`GET /api/v2/files/{FILE_ID}`) downloads; `mimeType` and `fileName` are
 * best-effort from the message object; `caption` is the optional comment a
 * user may attach to a file share.
 *
 * Legacy JSON-only Message handlers can reduce Deluge FILE objects to names.
 * Those entries use the history resolver; current generated handlers forward
 * bytes directly as multipart, and structured ID/URL descriptors download via
 * the Cliq API client. An unresolved name still reaches the agent body.
 */
export type { CliqInboundAttachment } from "./attachment-normalization.js";

/** Coarse media kind a channel reports to the agent context. */
export type CliqInboundMediaKind =
  | "image"
  | "video"
  | "audio"
  | "document"
  | "unknown";

const MIME_BY_EXTENSION: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  flac: "audio/flac",
  webm: "audio/webm",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  html: "text/html",
  htm: "text/html",
  xml: "text/xml",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  zip: "application/zip",
};

function inferInboundMimeType(fileName?: string): string | undefined {
  const extension = fileName?.trim().toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return extension ? MIME_BY_EXTENSION[extension] : undefined;
}

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

export interface PrepareInboundMediaParams {
  attachments: CliqInboundAttachment[];
  client: Pick<CliqClient, "downloadAttachment"> &
    Partial<Pick<CliqClient, "downloadAttachmentUrl">>;
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
 * Download each inbound attachment via the Cliq Files API, stage the bytes
 * into the media-store `inbound` bucket via {@link saveMediaBuffer}, and
 * build {@link CliqInboundMediaFacts} for each. A per-attachment failure
 * (download rejected, staging error) is swallowed and reported via
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
    const downloadUrl = attachment.downloadUrl?.trim();
    if (!fileId && !downloadUrl && !attachment.bytes) {
      params.onError?.(
        new Error(`cliq: attachment "${attachment.fileName ?? "?"}" has no resolvable file id`),
        { kind: "inbound-media-no-fileid", fileId: "" },
      );
      continue;
    }
    try {
      const fetched = attachment.bytes
        ? {
            bytes: attachment.bytes,
            contentType: attachment.mimeType ?? inferInboundMimeType(attachment.fileName),
          }
        : fileId
          ? await params.client.downloadAttachment(fileId)
          : params.client.downloadAttachmentUrl
            ? await params.client.downloadAttachmentUrl(downloadUrl!)
            : (() => {
                throw new Error("cliq: attachment URL downloader is unavailable");
              })();
      const contentType = fetched.contentType
        ?? attachment.mimeType
        ?? inferInboundMimeType(attachment.fileName);
      const kind = mediaKindFromMime(contentType);
      const saved = await saveMediaBuffer(
        Buffer.from(fetched.bytes),
        contentType,
        "inbound",
        undefined,
        attachment.fileName ?? undefined,
      );
      paths.push(saved.path);
      media.push({
        path: saved.path,
        contentType: saved.contentType ?? contentType,
        kind,
        transcribed: kind === "audio" ? false : undefined,
        messageId: params.messageId,
      });
    } catch (err) {
      params.onError?.(err, {
        kind: "inbound-media-download",
        fileId: fileId ?? "",
      });
    }
  }
  return { media, paths };
}

/**
 * Best-effort resolve the Cliq file id for name-only attachments (typically
 * from legacy JSON-only handlers — see issue #84).
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
  const hasNameOnly = params.attachments.some(
    (a) => !a.fileId?.trim() && !a.downloadUrl?.trim() && !a.bytes,
  );
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
    if (!file?.id && !file?.downloadUrl) continue;
    const name = file.name?.trim();
    if (name && !byName.has(name)) byName.set(name, m);
    if (!latestFile) latestFile = m;
  }

  const unresolved = params.attachments.filter(
    (a) => !a.fileId?.trim() && !a.downloadUrl?.trim() && !a.bytes,
  );
  return params.attachments.map((a) => {
    if (a.fileId?.trim() || a.downloadUrl?.trim() || a.bytes) return a;
    const name = a.fileName?.trim();
    const matched = name ? byName.get(name) : undefined;
    // A fallback to "latest file" is safe only for one unresolved attachment.
    // Mapping several names to the same recent file would duplicate or attach
    // the wrong media when a webhook carries multiple entries.
    const ref = matched ?? (unresolved.length === 1 ? latestFile : undefined);
    const fileId = ref?.file?.id?.trim();
    const downloadUrl = ref?.file?.downloadUrl?.trim();
    if (!fileId && !downloadUrl) return a;
    return {
      ...a,
      fileId,
      downloadUrl: fileId ? undefined : downloadUrl,
      fileName: a.fileName ?? ref?.file?.name,
      mimeType: a.mimeType ?? ref?.file?.type,
    };
  });
}
