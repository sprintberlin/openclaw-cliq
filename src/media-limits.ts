const BYTES_PER_MB = 1024 * 1024;

export const DEFAULT_CLIQ_INBOUND_MEDIA_MAX_MB = 20;
export const MIN_CLIQ_INBOUND_MEDIA_MAX_MB = 1;
export const MAX_CLIQ_INBOUND_MEDIA_MAX_MB = 100;

export const DEFAULT_CLIQ_INBOUND_MEDIA_MAX_BYTES =
  DEFAULT_CLIQ_INBOUND_MEDIA_MAX_MB * BYTES_PER_MB;

export function resolveCliqInboundMediaMaxBytes(maxInboundMb: unknown): number {
  if (typeof maxInboundMb !== "number" || !Number.isFinite(maxInboundMb)) {
    return DEFAULT_CLIQ_INBOUND_MEDIA_MAX_BYTES;
  }
  const clamped = Math.min(
    MAX_CLIQ_INBOUND_MEDIA_MAX_MB,
    Math.max(MIN_CLIQ_INBOUND_MEDIA_MAX_MB, maxInboundMb),
  );
  return Math.floor(clamped * BYTES_PER_MB);
}

export function formatCliqMediaMb(bytes: number): string {
  const mb = bytes / BYTES_PER_MB;
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

export const CLIQ_MULTIPART_ENVELOPE_BYTES = 128 * 1024;
export const CLIQ_MULTIPART_OVERSIZE_HEADROOM_BYTES = 5 * BYTES_PER_MB;

