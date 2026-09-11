import { describe, expect, it } from "vitest";
import {
  describeDelugeBodySyntax,
  repairDelugeUnescapedMessageBody,
} from "./inbound-deluge-repair.js";

/** Build a corrupt body exactly the way Zoho's unescaped toString emits it. */
function corrupt(message: string, user = '{"id":"u-1"}'): string {
  return `{"handler":"message","message":"${message}","user":${user},"chat":{"id":"c-1","type":"single"},"eventId":"20260905230132-253785205408"}`;
}

describe("repairDelugeUnescapedMessageBody (issues #223 / #227)", () => {
  it("repairs an unescaped double quote inside the message value", () => {
    const body = corrupt('Er sagte "others" und weiter');
    const value = repairDelugeUnescapedMessageBody(body) as {
      message?: string;
      eventId?: string;
    };
    expect(value).toBeTruthy();
    expect(value.message).toBe('Er sagte "others" und weiter');
    expect(value.eventId).toBe("20260905230132-253785205408");
  });

  it("repairs unescaped line breaks inside the message value", () => {
    const value = repairDelugeUnescapedMessageBody(
      corrupt("Zeile 1\nZeile 2\nZeile 3"),
    ) as { message?: string };
    expect(value.message).toBe("Zeile 1\nZeile 2\nZeile 3");
  });

  it("repairs the live forward shape: quotes AND line breaks together", () => {
    const value = repairDelugeUnescapedMessageBody(
      corrupt('Eintrag aus dem "others"\nist nicht ersichtlich\n\nLG'),
    ) as { message?: string; user?: { id?: string } };
    expect(value.message).toContain('"others"');
    expect(value.message).toContain("\n");
    expect(value.user?.id).toBe("u-1");
  });

  it("declines an adversarial text whose corruption happens to parse (documented edge)", () => {
    // `evil ","user":" trap` makes the corrupt body accidentally VALID JSON
    // (message="evil ", user=" trap", then the structural user key wins the
    // duplicate). The repair defers to the caller's parse: it returns
    // undefined and the truncated reading stands. Real text never contains
    // the literal `","user":` — and a skip line plus the syntax fingerprint
    // still surface anything genuinely unknown.
    expect(
      repairDelugeUnescapedMessageBody(corrupt('evil ","user":" trap')),
    ).toBeUndefined();
  });

  it("returns undefined for shapes it does not recognize", () => {
    // Form-encoded junk, welcome payloads (no message key), plain text,
    // and a body that does not even start like the generated payload.
    expect(repairDelugeUnescapedMessageBody("handler=message&message=x")).toBeUndefined();
    expect(
      repairDelugeUnescapedMessageBody('{"handler":"welcome","user":{"id":"u"}}'),
    ).toBeUndefined();
    expect(repairDelugeUnescapedMessageBody("not json at all")).toBeUndefined();
    expect(repairDelugeUnescapedMessageBody('{"other":"shape","message":"x"}')).toBeUndefined();
  });

  it("returns undefined when the repaired form still does not parse", () => {
    // Structural tail is itself broken — repair must not force a value.
    const body = `{"handler":"message","message":"ok","user":{broken tail`;
    expect(repairDelugeUnescapedMessageBody(body)).toBeUndefined();
  });

  it("never re-escapes an already-valid body (returns undefined; caller owns it)", () => {
    const clean = JSON.stringify({
      handler: "message",
      message: 'mit "quotes"',
      user: { id: "u-1" },
    });
    expect(repairDelugeUnescapedMessageBody(clean)).toBeUndefined();
  });
});

