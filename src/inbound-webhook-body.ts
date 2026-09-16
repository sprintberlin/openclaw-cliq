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
const LF = Buffer.from("\n");
const DEFAULT_JSON_MAX_BYTES = 1024 * 1024;
const DEFAULT_MULTIPART_MAX_BYTES = 25 * 1024 * 1024;

function multipartLineEndingAt(body: Buffer, offset: number): Buffer | undefined {
  if (body.subarray(offset, offset + CRLF.length).equals(CRLF)) return CRLF;
  if (body.subarray(offset, offset + LF.length).equals(LF)) return LF;
  return undefined;
}

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

function parseDispositionParameter(value: string, parameter: string): string | undefined {
  const escaped = parameter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `(?:^|;)\\s*${escaped}=(?:"([^"]*)"|'([^']*)'|([^;\\s]*))`,
    "i",
  ).exec(value);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function parseDisposition(value: string): { name?: string; fileName?: string } {
  const name = parseDispositionParameter(value, "name");
  const encodedFileName = /(?:^|;)\s*filename\*=UTF-8''([^;\r\n]*)/i.exec(value)?.[1];
  let fileName = parseDispositionParameter(value, "filename");
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
 * Scan one multipart part's header block starting at `start`.
 *
 * Live Deluge traffic (2026-09-16) reached the webhook with part headers that
 * run directly into the part content with no blank separator line, on top of
 * the already-known LF-only framing and unquoted disposition parameters. A
 * fixed CRLFCRLF/LFLF terminator search fails on that shape, so headers are
 * collected line-by-line: the block ends at a blank line (canonical) or at
 * the first non-header-shaped line (missing separator), and `contentStart`
 * is where part content begins either way.
 */
function scanMultipartHeaderBlock(
  body: Buffer,
  start: number,
): { contentStart: number; headerLines: string[] } | undefined {
  const headerLines: string[] = [];
  let pos = start;
  while (headerLines.length < 32) {
    const lineFeed = body.indexOf(0x0a, pos);
    if (lineFeed < 0) return undefined;
    const lineEnd = lineFeed > pos && body[lineFeed - 1] === 0x0d ? lineFeed - 1 : lineFeed;
    if (lineEnd - pos > 16 * 1024) return undefined;
    const line = body.subarray(pos, lineEnd).toString("latin1");
    if (line === "") {
      return headerLines.length > 0
        ? { contentStart: lineFeed + 1, headerLines }
        : undefined;
    }
    // With no blank separator line, part content (for example a JSON payload
    // whose first line contains a colon) would otherwise be swallowed as a
    // header. Deluge only emits these three part headers, so anything else
    // ends the header block and starts the content.
    const colon = line.indexOf(":");
    const headerName = colon > 0 ? line.slice(0, colon).trim().toLowerCase() : "";
    const knownPartHeader =
      headerName === "content-disposition" ||
      headerName === "content-type" ||
      headerName === "content-transfer-encoding";
    if (!knownPartHeader) {
      return headerLines.length > 0 ? { contentStart: pos, headerLines } : undefined;
    }
    headerLines.push(line);
    pos = lineFeed + 1;
  }
  return undefined;
}

/**
 * Zoho's Deluge `invokeUrl files:` transport can emit a valid multipart body
 * while omitting or mislabelling the request Content-Type. Detect only the
 * generated handler's canonical first part (`payload` / `metadata`) so an
 * arbitrary body beginning with dashes cannot opt into multipart parsing or
 * the larger attachment-size limit.
 */
function sniffCliqMultipartBoundary(body: Buffer): string | undefined {
  if (body.length < 4 || body[0] !== 0x2d || body[1] !== 0x2d) return undefined;
  const firstLf = body.indexOf(0x0a, 2);
  if (firstLf < 0 || firstLf > 203) return undefined;
  const firstLineEnd = body[firstLf - 1] === 0x0d ? firstLf - 1 : firstLf;
  const boundary = body.subarray(2, firstLineEnd).toString("latin1");
  if (!boundary || boundary.length > 200 || !/^[\x21-\x7e]+$/.test(boundary)) {
    return undefined;
  }
  const scanned = scanMultipartHeaderBlock(body, firstLf + 1);
  if (!scanned) return undefined;
  const dispositionLine = scanned.headerLines.find((line) =>
    line.toLowerCase().startsWith("content-disposition:"),
  );
  if (!dispositionLine) return undefined;
  const disposition = parseDisposition(dispositionLine.slice(dispositionLine.indexOf(":") + 1));
  return disposition.name === "payload" || disposition.name === "metadata"
    ? boundary
    : undefined;
}

/**
 * Parse the small multipart shape emitted by the generated Deluge handler.
 * Limits are intentionally strict: the route-level body limit is the primary
 * bound, and per-part headers/part count prevent adversarial multipart
 * growth. Part headers may end with a canonical blank line or run directly
 * into the part content (live Deluge evidence, 2026-09-16), and the line
 * ending before each subsequent delimiter may differ from the first part's
 * framing.
 */
export function parseCliqMultipartBody(
  body: Buffer,
  boundary: string,
  maxParts = 24,
): MultipartPart[] | undefined {
  const delimiter = Buffer.from(`--${boundary}`);
  const lfDelimiter = Buffer.concat([LF, delimiter]);
  const crlfDelimiter = Buffer.concat([CRLF, delimiter]);
  const parts: MultipartPart[] = [];
  let cursor = 0;

  while (cursor < body.length && parts.length < maxParts) {
    const start = body.indexOf(delimiter, cursor);
    if (start < 0) break;
    let partStart = start + delimiter.length;
    if (body.subarray(partStart, partStart + 2).equals(Buffer.from("--"))) break;
    const lineEnding = multipartLineEndingAt(body, partStart);
    if (!lineEnding) return undefined;
    partStart += lineEnding.length;
    const scanned = scanMultipartHeaderBlock(body, partStart);
    if (!scanned) return undefined;
    const contentStart = scanned.contentStart;
    const lfAt = body.indexOf(lfDelimiter, contentStart);
    const crlfAt = body.indexOf(crlfDelimiter, contentStart);
    let delimiterEol: number;
    if (crlfAt >= 0 && (lfAt < 0 || crlfAt <= lfAt)) {
      delimiterEol = crlfAt;
    } else if (lfAt >= 0) {
      delimiterEol = lfAt;
    } else {
      return undefined;
    }

    const headers = new Map<string, string>();
    for (const line of scanned.headerLines) {
      const colon = line.indexOf(":");
      if (colon <= 0) continue;
      headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }
    const disposition = parseDisposition(headers.get("content-disposition") ?? "");
    parts.push({
      ...disposition,
      contentType: headers.get("content-type"),
      bytes: new Uint8Array(body.subarray(contentStart, delimiterEol)),
    });
    cursor = delimiterEol + (body[delimiterEol] === 0x0d ? CRLF.length : LF.length);
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
  let boundary = multipartBoundary(contentType);
  let effectiveMaxBytes = maxBytes
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
    let sniffPrefix = Buffer.alloc(0);
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      if (!boundary && sniffPrefix.length < 16 * 1024 + 256) {
        const remaining = 16 * 1024 + 256 - sniffPrefix.length;
        sniffPrefix = Buffer.concat([sniffPrefix, chunk.subarray(0, remaining)]);
        boundary = sniffCliqMultipartBoundary(sniffPrefix);
        if (boundary && maxBytes === undefined) {
          effectiveMaxBytes = DEFAULT_MULTIPART_MAX_BYTES;
        }
      }
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
      boundary ??= sniffCliqMultipartBoundary(buffer);
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
