import Papa from "papaparse";
import { dedupeNames, guessDelimiter, normalizeLineEndings, parseCsv, quoteErrorDataRows, stripBom, type ParseOptions } from "./csvParse";
import { SpanTableBuilder, freshScanState, scanRecords, splitRecordsToTable, type ScanState, type SpanTable } from "./recordSpans";
import type { ParseResult } from "./types";

export const PARSE_SLICE_RECORDS = 2048;

const NUL = "\u0000";
const GUESS_TERMINATORS = 10;

// What parseCsv's delimiter guess sees (line endings normalized) without normalizing a file-sized string when the first ten lines decide it.
function guessInput(text: string, hasCR: boolean): string {
  const body = stripBom(text);
  if (!hasCR) return body;
  let end = 0;
  for (let i = 0; i < GUESS_TERMINATORS; i++) {
    const lf = body.indexOf("\n", end);
    const cr = body.indexOf("\r", end);
    const at = lf === -1 ? cr : cr === -1 ? lf : Math.min(lf, cr);
    if (at === -1) return normalizeLineEndings(body);
    end = at + (body.charCodeAt(at) === 13 && body.charCodeAt(at + 1) === 10 ? 2 : 1);
  }
  const head = body.slice(0, end);
  return head.includes('"') ? normalizeLineEndings(body) : normalizeLineEndings(head);
}

function isEmptyRecord(record: string[]): boolean {
  return record.length === 1 && record[0].length === 0;
}

// parseCsv, one slice of records at a time. The record scan that builds the span table also cuts the text: each slice is whole records, parsed
// on its own by Papa with the delimiter fixed, so the first rows are ready long before the last. Any disagreement between the scan and Papa
// (a different record count for a slice) abandons the slices and falls back to parseCsv over the whole text, which stays the reference.
export class ProgressiveParse {
  delimiter: string;
  quoting: boolean;
  // True once parseCsv's whole-text result replaced the slices (up front for a case slicing does not handle, or after a mismatch).
  fellBack = false;
  // Rows replaced under a reader that had already seen the slices.
  rebuilt = false;
  rows: string[][] = [];
  private readonly text: string;
  private readonly options: ParseOptions;
  private readonly firstRowIsHeader: boolean;
  private readonly quoteChar: string;
  private readonly sliceRecords: number;
  private readonly rebuildAfterSlices: number | undefined;
  private readonly builder: SpanTableBuilder;
  private readonly scan: ScanState = freshScanState();
  private readonly errors: Papa.ParseError[] = [];
  private scanFrom = 0;
  private sliceStart: number;
  private slices = 0;
  private rowsBefore = 0;
  private headerRow: string[] | null = null;
  private records = 0;
  private maxCols = 0;
  private widened = false;
  private complete = false;
  private whole: ParseResult | null = null;

  // `rebuildAfterSlices` is a test hook: it abandons the slices for the whole-text parse after that many, as a mismatch would.
  constructor(text: string, options: ParseOptions = {}, sliceRecords = PARSE_SLICE_RECORDS, rebuildAfterSlices?: number) {
    this.rebuildAfterSlices = rebuildAfterSlices;
    this.text = text;
    this.options = options;
    this.sliceRecords = sliceRecords;
    this.firstRowIsHeader = options.firstRowIsHeader ?? true;
    const quotesEnabled = options.quotes ?? true;
    const requested = options.delimiter && options.delimiter.length > 0 ? options.delimiter : undefined;
    this.quoting = quotesEnabled || text.includes(NUL);
    this.quoteChar = this.quoting ? '"' : NUL;
    this.sliceStart = text.length > 0 && text.charCodeAt(0) === 0xfeff ? 1 : 0;
    this.builder = new SpanTableBuilder(text.length);

    // One search for a CR serves the guess and the record scan, which would otherwise each look through the whole text for one.
    const hasCR = text.indexOf("\r") !== -1;
    if (!hasCR) this.scan.nextCR = text.length;
    const chosen = requested ?? guessDelimiter(guessInput(text, hasCR), this.quoteChar);
    // Papa quietly uses a comma for a delimiter it cannot work with.
    this.delimiter = Papa.BAD_DELIMITERS.indexOf(chosen) > -1 ? "," : chosen;
    // Papa drops a second leading U+FEFF that the record scan keeps, so the first slice could be cut where Papa would not cut it.
    const doubleBom = this.sliceStart === 1 && text.length > 1 && text.charCodeAt(1) === 0xfeff;
    if ((!quotesEnabled && requested === '"') || doubleBom) this.fallBack();
  }

  get done(): boolean {
    return this.complete;
  }

