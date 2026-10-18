import type { ChannelIngressQueue } from "openclaw/plugin-sdk/channel-outbound";

type Row = {
  id: string;
  payload: unknown;
  receivedAt: number;
  updatedAt: number;
  laneKey?: string;
  attempts: number;
  lastAttemptAt?: number;
  lastError?: string;
  status: "pending" | "claimed" | "completed" | "failed";
  claim?: { token: string; ownerId: string; claimedAt: number };
  failedReason?: string;
  failedMessage?: string;
};

export interface TestIngressQueue {
  queue: ChannelIngressQueue<never, unknown>;
  rows: Map<string, Row>;
  seedClaimed(params: {
    id: string;
    payload: unknown;
    laneKey: string;
    ownerId: string;
    claimedAt: number;
  }): void;
  seedPending(params: { id: string; payload: unknown; laneKey: string; receivedAt?: number }): void;
  statusOf(id: string): Row["status"] | undefined;
}

export function createTestIngressQueue(): TestIngressQueue {
  const rows = new Map<string, Row>();
  let tokenCounter = 0;
  const toRecord = (row: Row) => ({
    id: row.id,
    channelId: "cliq",
    accountId: "default",
    queueName: "cliq:default",
    payload: row.payload,
    receivedAt: row.receivedAt,
    updatedAt: row.updatedAt,
    ...(row.laneKey === undefined ? {} : { laneKey: row.laneKey }),
    attempts: row.attempts,
    ...(row.lastAttemptAt === undefined ? {} : { lastAttemptAt: row.lastAttemptAt }),
    ...(row.lastError === undefined ? {} : { lastError: row.lastError }),
  });
  const toClaim = (row: Row) => ({ ...toRecord(row), claim: { ...row.claim! } });
  const idOf = (idOrClaim: string | { id: string }) =>
    typeof idOrClaim === "string" ? idOrClaim : idOrClaim.id;
  const ordered = (status: Row["status"]) =>
    [...rows.values()]
      .filter((row) => row.status === status)
      .sort((a, b) => a.receivedAt - b.receivedAt || a.id.localeCompare(b.id));

  const queue = {
    async enqueue(id: string, payload: unknown, options?: { receivedAt?: number; laneKey?: string }) {
      const existing = rows.get(id);
      if (existing) {
        if (existing.status === "pending") {
          return { kind: "pending", duplicate: true, record: toRecord(existing) };
        }
        if (existing.status === "claimed") {
          return { kind: "claimed", duplicate: true, record: toClaim(existing) };
        }
        if (existing.status === "completed") {
          return { kind: "completed", duplicate: true, record: { id } };
        }
        return {
          kind: "failed",
          duplicate: true,
          record: { id, reason: existing.failedReason, message: existing.failedMessage },
        };
      }
      const receivedAt = options?.receivedAt ?? Date.now();
      const row: Row = {
        id,
        payload,
        receivedAt,
        updatedAt: receivedAt,
        laneKey: options?.laneKey,
        attempts: 0,
        status: "pending",
      };
      rows.set(id, row);
      return { kind: "accepted", duplicate: false, record: toRecord(row) };
    },
    async listPending() {
      return ordered("pending").map(toRecord);
    },
    async listClaims() {
      return ordered("claimed").map(toClaim);
    },
    async listFailed() {
      return ordered("failed").map((row) => ({
        id: row.id,
        reason: row.failedReason,
        message: row.failedMessage,
      }));
    },
    async claimNext(options?: {
      ownerId?: string;
      blockedLaneKeys?: Iterable<string>;
      candidateIds?: Iterable<string>;
    }) {
      const blocked = new Set(options?.blockedLaneKeys ?? []);
      const candidates = options?.candidateIds ? new Set(options.candidateIds) : null;
      for (const row of ordered("pending")) {
        if (candidates && !candidates.has(row.id)) continue;
        if (row.laneKey !== undefined && blocked.has(row.laneKey)) continue;
        tokenCounter += 1;
        row.status = "claimed";
        row.claim = {
          token: `token-${tokenCounter}`,
          ownerId: options?.ownerId ?? "owner",
          claimedAt: Date.now(),
        };
        return toClaim(row);
      }
      return null;
    },
    async claim(id: string, options?: { ownerId?: string }) {
      const row = rows.get(id);
      if (!row || row.status !== "pending") return null;
      tokenCounter += 1;
      row.status = "claimed";
      row.claim = {
        token: `token-${tokenCounter}`,
        ownerId: options?.ownerId ?? "owner",
        claimedAt: Date.now(),
      };
      return toClaim(row);
    },
    async complete(idOrClaim: string | { id: string }) {
      const row = rows.get(idOf(idOrClaim));
      if (!row || row.status !== "claimed") return false;
      row.status = "completed";
      row.claim = undefined;
      return true;
    },
    async release(
      idOrClaim: string | { id: string },
      options?: { lastError?: string; recordAttempt?: boolean; releasedAt?: number },
    ) {
      const row = rows.get(idOf(idOrClaim));
      if (!row || row.status !== "claimed") return false;
      row.status = "pending";
      row.claim = undefined;
      if (options?.recordAttempt !== false) {
        row.attempts += 1;
        row.lastAttemptAt = options?.releasedAt ?? Date.now();
        row.lastError = options?.lastError;
      }
      return true;
    },
    async fail(
      idOrClaim: string | { id: string },
      options: { reason: string; message?: string },
    ) {
      const row = rows.get(idOf(idOrClaim));
      if (!row || row.status !== "claimed") return false;
      row.status = "failed";
      row.claim = undefined;
      row.failedReason = options.reason;
      row.failedMessage = options.message;
      return true;
    },
    async delete(idOrClaim: string | { id: string }) {
      return rows.delete(idOf(idOrClaim));
    },
    async recoverStaleClaims(options?: {
      shouldRecover?: (claim: ReturnType<typeof toClaim>) => boolean | Promise<boolean>;
    }) {
      let recovered = 0;
      for (const row of ordered("claimed")) {
        if (options?.shouldRecover && !(await options.shouldRecover(toClaim(row)))) continue;
        row.status = "pending";
        row.claim = undefined;
        recovered += 1;
      }
      return recovered;
    },
    async prune() {
      return 0;
    },
  };

  return {
    queue: queue as unknown as ChannelIngressQueue<never, unknown>,
    rows,
    seedClaimed({ id, payload, laneKey, ownerId, claimedAt }) {
      rows.set(id, {
        id,
        payload,
        receivedAt: claimedAt,
        updatedAt: claimedAt,
        laneKey,
        attempts: 0,
        status: "claimed",
        claim: { token: `seed-${id}`, ownerId, claimedAt },
      });
    },
    seedPending({ id, payload, laneKey, receivedAt }) {
      const at = receivedAt ?? Date.now();
      rows.set(id, {
        id,
        payload,
        receivedAt: at,
        updatedAt: at,
        laneKey,
        attempts: 0,
        status: "pending",
      });
    },
    statusOf: (id) => rows.get(id)?.status,
  };
}
