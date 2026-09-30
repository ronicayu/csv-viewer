// RFC 4180-ish CSV/TSV parser. Pure module: no vscode or DOM imports so it can
// be unit-tested in node and bundled into the webview unchanged.

import type { ParseResult } from "./types";

const CANDIDATE_DELIMITERS = [",", ";", "\t", "|"];

export interface ParseOptions {
  /** Skip auto-detection and force this delimiter (e.g. tab for .tsv/.tab). */
  delimiter?: string;
  /** Default true. When false, every row is data and headers are synthesized. */
  firstRowIsHeader?: boolean;
}

/** Strip a leading UTF-8 BOM, if present. */
export function stripBom(text: string): string {
  return text.length > 0 && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Guess the field delimiter by sampling the first ~20 non-empty lines. For
 * each candidate, count occurrences per line and score by how many lines
 * share the most common non-zero count (consistency), tie-broken by that
 * count. This is line-based (not quote-aware) — good enough for sampling,
 * since the real parse below is quote-aware regardless of which delimiter
 * wins here.
 */
export function detectDelimiter(text: string): string {
  const lines = text.split(/\r\n|\r|\n/).slice(0, 20).filter((line) => line.length > 0);
  if (lines.length === 0) return ",";

  let best = ",";
  let bestScore = -1;

  for (const delimiter of CANDIDATE_DELIMITERS) {
    const counts = lines.map((line) => countOccurrences(line, delimiter)).filter((c) => c > 0);
    if (counts.length === 0) continue;

    const frequency = new Map<number, number>();
    for (const count of counts) frequency.set(count, (frequency.get(count) ?? 0) + 1);

    let modeCount = 0;
    let modeFrequency = 0;
    for (const [count, freq] of frequency) {
      if (freq > modeFrequency) {
        modeFrequency = freq;
        modeCount = count;
      }
    }

    const score = modeFrequency * 1000 + modeCount;
    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  }

  return best;
}

function countOccurrences(line: string, ch: string): number {
  let count = 0;
  for (let i = 0; i < line.length; i++) if (line[i] === ch) count++;
  return count;
}

/** Quote-aware tokenizer: turns raw text into rows of raw field strings. */
function tokenize(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += ch;
        i += 1;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
      i += 1;
    } else if (ch === "\r" || ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
    } else {
      field += ch;
      i += 1;
    }
  }

  // Only push a final row if there is unflushed content — otherwise a
  // trailing newline would produce a spurious empty row.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
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
  const delimiter = options.delimiter ?? detectDelimiter(stripped);
  const firstRowIsHeader = options.firstRowIsHeader ?? true;

  const records = tokenize(stripped, delimiter);
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
