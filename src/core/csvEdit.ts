import { serializeRecord, utf8Length } from "./csvSerialize";
import { EOL_TEXT, type RecordSpan, type SpanTable } from "./recordSpans";

export interface EditedRecord {
  index: number;
  fields: readonly string[];
}

export interface ByteEditedRecord {
  byteStart: number;
  byteEnd: number;
  fields: readonly string[];
}

// Trailing empties beyond `floor` (the record's field count in the file as first loaded) are an undone extension of a short row, not data.
export function fieldsForWrite(fields: readonly string[], floor: number): string[] {
  let length = fields.length;
  while (length > floor && fields[length - 1] === "") length--;
  return fields.slice(0, length);
}

// The fields the host writes for a record. Edits that empty a short row down to one empty field would write a blank line, which is not a row,
// so in a file with more than one column it is written as two empty fields (which reads back as the same all-empty row).
export function recordFieldsForWrite(originalFields: readonly string[], fields: readonly string[], floor: number, columns = 1): string[] {
  const trimmed = fieldsForWrite(fields, floor);
  const wasEmpty = originalFields.length === 1 && originalFields[0] === "";
  if (columns > 1 && trimmed.length === 1 && trimmed[0] === "" && !wasEmpty) return ["", ""];
  return trimmed;
}

export function isRecordEdited(originalFields: readonly string[], fields: readonly string[], floor = originalFields.length, columns = 1): boolean {
  const trimmed = recordFieldsForWrite(originalFields, fields, floor, columns);
  if (trimmed.length !== originalFields.length) return true;
  for (let i = 0; i < trimmed.length; i++) if (trimmed[i] !== originalFields[i]) return true;
  return false;
}

type SpanSource = RecordSpan[] | SpanTable;

function spanStart(spans: SpanSource, i: number): number {
  return Array.isArray(spans) ? spans[i].start : spans.start[i];
}

function spanEnd(spans: SpanSource, i: number): number {
  return Array.isArray(spans) ? spans[i].end : spans.end[i];
}

function spanCount(spans: SpanSource): number {
  return spans.length;
}

export interface TextPatch {
  start: number;
  end: number;
  text: string;
}

// The replacements, in ascending order, that turn the old text into the spliced one.
export function textPatches(spans: SpanSource, records: readonly EditedRecord[], delimiter: string, quotes: boolean): TextPatch[] {
  const patches: TextPatch[] = [];
  let cursor = 0;
  let previous = -1;
  for (const record of records) {
    if (record.index <= previous || record.index >= spanCount(spans)) {
      throw new Error(`textPatches: record ${record.index} is out of order or out of range`);
    }
    previous = record.index;
    const start = spanStart(spans, record.index);
    const end = spanEnd(spans, record.index);
    if (start < cursor) throw new Error(`textPatches: record ${record.index} overlaps the previous one`);
    patches.push({ start, end, text: serializeRecord(record.fields, delimiter, quotes) });
    cursor = end;
  }
  return patches;
}

export function applyTextPatches(text: string, patches: readonly TextPatch[]): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const patch of patches) {
    if (patch.start < cursor || patch.end < patch.start || patch.end > text.length) {
      throw new Error("applyTextPatches: patches must be ascending, non-overlapping and inside the text");
    }
    parts.push(text.slice(cursor, patch.start), patch.text);
    cursor = patch.end;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}

export function spliceText(text: string, spans: SpanSource, records: readonly EditedRecord[], delimiter: string, quotes: boolean): string {
  return applyTextPatches(text, textPatches(spans, records, delimiter, quotes));
}

