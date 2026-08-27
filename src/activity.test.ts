import { afterEach, describe, expect, it } from "vitest";
import {
  getChannelActivity,
  resetChannelActivityForTest,
} from "openclaw/plugin-sdk/infra-runtime";
import { recordCliqActivity, trackCliqOutboundActivity } from "./activity.js";

afterEach(() => {
  resetChannelActivityForTest();
});

describe("recordCliqActivity", () => {
  it("records inbound under the default account when accountId is null", () => {
    recordCliqActivity({ accountId: null, direction: "inbound", at: 111 });
    expect(getChannelActivity({ channel: "cliq", accountId: "default" })).toEqual({
      inboundAt: 111,
      outboundAt: null,
    });
  });

  it("records outbound under the named account", () => {
    recordCliqActivity({ accountId: "acct-7", direction: "outbound", at: 222 });
    expect(getChannelActivity({ channel: "cliq", accountId: "acct-7" })).toEqual({
      inboundAt: null,
      outboundAt: 222,
    });
  });

  it("never throws when the SDK helper is unhappy", () => {
    expect(() =>
      recordCliqActivity({ accountId: "default", direction: "inbound" }),
    ).not.toThrow();
  });
});

describe("trackCliqOutboundActivity", () => {
  it("records outbound after a successful send, not after a thrown send", async () => {
    const client = {
      sendMessage: async () => ({ messageId: "m1" }),
      sendMediaMessage: async () => {
        throw new Error("send failed");
      },
      sendCard: async () => ({ messageId: "c1" }),
    };
    const tracked = trackCliqOutboundActivity(client, null);

    await tracked.sendMessage();
    expect(getChannelActivity({ channel: "cliq", accountId: "default" }).outboundAt).toEqual(
      expect.any(Number),
    );

    const afterSuccess = getChannelActivity({
      channel: "cliq",
      accountId: "default",
    }).outboundAt;
    await expect(tracked.sendMediaMessage()).rejects.toThrow(/send failed/);
    expect(
      getChannelActivity({ channel: "cliq", accountId: "default" }).outboundAt,
    ).toBe(afterSuccess);
  });

  it("wraps sendCard as well as sendMessage", async () => {
    const client = {
      sendMessage: async () => ({ messageId: "m1" }),
      sendMediaMessage: async () => ({ messageId: "f1" }),
      sendCard: async () => ({ messageId: "c1" }),
    };
    const tracked = trackCliqOutboundActivity(client, "acct-9");
    await tracked.sendCard();
    expect(
      getChannelActivity({ channel: "cliq", accountId: "acct-9" }).outboundAt,
    ).toEqual(expect.any(Number));
  });

  it("is idempotent: wrapping twice does not double-record", async () => {
    const calls: number[] = [];
    const client = {
      sendMessage: async () => {
        calls.push(1);
        return { messageId: "m1" };
      },
      sendMediaMessage: async () => ({ messageId: "f1" }),
      sendCard: async () => ({ messageId: "c1" }),
    };
    const once = trackCliqOutboundActivity(client, "default");
    const twice = trackCliqOutboundActivity(once, "default");
    await twice.sendMessage();
    expect(calls).toHaveLength(1);
  });
});
