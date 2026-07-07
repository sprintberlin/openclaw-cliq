import { describe, it, expect } from "vitest";
import {
  cliqButtonToV3CardButton,
  cliqCardToV3MessageCard,
  V3_DEFAULT_CARD_TITLE,
  V3_MAX_BUTTONS_PER_CARD,
  V3_MAX_BUTTON_LABEL_LENGTH,
  V3_MAX_TITLE_LENGTH,
  type CliqV3CardInput,
} from "./v3-card.js";
import type { CliqButton } from "./presentation.js";

describe("cliqButtonToV3CardButton", () => {
  it("converts a v2 openurl button to a v3 open.url button", () => {
    const b: CliqButton = {
      label: "Open",
      type: "+",
      action: "openurl",
      url: "https://example.com",
    };
    expect(cliqButtonToV3CardButton(b)).toEqual({
      label: "Open",
      action: { type: "open.url", data: { web: "https://example.com" } },
    });
  });

  it("converts a v2 invoke button to a v3 invoke.bot button carrying bot_name + message", () => {
    const b: CliqButton = {
      label: "Confirm",
      type: "+",
      action: "invoke",
      data: "yes",
    };
    expect(cliqButtonToV3CardButton(b, "my-bot")).toEqual({
      label: "Confirm",
      action: {
        type: "invoke.bot",
        data: { bot_name: "my-bot", message: "yes" },
      },
    });
  });

  it("drops an invoke button when no botId is provided (cannot address the bot)", () => {
    const b: CliqButton = {
      label: "Confirm",
      type: "+",
      action: "invoke",
      data: "yes",
    };
    expect(cliqButtonToV3CardButton(b)).toBeNull();
  });

  it("drops an openurl button with no url", () => {
    const b = { label: "Open", type: "+" as const, action: "openurl" as const };
    expect(cliqButtonToV3CardButton(b)).toBeNull();
  });

  it("drops an invoke button with no data", () => {
    const b = {
      label: "Confirm",
      type: "+" as const,
      action: "invoke" as const,
    };
    expect(cliqButtonToV3CardButton(b, "bot")).toBeNull();
  });

  it("drops an api button (no v3 mapping for this plugin)", () => {
    const b: CliqButton = {
      label: "Call",
      type: "+",
      action: "api",
      url: "https://example.com/hook",
    };
    expect(cliqButtonToV3CardButton(b, "bot")).toBeNull();
  });

  it("drops a button with an empty/whitespace label", () => {
    const b: CliqButton = {
      label: "   ",
      type: "+",
      action: "openurl",
      url: "https://example.com",
    };
    expect(cliqButtonToV3CardButton(b)).toBeNull();
  });

  it("clamps a too-long label to 30 chars with an ellipsis", () => {
    const longLabel = "A".repeat(50);
    const b: CliqButton = {
      label: longLabel,
      type: "+",
      action: "openurl",
      url: "https://example.com",
    };
    const out = cliqButtonToV3CardButton(b);
    expect(out).not.toBeNull();
    expect(out!.label.length).toBe(V3_MAX_BUTTON_LABEL_LENGTH);
    expect(out!.label.endsWith("…")).toBe(true);
  });

  it("trims whitespace around a label", () => {
    const b: CliqButton = {
      label: "  Open  ",
      type: "+",
      action: "openurl",
      url: "https://example.com",
    };
    expect(cliqButtonToV3CardButton(b)!.label).toBe("Open");
  });
});

