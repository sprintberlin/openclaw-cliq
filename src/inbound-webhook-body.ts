import type { IncomingMessage } from "node:http";
import { normalizeCliqAttachment, type CliqInboundAttachment } from "./attachment-normalization.js";
import { repairDelugeUnescapedMessageBody } from "./inbound-deluge-repair.js";

export type CliqWebhookBodyReadResult =
  | { ok: true; value: unknown; repaired?: boolean; attachments?: CliqInboundAttachment[] }
  | { ok: false; error: string };

interface MultipartPart {
  name?: string;
  fileName?: string;
  contentType?: string;
  bytes: Uint8Array;
}

const CRLF = Buffer.from("\r\n");
const CRLFCRLF = Buffer.from("\r\n\r\n");
const DEFAULT_JSON_MAX_BYTES = 1024 * 1024;
const DEFAULT_MULTIPART_MAX_BYTES = 25 * 1024 * 1024;

function readHeaderValue(
  headers: IncomingMessage["headers"] | undefined,
  name: string,
): string | undefined {
  const value = headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function multipartBoundary(contentType: string): string | undefined {
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) return undefined;
  const match = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = (match?.[1] ?? match?.[2])?.trim();
  return boundary && boundary.length <= 200 ? boundary : undefined;
}

function parseDisposition(value: string): { name?: string; fileName?: string } {
  const name = /(?:^|;)\s*name="([^"]*)"/i.exec(value)?.[1];
  const encodedFileName = /(?:^|;)\s*filename\*=UTF-8''([^;\r\n]*)/i.exec(value)?.[1];
  let fileName = /(?:^|;)\s*filename="([^"]*)"/i.exec(value)?.[1];
  if (encodedFileName) {
    try {
      fileName = decodeURIComponent(encodedFileName);
    } catch {
      fileName = encodedFileName;
    }
  }
  return { name, fileName };
}

/**
 * Parse the small multipart shape emitted by the generated Deluge handler.
 * Limits are intentionally strict: the route-level body limit is the primary
 * bound, and per-part headers/part count prevent adversarial multipart growth.
 */
export function parseCliqMultipartBody(
  body: Buffer,
  boundary: string,
  maxParts = 24,
): MultipartPart[] | undefined {
  const delimiter = Buffer.from(`--${boundary}`);
  const nextDelimiter = Buffer.from(`\r\n--${boundary}`);
  const parts: MultipartPart[] = [];
  let cursor = 0;

  while (cursor < body.length && parts.length < maxParts) {
    const start = body.indexOf(delimiter, cursor);
    if (start < 0) break;
    let partStart = start + delimiter.length;
    if (body.subarray(partStart, partStart + 2).equals(Buffer.from("--"))) break;
    if (body.subarray(partStart, partStart + 2).equals(CRLF)) partStart += 2;
    const headersEnd = body.indexOf(CRLFCRLF, partStart);
    if (headersEnd < 0 || headersEnd - partStart > 16 * 1024) return undefined;
    const nextPrefix = body.indexOf(nextDelimiter, headersEnd + CRLFCRLF.length);
    if (nextPrefix < 0) return undefined;
    const next = nextPrefix + CRLF.length;
    const payloadEnd = nextPrefix;

    const rawHeaders = body.subarray(partStart, headersEnd).toString("latin1");
    const headers = new Map<string, string>();
    for (const line of rawHeaders.split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon <= 0) continue;
      headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }
    const disposition = parseDisposition(headers.get("content-disposition") ?? "");
    parts.push({
      ...disposition,
      contentType: headers.get("content-type"),
      bytes: new Uint8Array(body.subarray(headersEnd + CRLFCRLF.length, payloadEnd)),
    });
    cursor = next;
  }
  return parts.length > 0 ? parts : undefined;
}

