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

/**
 * Quote character used when the caller asks for quoting to be disabled
 * (ParseOptions.quotes === false). Papa Parse has no "off" switch for
 * quoting, so instead we give it a quoteChar that (almost always) cannot
 * occur in real text, which makes every `"` in the input literal data
 * instead of a quote-open/close. Guarded below against the rare case where
 * the text actually contains this character.
 */
const QUOTELESS_SENTINEL = "\u0000";

/**
 * Papa Parse hardcodes `"` as an always-bad delimiter (`Papa.BAD_DELIMITERS`
 * / the tokenizer's own validation forces a requested delimiter of `"`
 * back to `,`) — unconditionally, regardless of `quoteChar`. So `"` can
 * never be handed to Papa's `delimiter` option directly. When quoting is
 * off (the only time `"` as a delimiter makes sense — with quoting on it's
 * rejected one layer up, in the webview, before parseCsv is ever called
 * with this combination), every `"` in the text is unambiguously meant to
 * be a delimiter, so we substitute it for one Papa will accept before
 * parsing; no reversal is needed afterward since every occurrence was
 * consumed as a separator, never left behind as cell content. Guarded, like
 * QUOTELESS_SENTINEL above, against the rare case where the text already
 * contains this character.
 */
const QUOTE_DELIMITER_PLACEHOLDER = "\u0001";

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
  /**
   * Default true. When false, `"` is parsed as ordinary literal text
   * instead of opening/closing a quoted field — a workaround for a file
   * whose quoting is malformed enough that quote-aware parsing merges rows
   * together (see ParseResult.quoteProblems).
   */
  quotes?: boolean;
}

/** Strip a leading UTF-8 BOM, if present. */
export function stripBom(text: string): string {
  return text.length > 0 && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Normalize every line-ending style to `\n`. Papa Parse sniffs a single
 * newline style for the whole file from an early sample, then treats any
 * *other* style as literal text rather than a row separator — so a file
 * mixing CRLF, LF, and lone CR (which real-world CSVs exported by different
 * tools/OSes routinely do) silently merges rows and leaks newline
 * characters into cell values. Normalizing up front, before Papa ever sees
 * the text, fixes this for the whole file.
 *
 * This also normalizes a CRLF (or lone CR) *inside a quoted field* down to
 * a plain LF — a deliberate, documented simplification (not a bug): a
 * multi-line-ending file is rare enough, and telling quoted-CRLF apart from
 * row-separator CRLF without a full parse pass is complex enough, that
 * trading "a quoted field's internal line breaks are always LF" for "mixed
 * line endings never merge rows" is the right call.
 */
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n|\r/g, "\n");
}

function dedupeNames(names: string[]): string[] {
  // Every distinct literal name's *first* occurrence always keeps that
  // name as-is. A later duplicate needs a generated `_N` suffix — but the
  // generated name must never collide with any other *final* header,
  // including one that is itself a later literal (e.g. "a,a,a_2": the
  // literal "a_2" keeps its name, so the duplicate "a" at index 1 must
  // skip "a_2" and become "a_3"). `rawNames` (every literal name in the
  // file, before dedup) tells us every name that some column will
  // eventually claim literally, so checking against it up front — not just
  // against names already assigned so far — prevents that collision
  // regardless of processing order.
  const rawNameSet = new Set(names);
  const firstIndexOf = new Map<string, number>();
  names.forEach((name, i) => {
    if (!firstIndexOf.has(name)) firstIndexOf.set(name, i);
  });

  const used = new Set<string>();
  return names.map((name, i) => {
    if (firstIndexOf.get(name) === i) {
      used.add(name);
      return name;
    }
    let suffix = 2;
    let candidate = `${name}_${suffix}`;
    while (rawNameSet.has(candidate) || used.has(candidate)) {
      suffix++;
      candidate = `${name}_${suffix}`;
    }
    used.add(candidate);
    return candidate;
  });
}

