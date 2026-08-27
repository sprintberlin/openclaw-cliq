import { describe, expect, it } from "vitest";
import {
  CLIQ_ORGANIZATION_BOUNDARY_STATEMENT,
  resolveCliqOrganizationIdentity,
} from "./identity.js";

describe("Cliq organization identity", () => {
  it("normalizes organization_id as unverified handler-forwarded evidence", () => {
    expect(resolveCliqOrganizationIdentity({
      user: { id: "u1", organization_id: " org-1 " },
    })).toEqual({
      organizationId: "org-1",
      source: "user.organization_id",
      trust: "handler_forwarded_unverified",
      admissionBoundary: "authenticated_webhook_and_bot_installation",
    });
  });

  it("accepts wrapped camelCase evidence without treating it as proof", () => {
    const identity = resolveCliqOrganizationIdentity({
      params: { user: { organizationId: "org-2" } },
    });
    expect(identity.organizationId).toBe("org-2");
    expect(identity.trust).toBe("handler_forwarded_unverified");
  });

  it("reports the compatibility boundary when no tenant field is present", () => {
    const identity = resolveCliqOrganizationIdentity({ user: { id: "u1" } });
    expect(identity.source).toBe("absent");
    expect(identity.admissionBoundary).toBe("authenticated_webhook_and_bot_installation");
    expect(CLIQ_ORGANIZATION_BOUNDARY_STATEMENT).toMatch(/not a signed tenant claim/i);
  });
});
