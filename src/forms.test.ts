import { describe, it, expect } from "vitest";
import {
  isCliqFormPayload,
  parseCliqFormSubmission,
  normalizeCliqFormValue,
  formatCliqFormBody,
  type CliqFormWebhookPayload,
} from "./forms.js";

describe("isCliqFormPayload", () => {
  it("recognizes handler=form", () => {
    expect(isCliqFormPayload({ handler: "form", values: { a: "1" } })).toBe(true);
  });

  it("is case-insensitive on the handler marker", () => {
    expect(isCliqFormPayload({ handler: "Form", values: { a: "1" } })).toBe(true);
    expect(isCliqFormPayload({ handler: "FORMHANDLER", values: { a: "1" } })).toBe(true);
  });

  it("recognizes a values object without a handler marker", () => {
    expect(isCliqFormPayload({ values: { approver: "alice" } })).toBe(true);
  });

  it("recognizes form.values placement", () => {
    expect(isCliqFormPayload({ form: { name: "f", values: { x: "1" } } })).toBe(true);
  });

  it("recognizes form_data / formvalues placements", () => {
    expect(isCliqFormPayload({ form_data: { x: "1" } })).toBe(true);
    expect(isCliqFormPayload({ formvalues: { x: "1" } })).toBe(true);
  });

  it("recognizes the params wrapper", () => {
    expect(isCliqFormPayload({ params: { values: { x: "1" } } })).toBe(true);
    expect(isCliqFormPayload({ params: { form: { name: "f", values: { x: "1" } } } })).toBe(true);
  });

  it("rejects an empty values object", () => {
    expect(isCliqFormPayload({ handler: "form", values: {} })).toBe(false);
    expect(isCliqFormPayload({ values: {} })).toBe(false);
  });

  it("rejects non-form payloads", () => {
    expect(isCliqFormPayload(null)).toBe(false);
    expect(isCliqFormPayload("string")).toBe(false);
    expect(isCliqFormPayload([])).toBe(false);
    expect(isCliqFormPayload({ handler: "message", message: "hi" })).toBe(false);
    expect(isCliqFormPayload({})).toBe(false);
  });
});

describe("normalizeCliqFormValue", () => {
  it("primitives", () => {
    expect(normalizeCliqFormValue("hello")).toBe("hello");
    expect(normalizeCliqFormValue(42)).toBe("42");
    expect(normalizeCliqFormValue(true)).toBe("true");
  });

  it("null / undefined → empty string", () => {
    expect(normalizeCliqFormValue(null)).toBe("");
    expect(normalizeCliqFormValue(undefined)).toBe("");
  });

  it("arrays are comma-joined", () => {
    expect(normalizeCliqFormValue(["a", "b", "c"])).toBe("a, b, c");
  });

  it("arrays drop empty entries", () => {
    expect(normalizeCliqFormValue(["a", "", "c"])).toBe("a, c");
  });

  it("Cliq {label,value} dropdown object prefers label", () => {
    expect(normalizeCliqFormValue({ label: "High", value: "high" })).toBe("High");
  });

  it("Cliq {label,value} with empty label falls back to value", () => {
    expect(normalizeCliqFormValue({ label: "", value: "high" })).toBe("high");
  });

  it("arbitrary object falls back to JSON.stringify", () => {
    expect(normalizeCliqFormValue({ foo: "bar" })).toBe('{"foo":"bar"}');
  });
});

describe("formatCliqFormBody", () => {
  it("renders header + fields", () => {
    const body = formatCliqFormBody({
      formName: "approval_request",
      values: {
        approver: "alice@corp.com",
        priority: { label: "High", value: "high" },
        tags: ["prod", "deploy"],
        reason: "prod deploy gate",
      },
    });
    expect(body).toBe(
      [
        "Form: approval_request",
        "approver: alice@corp.com",
        "priority: High",
        "tags: prod, deploy",
        "reason: prod deploy gate",
      ].join("\n"),
    );
  });

  it("omits empty values", () => {
    const body = formatCliqFormBody({
      formName: "f",
      values: { a: "1", b: "", c: null, d: "x" },
    });
    expect(body).toBe("Form: f\na: 1\nd: x");
  });

  it("renders without a form name", () => {
    const body = formatCliqFormBody({ values: { a: "1", b: "2" } });
    expect(body).toBe("a: 1\nb: 2");
  });

  it("nameless form with all-empty values yields empty string", () => {
    expect(formatCliqFormBody({ values: { a: "", b: null } })).toBe("");
  });

  it("named form with all-empty values yields just the header", () => {
    expect(formatCliqFormBody({ formName: "f", values: { a: "" } })).toBe("Form: f");
  });
});

describe("parseCliqFormSubmission", () => {
  it("parses handler=form + values", () => {
    const payload: CliqFormWebhookPayload = {
      handler: "form",
      form: { name: "approval_request" },
      values: { approver: "alice", priority: "high" },
    };
    const sub = parseCliqFormSubmission(payload);
    expect(sub).not.toBeNull();
    expect(sub?.formName).toBe("approval_request");
    expect(sub?.values).toEqual({ approver: "alice", priority: "high" });
    expect(sub?.body).toBe(
      ["Form: approval_request", "approver: alice", "priority: high"].join("\n"),
    );
  });

  it("parses form.values placement + form.link_name", () => {
    const sub = parseCliqFormSubmission({
      form: { link_name: "onboarding", values: { name: "Bob" } },
    });
    expect(sub?.formName).toBe("onboarding");
    expect(sub?.body).toBe("Form: onboarding\nname: Bob");
  });

  it("parses top-level form_name + form_data", () => {
    const sub = parseCliqFormSubmission({
      form_name: "collection",
      form_data: { x: "1" },
    });
    expect(sub?.formName).toBe("collection");
    expect(sub?.body).toBe("Form: collection\nx: 1");
  });

  it("parses the params wrapper", () => {
    const sub = parseCliqFormSubmission({
      params: {
        form: { name: "wrapped" },
        values: { a: "1" },
      },
    });
    expect(sub?.formName).toBe("wrapped");
    expect(sub?.values).toEqual({ a: "1" });
  });

  it("prefers the first non-empty values placement", () => {
    const sub = parseCliqFormSubmission({
      values: { a: "first" },
      form_data: { b: "second" },
    });
    expect(sub?.values).toEqual({ a: "first" });
  });

  it("returns null when no values object present", () => {
    expect(parseCliqFormSubmission({ handler: "form" })).toBeNull();
    expect(parseCliqFormSubmission({ form: { name: "f" } })).toBeNull();
    expect(parseCliqFormSubmission({})).toBeNull();
    expect(parseCliqFormSubmission(null)).toBeNull();
  });

  it("returns null for an empty values object", () => {
    expect(parseCliqFormSubmission({ values: {} })).toBeNull();
  });

  it("returns null when a named form has only empty field values", () => {
    expect(
      parseCliqFormSubmission({
        form: { name: "f" },
        values: { a: "", b: null, c: [] },
      }),
    ).toBeNull();
  });

  it("returns null when a nameless form has only empty field values", () => {
    expect(parseCliqFormSubmission({ values: { a: "", b: null } })).toBeNull();
  });
});
