import Papa from "papaparse";
import type { ParseResult } from "./types";

const DELIMITERS_TO_GUESS = [",", ";", "\t", "|"];

// Papa cannot disable quoting; a NUL quoteChar makes every " literal unless NUL is in the text.
const QUOTELESS_SENTINEL = "\u0000";

// Papa forces a " delimiter back to ",", so it is swapped for this placeholder when quoting is off.
const QUOTE_DELIMITER_PLACEHOLDER = "\u0001";

export interface ParseOptions {
  delimiter?: string;
  firstRowIsHeader?: boolean;
  quotes?: boolean;
}

export function stripBom(text: string): string {
  return text.length > 0 && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// Papa sniffs one line-ending style, so mixed CRLF/LF/CR would merge rows; quoted ones become LF too.
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n|\r/g, "\n");
}

function dedupeNames(names: string[]): string[] {
  // Check against every literal name, not just assigned ones: "a,a,a_2" must become a, a_3, a_2.
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
  const requestedDelimiter = options.delimiter && options.delimiter.length > 0 ? options.delimiter : undefined;
  const quoteChar = quotesEnabled || stripped.includes(QUOTELESS_SENTINEL) ? '"' : QUOTELESS_SENTINEL;

  const useQuoteDelimiterWorkaround =
    !quotesEnabled && requestedDelimiter === '"' && !stripped.includes(QUOTE_DELIMITER_PLACEHOLDER);
  const textToParse = useQuoteDelimiterWorkaround ? stripped.split('"').join(QUOTE_DELIMITER_PLACEHOLDER) : stripped;
  const delimiterForPapa = useQuoteDelimiterWorkaround ? QUOTE_DELIMITER_PLACEHOLDER : requestedDelimiter;

  const parsed = Papa.parse<string[]>(textToParse, {
    header: false,
    skipEmptyLines: true,
    quoteChar,
    delimiter: delimiterForPapa,
    delimitersToGuess: DELIMITERS_TO_GUESS,
  });

  const records = parsed.data;
  const delimiter = useQuoteDelimiterWorkaround ? '"' : parsed.meta.delimiter;

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
