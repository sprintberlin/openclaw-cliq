/**
 * Native/custom commands adapter for the Cliq channel.
 *
 * The SDK's `ChannelCommandAdapter` (forwarded by `createChatChannelPlugin`
 * from `base`) drives the runtime's slash-command menu system — `/commands`,
 * `/models`, `/model <provider/model>`, … It has two halves:
 *
 * 1. **Auto-enable flags** — `nativeCommandsAutoEnabled` /
 *    `nativeSkillsAutoEnabled` tell the runtime the channel should have
 *    slash commands and registered skills turned on by default (operators
 *    can still disable per-channel). Without these the commands exist but
 *    are off until manually enabled.
 *
 * 2. **Channel-data builders** — when the runtime renders the `/commands`
 *    list or the `/models` menu, it asks the channel to contribute native
 *    interactive elements (Telegram returns inline keyboards; Discord
 *    returns component containers). For Cliq we return a rendered card
 *    marker (`{ cliqCard: { buttons } }`) — the SAME shape the outbound
 *    `sendPayload` adapter reads (see `outbound-presentation.ts`) — so the
 *    buttons are delivered via `CliqClient.sendCard` with no extra wiring.
 *
 * Cliq's button analog to a Telegram callback button is
 * `{ action: "invoke", data: <string> }`: tapping it posts `data` back to
 * the Deluge bot handler, which forwards it to our webhook as an inbound
 * message whose text IS the `data` string. So each button's `data` is the
 * slash command the runtime should re-parse when the user taps:
 *
 * - provider button  → `/models <provider>`      (list that provider's models)
 * - model button     → `/model <provider>/<model>` (switch to that model)
 * - prev/next button → `/models <provider> <page>`  (paginate the model list)
 * - browse button    → `/models`                  (back to providers list)
 *
 * The runtime's `/commands` handler does NOT accept a page argument (the
 * pagination is a bundled-channel callback-edit-in-place feature a plugin
 * channel cannot reproduce), so `buildCommandsListChannelData` returns
 * `null` and the commands list is delivered as plain text — which is fully
 * usable since the entries themselves are the command names.
 *
 * Cliq caps a single bot message at 10 buttons with 30-char labels, so the
 * model list paginates at 8 models per page (matching Telegram's page size)
 * to leave room for the prev/next + back row.
 */
import type { ChannelCommandAdapter } from "openclaw/plugin-sdk/channel-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/core";
import {
  CLIQ_MAX_BUTTONS_PER_MESSAGE,
  CLIQ_MAX_BUTTON_LABEL_LENGTH,
  type CliqButton,
} from "./presentation.js";

/** Models per page in the interactive model-list (leaves room for nav row). */
export const CLIQ_COMMANDS_MODELS_PAGE_SIZE = 6;

/** Channel-data marker key consumed by `outbound-presentation.sendPayload`. */
const CLIQ_CARD_CHANNEL_DATA_KEY = "cliqCard";

/** Max buttons Cliq will accept on one bot message. */
const MAX_BUTTONS = CLIQ_MAX_BUTTONS_PER_MESSAGE;

/**
 * Build a Cliq `invoke` button that posts `data` back to the Deluge handler
 * as an inbound message when tapped. Labels are clamped to the Cliq limit.
 */
export function cliqCommandButton(label: string, data: string): CliqButton {
  const trimmedLabel = label.trim();
  const clampedLabel =
    trimmedLabel.length <= CLIQ_MAX_BUTTON_LABEL_LENGTH
      ? trimmedLabel
      : trimmedLabel.slice(0, CLIQ_MAX_BUTTON_LABEL_LENGTH - 1).trimEnd() + "…";
  return {
    label: clampedLabel,
    type: "+",
    action: "invoke",
    data,
  };
}

/** Wrap a button array in the `cliqCard` channel-data marker. */
function toCardChannelData(
  buttons: CliqButton[],
): ReplyPayload["channelData"] | null {
  if (!buttons || buttons.length === 0) return null;
  return { [CLIQ_CARD_CHANNEL_DATA_KEY]: { buttons } } as unknown as ReplyPayload["channelData"];
}

/**
 * Build the provider-selection menu for `/models`. One invoke button per
 * provider, labelled `<provider> (<count>)`, posting `/models <provider>`.
 * Cliq's flat button list (no rows) is filled left-to-right; we emit two
 * providers per conceptual row by interleaving but Cliq lays them out
 * sequentially regardless. We cap at `MAX_BUTTONS` providers.
 */
export function buildCliqModelsMenuChannelData(params: {
  providers: Array<{ id: string; count: number }>;
}): ReplyPayload["channelData"] | null {
  if (!params.providers || params.providers.length === 0) return null;
  const buttons = params.providers
    .slice(0, MAX_BUTTONS)
    .map((p) => cliqCommandButton(`${p.id} (${p.count})`, `/models ${p.id}`));
  return toCardChannelData(buttons);
}

/** Alias for the provider menu (the runtime falls back to this builder). */
export function buildCliqModelsProviderChannelData(params: {
  providers: Array<{ id: string; count: number }>;
}): ReplyPayload["channelData"] | null {
  return buildCliqModelsMenuChannelData(params);
}

/**
 * Build the "add provider" menu (deprecated command surface — kept for
 * parity). Each button posts `/models add <provider>`.
 */
