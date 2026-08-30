import type { ChannelProgressDraftCompositorLine } from "openclaw/plugin-sdk/channel-outbound";
import { markdownToCliq } from "./markdown.js";

export function renderCliqProgressDraftText(
  text: string,
  _lines?: readonly ChannelProgressDraftCompositorLine[],
): string {
  return markdownToCliq(text);
}
