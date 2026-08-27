import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { WizardPrompter } from "openclaw/plugin-sdk/setup";
import { cliqDirectoryAdapter } from "./directory.js";

/**
 * A setup allowlist entry resolved (best effort) against the Cliq directory.
 *
 * `resolved` is false when the directory could not confirm the entry — the
 * operator's literal input is then kept verbatim rather than dropped or
 * broadened, so an offline / unscoped directory never silently changes who is
 * admitted.
 */
export interface CliqResolvedAllowlistEntry {
  input: string;
  id: string;
  label?: string;
  resolved: boolean;
}

function matches(entry: { id?: string; name?: string; handle?: string }, needle: string): boolean {
  const target = needle.trim().toLowerCase();
  if (!target) return false;
  return [entry.id, entry.name, entry.handle].some(
    (value) => typeof value === "string" && value.trim().toLowerCase() === target,
  );
}

/**
 * Resolve operator-entered allowlist entries (ids, names, emails, channel
 * unique names) to canonical Cliq ids using the existing directory adapter.
 *
 * For `kind: "user"` the canonical value is the Zoho user id (what DM
 * admission matches). For `kind: "group"` the canonical value is the channel
 * unique name (`handle`) because group config is keyed by unique name.
 * A directory failure degrades to "unresolved" for every entry.
 */
export async function resolveCliqDirectoryAllowlist(params: {
  cfg: OpenClawConfig;
  entries: string[];
  kind: "user" | "group";
  accountId?: string;
}): Promise<CliqResolvedAllowlistEntry[]> {
  const cleaned = params.entries
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (cleaned.length === 0) return [];

  let listed: Array<{ id?: string; name?: string; handle?: string }> = [];
  try {
    const list =
      params.kind === "user"
        ? await cliqDirectoryAdapter.listPeers?.({
            cfg: params.cfg,
            accountId: params.accountId,
            runtime: undefined as never,
          })
        : await cliqDirectoryAdapter.listGroups?.({
            cfg: params.cfg,
            accountId: params.accountId,
            runtime: undefined as never,
          });
    listed = list ?? [];
  } catch {
    listed = [];
  }

  return cleaned.map((input) => {
    const hit = listed.find((entry) => matches(entry, input));
    if (!hit) return { input, id: input, resolved: false };
    const id =
      params.kind === "group"
        ? (hit.handle ?? hit.id ?? input)
        : (hit.id ?? input);
    return { input, id, label: hit.name, resolved: true };
  });
}

export async function promptCliqDirectoryTarget(params: {
  cfg: OpenClawConfig;
  kind: "user" | "group";
  prompter: Pick<WizardPrompter, "text" | "note">;
  accountId?: string;
}): Promise<CliqResolvedAllowlistEntry | null> {
  const noun = params.kind === "user" ? "user" : "channel";
  const value = await params.prompter.text({
    message:
      params.kind === "user"
        ? "Optional first-contact user (name, email, or user id)"
        : "Optional test channel (name, handle, or channel id)",
    placeholder: params.kind === "user" ? "person@example.com" : "dev-team",
  });
  const input = value.trim();
  if (!input) return null;
  const [resolved] = await resolveCliqDirectoryAllowlist({
    cfg: params.cfg,
    entries: [input],
    kind: params.kind,
    accountId: params.accountId,
  });
  if (!resolved) return null;
  if (!resolved.resolved) {
    await params.prompter.note(
      `The Cliq directory could not resolve ${noun} "${input}". The literal value is preserved and no identity is guessed.`,
      "Zoho Cliq target",
    );
  }
  return resolved;
}
