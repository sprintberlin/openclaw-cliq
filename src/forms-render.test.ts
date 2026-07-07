import { describe, it, expect } from "vitest";
import {
  renderCliqFormCards,
  readFormParam,
  parseCliqFormResponse,
  CLIQ_FORM_MAX_BUTTONS_PER_CARD,
  CLIQ_FORM_SENTINEL,
  type CliqFormInput,
  type CliqFormFieldInput,
} from "./forms-render.js";

describe("renderCliqFormCards", () => {
  it("renders a single select field as one prompt card with a button per option", () => {
    const cards = renderCliqFormCards({
      title: "Which priority?",
      fields: [
        {
          name: "priority",
          label: "Priority",
          type: "select",
          options: [
            { label: "High", value: "high" },
            { label: "Medium", value: "medium" },
            { label: "Low", value: "low" },
          ],
        },
      ],
    });
    expect(cards).toHaveLength(1);
    expect(cards[0].theme).toBe("prompt");
    expect(cards[0].title).toBe("Which priority?");
    expect(cards[0].buttons).toHaveLength(3);
    expect(cards[0].buttons![0]).toMatchObject({
      action: "invoke",
      data: `${CLIQ_FORM_SENTINEL} priority=high`,
      label: "High",
    });
    expect(cards[0].buttons![1]).toMatchObject({ data: `${CLIQ_FORM_SENTINEL} priority=medium` });
    expect(cards[0].buttons![2]).toMatchObject({ data: `${CLIQ_FORM_SENTINEL} priority=low` });
  });

  it("uses the field label as title when no form title is set", () => {
    const cards = renderCliqFormCards({
      fields: [
        {
          name: "severity",
          type: "select",
          options: ["critical", "normal"],
        },
      ],
    });
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe("severity");
  });

  it("renders string options (label = value)", () => {
    const cards = renderCliqFormCards({
      fields: [
        {
          name: "env",
          type: "select",
          options: ["prod", "staging", "dev"],
        },
      ],
    });
    expect(cards[0].buttons).toHaveLength(3);
    expect(cards[0].buttons![0]).toMatchObject({ label: "prod", data: `${CLIQ_FORM_SENTINEL} env=prod` });
    expect(cards[0].buttons![2]).toMatchObject({ label: "dev", data: `${CLIQ_FORM_SENTINEL} env=dev` });
  });

  it("renders text/number fields as a summary card before prompt cards", () => {
    const cards = renderCliqFormCards({
      title: "Deploy info",
      fields: [
        { name: "version", type: "text", placeholder: "v1.2.3" },
        { name: "count", type: "number" },
        {
          name: "priority",
          type: "select",
          options: ["high", "low"],
        },
      ],
    });
    expect(cards).toHaveLength(2);
    // Summary card first
    expect(cards[0].theme).toBe("modern-inline");
    expect(cards[0].title).toBe("Deploy info");
    expect(cards[0].text).toContain("version");
    expect(cards[0].text).toContain("(v1.2.3)");
    expect(cards[0].text).toContain("count");
    expect(cards[0].text).toContain("(number)");
    // Prompt card second
    expect(cards[1].theme).toBe("prompt");
    expect(cards[1].title).toBe("priority");
    expect(cards[1].buttons).toHaveLength(2);
  });

  it("renders a summary-only card when there are no select fields", () => {
    const cards = renderCliqFormCards({
      title: "Tell me",
      fields: [
        { name: "name", type: "text" },
        { name: "email", type: "text" },
      ],
    });
    expect(cards).toHaveLength(1);
    expect(cards[0].theme).toBe("modern-inline");
    expect(cards[0].buttons).toBeUndefined();
    expect(cards[0].text).toContain("name");
    expect(cards[0].text).toContain("email");
  });

  it("renders multiple select fields as separate prompt cards", () => {
    const cards = renderCliqFormCards({
      title: "Config",
      fields: [
        { name: "region", type: "select", options: ["us", "eu"] },
        { name: "tier", type: "select", options: ["free", "paid"] },
      ],
    });
    expect(cards).toHaveLength(2);
    expect(cards[0].title).toBe("Config");
    expect(cards[0].buttons![0].data).toBe(`${CLIQ_FORM_SENTINEL} region=us`);
    expect(cards[1].title).toBe("tier");
    expect(cards[1].buttons![0].data).toBe(`${CLIQ_FORM_SENTINEL} tier=free`);
  });

  it("caps buttons at the per-card limit and lists the remainder in the body", () => {
    const options = ["a", "b", "c", "d", "e", "f", "g"];
    const cards = renderCliqFormCards({
      fields: [
        { name: "pick", type: "select", options },
      ],
    });
    expect(cards).toHaveLength(1);
    expect(cards[0].buttons).toHaveLength(CLIQ_FORM_MAX_BUTTONS_PER_CARD);
    expect(cards[0].text).toContain("More options:");
    expect(cards[0].text).toContain("f");
    expect(cards[0].text).toContain("g");
  });

  it("treats a select field with fewer than 2 options as a text field", () => {
    const cards = renderCliqFormCards({
      fields: [
        { name: "lone", type: "select", options: ["only"] },
      ],
    });
    expect(cards).toHaveLength(1);
    expect(cards[0].theme).toBe("modern-inline");
    expect(cards[0].buttons).toBeUndefined();
    expect(cards[0].text).toContain("lone");
  });

  it("clamps over-length button labels", () => {
    const longLabel = "A".repeat(50);
    const cards = renderCliqFormCards({
      fields: [
        { name: "x", type: "select", options: [{ label: longLabel, value: "v" }, "ok"] },
      ],
    });
    expect(cards[0].buttons![0].label.length).toBeLessThanOrEqual(30);
    expect(cards[0].buttons![0].label.endsWith("…")).toBe(true);
    expect(cards[0].buttons![0].data).toBe(`${CLIQ_FORM_SENTINEL} x=v`);
  });

  it("clamps over-length titles", () => {
    const longTitle = "T".repeat(300);
    const cards = renderCliqFormCards({
      title: longTitle,
      fields: [{ name: "x", type: "select", options: ["a", "b"] }],
    });
    expect(cards[0].title.length).toBeLessThanOrEqual(200);
    expect(cards[0].title.endsWith("…")).toBe(true);
  });

  it("returns [] for an empty form", () => {
    expect(renderCliqFormCards({ fields: [] })).toEqual([]);
    expect(renderCliqFormCards({ title: "x", fields: [] })).toEqual([]);
  });

  it("returns [] for a form with only unnamed fields", () => {
    expect(
      renderCliqFormCards({
        fields: [
          { name: "", type: "select", options: ["a", "b"] } as unknown as CliqFormFieldInput,
        ],
      }),
    ).toEqual([]);
  });

  it("returns [] for non-form input", () => {
    expect(renderCliqFormCards(null as unknown as CliqFormInput)).toEqual([]);
    expect(renderCliqFormCards({} as CliqFormInput)).toEqual([]);
    expect(
      renderCliqFormCards({ fields: "nope" } as unknown as CliqFormInput),
    ).toEqual([]);
  });

  it("drops invalid option entries", () => {
    const cards = renderCliqFormCards({
      fields: [
        {
          name: "x",
          type: "select",
          options: ["valid", "", { label: "", value: "" }, null, 42, { label: "Ok", value: "ok" }] as CliqFormFieldInput["options"],
        },
      ],
    });
    // "valid" + {Ok, ok} survive = 2 options ≥ 2 → prompt card
    expect(cards).toHaveLength(1);
    expect(cards[0].theme).toBe("prompt");
    expect(cards[0].buttons).toHaveLength(2);
  });

  it("button data uses field name (not label); card title uses field label", () => {
    const cards = renderCliqFormCards({
      fields: [
        {
          name: "priority_field",
          label: "Priority",
          type: "select",
          options: [
            { label: "High", value: "high" },
            { label: "Low", value: "low" },
          ],
        },
      ],
    });
    expect(cards).toHaveLength(1);
    expect(cards[0].theme).toBe("prompt");
    // Title uses the field label
    expect(cards[0].title).toBe("Priority");
    // Button data uses the field NAME (the key), not the label
    expect(cards[0].buttons![0].data).toBe(`${CLIQ_FORM_SENTINEL} priority_field=high`);
    expect(cards[0].buttons![0].label).toBe("High");
  });
});

