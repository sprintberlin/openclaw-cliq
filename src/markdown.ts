/**
 * Markdown → Zoho Cliq formatting converter.
 *
 * Cliq renders a subset of Markdown natively, but with different delimiter
 * conventions than CommonMark. To make agent output (which is standard
 * Markdown) render correctly in Cliq, we convert the well-known constructs:
 *
 *   Markdown          → Cliq
 *   -----------------    -----------------
 *   **bold**          → *bold*           (single asterisk = bold in Cliq)
 *   __bold__          → *bold*
 *   *italic*          → _italic_         (single underscore = italic in Cliq)
 *   _italic_          → _italic_         (already correct)
 *   ~~strike~~        → ~strike~         (single tilde = strikethrough)
 *   > blockquote      → !blockquote     (line prefix)
 *   | a | b |         → a — b           (tables flattened to plain text)
 *   | --- | --- |     → (removed)        (table separator rows dropped)
 *   `code`            → `code`          (preserved verbatim)
 *   ```fenced```      → ```fenced```     (preserved verbatim)
 *   [text](url)       → [text](url)     (preserved verbatim)
 *
 * Inline code and fenced code blocks are protected from transformation so
 * Markdown that lives inside code (e.g. `**not bold**`) is not mangled.
 *
 * The function is a pure string transform — no I/O, no side effects — so it
 * is trivial to unit-test and can be applied at every outbound send site.
 */

/** Internal placeholder prefix for protected fenced code blocks. */
const CODE_BLOCK_TOKEN = "\u0000CB\u0000";
/** Internal placeholder prefix for protected inline code. */
const INLINE_CODE_TOKEN = "\u0000IC\u0000";
/** Internal placeholder for bold (between the two asterisk passes). */
const BOLD_OPEN = "\u0000BO\u0000";
const BOLD_CLOSE = "\u0000BC\u0000";

/**
 * Convert standard Markdown to Cliq-native formatting. Returns the input
 * unchanged when it is empty or contains no convertible constructs.
 */
export function markdownToCliq(text: string): string {
  if (!text) return text;

  let out = text;

  // Protect fenced code blocks from any further transformation.
  const codeBlocks: string[] = [];
  out = out.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `${CODE_BLOCK_TOKEN}${codeBlocks.length - 1}\u0000`;
  });

  // Protect inline code from transformation.
  const inlineCodes: string[] = [];
  out = out.replace(/`[^`]+`/g, (match) => {
    inlineCodes.push(match);
    return `${INLINE_CODE_TOKEN}${inlineCodes.length - 1}\u0000`;
  });

  // Bold: **text** → *text* (Cliq bold). Use a placeholder pair so the
  // single-asterisk italic pass below does not eat the inner text of the
  // just-emitted *bold*. Restored after the italic pass.
  out = out.replace(/\*\*(.+?)\*\*/g, `${BOLD_OPEN}$1${BOLD_CLOSE}`);

  // Bold alternative: __text__ → *text*.
  out = out.replace(/__(.+?)__/g, `${BOLD_OPEN}$1${BOLD_CLOSE}`);

  // Italic: *text* → _text_. Avoid matching the `*` of a `**` pair (already
  // collapsed above) and avoid matching `*` adjacent to another `*`.
  out = out.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "_$1_");

  // Restore bold placeholders → *text* (Cliq bold).
  out = out.replace(
    new RegExp(`${BOLD_OPEN}(.+?)${BOLD_CLOSE}`, "g"),
    "*$1*",
  );

  // Strikethrough: ~~text~~ → ~text~ (Cliq uses a single tilde).
  out = out.replace(/~~(.+?)~~/g, "~$1~");

  // Blockquote: "> text" / ">text" at line start → "!text".
  out = out.replace(/^>\s?(.*)$/gm, "!$1");

  // Tables: drop separator rows like | --- | --- |.
  out = out.replace(/^\|[\s\-:|]+\|$/gm, "");
  // Convert data rows to plain text: | a | b | → a — b.
  out = out.replace(/^\|(.+)\|$/gm, (_match, inner: string) =>
    inner
      .split("|")
      .map((cell) => cell.trim())
      .filter((cell) => cell.length > 0)
      .join(" — "),
  );
  // Collapse triple+ blank lines left by separator-row removal.
  out = out.replace(/\n{3,}/g, "\n\n");

  // Restore protected content verbatim.
  out = out.replace(
    new RegExp(`${INLINE_CODE_TOKEN}(\\d+)\\u0000`, "g"),
    (_match, i: string) => inlineCodes[parseInt(i)],
  );
  out = out.replace(
    new RegExp(`${CODE_BLOCK_TOKEN}(\\d+)\\u0000`, "g"),
    (_match, i: string) => codeBlocks[parseInt(i)],
  );

  return out;
}
