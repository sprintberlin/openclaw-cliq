export interface CliqOrganizationIdentity {
  organizationId?: string;
  source: "user.organization_id" | "user.organizationId" | "absent";
  trust: "handler_forwarded_unverified" | "absent";
  admissionBoundary: "authenticated_webhook_and_bot_installation";
}

function readUser(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const payload = raw as Record<string, unknown>;
  const params = payload.params;
  const paramsUser = params && typeof params === "object" && !Array.isArray(params)
    ? (params as Record<string, unknown>).user
    : undefined;
  const value = paramsUser ?? payload.user;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function resolveCliqOrganizationIdentity(raw: unknown): CliqOrganizationIdentity {
  const user = readUser(raw);
  const snake = typeof user?.organization_id === "string" ? user.organization_id.trim() : "";
  if (snake) return { organizationId: snake, source: "user.organization_id", trust: "handler_forwarded_unverified", admissionBoundary: "authenticated_webhook_and_bot_installation" };
  const camel = typeof user?.organizationId === "string" ? user.organizationId.trim() : "";
  if (camel) return { organizationId: camel, source: "user.organizationId", trust: "handler_forwarded_unverified", admissionBoundary: "authenticated_webhook_and_bot_installation" };
  return { source: "absent", trust: "absent", admissionBoundary: "authenticated_webhook_and_bot_installation" };
}

export const CLIQ_ORGANIZATION_BOUNDARY_STATEMENT =
  "Zoho Cliq webhook user objects may contain organization_id, but Deluge forwards it as ordinary JSON; it is not a signed tenant claim and the Cliq user-directory API exposes no independent sender-to-organization proof. Runtime admission is therefore bounded by the verified x-cliq-webhook-secret and the installed bot-handler context, not by per-request organization verification.";
