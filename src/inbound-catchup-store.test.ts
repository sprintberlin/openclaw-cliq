import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cliqInboundCatchupConversationKey,
  readCliqInboundCatchupCursor,
  recordCliqInboundCatchupCursor,
  resetCliqInboundCatchupStoreForTest,
  withCliqInboundCatchupConversationLock,
} from "./inbound-catchup-store.js";

const dirs: string[] = [];
afterEach(() => {
  resetCliqInboundCatchupStoreForTest();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function storePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "cliq-catchup-"));
  dirs.push(dir);
  return join(dir, "inbound-catchup.json");
}

describe("inbound catch-up cursor store", () => {
  it("persists only an opaque keyed native cursor", () => {
    const path = storePath();
    recordCliqInboundCatchupCursor({
      accountId: "sales", chatId: "CT_private_chat", cursor: "1783502114151_267378657650", now: 1, storePath: path,
    });
    resetCliqInboundCatchupStoreForTest();
    expect(readCliqInboundCatchupCursor({ accountId: "sales", chatId: "CT_private_chat", storePath: path }))
      .toBe("1783502114151_267378657650");
    const contents = readFileSync(path, "utf8");
    expect(contents).not.toContain("CT_private_chat");
    expect(contents).toContain(cliqInboundCatchupConversationKey("sales", "CT_private_chat"));
  });

  it("serializes concurrent scans for the same account/chat", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const first = withCliqInboundCatchupConversationLock({
      accountId: "a", chatId: "CT_1", run: async () => {
        events.push("first-start");
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
        events.push("first-end");
      },
    });
    const second = withCliqInboundCatchupConversationLock({
      accountId: "a", chatId: "CT_1", run: async () => { events.push("second"); },
    });
    await Promise.resolve();
    expect(events).toEqual(["first-start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first-start", "first-end", "second"]);
  });

  it("separates account and chat cursors", () => {
    const path = storePath();
    recordCliqInboundCatchupCursor({ accountId: "a", chatId: "CT_1", cursor: "m1", storePath: path });
    recordCliqInboundCatchupCursor({ accountId: "b", chatId: "CT_1", cursor: "m2", storePath: path });
    expect(readCliqInboundCatchupCursor({ accountId: "a", chatId: "CT_1", storePath: path })).toBe("m1");
    expect(readCliqInboundCatchupCursor({ accountId: "b", chatId: "CT_1", storePath: path })).toBe("m2");
  });
});