export function spliceBytes(bytes: Uint8Array, records: readonly ByteEditedRecord[], delimiter: string, quotes: boolean): Uint8Array {
  const encoder = new TextEncoder();
  const encoded: Uint8Array[] = [];
  let cursor = 0;
  let total = 0;
  for (const record of records) {
    if (record.byteStart < cursor || record.byteEnd < record.byteStart || record.byteEnd > bytes.length) {
      throw new Error("spliceBytes: records must be ascending, non-overlapping and inside the file");
    }
    const replacement = encoder.encode(serializeRecord(record.fields, delimiter, quotes));
    encoded.push(replacement);
    total += record.byteStart - cursor + replacement.length;
    cursor = record.byteEnd;
  }
  total += bytes.length - cursor;

  const out = new Uint8Array(total);
  let written = 0;
  cursor = 0;
  records.forEach((record, i) => {
    out.set(bytes.subarray(cursor, record.byteStart), written);
    written += record.byteStart - cursor;
    out.set(encoded[i], written);
    written += encoded[i].length;
    cursor = record.byteEnd;
  });
  out.set(bytes.subarray(cursor), written);
  return out;
}

// The span table of the spliced output, without re-splitting it.
export function rebaseSpanTable(table: SpanTable, records: readonly EditedRecord[], delimiter: string, quotes: boolean): SpanTable {
  const hasBytes = table.byteStart !== undefined && table.byteEnd !== undefined;
  const start = new Uint32Array(table.length);
  const end = new Uint32Array(table.length);
  const fieldCount = table.fieldCount.slice();
  const eol = table.eol.slice();
  const byteStart = hasBytes ? new Uint32Array(table.length) : undefined;
  const byteEnd = hasBytes ? new Uint32Array(table.length) : undefined;

  let charDelta = 0;
  let byteDelta = 0;
  let next = 0;

  const shiftRange = (from: number, to: number): void => {
    for (let i = from; i < to; i++) {
      start[i] = table.start[i] + charDelta;
      end[i] = table.end[i] + charDelta;
      if (byteStart && byteEnd) {
        byteStart[i] = table.byteStart![i] + byteDelta;
        byteEnd[i] = table.byteEnd![i] + byteDelta;
      }
    }
  };

  let previous = -1;
  for (const record of records) {
    if (record.index <= previous || record.index >= table.length) {
      throw new Error(`rebaseSpans: record ${record.index} is out of order or out of range`);
    }
    previous = record.index;
    shiftRange(next, record.index);

    const written = serializeRecord(record.fields, delimiter, quotes);
    const i = record.index;
    start[i] = table.start[i] + charDelta;
    end[i] = start[i] + written.length;
    if (byteStart && byteEnd) {
      byteStart[i] = table.byteStart![i] + byteDelta;
      byteEnd[i] = byteStart[i] + utf8Length(written);
      byteDelta += byteEnd[i] - byteStart[i] - (table.byteEnd![i] - table.byteStart![i]);
    }
    charDelta += written.length - (table.end[i] - table.start[i]);
    fieldCount[i] = record.fields.length;
    next = i + 1;
  }
  shiftRange(next, table.length);

  return { length: table.length, start, end, fieldCount, eol, byteStart, byteEnd };
}

export interface ByteSpan {
  byteStart: number;
  byteEnd: number;
}

// The same rebase over plain span objects, for callers that do not hold typed tables.
export function rebaseSpans(
  spans: readonly RecordSpan[],
  byteSpans: readonly ByteSpan[],
  records: readonly EditedRecord[],
  delimiter: string,
  quotes: boolean,
): { spans: RecordSpan[]; byteSpans: ByteSpan[] } {
  const table: SpanTable = {
    length: spans.length,
    start: Uint32Array.from(spans, (s) => s.start),
    end: Uint32Array.from(spans, (s) => s.end),
    fieldCount: Uint32Array.from(spans, (s) => s.fieldCount),
    eol: Uint8Array.from(spans, (s) => EOL_TEXT.indexOf(s.eol)),
    byteStart: Uint32Array.from(byteSpans, (b) => b.byteStart),
    byteEnd: Uint32Array.from(byteSpans, (b) => b.byteEnd),
  };
  const rebased = rebaseSpanTable(table, records, delimiter, quotes);
  return {
    spans: Array.from({ length: rebased.length }, (_, i) => ({
      start: rebased.start[i],
      end: rebased.end[i],
      eol: EOL_TEXT[rebased.eol[i]],
      fieldCount: rebased.fieldCount[i],
    })),
    byteSpans: Array.from({ length: rebased.length }, (_, i) => ({ byteStart: rebased.byteStart![i], byteEnd: rebased.byteEnd![i] })),
  };
}