describe("describeDelugeBodySyntax (issue #227 evidence)", () => {
  it("masks words but preserves the punctuation skeleton", () => {
    const fp = describeDelugeBodySyntax(
      '{"handler":"message","message":"Sebastian Seiler"}',
    );
    // The structural skeleton survives …
    expect(fp).toBe('{"x*":"x*","x*":"x* x*"}');
    // … while no original word does.
    expect(fp).not.toMatch(/handler|message|Sebastian|Seiler/);
  });

  it("distinguishes unescaped-quote corruption from Deluge map syntax", () => {
    // The two corruption shapes we must tell apart in the wild produce
    // visibly different fingerprints.
    const unescapedQuotes = describeDelugeBodySyntax(
      '{"message":"er sagte "others" dazu"}',
    );
    const delugeMap = describeDelugeBodySyntax("{message=er sagte others}");
    expect(unescapedQuotes).toContain('"');
    expect(delugeMap).toContain("=");
    expect(delugeMap).not.toContain('"');
    expect(unescapedQuotes).not.toBe(delugeMap);
  });

  it("marks line breaks so unescaped-newline corruption is visible", () => {
    const fp = describeDelugeBodySyntax('{"a":"b\nc"}');
    expect(fp).toContain("⏎");
  });

  it("caps the fingerprint length", () => {
    const fp = describeDelugeBodySyntax("x".repeat(500));
    expect(fp.length).toBeLessThanOrEqual(96);
  });

  it("keeps the generated suffix visible for a long rejected body", () => {
    const fp = describeDelugeBodySyntax(
      `{"handler":"message","message":"${"long text ".repeat(80)}","user":BROKEN_TAIL}`,
    );
    expect(fp.length).toBeLessThanOrEqual(96);
    expect(fp).toContain("…");
    expect(fp).toMatch(/,"x\*":x\*_x\*}$/);
  });
});

describe("repair survives added flat handler fields (#228 regression)", () => {
  // The handlerSchema marker landed between `handler` and `message`, which
  // silently disabled the repair and made a live corrupt forward 400 again.
  it("repairs a body carrying handlerSchema before the message value", () => {
    const raw =
      '{"handler":"message","handlerSchema":"v2","message":"Eintrag aus dem "others"\nist nicht ersichtlich","user":{"id":"u-1","name":"Alice"},"chat":{"id":"c-1","type":"single"},"eventId":"evt-1"}';
    const repaired = repairDelugeUnescapedMessageBody(raw) as Record<string, unknown>;
    expect(repaired).toBeDefined();
    expect(repaired.handlerSchema).toBe("v2");
    expect(repaired.message).toBe('Eintrag aus dem "others"\nist nicht ersichtlich');
    expect((repaired.user as Record<string, unknown>).id).toBe("u-1");
  });

  it("repairs a mention body with several added flat markers", () => {
    const raw =
      '{"handler":"mention","handlerSchema":"v2","locale":"de","message":"sagt "hallo"","user":{"id":"u-2"},"chat":{"id":"c-2"},"eventId":"evt-2"}';
    const repaired = repairDelugeUnescapedMessageBody(raw) as Record<string, unknown>;
    expect(repaired?.message).toBe('sagt "hallo"');
  });

  it("repairs the live shape when Deluge adds structural whitespace", () => {
    const raw =
      '{"handler":"message","handlerSchema":"v2","message":"OPENCLAW_CLIQ_ROUNDTRIP_REQUEST test\nContact email: test@example.invalid\nQuoted text: "doctor-safe"" , "user" : {"id":"u-1","name":"Alice"}, "chat" : {"id":"c-1","type":"single"}, "eventId" : "evt-1"}';
    const repaired = repairDelugeUnescapedMessageBody(raw) as Record<string, unknown>;
    expect(repaired).toBeDefined();
    expect(repaired.message).toBe(
      'OPENCLAW_CLIQ_ROUNDTRIP_REQUEST test\nContact email: test@example.invalid\nQuoted text: "doctor-safe"',
    );
    expect((repaired.user as Record<string, unknown>).id).toBe("u-1");
    expect((repaired.chat as Record<string, unknown>).id).toBe("c-1");
  });

  it("finds the generated boundary past a known field name nested in the suffix", () => {
    const raw =
      '{"handler":"message","message":"line one\nline "two"","user":{"id":"u-1","profile":{"user":{"id":"nested"}}},"chat":{"id":"c-1"},"eventId":"evt-1"}';
    const repaired = repairDelugeUnescapedMessageBody(raw) as Record<string, unknown>;
    expect(repaired.message).toBe('line one\nline "two"');
    expect((repaired.user as Record<string, unknown>).id).toBe("u-1");
  });

  it("does not treat a corrupted marker value as a skippable field", () => {
    // A marker whose own value is corrupted is not machine-generated shape;
    // the repair must decline rather than guess a boundary.
    const raw =
      '{"handler":"message","handlerSchema":"v"2","message":"hi","user":{"id":"u-3"},"chat":{"id":"c-3"},"eventId":"evt-3"}';
    expect(repairDelugeUnescapedMessageBody(raw)).toBeUndefined();
  });
});