export function buildCliqModelsAddProviderChannelData(params: {
  providers: Array<{ id: string }>;
}): ReplyPayload["channelData"] | null {
  if (!params.providers || params.providers.length === 0) return null;
  const buttons = params.providers
    .slice(0, MAX_BUTTONS)
    .map((p) => cliqCommandButton(p.id, `/models add ${p.id}`));
  return toCardChannelData(buttons);
}

/**
 * Build a single "Browse providers" button for the `/model` summary view.
 * Tapping it posts `/models` (back to the providers menu).
 */
export function buildCliqModelBrowseChannelData(): ReplyPayload["channelData"] | null {
  return toCardChannelData([cliqCommandButton("Browse providers", "/models")]);
}

/**
 * Build the model-list menu for `/models <provider>`. One invoke button per
 * model on the current page, posting `/model <provider>/<model>` (switches
 * the session model). A trailing navigation row offers prev / page-indicator
 * / next (posting `/models <provider> <page>`) and a back button (posting
 * `/models` to return to the providers list). The currently-selected model is
 * marked with a ` ✓` suffix on its label.
 *
 * Cliq caps a single bot message at 10 buttons, so the nav row (up to 4:
 * prev + page + next + back) is computed first and the model grid fills the
 * remaining slots — never exceeding the cap. When `totalPages <= 1` the
 * prev/page/next buttons are omitted; the back button is always present.
 */
export function buildCliqModelsListChannelData(params: {
  provider: string;
  models: readonly string[];
  currentModel?: string;
  currentPage: number;
  totalPages: number;
  pageSize?: number;
  modelNames?: ReadonlyMap<string, string>;
}): ReplyPayload["channelData"] | null {
  const {
    provider,
    models,
    currentModel,
    currentPage,
    totalPages,
    pageSize = CLIQ_COMMANDS_MODELS_PAGE_SIZE,
    modelNames,
  } = params;

  if (!models || models.length === 0) {
    return toCardChannelData([cliqCommandButton("<< Back", "/models")]);
  }

  const safeTotalPages = Math.max(1, totalPages);
  const safePage = Math.max(1, Math.min(currentPage, safeTotalPages));
  const startIndex = (safePage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, models.length);
  const pageModels = models.slice(startIndex, endIndex);

  // Compute the navigation row first so the model grid can fill the
  // remaining slots without breaching Cliq's 10-button cap.
  const navButtons: CliqButton[] = [];
  if (safeTotalPages > 1) {
    if (safePage > 1) {
      navButtons.push(
        cliqCommandButton("◀ Prev", `/models ${provider} ${safePage - 1}`),
      );
    }
    navButtons.push(
      cliqCommandButton(`${safePage}/${safeTotalPages}`, `/models ${provider} ${safePage}`),
    );
    if (safePage < safeTotalPages) {
      navButtons.push(
        cliqCommandButton("Next ▶", `/models ${provider} ${safePage + 1}`),
      );
    }
  }
  navButtons.push(cliqCommandButton("<< Back", "/models"));

  const maxModelButtons = Math.max(0, MAX_BUTTONS - navButtons.length);
  const visibleModels = pageModels.slice(0, maxModelButtons);

  const buttons: CliqButton[] = [];
  for (const model of visibleModels) {
    const ref = `${provider}/${model}`;
    const display =
      modelNames?.get(ref) ?? (model.includes("/") ? ref : model);
    const isCurrent = isCurrentModelMatch(currentModel, provider, model);
    const label = isCurrent ? `${display} ✓` : display;
    buttons.push(cliqCommandButton(label, `/model ${ref}`));
  }

  buttons.push(...navButtons);

  return toCardChannelData(buttons);
}

/**
 * The `/commands` list pagination is a bundled-channel callback-edit
 * feature (Telegram edits the message in place with a new keyboard). A
 * plugin channel cannot reproduce it: a tapped button arrives as a fresh
 * inbound message, and the runtime's `/commands` handler does not accept
 * a page argument. Returning `null` lets the runtime deliver the commands
 * list as plain text, which is the correct degraded UX.
 */
export function buildCliqCommandsListChannelData(_params: {
  currentPage: number;
  totalPages: number;
  agentId?: string;
}): ReplyPayload["channelData"] | null {
  return null;
}

/** Whether `currentModel` matches `<provider>/<model>` or bare `model`. */
function isCurrentModelMatch(
  currentModel: string | undefined,
  provider: string,
  model: string,
): boolean {
  const current = currentModel?.trim();
  if (!current) return false;
  return current.includes("/")
    ? current === `${provider}/${model}`
    : current === model;
}

/**
 * Cliq `commands` adapter surface. Spread onto `base` of
 * `createChatChannelPlugin` (it forwards `commands` via `{ ...params.base }`).
 */
export const cliqCommandsAdapter: ChannelCommandAdapter = {
  nativeCommandsAutoEnabled: true,
  nativeSkillsAutoEnabled: true,
  buildCommandsListChannelData: buildCliqCommandsListChannelData,
  buildModelsMenuChannelData: buildCliqModelsMenuChannelData,
  buildModelsProviderChannelData: buildCliqModelsProviderChannelData,
  buildModelsAddProviderChannelData: buildCliqModelsAddProviderChannelData,
  buildModelsListChannelData: buildCliqModelsListChannelData,
  buildModelBrowseChannelData: buildCliqModelBrowseChannelData,
};
