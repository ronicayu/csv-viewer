// Heuristic "does this CSV cell value look like Markdown" detection. Feeds the
// worker's column profiling (src/core/columns.ts — markdownShare, which makes
// a column auto-Markdown in row details) and decides which Raw-mode detail
// fields get a "Markdown" link (src/webview/main.ts). Pure module with NO
// dependencies beyond json.ts: the worker bundle imports it, so it must never
// pull in the renderer (src/core/markdownRender.ts, which needs markdown-it).
//
// Deliberately conservative — prose with a stray `*`, `#1` or `1.` must stay
// plain. One *strong* signal is enough on its own; *weak* signals only count
// when at least two different kinds show up together.

import { looksLikeJsonObjectOrArray } from "./json";

/** A value longer than this is never rendered as Markdown (it stays raw in
 * row details) and only its first this-many characters are scanned here, so
 * profiling a column of multi-megabyte cells stays cheap. */
export const MARKDOWN_MAX_CHARS = 100_000;

// Strong signals.
const HEADING = /^#{1,6} \S/m;
const FENCE = /^ {0,3}(?:```|~~~)/m;
const LINK = /\[[^\]\n]+\]\((?:https?:\/\/|mailto:)[^)\s]+\)/i;
const TABLE_DELIMITER_ROW = /^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/m;

// Weak signals (kinds).
const BOLD = /\*\*\S(?:[^*\n]*\S)?\*\*|__\S(?:[^_\n]*\S)?__/;
const BULLET_LINE = /^[ \t]*[-*+] \S/gm;
const ORDERED_LINE = /^[ \t]*\d+\. \S/gm;
const BLOCKQUOTE = /^ {0,3}> \S/m;
const INLINE_CODE = /`[^`\n]+`/;

function countMatches(re: RegExp, text: string): number {
  return text.match(re)?.length ?? 0; // String.match with a /g regex resets lastIndex itself
}

export function looksLikeMarkdown(value: string): boolean {
  if (value === "") return false;
  const text = value.length > MARKDOWN_MAX_CHARS ? value.slice(0, MARKDOWN_MAX_CHARS) : value;
  if (looksLikeJsonObjectOrArray(value)) return false;

  if (HEADING.test(text) || FENCE.test(text) || LINK.test(text) || TABLE_DELIMITER_ROW.test(text)) return true;

  let weak = 0;
  if (BOLD.test(text)) weak++;
  if (countMatches(BULLET_LINE, text) >= 2) weak++;
  if (countMatches(ORDERED_LINE, text) >= 2) weak++;
  if (BLOCKQUOTE.test(text)) weak++;
  if (INLINE_CODE.test(text)) weak++;
  return weak >= 2;
}
