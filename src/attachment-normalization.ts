/**
 * Known Zoho Cliq / Deluge attachment representations normalized into the
 * plugin's inbound-media contract. This module has no client/runtime imports
 * so both webhook parsing and chat-history parsing can use the same rules.
 */
export interface CliqInboundAttachment {
  /** Value accepted by `GET /api/v2/files/{FILE_ID}`. */
  fileId?: string;
  /**
   * Download URL supplied by Cliq. It remains untrusted input; CliqClient
   * enforces HTTPS + the configured API origin before fetching it.
   */
  downloadUrl?: string;
  fileName?: string;
  mimeType?: string;
  caption?: string;
  /** Bytes forwarded directly as multipart by the generated Deluge handler. */
  bytes?: Uint8Array;
}

const ID_KEYS = [
  "file_id",
  "fileId",
  "attachment_id",
  "attachmentId",
  "attachmentid",
  "resource_id",
  "resourceId",
  "fileid",
] as const;

const NAME_KEYS = [
  "name",
  "file_name",
  "fileName",
  "filename",
  "original_filename",
  "originalFilename",
  "actual_name",
  "actualName",
] as const;

const TYPE_KEYS = [
  "type",
  "mime_type",
  "mimeType",
  "content_type",
  "contentType",
] as const;

const URL_KEYS = [
  "download_url",
  "downloadUrl",
  "downloadURL",
  "file_url",
  "fileUrl",
  "fileURL",
  "url",
  "href",
] as const;

const NESTED_KEYS = [
  "file",
  "attachment",
  "audio",
  "voice",
  "data",
  "content",
  "details",
  "file_details",
  "fileDetails",
  "attachment_details",
  "attachmentDetails",
  "metadata",
] as const;

const COLLECTION_KEYS = ["attachments", "files", "items", "results"] as const;
const MAX_ATTACHMENT_DEPTH = 4;
const MAX_ATTACHMENTS = 20;

function readString(
  object: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function readBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value;
  // Buffers are Uint8Arrays too. Do not accept numeric JSON arrays here: a
  // webhook must not inflate a giant attacker-controlled array into bytes.
  return undefined;
}

/** Pull a Files-API id from the documented `/api/v2/files/{id}` URL shape. */
export function extractCliqFileIdFromUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let url: URL;
  try {
    // The dummy origin lets API-relative paths be inspected without granting
    // them network authority. CliqClient performs the actual origin check.
    url = new URL(raw, "https://cliq.invalid");
  } catch {
    return undefined;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const filesIndex = parts.findIndex(
    (part, index) =>
      part === "files" && parts[index - 2] === "api" && parts[index - 1] === "v2",
  );
  const encodedId = filesIndex >= 0 ? parts[filesIndex + 1] : undefined;
  if (!encodedId) return undefined;
  try {
    return decodeURIComponent(encodedId).trim() || undefined;
  } catch {
    return encodedId.trim() || undefined;
  }
}

/**
 * Normalize one descriptor, merging metadata from bounded known wrappers.
 * Unknown object keys are not traversed, preventing arbitrary webhook trees
 * from becoming an unbounded parser or from supplying unrelated `id` fields.
 */
export function normalizeCliqAttachment(
  value: unknown,
  caption?: string,
  depth = 0,
): CliqInboundAttachment | undefined {
  if (typeof value === "string") {
    const fileName = value.trim();
    return fileName ? { fileName, caption } : undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > MAX_ATTACHMENT_DEPTH) {
    return undefined;
  }

  const object = value as Record<string, unknown>;
  let nested: CliqInboundAttachment | undefined;
  for (const key of NESTED_KEYS) {
    nested = normalizeCliqAttachment(object[key], caption, depth + 1);
    if (nested) break;
  }

  const explicitId = readString(object, ID_KEYS);
  const downloadUrl = readString(object, URL_KEYS) ?? nested?.downloadUrl;
  const fileName = readString(object, NAME_KEYS) ?? nested?.fileName;
  const mimeType = readString(object, TYPE_KEYS) ?? nested?.mimeType;
  const bytes = readBytes(object.bytes) ?? nested?.bytes;
  // Zoho's documented message file descriptor uses generic `id`. Prefer a
  // nested explicit descriptor first so wrapper/message ids cannot shadow it.
  const genericId = readString(object, ["id"]);
  const hasDirectFileShape = Boolean(
    readString(object, NAME_KEYS) ||
    readString(object, TYPE_KEYS) ||
    readBytes(object.bytes) ||
    readString(object, URL_KEYS),
  );
  const fileId = explicitId
    ?? extractCliqFileIdFromUrl(downloadUrl)
    ?? nested?.fileId
    ?? (genericId && hasDirectFileShape ? genericId : undefined);

  if (!fileId && !downloadUrl && !fileName && !bytes) return undefined;
  return {
    fileId,
    downloadUrl: downloadUrl && !fileId ? downloadUrl : undefined,
    fileName,
    mimeType,
    caption,
    bytes,
  };
}

/** Normalize arrays and the known collection wrappers, bounded to 20 files. */
export function normalizeCliqAttachments(
  value: unknown,
  caption?: string,
  depth = 0,
): CliqInboundAttachment[] {
  if (depth > MAX_ATTACHMENT_DEPTH) return [];
  if (Array.isArray(value)) {
    const out: CliqInboundAttachment[] = [];
    for (const item of value) {
      out.push(...normalizeCliqAttachments(item, caption, depth + 1));
      if (out.length >= MAX_ATTACHMENTS) return out.slice(0, MAX_ATTACHMENTS);
    }
    return out;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    for (const key of COLLECTION_KEYS) {
      if (object[key] !== undefined) {
        const nested = normalizeCliqAttachments(object[key], caption, depth + 1);
        if (nested.length > 0) return nested.slice(0, MAX_ATTACHMENTS);
      }
    }
  }
  const attachment = normalizeCliqAttachment(value, caption, depth);
  return attachment ? [attachment] : [];
}
