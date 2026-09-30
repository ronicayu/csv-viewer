// CSV/TSV parsing. Pure module: no vscode or DOM imports so it can be
// unit-tested in node and bundled into the webview unchanged.
//
// Tokenizing is delegated to Papa Parse (papaparse), which is quote-aware —
// unlike the hand-written tokenizer this replaced, a stray `"` inside an
// unquoted field (e.g. `1,5" screen,TV`, or `He said "hi" there`) no longer
// flips the parser into quoted mode and swallows the rest of the file into
// one cell. Header dedupe, empty-header naming, ragged-row padding, and
// extra-cell auto-headers are still handled here on top of Papa's raw rows,
// so the public `ParseResult` shape (and its rules) is unchanged.

import Papa from "papaparse";
import type { ParseResult } from "./types";

/** Delimiters Papa is allowed to guess between when auto-detecting. */
const DELIMITERS_TO_GUESS = [",", ";", "\t", "|"];

export interface ParseOptions {
  /**
   * Force this delimiter (e.g. tab for .tsv/.tab, or a user-chosen
   * separator, which may be multiple characters, e.g. `||`).
   * Empty string or undefined means auto-detect via Papa's quote-aware
   * guessing among `DELIMITERS_TO_GUESS`.
   */
  delimiter?: string;
  /** Default true. When false, every row is data and headers are synthesized. */
  firstRowIsHeader?: boolean;
}

/** Strip a leading UTF-8 BOM, if present. */
export function stripBom(text: string): string {
  return text.length > 0 && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function dedupeNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    return count === 0 ? name : `${name}_${count + 1}`;
  });
}

export function parseCsv(text: string, options: ParseOptions = {}): ParseResult {
  const stripped = stripBom(text);
  const firstRowIsHeader = options.firstRowIsHeader ?? true;
  // "" and undefined both mean auto-detect; only a non-empty string forces
  // a specific delimiter.
  const requestedDelimiter = options.delimiter && options.delimiter.length > 0 ? options.delimiter : undefined;

  // skipEmptyLines: true drops lines that are entirely blank (no characters
  // at all), both a trailing newline at end of file and blank lines in the
  // middle of the file — so neither produces a spurious empty row. A line
  // that has content but only delimiters (e.g. ",,,") is NOT blank in this
  // sense: it is a real row of empty fields and is kept, same as before.
  const parsed = Papa.parse<string[]>(stripped, {
    header: false,
    skipEmptyLines: true,
    quoteChar: '"',
    delimiter: requestedDelimiter,
    delimitersToGuess: DELIMITERS_TO_GUESS,
  });

  const records = parsed.data;
  const delimiter = parsed.meta.delimiter;

  if (records.length === 0) {
    return { headers: [], rows: [], delimiter };
  }

  const headerRow = firstRowIsHeader ? records[0] : [];
  const dataRecords = firstRowIsHeader ? records.slice(1) : records;

  let maxCols = headerRow.length;
  for (const r of dataRecords) if (r.length > maxCols) maxCols = r.length;

  const rawNames: string[] = [];
  for (let i = 0; i < maxCols; i++) {
    const given = i < headerRow.length ? headerRow[i] : "";
    rawNames.push(given !== "" ? given : `column_${i + 1}`);
  }
  const headers = dedupeNames(rawNames);

  const rows = dataRecords.map((r) => {
    if (r.length >= maxCols) return r;
    const padded = r.slice();
    while (padded.length < maxCols) padded.push("");
    return padded;
  });

  return { headers, rows, delimiter };
}