describe("readFormParam", () => {
  it("parses a full form definition", () => {
    const form = readFormParam({
      title: "Approve?",
      fields: [
        { name: "priority", label: "Priority", type: "select", options: ["high", "low"] },
        { name: "reason", type: "text", placeholder: "why" },
      ],
    });
    expect(form).not.toBeNull();
    expect(form!.title).toBe("Approve?");
    expect(form!.fields).toHaveLength(2);
    expect(form!.fields[0].type).toBe("select");
    expect(form!.fields[1].placeholder).toBe("why");
  });

  it("defaults type to text when absent", () => {
    const form = readFormParam({ fields: [{ name: "x" }] });
    expect(form!.fields[0].type).toBeUndefined();
  });

  it("returns null for a non-object", () => {
    expect(readFormParam(null)).toBeNull();
    expect(readFormParam("string")).toBeNull();
    expect(readFormParam([])).toBeNull();
  });

  it("returns null when fields is not an array", () => {
    expect(readFormParam({ title: "x", fields: "nope" })).toBeNull();
  });

  it("returns null when no fields survive validation", () => {
    expect(readFormParam({ fields: [{ label: "no name" }] })).toBeNull();
    expect(readFormParam({ fields: [] })).toBeNull();
  });

  it("drops invalid field entries", () => {
    const form = readFormParam({
      fields: [
        null,
        "string",
        { name: "good", type: "select", options: ["a", "b"] },
        { name: "" },
        42,
      ],
    });
    expect(form!.fields).toHaveLength(1);
    expect(form!.fields[0].name).toBe("good");
  });

  it("accepts string and object options", () => {
    const form = readFormParam({
      fields: [
        {
          name: "x",
          type: "select",
          options: ["str", { label: "Obj", value: "obj" }],
        },
      ],
    });
    expect(form!.fields[0].options).toEqual(["str", { label: "Obj", value: "obj" }]);
  });
});

