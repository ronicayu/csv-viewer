// Shared case-insensitive folding, used by both the filter operators
// (contains/equals/startsWith/endsWith) and the global quick search in
// src/core/filter.ts. Pure module, no vscode/DOM.
//
// Plain `toLowerCase()` alone mishandles two real-world cases:
//   - Turkish dotted İ (U+0130) lowercases to "i" + a COMBINING DOT ABOVE
//     (U+0307) — a two-codepoint string that can never appear as a
//     substring of ordinary lowercase text typed with a plain "i". Dropping
//     that combining dot (only when it immediately follows an "i") lets
//     "İstanbul" match "istanbul".
//   - German "ß" doesn't fold to "ss" under plain `toLowerCase()` at all.
//     Folding it here lets "STRASSE" match "straße".
// This is deliberately narrow — no accent-stripping or full Unicode case
// folding beyond these two documented rules.
const COMBINING_DOT_ABOVE = "̇";
const I_WITH_COMBINING_DOT = /i̇/g;

export function foldCase(s: string): string {
  let out = s.toLowerCase();
  // Fast-path guards: applyFilters/quick search call this per cell over
  // potentially hundreds of thousands of rows, and the overwhelming
  // majority of real-world text contains neither of these characters —
  // a cheap `includes` check to skip the regex replace / split+join
  // entirely is a large win at that scale (measured ~4x faster on ASCII
  // text than always running both unconditionally).
  if (out.includes(COMBINING_DOT_ABOVE)) out = out.replace(I_WITH_COMBINING_DOT, "i");
  if (out.includes("ß")) out = out.split("ß").join("ss");
  return out;
}
