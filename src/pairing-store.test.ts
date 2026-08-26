import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLIQ_PAIRING_CODE_TTL_MS,
  CliqPairingStoreUnavailableError,
  consumeCliqPairingCode,
  dropCliqPairingAccount,
  readCliqApprovedSenders,
  recordCliqPairingApproval,
  recordCliqPairingCode,
  removeCliqPairingApproval,
  resetCliqPairingStoreCacheForTests,
} from "./pairing-store.js";

const dirs: string[] = [];

function storePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "cliq-pairing-store-"));
  dirs.push(dir);
  return join(dir, "pairing.json");
}

afterEach(() => {
  resetCliqPairingStoreCacheForTests();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Cliq pairing store", () => {
  it("resolves codes case-insensitively and consumes them once", () => {
    const path = storePath();
    recordCliqPairingCode({
      accountId: "account-1",
      code: "abc123",
      senderId: "requester-1",
      now: 1_000,
      storePath: path,
    });

    expect(
      consumeCliqPairingCode({
        accountId: "account-1",
        code: "AbC123",
        now: 2_000,
        storePath: path,
      }),
    ).toBe("requester-1");
    expect(
      consumeCliqPairingCode({
        accountId: "account-1",
        code: "ABC123",
        now: 2_001,
        storePath: path,
      }),
    ).toBeNull();
  });

  it("rejects and consumes an expired code", () => {
    const path = storePath();
    recordCliqPairingCode({
      code: "STALE",
      senderId: "requester-1",
      now: 1_000,
      storePath: path,
    });

    expect(
      consumeCliqPairingCode({
        code: "STALE",
        now: 1_000 + CLIQ_PAIRING_CODE_TTL_MS + 1,
        storePath: path,
      }),
    ).toBeNull();
    expect(
      consumeCliqPairingCode({
        code: "STALE",
        now: 2_000,
        storePath: path,
      }),
    ).toBeNull();
  });

  it("persists sender, approving owner, and timestamp without storing a pairing code", () => {
    const path = storePath();
    recordCliqPairingApproval({
      accountId: "account-1",
      senderId: "requester-1",
      approvedBy: "owner-1",
      now: 42,
      storePath: path,
    });

    resetCliqPairingStoreCacheForTests();
    expect(
      readCliqApprovedSenders({ accountId: "account-1", storePath: path }),
    ).toEqual(["requester-1"]);
    const onDisk = readFileSync(path, "utf8");
    expect(onDisk).toContain('"approvedBy": "owner-1"');
    expect(onDisk).toContain('"approvedAt": 42');
    expect(onDisk).not.toContain("PAIRING-CODE");
  });

  it("removes an approval so access can be withdrawn", () => {
    const path = storePath();
    recordCliqPairingApproval({
      accountId: "account-1",
      senderId: "requester-1",
      approvedBy: "owner-1",
      storePath: path,
    });

    expect(
      removeCliqPairingApproval({
        accountId: "account-1",
        senderId: "REQUESTER-1",
        storePath: path,
      }),
    ).toBe(true);
    expect(
      readCliqApprovedSenders({ accountId: "account-1", storePath: path }),
    ).toEqual([]);
    expect(
      removeCliqPairingApproval({
        accountId: "account-1",
        senderId: "requester-1",
        storePath: path,
      }),
    ).toBe(false);
  });

  it("drops every record for a removed account", () => {
    const path = storePath();
    recordCliqPairingApproval({
      accountId: "gone",
      senderId: "requester-1",
      approvedBy: "owner-1",
      storePath: path,
    });
    recordCliqPairingApproval({
      accountId: "kept",
      senderId: "requester-2",
      approvedBy: "owner-1",
      storePath: path,
    });

    dropCliqPairingAccount({ accountId: "gone", storePath: path });

    expect(readCliqApprovedSenders({ accountId: "gone", storePath: path })).toEqual([]);
    expect(readCliqApprovedSenders({ accountId: "kept", storePath: path })).toEqual([
      "requester-2",
    ]);
  });

  it("raises rather than silently reporting no approvals when the store is unreadable", () => {
    const path = storePath();
    recordCliqPairingApproval({
      accountId: "account-1",
      senderId: "requester-1",
      approvedBy: "owner-1",
      storePath: path,
    });
    resetCliqPairingStoreCacheForTests();
    writeFileSync(path, "{ not valid json");

    expect(() =>
      readCliqApprovedSenders({ accountId: "account-1", storePath: path }),
    ).toThrow(CliqPairingStoreUnavailableError);
    // The unreadable store must not be cached as empty, nor overwritten.
    expect(() =>
      readCliqApprovedSenders({ accountId: "account-1", storePath: path }),
    ).toThrow(CliqPairingStoreUnavailableError);
    expect(readFileSync(path, "utf8")).toBe("{ not valid json");
  });

  it("keeps approvals isolated by account", () => {
    const path = storePath();
    recordCliqPairingApproval({
      accountId: "a",
      senderId: "user-a",
      approvedBy: "owner",
      storePath: path,
    });
    recordCliqPairingApproval({
      accountId: "b",
      senderId: "user-b",
      approvedBy: "owner",
      storePath: path,
    });

    expect(readCliqApprovedSenders({ accountId: "a", storePath: path })).toEqual([
      "user-a",
    ]);
    expect(readCliqApprovedSenders({ accountId: "b", storePath: path })).toEqual([
      "user-b",
    ]);
  });
});
