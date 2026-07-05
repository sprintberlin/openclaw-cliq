import { describe, it, expect } from "vitest";
import {
  cliqCommandsAdapter,
  cliqCommandButton,
  buildCliqCommandsListChannelData,
  buildCliqModelsMenuChannelData,
  buildCliqModelsProviderChannelData,
  buildCliqModelsAddProviderChannelData,
  buildCliqModelsListChannelData,
  buildCliqModelBrowseChannelData,
  CLIQ_COMMANDS_MODELS_PAGE_SIZE,
} from "./commands.js";
import {
  CLIQ_MAX_BUTTONS_PER_MESSAGE,
  CLIQ_MAX_BUTTON_LABEL_LENGTH,
} from "./presentation.js";

function isCardChannelData(value: unknown): value is { cliqCard: { buttons: unknown[] } } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const card = (value as Record<string, unknown>)["cliqCard"];
  return Boolean(card && typeof card === "object" && !Array.isArray(card));
}

function buttonsOf(value: unknown): unknown[] {
  if (!isCardChannelData(value)) return [];
  return (value as { cliqCard: { buttons: unknown[] } }).cliqCard.buttons;
}

describe("cliqCommandsAdapter", () => {
  it("auto-enables native commands and skills", () => {
    expect(cliqCommandsAdapter.nativeCommandsAutoEnabled).toBe(true);
    expect(cliqCommandsAdapter.nativeSkillsAutoEnabled).toBe(true);
  });

  it("exposes the model-menu builders", () => {
    expect(typeof cliqCommandsAdapter.buildModelsMenuChannelData).toBe("function");
    expect(typeof cliqCommandsAdapter.buildModelsListChannelData).toBe("function");
    expect(typeof cliqCommandsAdapter.buildModelBrowseChannelData).toBe("function");
    expect(typeof cliqCommandsAdapter.buildCommandsListChannelData).toBe("function");
  });
});

describe("cliqCommandButton", () => {
  it("builds an invoke button carrying the slash command as data", () => {
    const btn = cliqCommandButton("openai", "/models openai");
    expect(btn).toEqual({
      label: "openai",
      type: "+",
      action: "invoke",
      data: "/models openai",
    });
  });

  it("clamps labels to the Cliq limit", () => {
    const long = "x".repeat(CLIQ_MAX_BUTTON_LABEL_LENGTH + 5);
    const btn = cliqCommandButton(long, "/model p/m");
    expect(btn.label.length).toBe(CLIQ_MAX_BUTTON_LABEL_LENGTH);
    expect(btn.label.endsWith("…")).toBe(true);
  });
});

describe("buildCliqModelsMenuChannelData", () => {
  it("returns one invoke button per provider posting /models <provider>", () => {
    const cd = buildCliqModelsMenuChannelData({
      providers: [
        { id: "openai", count: 3 },
        { id: "anthropic", count: 5 },
      ],
    });
    const buttons = buttonsOf(cd);
    expect(buttons).toHaveLength(2);
    expect(buttons).toContainEqual({
      label: "openai (3)",
      type: "+",
      action: "invoke",
      data: "/models openai",
    });
    expect(buttons).toContainEqual({
      label: "anthropic (5)",
      type: "+",
      action: "invoke",
      data: "/models anthropic",
    });
  });

  it("returns null when there are no providers", () => {
    expect(buildCliqModelsMenuChannelData({ providers: [] })).toBeNull();
  });

  it("caps the button count at the Cliq max", () => {
    const providers = Array.from({ length: CLIQ_MAX_BUTTONS_PER_MESSAGE + 3 }, (_, i) => ({
      id: `p${i}`,
      count: 1,
    }));
    const buttons = buttonsOf(buildCliqModelsMenuChannelData({ providers }));
    expect(buttons).toHaveLength(CLIQ_MAX_BUTTONS_PER_MESSAGE);
  });

  it("buildCliqModelsProviderChannelData is an alias for the menu", () => {
    const params = { providers: [{ id: "openai", count: 2 }] };
    expect(buildCliqModelsProviderChannelData(params)).toEqual(
      buildCliqModelsMenuChannelData(params),
    );
  });
});

describe("buildCliqModelsAddProviderChannelData", () => {
  it("builds /models add <provider> buttons", () => {
    const cd = buildCliqModelsAddProviderChannelData({
      providers: [{ id: "openai" }, { id: "anthropic" }],
    });
    const buttons = buttonsOf(cd);
    expect(buttons).toHaveLength(2);
    expect(buttons).toContainEqual({
      label: "openai",
      type: "+",
      action: "invoke",
      data: "/models add openai",
    });
  });

  it("returns null for empty providers", () => {
    expect(buildCliqModelsAddProviderChannelData({ providers: [] })).toBeNull();
  });
});

describe("buildCliqModelBrowseChannelData", () => {
  it("returns a single Browse providers button posting /models", () => {
    const buttons = buttonsOf(buildCliqModelBrowseChannelData());
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toEqual({
      label: "Browse providers",
      type: "+",
      action: "invoke",
      data: "/models",
    });
  });
});