/**
 * Data-row numbers (1-based, as the user sees them) where Papa reported a
 * quote-related error, capped at the first ~20. `recordIndex` is Papa's
 * 0-based index into its raw `records` array (header row included when
 * present): when `firstRowIsHeader` is true, record index 1 is data row 1,
 * so dataRow = recordIndex; when false, record index 0 is data row 1, so
 * dataRow = recordIndex + 1. An error at record index 0 while there IS a
 * header row refers to the header itself, not any data row, and is
 * dropped.
 */
function quoteErrorDataRows(errors: Papa.ParseError[], firstRowIsHeader: boolean): { row: number }[] {
  const rows: { row: number }[] = [];
  const seen = new Set<number>();
  for (const e of errors) {
    if (e.type !== "Quotes" || typeof e.row !== "number") continue;
    if (firstRowIsHeader && e.row === 0) continue;
    const dataRow = firstRowIsHeader ? e.row : e.row + 1;
    if (dataRow < 1 || seen.has(dataRow)) continue;
    seen.add(dataRow);
    rows.push({ row: dataRow });
    if (rows.length >= 20) break;
  }
  return rows;
}

export function parseCsv(text: string, options: ParseOptions = {}): ParseResult {
  const stripped = normalizeLineEndings(stripBom(text));
  const firstRowIsHeader = options.firstRowIsHeader ?? true;
  const quotesEnabled = options.quotes ?? true;
  // "" and undefined both mean auto-detect; only a non-empty string forces
  // a specific delimiter.
  const requestedDelimiter = options.delimiter && options.delimiter.length > 0 ? options.delimiter : undefined;
  // When quoting is disabled, use a quoteChar that (almost) never occurs in
  // real text so every `"` is parsed as literal data. Guard against the
  // rare case where the sentinel itself is already in the text — falling
  // back to normal quoting rather than risk misparsing on it.
  const quoteChar = quotesEnabled || stripped.includes(QUOTELESS_SENTINEL) ? '"' : QUOTELESS_SENTINEL;

  // `"` as a requested delimiter only makes it through Papa when quoting
  // is off (see QUOTE_DELIMITER_PLACEHOLDER above) — substitute it for a
  // delimiter Papa will accept before parsing.
  const useQuoteDelimiterWorkaround =
    !quotesEnabled && requestedDelimiter === '"' && !stripped.includes(QUOTE_DELIMITER_PLACEHOLDER);
  const textToParse = useQuoteDelimiterWorkaround ? stripped.split('"').join(QUOTE_DELIMITER_PLACEHOLDER) : stripped;
  const delimiterForPapa = useQuoteDelimiterWorkaround ? QUOTE_DELIMITER_PLACEHOLDER : requestedDelimiter;

  // skipEmptyLines: true drops lines that are entirely blank (no characters
  // at all), both a trailing newline at end of file and blank lines in the
  // middle of the file — so neither produces a spurious empty row. A line
  // that has content but only delimiters (e.g. ",,,") is NOT blank in this
  // sense: it is a real row of empty fields and is kept, same as before.
  const parsed = Papa.parse<string[]>(textToParse, {
    header: false,
    skipEmptyLines: true,
    quoteChar,
    delimiter: delimiterForPapa,
    delimitersToGuess: DELIMITERS_TO_GUESS,
  });

  const records = parsed.data;
  const delimiter = useQuoteDelimiterWorkaround ? '"' : parsed.meta.delimiter;

  // Papa reports every case where a bad quote swallows following rows
  // (InvalidQuotes/MissingQuotes). A `"` in the middle of an unquoted
  // field produces no error because it parses correctly as literal text.
  const quoteProblems = quoteErrorDataRows(parsed.errors, firstRowIsHeader);

  if (records.length === 0) {
    return { headers: [], rows: [], delimiter, quoteProblems };
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

  return { headers, rows, delimiter, quoteProblems };
}
