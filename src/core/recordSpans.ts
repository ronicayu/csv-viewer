import { utf8Length } from "./csvSerialize";

export type Eol = "\r\n" | "\n" | "\r" | "";

export interface RecordSpan {
  start: number;
  end: number;
  eol: Eol;
  fieldCount: number;
}

export interface SplitOptions {
  delimiter: string;
  // The effective quoting (ParseResult.quoting), not the raw option.
  quotes: boolean;
}

export const EOL_NONE = 0;
export const EOL_LF = 1;
export const EOL_CRLF = 2;
export const EOL_CR = 3;
export const EOL_TEXT: readonly Eol[] = ["", "\n", "\r\n", "\r"];

// Columnar so a multi-million-record file does not cost an object per record.
export interface SpanTable {
  length: number;
  start: Uint32Array;
  end: Uint32Array;
  fieldCount: Uint32Array;
  eol: Uint8Array;
  byteStart?: Uint32Array;
  byteEnd?: Uint32Array;
}

const QUOTE = 34;
const LF = 10;
const CR = 13;

// The characters String.prototype.trim() strips, minus the line terminators: Papa lets these sit between a closing quote and the delimiter.
function isTrimBlank(c: number): boolean {
  return (
    c === 32 ||
    c === 9 ||
    c === 11 ||
    c === 12 ||
    c === 0xa0 ||
    c === 0xfeff ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000
  );
}

function indexOrEnd(text: string, needle: string, from: number, end: number): number {
  const at = text.indexOf(needle, from);
  return at === -1 ? end : at;
}

// Where the next delimiter and terminators are at or after the scan position (text.length when there is none), -1 when not yet looked up.
// Pure functions of (text, position), so a resumed scan on the same text can carry them instead of searching to the end of the text again.
export interface ScanState {
  nextDelim: number;
  nextLF: number;
  nextCR: number;
}

export function freshScanState(): ScanState {
  return { nextDelim: -1, nextLF: -1, nextCR: -1 };
}

// Reproduces Papa's record boundaries only, never field values. Scans from `from` (a record boundary) for at most
// `maxRecords` records and returns where to resume; text.length means done. `state`, if given, is read on entry and written back on return;
// it is only valid for resuming the same text at the returned position.
export function scanRecords(
  text: string,
  options: SplitOptions,
  emit: (start: number, end: number, eol: number, fieldCount: number) => void,
  from = 0,
  maxRecords = Infinity,
  state?: ScanState,
): number {
  const n = text.length;
  const delimiter = options.delimiter === "" ? "," : options.delimiter;
  const quotes = options.quotes;
  const dl = delimiter.length;
  const d0 = delimiter.charCodeAt(0);

  let pos = from > 0 ? from : n > 0 && text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let nextDelim = state ? state.nextDelim : -1;
  let nextLF = state ? state.nextLF : -1;
  let nextCR = state ? state.nextCR : -1;
  let scanned = 0;

  while (pos < n && scanned++ < maxRecords) {
    const start = pos;
    let fieldCount = 0;
    let singleFieldEmpty = false;
    let end = n;
    let eol = EOL_NONE;
    let next = n;

    fields: for (;;) {
      fieldCount++;

      if (quotes && pos < n && text.charCodeAt(pos) === QUOTE) {
        let from = pos + 1;
        for (;;) {
          const qi = text.indexOf('"', from);
          if (qi === -1) {
            singleFieldEmpty = pos + 1 === n;
            break fields;
          }
          if (qi === n - 1) {
            singleFieldEmpty = qi === pos + 1;
            break fields;
          }
          if (text.charCodeAt(qi + 1) === QUOTE) {
            from = qi + 2;
            continue;
          }

          let j = qi + 1;
          let followedBy = 0; // 1 delimiter, 2 terminator
          while (j < n) {
            const c = text.charCodeAt(j);
            if (c === LF || c === CR) {
              followedBy = 2;
              break;
            }
            if (c === d0 && (dl === 1 || text.startsWith(delimiter, j))) {
              followedBy = 1;
              break;
            }
            if (!isTrimBlank(c)) break;
            j++;
          }

          if (followedBy === 1) {
            singleFieldEmpty = qi === pos + 1;
            pos = j + dl;
            continue fields;
          }
          if (followedBy === 2) {
            singleFieldEmpty = qi === pos + 1;
            end = j;
            if (text.charCodeAt(j) === CR && text.charCodeAt(j + 1) === LF) {
              eol = EOL_CRLF;
              next = j + 2;
            } else {
              eol = text.charCodeAt(j) === CR ? EOL_CR : EOL_LF;
              next = j + 1;
            }
            break fields;
          }
          // A quote not followed by a delimiter or terminator is literal; Papa keeps searching.
          from = qi + 1;
        }
      }

      // Cached positions of the next delimiter and terminators at or after `pos`; recomputed only once passed, so each is found once.
      if (nextDelim < pos) nextDelim = indexOrEnd(text, delimiter, pos, n);
      if (nextLF < pos) nextLF = indexOrEnd(text, "\n", pos, n);
      if (nextCR < pos) nextCR = indexOrEnd(text, "\r", pos, n);
      const terminator = nextLF < nextCR ? nextLF : nextCR;
      singleFieldEmpty = (nextDelim < terminator ? nextDelim : terminator) === pos;

      if (nextDelim < terminator) {
        pos = nextDelim + dl;
        continue fields;
      }
      if (terminator >= n) break fields;
      end = terminator;
      if (terminator === nextCR && text.charCodeAt(terminator + 1) === LF) {
        eol = EOL_CRLF;
        next = terminator + 2;
      } else {
        eol = terminator === nextCR ? EOL_CR : EOL_LF;
        next = terminator + 1;
      }
      break fields;
    }

    // Papa's skipEmptyLines: a record that is one empty field is not a row.
    if (!(fieldCount === 1 && singleFieldEmpty)) emit(start, end, eol, fieldCount);
    pos = next;
  }
  if (state) {
    state.nextDelim = nextDelim;
    state.nextLF = nextLF;
    state.nextCR = nextCR;
  }
  return pos;
}