describe("buildCliqModelsListChannelData", () => {
  const models = ["gpt-4", "gpt-4o", "o1", "o3", "gpt-3.5", "gpt-4-mini", "o1-mini", "o3-mini"];

  it("builds a switch button per model posting /model <provider>/<model>", () => {
    const cd = buildCliqModelsListChannelData({
      provider: "openai",
      models,
      currentPage: 1,
      totalPages: 1,
      pageSize: models.length,
    });
    const buttons = buttonsOf(cd);
    expect(buttons).toHaveLength(models.length + 1); // models + Back
    expect(buttons).toContainEqual({
      label: "gpt-4",
      type: "+",
      action: "invoke",
      data: "/model openai/gpt-4",
    });
    // Back button always present
    expect(buttons).toContainEqual({
      label: "<< Back",
      type: "+",
      action: "invoke",
      data: "/models",
    });
  });

  it("marks the current model with a checkmark and keeps the same data", () => {
    const cd = buildCliqModelsListChannelData({
      provider: "openai",
      models,
      currentModel: "openai/gpt-4",
      currentPage: 1,
      totalPages: 1,
    });
    const buttons = buttonsOf(cd);
    const gpt4 = buttons.find((b) => (b as { data?: string }).data === "/model openai/gpt-4");
    expect((gpt4 as { label: string }).label).toBe("gpt-4 ✓");
  });

  it("matches a bare current model id (no provider prefix)", () => {
    const cd = buildCliqModelsListChannelData({
      provider: "openai",
      models,
      currentModel: "gpt-4o",
      currentPage: 1,
      totalPages: 1,
    });
    const buttons = buttonsOf(cd);
    const o = buttons.find((b) => (b as { data?: string }).data === "/model openai/gpt-4o");
    expect((o as { label: string }).label).toBe("gpt-4o ✓");
  });

  it("uses the modelNames map for display labels", () => {
    const names = new Map([["openai/o1", "o1 (reasoning)"]]);
    const cd = buildCliqModelsListChannelData({
      provider: "openai",
      models,
      modelNames: names,
      currentPage: 1,
      totalPages: 1,
    });
    const buttons = buttonsOf(cd);
    const o1 = buttons.find((b) => (b as { data?: string }).data === "/model openai/o1");
    expect((o1 as { label: string }).label).toBe("o1 (reasoning)");
  });

  it("adds prev/next/page buttons when totalPages > 1 and posts the page number", () => {
    const cd = buildCliqModelsListChannelData({
      provider: "openai",
      models,
      currentPage: 2,
      totalPages: 3,
    });
    const buttons = buttonsOf(cd);
    expect(buttons).toContainEqual({
      label: "◀ Prev",
      type: "+",
      action: "invoke",
      data: "/models openai 1",
    });
    expect(buttons).toContainEqual({
      label: "2/3",
      type: "+",
      action: "invoke",
      data: "/models openai 2",
    });
    expect(buttons).toContainEqual({
      label: "Next ▶",
      type: "+",
      action: "invoke",
      data: "/models openai 3",
    });
  });

  it("omits prev on the first page and next on the last page", () => {
    const first = buttonsOf(
      buildCliqModelsListChannelData({ provider: "openai", models, currentPage: 1, totalPages: 3 }),
    );
    expect(first.find((b) => (b as { label?: string }).label === "◀ Prev")).toBeUndefined();
    expect(first.find((b) => (b as { label?: string }).label === "Next ▶")).toBeDefined();

    const last = buttonsOf(
      buildCliqModelsListChannelData({ provider: "openai", models, currentPage: 3, totalPages: 3 }),
    );
    expect(last.find((b) => (b as { label?: string }).label === "Next ▶")).toBeUndefined();
    expect(last.find((b) => (b as { label?: string }).label === "◀ Prev")).toBeDefined();
  });

  it("clamps page into [1, totalPages]", () => {
    const cd = buildCliqModelsListChannelData({
      provider: "openai",
      models,
      currentPage: 99,
      totalPages: 2,
    });
    const buttons = buttonsOf(cd);
    expect(buttons).toContainEqual({
      label: "2/2",
      type: "+",
      action: "invoke",
      data: "/models openai 2",
    });
  });

  it("returns a lone Back button when the model list is empty", () => {
    const cd = buildCliqModelsListChannelData({
      provider: "openai",
      models: [],
      currentPage: 1,
      totalPages: 1,
    });
    const buttons = buttonsOf(cd);
    expect(buttons).toHaveLength(1);
    expect(buttons).toContainEqual({
      label: "<< Back",
      type: "+",
      action: "invoke",
      data: "/models",
    });
  });

  it("respects the Cliq 10-button cap even with nav + back", () => {
    const many = Array.from({ length: 50 }, (_, i) => `model-${i}`);
    const cd = buildCliqModelsListChannelData({
      provider: "openai",
      models: many,
      currentPage: 1,
      totalPages: 10,
    });
    const buttons = buttonsOf(cd);
    expect(buttons.length).toBeLessThanOrEqual(CLIQ_MAX_BUTTONS_PER_MESSAGE);
  });

  it("uses the configured page size to slice the visible window", () => {
    const page = buildCliqModelsListChannelData({
      provider: "openai",
      models,
      currentPage: 2,
      totalPages: 2,
      pageSize: CLIQ_COMMANDS_MODELS_PAGE_SIZE,
    });
    const buttons = buttonsOf(page);
    // page 2 of 6-per-page from 8 models -> models index 6,7 (2 models)
    const modelButtons = buttons.filter((b) =>
      (b as { data?: string }).data?.startsWith("/model "),
    );
    expect(modelButtons).toHaveLength(2);
    expect(modelButtons).toContainEqual({
      label: "o1-mini",
      type: "+",
      action: "invoke",
      data: "/model openai/o1-mini",
    });
  });
});

describe("buildCliqCommandsListChannelData", () => {
  it("returns null (pagination is a bundled-channel callback feature)", () => {
    expect(
      buildCliqCommandsListChannelData({ currentPage: 1, totalPages: 3 }),
    ).toBeNull();
    expect(
      buildCliqCommandsListChannelData({ currentPage: 2, totalPages: 3, agentId: "main" }),
    ).toBeNull();
  });
});
