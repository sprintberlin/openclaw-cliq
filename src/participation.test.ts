import { describe, expect, it } from "vitest";
import { isCliqParticipationPayload, isCliqParticipationMessage } from "./participation.js";

describe("participation handler helpers", () => {
  it("detects participation handler payload", () => {
    expect(isCliqParticipationPayload({ handler: "participation" })).toBe(true);
    expect(isCliqParticipationPayload({ handler: "Participation" })).toBe(true);
    expect(isCliqParticipationPayload({ handler: "  participation  " })).toBe(true);
    expect(isCliqParticipationPayload({ handler: "message" })).toBe(false);
    expect(isCliqParticipationPayload({ handler: "mention" })).toBe(false);
    expect(isCliqParticipationPayload(null)).toBe(false);
    expect(isCliqParticipationPayload({})).toBe(false);
  });

  it("identifies message_sent operation", () => {
    expect(isCliqParticipationMessage({ handler: "participation", operation: "message_sent" })).toBe(true);
    expect(isCliqParticipationMessage({ handler: "participation" })).toBe(true);
    expect(isCliqParticipationMessage({ handler: "participation", operation: "bot_added" })).toBe(false);
    expect(isCliqParticipationMessage({ handler: "participation", operation: "bot_removed" })).toBe(false);
    expect(isCliqParticipationMessage({ handler: "participation", operation: "message_deleted" })).toBe(false);
  });
});
