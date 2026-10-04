// toLowerCase turns İ into "i" + U+0307 and keeps ß; fold both so "İstanbul" and "STRASSE" match.
const COMBINING_DOT_ABOVE = "̇";
const I_WITH_COMBINING_DOT = /i̇/g;

export function foldCase(s: string): string {
  let out = s.toLowerCase();
  if (out.includes(COMBINING_DOT_ABOVE)) out = out.replace(I_WITH_COMBINING_DOT, "i");
  if (out.includes("ß")) out = out.split("ß").join("ss");
  return out;
}