describe("parseCliqFormResponse", () => {
  it("parses a sentinel-prefixed field=value button-click payload", () => {
    const parsed = parseCliqFormResponse(`${CLIQ_FORM_SENTINEL} priority=high`);
    expect(parsed.matched).toBe(true);
    expect(parsed.formValues).toEqual({ priority: "high" });
    expect(parsed.body).toBe("priority: high");
    expect(parsed.text).toBe("priority: high");
  });

  it("splits on the first = so a value may contain =", () => {
    const parsed = parseCliqFormResponse(`${CLIQ_FORM_SENTINEL} token=abc=def=ghi`);
    expect(parsed.matched).toBe(true);
    expect(parsed.formValues).toEqual({ token: "abc=def=ghi" });
    expect(parsed.body).toBe("token: abc=def=ghi");
  });

  it("preserves spaces inside the value", () => {
    const parsed = parseCliqFormResponse(
      `${CLIQ_FORM_SENTINEL} reason=deploy the prod build`,
    );
    expect(parsed.matched).toBe(true);
    expect(parsed.formValues).toEqual({ reason: "deploy the prod build" });
    expect(parsed.body).toBe("reason: deploy the prod build");
  });

  it("returns unmatched for an ordinary message (no sentinel)", () => {
    const parsed = parseCliqFormResponse("priority: high");
    expect(parsed.matched).toBe(false);
    expect(parsed.formValues).toEqual({});
    expect(parsed.text).toBe("priority: high");
  });

  it("returns unmatched for a free-text name:value reply (summary-card path)", () => {
    const parsed = parseCliqFormResponse("version: 1.2.3");
    expect(parsed.matched).toBe(false);
    expect(parsed.formValues).toEqual({});
  });

  it("returns unmatched for empty / non-string input", () => {
    expect(parseCliqFormResponse("").matched).toBe(false);
    expect(parseCliqFormResponse(undefined as unknown as string).matched).toBe(false);
    expect(parseCliqFormResponse(null as unknown as string).matched).toBe(false);
  });

  it("recognizes a sentinel with no = (malformed) as matched but empty values", () => {
    const parsed = parseCliqFormResponse(`${CLIQ_FORM_SENTINEL} bogus`);
    expect(parsed.matched).toBe(true);
    expect(parsed.formValues).toEqual({});
    expect(parsed.body).toBe("bogus");
    expect(parsed.text).toBe("bogus");
  });

  it("recognizes a sentinel with an empty key (=value) as matched but empty values", () => {
    const parsed = parseCliqFormResponse(`${CLIQ_FORM_SENTINEL} =value`);
    expect(parsed.matched).toBe(true);
    expect(parsed.formValues).toEqual({});
  });

  it("does not match a sentinel substring elsewhere in the message", () => {
    const parsed = parseCliqFormResponse(`foo ${CLIQ_FORM_SENTINEL} x=1`);
    expect(parsed.matched).toBe(false);
  });

  it("requires the sentinel to be at the very start (no leading whitespace)", () => {
    // The Cliq message handler trims; a leading-space payload is treated as
    // unmatched to avoid a crafted `  __cliq_form__ …` bypassing detection.
    const parsed = parseCliqFormResponse(` ${CLIQ_FORM_SENTINEL} x=1`);
    expect(parsed.matched).toBe(false);
    // The text is still trimmed for downstream use.
    expect(parsed.text).toBe(`${CLIQ_FORM_SENTINEL} x=1`);
  });
});