describe("cliqCardToV3MessageCard", () => {
  const buttons: CliqButton[] = [
    { label: "Open", type: "+", action: "openurl", url: "https://example.com" },
    { label: "Confirm", type: "+", action: "invoke", data: "yes" },
  ];

  it("converts text + buttons into a modern-inline card with title + buttons + text fallback", () => {
    const card: CliqV3CardInput = { text: "Pick an option", buttons };
    const out = cliqCardToV3MessageCard(card, { botId: "bot" });
    expect(out).not.toBeNull();
    expect(out!.card.theme).toBe("modern-inline");
    expect(out!.card.title).toBe("Pick an option");
    expect(out!.card.buttons).toHaveLength(2);
    expect(out!.card.buttons![0].action.type).toBe("open.url");
    expect(out!.card.buttons![1].action.type).toBe("invoke.bot");
    // Full text kept as the top-level fallback.
    expect(out!.text).toBe("Pick an option");
    // No remainder → no slides.
    expect(out!.slides).toBeUndefined();
  });

  it("uses the first line as the title and pushes the rest into a text slide", () => {
    const card: CliqV3CardInput = {
      text: "Header line\nBody paragraph 1\nBody paragraph 2",
      buttons,
    };
    const out = cliqCardToV3MessageCard(card, { botId: "bot" });
    expect(out!.card.title).toBe("Header line");
    expect(out!.text).toBe("Header line\nBody paragraph 1\nBody paragraph 2");
    expect(out!.slides).toEqual([
      { type: "text", data: "Body paragraph 1\nBody paragraph 2" },
    ]);
  });

  it("truncates a too-long first line to 200 chars and carries the overflow into a slide", () => {
    const longLine = "A".repeat(350);
    const card: CliqV3CardInput = { text: longLine };
    const out = cliqCardToV3MessageCard(card);
    expect(out!.card.title.length).toBe(V3_MAX_TITLE_LENGTH);
    expect(out!.card.title.endsWith("A")).toBe(true);
    expect(out!.slides).toBeDefined();
    expect(out!.slides![0].type).toBe("text");
    const remainder = out!.slides![0].data as string;
    expect(remainder.length).toBe(350 - V3_MAX_TITLE_LENGTH);
  });

  it("caps buttons at 5 (v3 limit, vs v2's 10)", () => {
    const many: CliqButton[] = Array.from({ length: 8 }, (_, i) => ({
      label: `B${i}`,
      type: "+" as const,
      action: "openurl" as const,
      url: `https://example.com/${i}`,
    }));
    const card: CliqV3CardInput = { text: "t", buttons: many };
    const out = cliqCardToV3MessageCard(card)!;
    expect(out.card.buttons).toHaveLength(V3_MAX_BUTTONS_PER_CARD);
  });

  it("drops invoke buttons when no botId is given but still renders the card from text", () => {
    const card: CliqV3CardInput = {
      text: "Pick",
      buttons: [
        { label: "Confirm", type: "+", action: "invoke", data: "yes" },
        { label: "Open", type: "+", action: "openurl", url: "https://x.com" },
      ],
    };
    const out = cliqCardToV3MessageCard(card);
    expect(out!.card.title).toBe("Pick");
    // The invoke button is dropped; the openurl button survives.
    expect(out!.card.buttons).toHaveLength(1);
    expect(out!.card.buttons![0].action.type).toBe("open.url");
  });

  it("uses the default title for a buttons-only card (no text)", () => {
    const card: CliqV3CardInput = { buttons };
    const out = cliqCardToV3MessageCard(card, { botId: "bot" });
    expect(out!.card.title).toBe(V3_DEFAULT_CARD_TITLE);
    expect(out!.card.buttons).toHaveLength(2);
    expect(out!.text).toBeUndefined();
    expect(out!.slides).toBeUndefined();
  });

  it("honors a custom defaultTitle for a buttons-only card", () => {
    const card: CliqV3CardInput = { buttons };
    const out = cliqCardToV3MessageCard(card, {
      botId: "bot",
      defaultTitle: "Choose",
    });
    expect(out!.card.title).toBe("Choose");
  });

  it("returns null for an empty card (no text, no buttons)", () => {
    expect(cliqCardToV3MessageCard({})).toBeNull();
  });

  it("returns null when all buttons are dropped and there is no text", () => {
    const card: CliqV3CardInput = {
      buttons: [
        { label: "Confirm", type: "+", action: "invoke", data: "x" },
      ],
    };
    // No botId → invoke button dropped; no text → nothing to render.
    expect(cliqCardToV3MessageCard(card)).toBeNull();
  });

  it("renders a text-only card (no buttons) with title + text fallback + slide", () => {
    const card: CliqV3CardInput = { text: "Hello\nWorld" };
    const out = cliqCardToV3MessageCard(card)!;
    expect(out.card.title).toBe("Hello");
    expect(out.card.buttons).toBeUndefined();
    expect(out.text).toBe("Hello\nWorld");
    expect(out.slides).toEqual([{ type: "text", data: "World" }]);
  });

  it("trims whitespace around the text and skips an empty remainder", () => {
    const card: CliqV3CardInput = { text: "  Only one line  " };
    const out = cliqCardToV3MessageCard(card)!;
    expect(out.card.title).toBe("Only one line");
    // The full (trimmed) text is kept as the top-level fallback.
    expect(out.text).toBe("Only one line");
    expect(out.slides).toBeUndefined();
  });

  it("strips leading blank lines and uses the first non-blank line as the title", () => {
    const card: CliqV3CardInput = { text: "\n\nbody" };
    const out = cliqCardToV3MessageCard(card, { defaultTitle: "Custom" })!;
    expect(out.card.title).toBe("body");
    expect(out.slides).toBeUndefined();
  });
});