export function splitRecords(text: string, options: SplitOptions): RecordSpan[] {
  const spans: RecordSpan[] = [];
  scanRecords(text, options, (start, end, eol, fieldCount) => {
    spans.push({ start, end, eol: EOL_TEXT[eol], fieldCount });
  });
  return spans;
}

// Records are rarely shorter than this many characters, so sizing for it up front avoids the doubling copies on a large text.
const MIN_RECORD_CHARS = 48;
// Long records mean far fewer than one per 48 characters; this bounds what a guess can over-allocate (13 MB) before doubling takes over.
const MAX_PRESIZED_RECORDS = 1 << 20;

// Accumulates scan results into typed arrays; usable across several scanRecords calls.
export class SpanTableBuilder {
  private capacity: number;
  private start: Uint32Array;
  private end: Uint32Array;
  private fieldCount: Uint32Array;
  private eol: Uint8Array;
  private length = 0;

  constructor(textLength = 0) {
    this.capacity = Math.min(MAX_PRESIZED_RECORDS, Math.max(1024, Math.floor(textLength / MIN_RECORD_CHARS)));
    this.start = new Uint32Array(this.capacity);
    this.end = new Uint32Array(this.capacity);
    this.fieldCount = new Uint32Array(this.capacity);
    this.eol = new Uint8Array(this.capacity);
  }

  readonly push = (s: number, e: number, k: number, f: number): void => {
    if (this.length === this.capacity) this.grow();
    this.start[this.length] = s;
    this.end[this.length] = e;
    this.fieldCount[this.length] = f;
    this.eol[this.length] = k;
    this.length++;
  };

  private grow(): void {
    this.capacity *= 2;
    const bigger = <T extends Uint32Array | Uint8Array>(a: T): T => {
      const copy = new (a.constructor as new (n: number) => T)(this.capacity);
      copy.set(a);
      return copy;
    };
    this.start = bigger(this.start);
    this.end = bigger(this.end);
    this.fieldCount = bigger(this.fieldCount);
    this.eol = bigger(this.eol);
  }

  // Views over the builder's arrays unless they are more than half empty, so what a table keeps alive stays within twice its size.
  finish(): SpanTable {
    const trim = <T extends Uint32Array | Uint8Array>(a: T): T => (this.length * 2 >= this.capacity ? (a.subarray(0, this.length) as T) : (a.slice(0, this.length) as T));
    return {
      length: this.length,
      start: trim(this.start),
      end: trim(this.end),
      fieldCount: trim(this.fieldCount),
      eol: trim(this.eol),
    };
  }
}

export function splitRecordsToTable(text: string, options: SplitOptions): SpanTable {
  const builder = new SpanTableBuilder(text.length);
  scanRecords(text, options, builder.push);
  return builder.finish();
}

export function spansFromTable(table: SpanTable): RecordSpan[] {
  const spans: RecordSpan[] = [];
  for (let i = 0; i < table.length; i++) {
    spans.push({ start: table.start[i], end: table.end[i], eol: EOL_TEXT[table.eol[i]], fieldCount: table.fieldCount[i] });
  }
  return spans;
}

// UTF-8 offsets for each span, in one pass; exact for valid UTF-8, which editable files are.
// `byteLength`, if the caller knows the file's size in bytes, settles ASCII without a pass over the text: for valid UTF-8 the sizes are equal only then.
export function addByteOffsets(table: SpanTable, text: string, byteLength?: number): void {
  // Character and byte offsets coincide in ASCII, and checking that is several times cheaper than measuring every span.
  if (byteLength !== undefined ? byteLength === text.length : !/[^\x00-\x7f]/.test(text)) {
    table.byteStart = table.start;
    table.byteEnd = table.end;
    return;
  }
  const byteStart = new Uint32Array(table.length);
  const byteEnd = new Uint32Array(table.length);
  let charPos = 0;
  let bytePos = 0;
  for (let i = 0; i < table.length; i++) {
    bytePos += utf8Length(text, charPos, table.start[i]);
    byteStart[i] = bytePos;
    bytePos += utf8Length(text, table.start[i], table.end[i]);
    byteEnd[i] = bytePos;
    charPos = table.end[i];
  }
  table.byteStart = byteStart;
  table.byteEnd = byteEnd;
}
