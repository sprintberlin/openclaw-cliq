import { describe, it, expect } from "vitest";
import { parseCliqErrorBody } from "./cliq-error.js";

describe("parseCliqErrorBody", () => {
  it("extracts the message from a v3 envelope", () => {
    const raw = JSON.stringify({
      message: "Request was rejected because of invalid AuthToken.",
    });
    const parsed = parseCliqErrorBody(raw);
    expect(parsed.isV3Envelope).toBe(true);
    expect(parsed.message).toBe("Request was rejected because of invalid AuthToken.");
    expect(parsed.raw).toBe(raw);
  });

  it("extracts the message when extra fields are present (code/details)", () => {
    const raw = JSON.stringify({
      code: "UNAUTHORIZED",
      message: "The user does not have enough permission to access the resource.",
      details: { scope: "ZohoCliq.Channels.UPDATE" },
    });
    const parsed = parseCliqErrorBody(raw);
    expect(parsed.isV3Envelope).toBe(true);
    expect(parsed.message).toBe(
      "The user does not have enough permission to access the resource.",
    );
  });

  it("passes a v2 opaque string body through unchanged", () => {
    const raw = "invalid_client";
    const parsed = parseCliqErrorBody(raw);
    expect(parsed.isV3Envelope).toBe(false);
    expect(parsed.message).toBe("invalid_client");
    expect(parsed.raw).toBe("invalid_client");
  });

  it("passes a v2 JSON body without a string message through unchanged", () => {
    // v2-style `{"error":"invalid_client"}` has no `message` field.
    const raw = '{"error":"invalid_client"}';
    const parsed = parseCliqErrorBody(raw);
    expect(parsed.isV3Envelope).toBe(false);
    expect(parsed.message).toBe(raw);
  });

  it("falls back to the raw body when message is an empty string", () => {
    const raw = '{"message":""}';
    const parsed = parseCliqErrorBody(raw);
    expect(parsed.isV3Envelope).toBe(false);
    expect(parsed.message).toBe(raw);
  });

  it("falls back to the raw body when message is a non-string", () => {
    const raw = '{"message":42}';
    const parsed = parseCliqErrorBody(raw);
    expect(parsed.isV3Envelope).toBe(false);
    expect(parsed.message).toBe(raw);
  });

  it("falls back to the raw body for malformed JSON", () => {
    const raw = '{"message":"unclosed';
    const parsed = parseCliqErrorBody(raw);
    expect(parsed.isV3Envelope).toBe(false);
    expect(parsed.message).toBe(raw);
  });

  it("returns empty for an empty body", () => {
    const parsed = parseCliqErrorBody("");
    expect(parsed.isV3Envelope).toBe(false);
    expect(parsed.message).toBe("");
    expect(parsed.raw).toBe("");
  });

  it("does not treat a JSON array as an envelope", () => {
    const raw = '["a","b"]';
    const parsed = parseCliqErrorBody(raw);
    expect(parsed.isV3Envelope).toBe(false);
    expect(parsed.message).toBe(raw);
  });
});
