import { describe, expect, it } from "vitest";
import { getChannelActivity } from "openclaw/plugin-sdk/infra-runtime";
import { recordCliqActivity, trackCliqOutboundActivity } from "./activity.js";

describe("recordCliqActivity", () => {
  it("records inbound under the default account when accountId is null", () => {
    recordCliqActivity({ accountId: null, direction: "inbound", at: 111 });
    expect(
      getChannelActivity({ channel: "cliq", accountId: "default" }).inboundAt,
    ).toBe(111);
  });

  it("records outbound under the named account", () => {
    recordCliqActivity({
      accountId: "activity-acct-7",
      direction: "outbound",
      at: 222,
    });
    expect(
      getChannelActivity({
        channel: "cliq",
        accountId: "activity-acct-7",
      }).outboundAt,
    ).toBe(222);
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
    const tracked = trackCliqOutboundActivity(client, "activity-send");

    await tracked.sendMessage();
    expect(
      getChannelActivity({
        channel: "cliq",
        accountId: "activity-send",
      }).outboundAt,
    ).toEqual(expect.any(Number));

    const afterSuccess = getChannelActivity({
      channel: "cliq",
      accountId: "activity-send",
    }).outboundAt;
    await expect(tracked.sendMediaMessage()).rejects.toThrow(/send failed/);
    expect(
      getChannelActivity({
        channel: "cliq",
        accountId: "activity-send",
      }).outboundAt,
    ).toBe(afterSuccess);
  });

  it("wraps sendCard as well as sendMessage", async () => {
    const client = {
      sendMessage: async () => ({ messageId: "m1" }),
      sendMediaMessage: async () => ({ messageId: "f1" }),
      sendCard: async () => ({ messageId: "c1" }),
    };
    const tracked = trackCliqOutboundActivity(client, "activity-card");
    await tracked.sendCard();
    expect(
      getChannelActivity({
        channel: "cliq",
        accountId: "activity-card",
      }).outboundAt,
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
