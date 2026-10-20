import Papa from "papaparse";
import type { ParseResult } from "./types";

const DELIMITERS_TO_GUESS = [",", ";", "\t", "|"];
const GUESS_RECORDS = 10;

// Papa cannot disable quoting; a NUL quoteChar makes every " literal unless NUL is in the text.
const QUOTELESS_SENTINEL = "\u0000";

// Papa forces a " delimiter back to ",", so it is swapped for this placeholder when quoting is off.
const QUOTE_DELIMITER_PLACEHOLDER = "\u0001";

export interface ParseOptions {
  delimiter?: string;
  firstRowIsHeader?: boolean;
  quotes?: boolean;
}

// What Papa was actually run with: the NUL sentinel cannot be the quote char when the text contains NUL.
export function effectiveQuoting(text: string, quotes: boolean): boolean {
  return quotes || text.includes(QUOTELESS_SENTINEL);
}

export function stripBom(text: string): string {
  return text.length > 0 && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// Papa sniffs one line-ending style, so mixed CRLF/LF/CR would merge rows; quoted ones become LF too.
export function normalizeLineEndings(text: string): string {
  return text.indexOf("\r") === -1 ? text : text.replace(/\r\n|\r/g, "\n");
}

// What Papa's own guess would pick, run over the whole text: the reference for guessDelimiter.
export function guessDelimiterFull(text: string, quoteChar: string): string {
  return Papa.parse<string[]>(text, { preview: GUESS_RECORDS, skipEmptyLines: true, quoteChar, delimitersToGuess: DELIMITERS_TO_GUESS }).meta.delimiter;
}

// Papa's guess previews the first ten records of line-ending-normalized text, and with no quote among them each ends at a newline,
// so everything after the tenth newline cannot change the answer. Papa's own quote char is always `"` in the guess, whatever the parse uses.
export function guessDelimiter(text: string, quoteChar: string): string {
  let end = 0;
  for (let i = 0; i < GUESS_RECORDS; i++) {
    const newline = text.indexOf("\n", end);
    if (newline === -1) return guessDelimiterFull(text, quoteChar);
    end = newline + 1;
  }
  const prefix = text.slice(0, end);
  return guessDelimiterFull(prefix.includes('"') ? text : prefix, quoteChar);
}

export function dedupeNames(names: string[]): string[] {
  // Check against every literal name, not just assigned ones: "a,a,a_2" must become a, a_3, a_2.
  const firstIndexOf = new Map<string, number>();
  names.forEach((name, i) => {
    if (!firstIndexOf.has(name)) firstIndexOf.set(name, i);
  });

  const generated = new Set<string>();
  return names.map((name, i) => {
    if (firstIndexOf.get(name) === i) return name;
    let suffix = 2;
    let candidate = `${name}_${suffix}`;
    while (firstIndexOf.has(candidate) || generated.has(candidate)) {
      suffix++;
      candidate = `${name}_${suffix}`;
    }
    generated.add(candidate);
    return candidate;
  });
}

export function quoteErrorDataRows(errors: Papa.ParseError[], firstRowIsHeader: boolean): { row: number }[] {
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
  const requestedDelimiter = options.delimiter && options.delimiter.length > 0 ? options.delimiter : undefined;
  const quoting = effectiveQuoting(stripped, quotesEnabled);
  const quoteChar = quoting ? '"' : QUOTELESS_SENTINEL;

  const useQuoteDelimiterWorkaround =
    !quotesEnabled && requestedDelimiter === '"' && !stripped.includes(QUOTE_DELIMITER_PLACEHOLDER);
  const textToParse = useQuoteDelimiterWorkaround ? stripped.split('"').join(QUOTE_DELIMITER_PLACEHOLDER) : stripped;
  const delimiterForPapa = useQuoteDelimiterWorkaround ? QUOTE_DELIMITER_PLACEHOLDER : (requestedDelimiter ?? guessDelimiter(stripped, quoteChar));

  const parsed = Papa.parse<string[]>(textToParse, {
    header: false,
    skipEmptyLines: true,
    quoteChar,
    delimiter: delimiterForPapa,
  });

  const records = parsed.data;
  const delimiter = useQuoteDelimiterWorkaround ? '"' : parsed.meta.delimiter;

  const quoteProblems = quoteErrorDataRows(parsed.errors, firstRowIsHeader);

  if (records.length === 0) {
    return { headers: [], rows: [], delimiter, quoteProblems, quoting };
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

  return { headers, rows, delimiter, quoteProblems, quoting };
}
