import { describe, it, expect } from "vitest";
import {
  presentationToCliqCard,
  cliqButtonFromPortable,
  cliqButtonFromOption,
  simpleButtonsToCliqButtons,
  CLIQ_PRESENTATION_CAPABILITIES,
  CLIQ_MAX_BUTTONS_PER_MESSAGE,
  CLIQ_MAX_BUTTON_LABEL_LENGTH,
  type PortablePresentation,
} from "./presentation.js";

describe("cliqButtonFromPortable", () => {
  it("converts a url button to an openurl button", () => {
    const b = cliqButtonFromPortable({ label: "Open", url: "https://example.com" });
    expect(b).toEqual({
      label: "Open",
      type: "+",
      action: "openurl",
      url: "https://example.com",
    });
  });

  it("converts a callback-value button to an invoke button", () => {
    const b = cliqButtonFromPortable({ label: "Confirm", value: "confirm:yes" });
    expect(b).toEqual({
      label: "Confirm",
      type: "+",
      action: "invoke",
      data: "confirm:yes",
    });
  });

  it("converts a command action to an invoke button carrying the command", () => {
    const b = cliqButtonFromPortable({
      label: "Run",
      action: { type: "command", command: "/status" },
    });
    expect(b).toEqual({
      label: "Run",
      type: "+",
      action: "invoke",
      data: "/status",
    });
  });

  it("converts a callback action to an invoke button carrying the value", () => {
    const b = cliqButtonFromPortable({
      label: "Pick",
      action: { type: "callback", value: "opt-3" },
    });
    expect(b).toEqual({ label: "Pick", type: "+", action: "invoke", data: "opt-3" });
  });

  it("drops a button with neither url nor callback value", () => {
    expect(cliqButtonFromPortable({ label: "Nothing" })).toBeUndefined();
  });

  it("drops a disabled button", () => {
    expect(
      cliqButtonFromPortable({ label: "X", url: "https://x", disabled: true }),
    ).toBeUndefined();
  });

  it("drops a button whose label is empty after trim", () => {
    expect(cliqButtonFromPortable({ label: "   ", url: "https://x" })).toBeUndefined();
  });

  it("clamps a label exceeding the Cliq limit, adding an ellipsis", () => {
    const long = "a".repeat(CLIQ_MAX_BUTTON_LABEL_LENGTH + 5);
    const b = cliqButtonFromPortable({ label: long, url: "https://x" });
    expect(b!.label.length).toBe(CLIQ_MAX_BUTTON_LABEL_LENGTH);
    expect(b!.label.endsWith("…")).toBe(true);
  });

  it("drops the style hint (Cliq has no button styles)", () => {
    const b = cliqButtonFromPortable({
      label: "Danger",
      url: "https://x",
      style: "danger",
    });
    expect(b).not.toHaveProperty("style");
  });
});

describe("cliqButtonFromOption", () => {
  it("converts a select option into an invoke button (value fallback to label)", () => {
    expect(cliqButtonFromOption({ label: "Yes" })).toEqual({
      label: "Yes",
      type: "+",
      action: "invoke",
      data: "Yes",
    });
  });

  it("uses the option value when present", () => {
    expect(cliqButtonFromOption({ label: "Yes", value: "y" })).toEqual({
      label: "Yes",
      type: "+",
      action: "invoke",
      data: "y",
    });
  });
});