  // Parses the next slice; returns true once everything is parsed.
  step(): boolean {
    if (this.complete) return true;
    if (this.rebuildAfterSlices !== undefined && this.slices >= this.rebuildAfterSlices) {
      this.fallBack();
      return true;
    }
    const text = this.text;
    const first = this.slices === 0;
    let emitted = 0;
    const end = scanRecords(
      text,
      { delimiter: this.delimiter, quotes: this.quoting },
      (start, stop, eol, fields) => {
        emitted++;
        this.builder.push(start, stop, eol, fields);
      },
      this.scanFrom,
      this.sliceRecords,
      this.scan,
    );
    const chunk = normalizeLineEndings(text.slice(this.sliceStart, end));
    // A U+FEFF opening a later slice would be taken for a byte order mark, so later slices start with a blank line (which is skipped).
    const input = first ? chunk : "\n" + chunk;
    const parsed = Papa.parse<string[]>(input, { header: false, skipEmptyLines: false, quoteChar: this.quoteChar, delimiter: this.delimiter, newline: "\n" });
    const data = parsed.data;
    const records = data.filter((r) => !isEmptyRecord(r));
    if (records.length !== emitted) {
      this.fallBack();
      return true;
    }

    const prefixRows = first ? 0 : 1;
    const trailing = input.endsWith("\n") && data.length > prefixRows && isEmptyRecord(data[data.length - 1]) ? 1 : 0;
    for (const e of parsed.errors) {
      if (e.type === "Quotes" && typeof e.row === "number") this.errors.push({ ...e, row: this.rowsBefore + e.row - prefixRows });
    }
    this.rowsBefore += data.length - prefixRows - trailing;

    const rowsBefore = this.rows.length;
    for (const record of records) {
      if (this.records === 0 && this.firstRowIsHeader) {
        this.headerRow = record;
        this.maxCols = record.length;
      } else {
        if (record.length > this.maxCols) {
          this.maxCols = record.length;
          if (this.rows.length > 0) this.widened = true;
        }
        this.rows.push(record);
      }
      this.records++;
    }
    // Rows keep the width the headers have at this point; a wider row later pads the earlier ones in finish.
    for (let i = rowsBefore; i < this.rows.length; i++) while (this.rows[i].length < this.maxCols) this.rows[i].push("");
    this.slices++;
    this.sliceStart = end;
    this.scanFrom = end;
    if (end >= text.length) {
      this.finish();
      this.complete = true;
    }
    return this.complete;
  }

  runToEnd(): void {
    while (!this.step());
  }

  // The headers for the rows so far; they gain columns if a later row is wider.
  headers(): string[] {
    if (this.whole) return this.whole.headers;
    if (this.records === 0) return [];
    const names: string[] = [];
    const headerRow = this.headerRow ?? [];
    for (let i = 0; i < this.maxCols; i++) {
      const given = i < headerRow.length ? headerRow[i] : "";
      names.push(given !== "" ? given : `column_${i + 1}`);
    }
    return dedupeNames(names);
  }

  quoteProblems(): { row: number }[] {
    return this.whole ? this.whole.quoteProblems : quoteErrorDataRows(this.errors, this.firstRowIsHeader);
  }

  result(): ParseResult {
    if (this.whole) return this.whole;
    return { headers: this.headers(), rows: this.rows, delimiter: this.delimiter, quoteProblems: this.quoteProblems(), quoting: this.quoting };
  }

  // The span table of the whole text; only meaningful once done.
  spans(): SpanTable {
    return this.fellBack ? splitRecordsToTable(this.text, { delimiter: this.delimiter, quotes: this.quoting }) : this.builder.finish();
  }

  private finish(): void {
    if (!this.widened) return;
    for (const row of this.rows) while (row.length < this.maxCols) row.push("");
  }

  private fallBack(): void {
    const hadSlices = this.slices > 0;
    this.whole = parseCsv(this.text, this.options);
    this.rows = this.whole.rows;
    this.delimiter = this.whole.delimiter;
    this.quoting = this.whole.quoting;
    this.fellBack = true;
    this.rebuilt = hadSlices;
    this.complete = true;
  }
}

// Everything in one go, with the slice size chosen by the caller; what the tests compare with parseCsv.
export function parseProgressive(text: string, options: ParseOptions = {}, sliceRecords = PARSE_SLICE_RECORDS): { result: ParseResult; spans: SpanTable; fellBack: boolean } {
  const parse = new ProgressiveParse(text, options, sliceRecords);
  parse.runToEnd();
  return { result: parse.result(), spans: parse.spans(), fellBack: parse.fellBack };
}
