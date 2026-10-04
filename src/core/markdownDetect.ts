// The worker bundle imports this, so it must not depend on markdownRender.ts (markdown-it).

import { looksLikeJsonObjectOrArray } from "./json";

export const MARKDOWN_MAX_CHARS = 100_000;

const HEADING = /^#{1,6} \S/m;
const FENCE = /^ {0,3}(?:```|~~~)/m;
const LINK = /\[[^\]\n]+\]\((?:https?:\/\/|mailto:)[^)\s]+\)/i;
const TABLE_DELIMITER_ROW = /^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/m;

const BOLD = /\*\*\S(?:[^*\n]*\S)?\*\*|__\S(?:[^_\n]*\S)?__/;
const BULLET_LINE = /^[ \t]*[-*+] \S/gm;
const ORDERED_LINE = /^[ \t]*\d+\. \S/gm;
const BLOCKQUOTE = /^ {0,3}> \S/m;
const INLINE_CODE = /`[^`\n]+`/;

function countMatches(re: RegExp, text: string): number {
  return text.match(re)?.length ?? 0;
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
