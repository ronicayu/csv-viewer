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

// Reproduces Papa's record boundaries only, never field values.
export function scanRecords(
  text: string,
  options: SplitOptions,
  emit: (start: number, end: number, eol: number, fieldCount: number) => void,
): void {
  const n = text.length;
  const delimiter = options.delimiter === "" ? "," : options.delimiter;
  const quotes = options.quotes;
  const dl = delimiter.length;
  const d0 = delimiter.charCodeAt(0);

  let pos = n > 0 && text.charCodeAt(0) === 0xfeff ? 1 : 0;

  while (pos < n) {
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

      let i = pos;
      let c = 0;
      if (dl === 1) {
        for (; i < n; i++) {
          c = text.charCodeAt(i);
          if (c === d0 || c === LF || c === CR) break;
        }
      } else {
        for (; i < n; i++) {
          c = text.charCodeAt(i);
          if (c === LF || c === CR) break;
          if (c === d0 && text.startsWith(delimiter, i)) break;
        }
      }
      singleFieldEmpty = i === pos;
      if (i >= n) break fields;
      if (c === LF || c === CR) {
        end = i;
        if (c === CR && text.charCodeAt(i + 1) === LF) {
          eol = EOL_CRLF;
          next = i + 2;
        } else {
          eol = c === CR ? EOL_CR : EOL_LF;
          next = i + 1;
        }
        break fields;
      }
      pos = i + dl;
    }

    // Papa's skipEmptyLines: a record that is one empty field is not a row.
    if (!(fieldCount === 1 && singleFieldEmpty)) emit(start, end, eol, fieldCount);
    pos = next;
  }
}

export function splitRecords(text: string, options: SplitOptions): RecordSpan[] {
  const spans: RecordSpan[] = [];
  scanRecords(text, options, (start, end, eol, fieldCount) => {
    spans.push({ start, end, eol: EOL_TEXT[eol], fieldCount });
  });
  return spans;
}

export function splitRecordsToTable(text: string, options: SplitOptions): SpanTable {
  let capacity = 1024;
  let start = new Uint32Array(capacity);
  let end = new Uint32Array(capacity);
  let fieldCount = new Uint32Array(capacity);
  let eol = new Uint8Array(capacity);
  let length = 0;

  scanRecords(text, options, (s, e, k, f) => {
    if (length === capacity) {
      capacity *= 2;
      const grow = <T extends Uint32Array | Uint8Array>(a: T): T => {
        const bigger = new (a.constructor as new (n: number) => T)(capacity);
        bigger.set(a);
        return bigger;
      };
      start = grow(start);
      end = grow(end);
      fieldCount = grow(fieldCount);
      eol = grow(eol);
    }
    start[length] = s;
    end[length] = e;
    fieldCount[length] = f;
    eol[length] = k;
    length++;
  });

  return {
    length,
    start: start.slice(0, length),
    end: end.slice(0, length),
    fieldCount: fieldCount.slice(0, length),
    eol: eol.slice(0, length),
  };
}

export function spansFromTable(table: SpanTable): RecordSpan[] {
  const spans: RecordSpan[] = [];
  for (let i = 0; i < table.length; i++) {
    spans.push({ start: table.start[i], end: table.end[i], eol: EOL_TEXT[table.eol[i]], fieldCount: table.fieldCount[i] });
  }
  return spans;
}

// UTF-8 offsets for each span, in one pass; exact for valid UTF-8, which editable files are.
export function addByteOffsets(table: SpanTable, text: string): void {
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