describe("presentationToCliqCard", () => {
  it("concatenates text + context blocks, inserts dividers as --- rules", () => {
    const card = presentationToCliqCard({
      blocks: [
        { type: "text", text: "Title here" },
        { type: "context", text: "subtitle" },
        { type: "divider" },
        { type: "text", text: "Body" },
      ],
    });
    expect(card.text).toBe("Title here\n\nsubtitle\n\n---\n\nBody");
    expect(card.buttons).toBeUndefined();
  });

  it("prefixes the title on its own line", () => {
    const card = presentationToCliqCard({
      title: "Alert",
      blocks: [{ type: "text", text: "Something happened." }],
    });
    expect(card.text).toBe("Alert\n\nSomething happened.");
  });

  it("flattens buttons blocks into the buttons array (capped at the limit)", () => {
    const buttons = Array.from({ length: CLIQ_MAX_BUTTONS_PER_MESSAGE + 3 }, (_, i) => ({
      label: `B${i}`,
      value: `v${i}`,
    }));
    const card = presentationToCliqCard({
      blocks: [{ type: "buttons", buttons }],
    });
    expect(card.buttons).toHaveLength(CLIQ_MAX_BUTTONS_PER_MESSAGE);
    expect(card.buttons![0]).toMatchObject({ label: "B0", action: "invoke", data: "v0" });
  });

  it("flattens select options into buttons", () => {
    const card = presentationToCliqCard({
      blocks: [
        {
          type: "select",
          options: [
            { label: "Red", value: "r" },
            { label: "Green", value: "g" },
          ],
        },
      ],
    });
    expect(card.buttons).toHaveLength(2);
    expect(card.buttons![0]).toMatchObject({ label: "Red", action: "invoke", data: "r" });
  });

  it("returns an empty object for a presentation with no content", () => {
    expect(presentationToCliqCard({ blocks: [] })).toEqual({});
  });

  it("combines text + buttons in one card", () => {
    const card = presentationToCliqCard({
      title: "Pick one",
      blocks: [
        { type: "text", text: "Choose an action:" },
        { type: "buttons", buttons: [{ label: "Open", url: "https://x" }] },
      ],
    });
    expect(card.text).toBe("Pick one\n\nChoose an action:");
    expect(card.buttons).toHaveLength(1);
    expect(card.buttons![0]).toMatchObject({ action: "openurl", url: "https://x" });
  });
});

describe("simpleButtonsToCliqButtons", () => {
  it("converts the simple {label,url?,value?} shape", () => {
    const out = simpleButtonsToCliqButtons([
      { label: "Open", url: "https://example.com" },
      { label: "Confirm", value: "yes" },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ action: "openurl", url: "https://example.com" });
    expect(out[1]).toMatchObject({ action: "invoke", data: "yes" });
  });

  it("accepts `data` and `command` aliases for the callback value", () => {
    const out = simpleButtonsToCliqButtons([
      { label: "A", data: "d1" },
      { label: "B", command: "/run" },
    ]);
    expect(out[0]).toMatchObject({ data: "d1" });
    expect(out[1]).toMatchObject({ data: "/run" });
  });

  it("accepts `text` as a label alias", () => {
    const out = simpleButtonsToCliqButtons([{ text: "FromText", value: "v" }]);
    expect(out[0]).toMatchObject({ label: "FromText" });
  });

  it("drops entries with no resolvable button (no url/value)", () => {
    const out = simpleButtonsToCliqButtons([
      { label: "NoAction" },
      { label: "Ok", value: "v" },
      "not-an-object" as unknown as Record<string, unknown>,
      null,
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ label: "Ok" });
  });

  it("caps at the per-message limit", () => {
    const many = Array.from({ length: CLIQ_MAX_BUTTONS_PER_MESSAGE + 5 }, (_, i) => ({
      label: `B${i}`,
      value: `v${i}`,
    }));
    expect(simpleButtonsToCliqButtons(many)).toHaveLength(CLIQ_MAX_BUTTONS_PER_MESSAGE);
  });
});

describe("CLIQ_PRESENTATION_CAPABILITIES", () => {
  it("declares buttons supported, selects/context/divider not native", () => {
    expect(CLIQ_PRESENTATION_CAPABILITIES.supported).toBe(true);
    expect(CLIQ_PRESENTATION_CAPABILITIES.buttons).toBe(true);
    expect(CLIQ_PRESENTATION_CAPABILITIES.selects).toBe(false);
    expect(CLIQ_PRESENTATION_CAPABILITIES.context).toBe(false);
    expect(CLIQ_PRESENTATION_CAPABILITIES.divider).toBe(false);
  });

  it("declares the per-message action limits", () => {
    expect(CLIQ_PRESENTATION_CAPABILITIES.limits?.actions?.maxActions).toBe(
      CLIQ_MAX_BUTTONS_PER_MESSAGE,
    );
    expect(CLIQ_PRESENTATION_CAPABILITIES.limits?.actions?.supportsStyles).toBe(false);
  });
});

// Compile-time guard: the structural PortablePresentation type accepts the
// canonical shapes used above without needing the SDK's internal types.
const _guard: PortablePresentation = {
  title: "t",
  tone: "info",
  blocks: [
    { type: "text", text: "x" },
    { type: "context", text: "y" },
    { type: "divider" },
    { type: "buttons", buttons: [{ label: "z", url: "u" }] },
    { type: "select", options: [{ label: "o", value: "v" }] },
  ],
};
void _guard;