function tryParseJson(value: string): unknown | undefined {
  const trimmed = value.trim();
  if (!trimmed || !["{", "[", '"'].includes(trimmed[0] ?? "")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/** Normalize legacy Deluge `parameters:` form bodies. */
export function normalizeFormUrlencodedBody(
  raw: string,
  headers?: IncomingMessage["headers"],
): unknown | undefined {
  const contentType = readHeaderValue(headers, "content-type");
  const isFormCt = contentType?.toLowerCase().includes("application/x-www-form-urlencoded") === true;
  const looksFormEncoded = raw.includes("=") && !raw.trimStart().startsWith("{") && !raw.trimStart().startsWith("[");
  if (!isFormCt && !looksFormEncoded) return undefined;
  try {
    const params = new URLSearchParams(raw);
    const object: Record<string, unknown> = {};
    for (const [key, value] of params.entries()) object[key] = tryParseJson(value) ?? value;
    return object;
  } catch {
    return undefined;
  }
}

function parsePayloadJson(raw: string): { value: unknown; repaired?: boolean } | undefined {
  try {
    return { value: JSON.parse(raw) };
  } catch {
    const repaired = repairDelugeUnescapedMessageBody(raw);
    return repaired === undefined ? undefined : { value: repaired, repaired: true };
  }
}

function attachMultipartFiles(
  payload: unknown,
  parts: MultipartPart[],
): { value: unknown; attachments: CliqInboundAttachment[] } {
  const payloadNames = new Set<string>();
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const raw = (payload as Record<string, unknown>).attachments;
    const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
    for (const value of values) {
      if (typeof value === "string" && value.trim()) payloadNames.add(value.trim());
    }
  }
  const attachments = parts
    .filter((part) => part.fileName)
    // Deluge appends the JSON string-part to the same `files` list. Some
    // runtimes may expose its `contentType` metadata as a filename; never
    // mistake that metadata part for user media.
    .filter((part) => part.name !== "payload" && part.name !== "metadata")
    .map((part) => normalizeCliqAttachment({
      name: part.fileName,
      type: part.contentType,
      bytes: part.bytes,
    }))
    .filter((part): part is CliqInboundAttachment => Boolean(part));
  attachments.sort((a, b) => Number(payloadNames.has(b.fileName ?? "")) - Number(payloadNames.has(a.fileName ?? "")));
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || attachments.length === 0) {
    return { value: payload, attachments };
  }
  const payloadObject = payload as Record<string, unknown>;
  const rawAttachments = payloadObject.attachments;
  if (rawAttachments === undefined || (Array.isArray(rawAttachments) && rawAttachments.length === 0)) {
    payloadObject.attachments = attachments.map((a) => a.fileName).filter(Boolean);
  }
  // Keep binary bytes outside the JSON-shaped payload. The route injects them
  // into the parsed attachment list after normal text/identity parsing.
  return { value: payload, attachments };
}

function describeBodySyntax(raw: string, maxLen = 96): string {
  const masked = raw
    .replace(/\r/g, "")
    .replace(/\n/g, "⏎")
    .replace(/[^\s⏎]/g, (character) => (/[A-Za-z0-9]/.test(character) ? "x" : character))
    .replace(/x{2,}/g, "x*")
    .replace(/\s+/g, " ");
  if (masked.length <= maxLen) return masked;
  const tailLength = Math.floor((maxLen - 1) / 2);
  const headLength = maxLen - 1 - tailLength;
  return `${masked.slice(0, headLength)}…${masked.slice(-tailLength)}`;
}

/**
 * Read JSON, legacy form, or generated-handler multipart input.
 *
 * Ordinary webhook bodies retain the historical 1 MiB limit. Only an
 * explicitly declared multipart request receives the larger aggregate limit
 * needed for file bytes; callers may pass a lower explicit limit in tests or
 * constrained integrations.
 */
export async function readCliqWebhookBody(
  req: Pick<IncomingMessage, "on" | "removeAllListeners" | "destroy"> & {
    headers?: IncomingMessage["headers"];
  },
  maxBytes?: number,
): Promise<CliqWebhookBodyReadResult> {
  const contentType = readHeaderValue(req.headers, "content-type") ?? "";
  const boundary = multipartBoundary(contentType);
  const effectiveMaxBytes = maxBytes
    ?? (boundary ? DEFAULT_MULTIPART_MAX_BYTES : DEFAULT_JSON_MAX_BYTES);
  return await new Promise((resolve) => {
    let resolved = false;
    const done = (result: CliqWebhookBodyReadResult) => {
      if (resolved) return;
      resolved = true;
      req.removeAllListeners();
      resolve(result);
    };
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > effectiveMaxBytes) {
        done({ ok: false, error: "payload too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const buffer = Buffer.concat(chunks);
      if (buffer.length === 0) {
        done({ ok: false, error: "empty payload" });
        return;
      }
      if (boundary) {
        const parts = parseCliqMultipartBody(buffer, boundary);
        const payloadPart = parts?.find((part) => part.name === "payload" || part.name === "metadata");
        if (!parts || !payloadPart) {
          done({ ok: false, error: "invalid Cliq multipart payload" });
          return;
        }
        const parsed = parsePayloadJson(Buffer.from(payloadPart.bytes).toString("utf8"));
        if (!parsed) {
          done({ ok: false, error: "multipart payload field is not valid JSON" });
          return;
        }
        const attached = attachMultipartFiles(parsed.value, parts);
        done({ ok: true, ...attached, repaired: parsed.repaired });
        return;
      }

      const raw = buffer.toString("utf8");
      const parsed = parsePayloadJson(raw);
      if (parsed) {
        done({ ok: true, ...parsed });
        return;
      }
      const normalized = normalizeFormUrlencodedBody(raw, req.headers);
      if (normalized !== undefined) {
        done({ ok: true, value: normalized });
        return;
      }
      done({
        ok: false,
        error: `body is not valid JSON and could not be normalized as a Deluge form-urlencoded payload; use \`body: payload\` with a \`Content-Type: application/json\` header in the Deluge handler; shape: ${describeBodySyntax(raw)}`,
      });
    });
    req.on("error", (error: Error) => done({ ok: false, error: error.message }));
  });
}
