import { describe, it, expect } from "vitest";
import {
  cliqButtonToV3CardButton,
  cliqCardToV3MessageCard,
  normalizeV3Slide,
  normalizeV3Slides,
  V3_DEFAULT_CARD_TITLE,
  V3_MAX_BUTTONS_PER_CARD,
  V3_MAX_BUTTON_LABEL_LENGTH,
  V3_MAX_IMAGE_URLS,
  V3_MAX_LIST_ITEMS,
  V3_MAX_POLL_OPTIONS,
  V3_MAX_SLIDES,
  V3_MAX_SLIDE_CELL_LENGTH,
  V3_MAX_SLIDE_TEXT_LENGTH,
  V3_MAX_TABLE_HEADERS,
  V3_MAX_TABLE_ROWS,
  V3_MAX_TITLE_LENGTH,
  type CliqV3CardInput,
  type V3CardSlideInput,
  type V3ModernInlineCard,
  type V3PollCard,
  type V3PromptCard,
} from "./v3-card.js";
import type { CliqButton } from "./presentation.js";

/** Cast a v3 card body to modern-inline (the test author knows the theme). */
function asModern(card: { theme: string }): V3ModernInlineCard {
  return card as unknown as V3ModernInlineCard;
}

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
    expect(asModern(out!.card).buttons).toHaveLength(2);
    expect(asModern(out!.card).buttons![0].action.type).toBe("open.url");
    expect(asModern(out!.card).buttons![1].action.type).toBe("invoke.bot");
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
    expect(asModern(out.card).buttons).toHaveLength(V3_MAX_BUTTONS_PER_CARD);
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
    expect(asModern(out!.card).buttons).toHaveLength(1);
    expect(asModern(out!.card).buttons![0].action.type).toBe("open.url");
  });

  it("uses the default title for a buttons-only card (no text)", () => {
    const card: CliqV3CardInput = { buttons };
    const out = cliqCardToV3MessageCard(card, { botId: "bot" });
    expect(out!.card.title).toBe(V3_DEFAULT_CARD_TITLE);
    expect(asModern(out!.card).buttons).toHaveLength(2);
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
    expect(asModern(out.card).buttons).toBeUndefined();
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

describe("cliqCardToV3MessageCard — prompt theme", () => {
  const promptButtons: CliqButton[] = [
    { label: "Approve", type: "+", action: "invoke", data: "/approve" },
    { label: "Reject", type: "+", action: "invoke", data: "/reject" },
    { label: "View", type: "+", action: "openurl", url: "https://example.com" },
  ];

  it("emits a prompt card with theme/title/buttons when theme === 'prompt'", () => {
    const card: CliqV3CardInput = {
      text: "Approve deploy?",
      buttons: promptButtons,
      theme: "prompt",
    };
    const out = cliqCardToV3MessageCard(card, { botId: "bot" });
    expect(out).not.toBeNull();
    expect(out!.card.theme).toBe("prompt");
    const prompt = out!.card as V3PromptCard;
    expect(prompt.theme).toBe("prompt");
    expect(prompt.title).toBe("Approve deploy?");
    expect(prompt.buttons).toHaveLength(3);
    // prompt has NO sections / thumbnail fields.
    expect("sections" in prompt).toBe(false);
    expect("thumbnail" in prompt).toBe(false);
    // Full text kept as the top-level fallback.
    expect(out!.text).toBe("Approve deploy?");
    // Single-line text → no remainder → no slides.
    expect(out!.slides).toBeUndefined();
  });

  it("honors opts.theme as a fallback when card.theme is absent", () => {
    const card: CliqV3CardInput = { text: "Pick", buttons: promptButtons };
    const out = cliqCardToV3MessageCard(card, { botId: "bot", theme: "prompt" });
    expect(out!.card.theme).toBe("prompt");
  });

  it("card.theme takes precedence over opts.theme", () => {
    const card: CliqV3CardInput = {
      text: "Pick",
      buttons: promptButtons,
      theme: "modern-inline",
    };
    const out = cliqCardToV3MessageCard(card, { botId: "bot", theme: "prompt" });
    expect(out!.card.theme).toBe("modern-inline");
  });

  it("splits the first line into the title and the rest into a text slide", () => {
    const card: CliqV3CardInput = {
      text: "Approve deploy?\nExtra context line.",
      buttons: promptButtons,
      theme: "prompt",
    };
    const out = cliqCardToV3MessageCard(card, { botId: "bot" })!;
    expect(out.card.title).toBe("Approve deploy?");
    expect(out.text).toBe("Approve deploy?\nExtra context line.");
    expect(out.slides).toEqual([
      { type: "text", data: "Extra context line." },
    ]);
  });

  it("uses the default title when text is empty (buttons-only prompt)", () => {
    const card: CliqV3CardInput = {
      buttons: promptButtons,
      theme: "prompt",
    };
    const out = cliqCardToV3MessageCard(card, {
      botId: "bot",
      defaultTitle: "Choose an option",
    })!;
    expect(out.card.title).toBe("Choose an option");
    expect(out.text).toBeUndefined();
    expect(out.slides).toBeUndefined();
  });

  it("returns null when no buttons survive conversion (prompt requires ≥1)", () => {
    // All invoke buttons dropped (no botId) → no convertible buttons → null.
    const card: CliqV3CardInput = {
      text: "Approve?",
      buttons: [{ label: "OK", type: "+", action: "invoke", data: "/ok" }],
      theme: "prompt",
    };
    expect(cliqCardToV3MessageCard(card)).toBeNull();
  });

  it("returns null for a buttonless prompt even when text is present", () => {
    const card: CliqV3CardInput = {
      text: "Just a question",
      buttons: [],
      theme: "prompt",
    };
    expect(cliqCardToV3MessageCard(card)).toBeNull();
  });

  it("returns null for a buttonless prompt with no text either", () => {
    const card: CliqV3CardInput = { theme: "prompt" };
    expect(cliqCardToV3MessageCard(card)).toBeNull();
  });

  it("caps prompt buttons at 5 (v3 limit)", () => {
    const many: CliqButton[] = Array.from({ length: 8 }, (_, i) => ({
      label: `B${i}`,
      type: "+" as const,
      action: "openurl" as const,
      url: `https://example.com/${i}`,
    }));
    const card: CliqV3CardInput = { text: "Pick", buttons: many, theme: "prompt" };
    const out = cliqCardToV3MessageCard(card)!;
    expect((out.card as V3PromptCard).buttons).toHaveLength(V3_MAX_BUTTONS_PER_CARD);
  });

  it("preserves the v2→v3 button action mapping for prompt buttons", () => {
    const card: CliqV3CardInput = {
      text: "Pick",
      buttons: promptButtons,
      theme: "prompt",
    };
    const out = cliqCardToV3MessageCard(card, { botId: "bot" })!;
    const buttons = (out.card as V3PromptCard).buttons;
    // invoke → invoke.bot carrying bot_name + message.
    expect(buttons[0].action.type).toBe("invoke.bot");
    expect(buttons[0].action.data).toEqual({ bot_name: "bot", message: "/approve" });
    // openurl → open.url carrying web.
    expect(buttons[2].action.type).toBe("open.url");
    expect(buttons[2].action.data).toEqual({ web: "https://example.com" });
  });

  it("falls back to modern-inline (the default) when theme is absent", () => {
    const card: CliqV3CardInput = { text: "Pick", buttons: promptButtons };
    const out = cliqCardToV3MessageCard(card, { botId: "bot" })!;
    expect(out.card.theme).toBe("modern-inline");
  });
});

describe("cliqCardToV3MessageCard — poll theme", () => {
  it("emits a poll card with theme/title/options when theme === 'poll'", () => {
    const card: CliqV3CardInput = {
      text: "Which feature should we prioritize?",
      theme: "poll",
      pollOptions: ["OAuth 2.0", "Dark mode", "Push notifications"],
    };
    const out = cliqCardToV3MessageCard(card);
    expect(out).not.toBeNull();
    expect(out!.card.theme).toBe("poll");
    const poll = out!.card as V3PollCard;
    expect(poll.theme).toBe("poll");
    expect(poll.title).toBe("Which feature should we prioritize?");
    expect(poll.options).toEqual([
      { text: "OAuth 2.0" },
      { text: "Dark mode" },
      { text: "Push notifications" },
    ]);
    // poll has NO buttons / sections / thumbnail fields.
    expect("buttons" in poll).toBe(false);
    expect("sections" in poll).toBe(false);
    expect("thumbnail" in poll).toBe(false);
    // Full text kept as the top-level fallback.
    expect(out!.text).toBe("Which feature should we prioritize?");
    // Single-line text → no remainder → no slides.
    expect(out!.slides).toBeUndefined();
  });

  it("ignores `buttons` for a poll (voting options are not action buttons)", () => {
    const card: CliqV3CardInput = {
      text: "Vote!",
      theme: "poll",
      pollOptions: ["A", "B"],
      buttons: [
        { label: "Open", type: "+", action: "openurl", url: "https://x.com" },
      ],
    };
    const out = cliqCardToV3MessageCard(card)!;
    expect((out.card as V3PollCard).options).toHaveLength(2);
    expect("buttons" in out.card).toBe(false);
  });

  it("splits the first line into the title and the rest into a text slide", () => {
    const card: CliqV3CardInput = {
      text: "Pick a feature.\nExtra context line.",
      theme: "poll",
      pollOptions: ["A", "B"],
    };
    const out = cliqCardToV3MessageCard(card)!;
    expect(out.card.title).toBe("Pick a feature.");
    expect(out.text).toBe("Pick a feature.\nExtra context line.");
    expect(out.slides).toEqual([{ type: "text", data: "Extra context line." }]);
  });

  it("uses the default title when text is empty", () => {
    const card: CliqV3CardInput = {
      theme: "poll",
      pollOptions: ["A", "B"],
    };
    const out = cliqCardToV3MessageCard(card, { defaultTitle: "Poll" })!;
    expect(out.card.title).toBe("Poll");
    expect(out.text).toBeUndefined();
    expect(out.slides).toBeUndefined();
  });

  it("returns null when fewer than 2 poll options survive", () => {
    expect(
      cliqCardToV3MessageCard({ theme: "poll", pollOptions: ["only"] }),
    ).toBeNull();
    expect(
      cliqCardToV3MessageCard({ theme: "poll", pollOptions: [] }),
    ).toBeNull();
    expect(
      cliqCardToV3MessageCard({ theme: "poll" }),
    ).toBeNull();
  });

  it("drops empty/whitespace poll options before counting", () => {
    const card: CliqV3CardInput = {
      theme: "poll",
      pollOptions: ["A", "  ", "", "B"],
    };
    const out = cliqCardToV3MessageCard(card)!;
    expect((out.card as V3PollCard).options).toEqual([{ text: "A" }, { text: "B" }]);
  });

  it("caps poll options at 10 (v3 limit)", () => {
    const many = Array.from({ length: 15 }, (_, i) => `Option ${i}`);
    const card: CliqV3CardInput = { theme: "poll", pollOptions: many };
    const out = cliqCardToV3MessageCard(card)!;
    expect((out.card as V3PollCard).options).toHaveLength(V3_MAX_POLL_OPTIONS);
  });

  it("clamps a too-long option to 100 chars with an ellipsis", () => {
    const long = "A".repeat(150);
    const card: CliqV3CardInput = { theme: "poll", pollOptions: [long, "B"] };
    const out = cliqCardToV3MessageCard(card)!;
    const options = (out.card as V3PollCard).options;
    expect(options[0].text.length).toBe(100);
    expect(options[0].text.endsWith("…")).toBe(true);
    expect(options[1].text).toBe("B");
  });

  it("honors opts.theme as a fallback when card.theme is absent", () => {
    const card: CliqV3CardInput = {
      text: "Vote",
      pollOptions: ["A", "B"],
    };
    const out = cliqCardToV3MessageCard(card, { theme: "poll" })!;
    expect(out.card.theme).toBe("poll");
  });

  it("card.theme takes precedence over opts.theme", () => {
    const card: CliqV3CardInput = {
      text: "Vote",
      theme: "poll",
      pollOptions: ["A", "B"],
    };
    const out = cliqCardToV3MessageCard(card, { theme: "modern-inline" })!;
    expect(out.card.theme).toBe("poll");
  });
});

describe("normalizeV3Slide", () => {
  it("normalizes a table slide (drops empty headers, keeps only matching row keys)", () => {
    const out = normalizeV3Slide({
      type: "table",
      title: "Ticket Details",
      headers: ["Field", "  ", "Value"],
      rows: [
        { Field: "Ticket ID", Value: "#TKT-1", Bogus: "x" },
        { Field: "Priority", Value: "Critical" },
      ],
    })!;
    expect(out).not.toBeNull();
    expect(out.type).toBe("table");
    expect(out.title).toBe("Ticket Details");
    expect((out.data as { headers: string[] }).headers).toEqual([
      "Field",
      "Value",
    ]);
    const rows = (out.data as { rows: Record<string, string>[] }).rows;
    expect(rows).toEqual([
      { Field: "Ticket ID", Value: "#TKT-1" },
      { Field: "Priority", Value: "Critical" },
    ]);
  });

  it("returns null for a table with no surviving headers", () => {
    expect(
      normalizeV3Slide({ type: "table", headers: ["  ", ""], rows: [] }),
    ).toBeNull();
  });

  it("clamps table headers/rows to their caps", () => {
    const headers = Array.from({ length: V3_MAX_TABLE_HEADERS + 5 }, (_, i) => `h${i}`);
    const rows = Array.from({ length: V3_MAX_TABLE_ROWS + 5 }, () =>
      Object.fromEntries(headers.map((h) => [h, "v"])),
    );
    const out = normalizeV3Slide({ type: "table", headers, rows })!;
    const data = out.data as { headers: string[]; rows: unknown[] };
    expect(data.headers).toHaveLength(V3_MAX_TABLE_HEADERS);
    expect(data.rows).toHaveLength(V3_MAX_TABLE_ROWS);
  });

  it("clamps over-long table cells to the cell cap with an ellipsis", () => {
    const long = "A".repeat(V3_MAX_SLIDE_CELL_LENGTH + 50);
    const out = normalizeV3Slide({
      type: "table",
      headers: ["H"],
      rows: [{ H: long }],
    })!;
    const rows = (out.data as { rows: Record<string, string>[] }).rows;
    expect(rows[0].H.length).toBe(V3_MAX_SLIDE_CELL_LENGTH);
    expect(rows[0].H.endsWith("…")).toBe(true);
  });

  it("normalizes a list slide (drops empties)", () => {
    const out = normalizeV3Slide({
      type: "list",
      title: "Steps",
      items: ["one", "  ", "", "two"],
    })!;
    expect(out.type).toBe("list");
    expect(out.title).toBe("Steps");
    expect(out.data).toEqual(["one", "two"]);
  });

  it("returns null for an empty list", () => {
    expect(normalizeV3Slide({ type: "list", items: ["  ", ""] })).toBeNull();
    expect(normalizeV3Slide({ type: "list", items: [] })).toBeNull();
  });

  it("caps list items at the limit", () => {
    const items = Array.from({ length: V3_MAX_LIST_ITEMS + 5 }, (_, i) => `i${i}`);
    const out = normalizeV3Slide({ type: "list", items })!;
    expect((out.data as string[]).length).toBe(V3_MAX_LIST_ITEMS);
  });

  it("normalizes a label slide (drops pairs with empty label or value)", () => {
    const out = normalizeV3Slide({
      type: "label",
      pairs: [
        { label: "Status", value: "Open" },
        { label: "  ", value: "x" },
        { label: "Owner", value: "" },
        { label: "Env", value: "prod" },
      ],
    })!;
    expect(out.type).toBe("label");
    expect(out.data).toEqual([
      { label: "Status", value: "Open" },
      { label: "Env", value: "prod" },
    ]);
  });

  it("returns null for a label slide with no surviving pairs", () => {
    expect(
      normalizeV3Slide({
        type: "label",
        pairs: [{ label: "", value: "" }],
      }),
    ).toBeNull();
  });

  it("normalizes an images slide (HTTPS only, drops non-https / empty)", () => {
    const out = normalizeV3Slide({
      type: "images",
      urls: [
        "https://example.com/a.png",
        "http://insecure.com/b.png",
        "  ",
        "https://example.com/c.png",
      ],
    })!;
    expect(out.type).toBe("images");
    expect(out.data).toEqual([
      "https://example.com/a.png",
      "https://example.com/c.png",
    ]);
  });

  it("returns null for an images slide with no HTTPS urls", () => {
    expect(
      normalizeV3Slide({ type: "images", urls: ["http://x.com/a.png"] }),
    ).toBeNull();
  });

  it("caps image urls at the limit", () => {
    const urls = Array.from(
      { length: V3_MAX_IMAGE_URLS + 5 },
      (_, i) => `https://example.com/${i}.png`,
    );
    const out = normalizeV3Slide({ type: "images", urls })!;
    expect((out.data as string[]).length).toBe(V3_MAX_IMAGE_URLS);
  });

  it("normalizes a text slide (trims, clamps to cap)", () => {
    const long = "A".repeat(V3_MAX_SLIDE_TEXT_LENGTH + 100);
    const out = normalizeV3Slide({ type: "text", text: `  ${long}  ` })!;
    expect(out.type).toBe("text");
    expect((out.data as string).length).toBe(V3_MAX_SLIDE_TEXT_LENGTH);
    expect((out.data as string).endsWith("…")).toBe(true);
  });

  it("returns null for an empty text slide", () => {
    expect(normalizeV3Slide({ type: "text", text: "   " })).toBeNull();
  });

  it("drops the title when whitespace-only", () => {
    const out = normalizeV3Slide({
      type: "list",
      title: "   ",
      items: ["a"],
    })!;
    expect(out.title).toBeUndefined();
  });

  it("clamps an over-long slide title", () => {
    const out = normalizeV3Slide({
      type: "list",
      title: "A".repeat(200),
      items: ["a"],
    })!;
    expect(out.title!.length).toBe(100);
    expect(out.title!.endsWith("…")).toBe(true);
  });
});

describe("normalizeV3Slides", () => {
  it("returns undefined for no input / empty array", () => {
    expect(normalizeV3Slides(undefined)).toBeUndefined();
    expect(normalizeV3Slides([])).toBeUndefined();
  });

  it("drops invalid slides and keeps the survivors in order", () => {
    const out = normalizeV3Slides([
      { type: "list", items: ["a", "b"] },
      { type: "list", items: [] },
      { type: "text", text: "hello" },
      { type: "images", urls: ["http://insecure.com/x.png"] },
    ])!;
    expect(out).toHaveLength(2);
    expect(out[0].type).toBe("list");
    expect(out[1].type).toBe("text");
  });

  it("caps the number of slides at V3_MAX_SLIDES", () => {
    const slides: V3CardSlideInput[] = Array.from(
      { length: V3_MAX_SLIDES + 5 },
      () => ({ type: "text" as const, text: "x" }),
    );
    expect(normalizeV3Slides(slides)).toHaveLength(V3_MAX_SLIDES);
  });

  it("returns undefined when every slide is invalid", () => {
    expect(
      normalizeV3Slides([
        { type: "list", items: [] },
        { type: "text", text: "  " },
      ]),
    ).toBeUndefined();
  });
});

describe("cliqCardToV3MessageCard — slides passthrough", () => {
  it("appends input slides after the text-remainder slide (modern-inline)", () => {
    const card: CliqV3CardInput = {
      text: "Header\nbody remainder",
      slides: [
        { type: "list", items: ["a", "b"] },
        { type: "label", pairs: [{ label: "K", value: "V" }] },
      ],
    };
    const out = cliqCardToV3MessageCard(card)!;
    expect(out.slides).toEqual([
      { type: "text", data: "body remainder" },
      { type: "list", data: ["a", "b"] },
      { type: "label", data: [{ label: "K", value: "V" }] },
    ]);
  });

  it("appends input slides to a poll card (theme-independent)", () => {
    const card: CliqV3CardInput = {
      text: "Pick a feature.\nextra context",
      theme: "poll",
      pollOptions: ["A", "B"],
      slides: [{ type: "table", headers: ["X"], rows: [{ X: "1" }] }],
    };
    const out = cliqCardToV3MessageCard(card)!;
    expect(out.slides).toEqual([
      { type: "text", data: "extra context" },
      { type: "table", data: { headers: ["X"], rows: [{ X: "1" }] } },
    ]);
  });

  it("appends input slides to a prompt card", () => {
    const card: CliqV3CardInput = {
      text: "Approve?",
      buttons: [{ label: "OK", type: "+", action: "invoke", data: "y" }],
      theme: "prompt",
      slides: [{ type: "text", text: "extra detail" }],
    };
    const out = cliqCardToV3MessageCard(card, { botId: "bot" })!;
    expect(out.slides).toEqual([{ type: "text", data: "extra detail" }]);
  });

  it("omits slides when no input slides and no text remainder", () => {
    const card: CliqV3CardInput = {
      text: "Single line",
      slides: [{ type: "list", items: [] }],
    };
    const out = cliqCardToV3MessageCard(card)!;
    expect(out.slides).toBeUndefined();
  });

  it("omits slides when all input slides are invalid and there is no remainder", () => {
    const card: CliqV3CardInput = {
      text: "Single line",
      slides: [{ type: "list", items: [] }, { type: "text", text: "  " }],
    };
    const out = cliqCardToV3MessageCard(card)!;
    expect(out.slides).toBeUndefined();
  });

  it("drops invalid slides silently and never fails the send", () => {
    const card: CliqV3CardInput = {
      text: "Title",
      slides: [
        { type: "table", headers: [], rows: [] },
        { type: "images", urls: ["http://x.com/a.png"] },
        { type: "list", items: ["ok"] },
      ],
    };
    const out = cliqCardToV3MessageCard(card)!;
    expect(out.slides).toEqual([{ type: "list", data: ["ok"] }]);
  });
});
