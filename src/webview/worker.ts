import { profileColumns } from "../core/columns";
import { applyTextPatches, recordFieldsForWrite, rebaseSpanTable, textPatches, type EditedRecord } from "../core/csvEdit";
import { parseCsv } from "../core/csvParse";
import { serializeField, serializeRecord } from "../core/csvSerialize";
import { distinctValues, type DistinctResult } from "../core/distinct";
import { filterRowIds } from "../core/filter";
import { buildColumnSortKeys, sortRowIdsByCachedKeys, type ResolvedCellSortKey } from "../core/sort";
import { pageSlice } from "../core/paging";
import { EOL_TEXT, SpanTableBuilder, addByteOffsets, freshScanState, scanRecords, splitRecordsToTable, type ScanState, type SpanTable } from "../core/recordSpans";
import type { CellChange, FilterRule, RecordFloor, SortDirection, SortKey, WrittenRecord } from "../core/types";
import type { CellValue, RowBaseline, WorkerRequest, WorkerResponse } from "./workerProtocol";

let headers: string[] = [];
let rawRows: string[][] = [];
let currentView: number[] | null = null;
let sortKeyCache = new Map<string, ResolvedCellSortKey[]>();
let distinctCache = new Map<string, DistinctResult>();

// Kept for the document's lifetime: span slicing and the per-commit re-parse need the text the spans describe.
let text = "";
let spans: SpanTable | null = null;
let spansOk = false;
let delimiter = ",";
let quoting = true;
let quotesRequested = true;
// Smallest field count a record may be written with: its count when first touched, which survives saves so an undo can shrink a record back.
let floors = new Map<number, number>();
let headerOffset = 0;
// Baseline value of every cell that differs from the file; an entry is dropped when the cell returns to it.
let originals = new Map<number, Map<number, string>>();

// Past this size the span pass would hold up the first render, so it runs in slices after the initial queries and edits finish it on demand.
const SYNC_SPANS_MAX_CHARS = 8 * 1024 * 1024;
const SPAN_SLICE_MS = 8;
const SPAN_SLICE_RECORDS = 4096;

interface SpanJob {
  requestId: number;
  builder: SpanTableBuilder;
  pos: number;
  scan: ScanState;
  channel: MessageChannel;
  expectedRecords: number;
}

let spanJob: SpanJob | null = null;

function post(message: WorkerResponse): void {
  (self as unknown as Worker).postMessage(message);
}

function onInit(requestId: number, source: string, options: { delimiter?: string; firstRowIsHeader: boolean; quotes: boolean }, initialFloors: RecordFloor[] | undefined): void {
  const parsed = parseCsv(source, options);
  text = source;
  delimiter = parsed.delimiter;
  quoting = parsed.quoting;
  quotesRequested = options.quotes;
  originals = new Map();
  floors = new Map((initialFloors ?? []).map((f) => [f.recordIndex, f.floor]));
  headerOffset = options.firstRowIsHeader && parsed.headers.length > 0 ? 1 : 0;
  spans = null;
  spansOk = false;
  endSpanJob();
  const expectedRecords = parsed.rows.length + headerOffset;
  if (source.length <= SYNC_SPANS_MAX_CHARS) {
    spans = splitRecordsToTable(source, { delimiter, quotes: quoting });
    spansOk = spans.length === expectedRecords;
    if (!spansOk) reportSpanMismatch(spans.length, expectedRecords);
  } else {
    startSpanJob({ requestId, builder: new SpanTableBuilder(), pos: 0, scan: freshScanState(), channel: new MessageChannel(), expectedRecords });
  }
  headers = parsed.headers;
  rawRows = parsed.rows;
  currentView = null;
  sortKeyCache = new Map();
  distinctCache = new Map();

  post({
    type: "initResult",
    requestId,
    headers,
    detectedDelimiter: parsed.delimiter,
    quoteProblems: parsed.quoteProblems,
    totalRows: rawRows.length,
    columnProfiles: profileColumns(headers, rawRows),
    quoting,
    spansOk: spanJob ? undefined : spansOk,
  });
}

function reportSpanMismatch(found: number, expected: number): void {
  // eslint-disable-next-line no-console
  console.error(`csv-viewer: record splitter found ${found} records but the parser found ${expected}; editing is disabled`);
}

// Slices are chained through a MessageChannel: unlike setTimeout it is not clamped to 4 ms, and unlike a microtask it lets queued requests run between slices.
function startSpanJob(job: SpanJob): void {
  spanJob = job;
  job.channel.port1.onmessage = () => stepSpanJob(job);
  job.channel.port2.postMessage(null);
}

function endSpanJob(): void {
  if (!spanJob) return;
  spanJob.channel.port1.close();
  spanJob = null;
}

function finishSpanJob(job: SpanJob): void {
  spans = job.builder.finish();
  spansOk = spans.length === job.expectedRecords;
  endSpanJob();
  if (!spansOk) reportSpanMismatch(spans.length, job.expectedRecords);
  post({ type: "spansReady", requestId: job.requestId, spansOk });
}

function stepSpanJob(job: SpanJob): void {
  if (spanJob !== job) return;
  const deadline = performance.now() + SPAN_SLICE_MS;
  do {
    job.pos = scanRecords(text, { delimiter, quotes: quoting }, job.builder.push, job.pos, SPAN_SLICE_RECORDS, job.scan);
  } while (job.pos < text.length && performance.now() < deadline);
  if (job.pos < text.length) job.channel.port2.postMessage(null);
  else finishSpanJob(job);
}

// Anything that needs the spans before the background pass is done finishes it in one go.
function ensureSpans(withBytes: boolean): void {
  const job = spanJob;
  if (job) {
    job.pos = scanRecords(text, { delimiter, quotes: quoting }, job.builder.push, job.pos, Infinity, job.scan);
    finishSpanJob(job);
  }
  if (withBytes && spans && !spans.byteStart) addByteOffsets(spans, text);
}

function getColumnSortKeys(columnIndex: number, columnName: string): ResolvedCellSortKey[] {
  const cached = sortKeyCache.get(columnName);
  if (cached) return cached;
  const built = buildColumnSortKeys(rawRows, columnIndex);
  sortKeyCache.set(columnName, built);
  return built;
}

function onQuery(requestId: number, quickSearch: string, filterRules: FilterRule[], sortKeys: SortKey[]): void {
  // queryStarted/filterDone bracket only the filter phase, which is what the regex watchdog times.
  post({ type: "queryStarted", requestId });
  const ids = filterRowIds(headers, rawRows, quickSearch, filterRules);
  post({ type: "filterDone", requestId });

  const columnIndexByName = new Map(headers.map((h, i) => [h, i]));
  const sortColumns: { direction: SortDirection; keys: ResolvedCellSortKey[] }[] = [];
  for (const key of sortKeys) {
    const ci = columnIndexByName.get(key.column);
    if (ci === undefined) continue; // stale key, e.g. after a separator change
    sortColumns.push({ direction: key.direction, keys: getColumnSortKeys(ci, key.column) });
  }

  const sortedIds = sortRowIdsByCachedKeys(ids, sortColumns);
  currentView = sortedIds;
  post({ type: "queryResult", requestId, filteredCount: sortedIds.length });
}

function onDistinct(requestId: number, column: string): void {
  let result = distinctCache.get(column);
  if (!result) {
    const columnIndex = headers.indexOf(column);
    result = columnIndex === -1 ? { values: [], truncated: false } : distinctValues(rawRows, columnIndex);
    distinctCache.set(column, result);
  }
  post({ type: "distinctResult", requestId, column, values: result.values, truncated: result.truncated });
}

function baselineFields(rowId: number): string[] {
  const recordIndex = rowId + headerOffset;
  const fieldCount = spans!.fieldCount[recordIndex];
  const fields = rawRows[rowId].slice(0, fieldCount);
  const changed = originals.get(rowId);
  if (changed) for (const [column, value] of changed) if (column < fieldCount) fields[column] = value;
  return fields;
}

function recordText(recordIndex: number, withTerminator: boolean): string {
  const end = spans!.end[recordIndex] + (withTerminator ? EOL_TEXT[spans!.eol[recordIndex]].length : 0);
  return text.slice(spans!.start[recordIndex], end);
}

function sameFields(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function noteBaseline(rowId: number, columnIndex: number, previous: string, next: string): void {
  let changed = originals.get(rowId);
  const baseline = changed?.has(columnIndex) ? changed.get(columnIndex)! : previous;
  if (next === baseline) {
    changed?.delete(columnIndex);
    if (changed && changed.size === 0) originals.delete(rowId);
    return;
  }
  if (!changed) {
    changed = new Map();
    originals.set(rowId, changed);
  }
  changed.set(columnIndex, baseline);
}

function invalidateColumn(columnIndex: number): void {
  const name = headers[columnIndex];
  sortKeyCache.delete(name);
  distinctCache.delete(name);
}

function floorOf(recordIndex: number): number {
  return floors.get(recordIndex) ?? spans!.fieldCount[recordIndex];
}

// How many fields the host would write for a record: its own, the edited cell, and every other cell already edited (those are written too).
function writeReach(rowId: number, columnIndex: number): number {
  let reach = Math.max(spans!.fieldCount[rowId + headerOffset], columnIndex + 1);
  for (const column of originals.get(rowId)?.keys() ?? []) reach = Math.max(reach, column + 1);
  return reach;
}

function writtenFields(rowId: number, columnIndex: number, value: string): string[] {
  const recordIndex = rowId + headerOffset;
  const current = rawRows[rowId].slice(0, writeReach(rowId, columnIndex));
  current[columnIndex] = value;
  return recordFieldsForWrite(baselineFields(rowId), current, floorOf(recordIndex), headers.length);
}

// A newline first keeps Papa from treating a U+FEFF at the record's start as the file's BOM.
function parseRecord(recordText: string): string[][] {
  return parseCsv(`\n${recordText}`, { delimiter, firstRowIsHeader: false, quotes: quoting }).rows;
}

const NUL = "\u0000";

// An edit is accepted only if the record's text still parses to its baseline and the new record parses back to what we mean to write.
function rejectionReason(rowId: number, columnIndex: number, value: string): string | null {
  if (!spans || !spansOk) return "this file's rows couldn't be matched to its text";
  const recordIndex = rowId + headerOffset;
  if (recordIndex >= spans.length) return "the row's text couldn't be matched exactly";
  const eol = EOL_TEXT[spans.eol[recordIndex]];

  const reparsed = parseRecord(recordText(recordIndex, true));
  if (reparsed.length !== 1 || !sameFields(reparsed[0], baselineFields(rowId))) {
    return "the row's text couldn't be matched exactly";
  }

  if (serializeField(value, delimiter, quoting) === null) {
    return "with Quoted fields off, a value can't contain the separator or a line break";
  }
  // With quoting off, a NUL is what makes Papa read quotes again, so adding or removing one would re-tokenize the whole file.
  if (!quotesRequested) {
    if (value.includes(NUL)) return "with Quoted fields off, a value can't contain a NUL character";
    if (quoting && rawRows[rowId][columnIndex].includes(NUL)) return "this file's NUL characters keep quoting on, so this value can't change";
  }
  const fields = writtenFields(rowId, columnIndex, value);
  if (fields.length === 1 && fields[0] === "" && !sameFields(fields, baselineFields(rowId))) return "an empty value would leave this row empty, which removes it from the file";
  const serialized = serializeRecord(fields, delimiter, quoting);
  if (recordIndex === 0 && serialized.charCodeAt(0) === 0xfeff) return "a value at the very start of the file can't begin with a byte order mark";
  const written = parseRecord(serialized + eol);
  if (written.length !== 1 || !sameFields(written[0], fields)) {
    return "that value can't be written to this file without changing its other cells";
  }
  return null;
}

function onEditCell(requestId: number, rowId: number, columnIndex: number, value: string): void {
  ensureSpans(true);
  const row = rawRows[rowId];
  if (!row || columnIndex < 0 || columnIndex >= headers.length) {
    post({ type: "editResult", requestId, ok: false, reason: "no such cell" });
    return;
  }
  const oldValue = row[columnIndex];
  if (oldValue === value) {
    post({ type: "editResult", requestId, ok: true, change: null });
    return;
  }
  const reason = rejectionReason(rowId, columnIndex, value);
  if (reason !== null) {
    post({ type: "editResult", requestId, ok: false, reason });
    return;
  }

  const recordIndex = rowId + headerOffset;
  const originalFields = baselineFields(rowId);
  noteBaseline(rowId, columnIndex, oldValue, value);
  row[columnIndex] = value;
  invalidateColumn(columnIndex);

  const change: CellChange = {
    rowId,
    recordIndex,
    columnIndex,
    column: headers[columnIndex],
    oldValue,
    newValue: value,
    record: {
      charStart: spans!.start[recordIndex],
      charEnd: spans!.end[recordIndex],
      byteStart: spans!.byteStart![recordIndex],
      byteEnd: spans!.byteEnd![recordIndex],
      eol: EOL_TEXT[spans!.eol[recordIndex]],
      fieldCount: spans!.fieldCount[recordIndex],
      originalText: recordText(recordIndex, false),
      originalFields,
      columns: headers.length,
    },
    format: { delimiter, quoting },
  };
  post({ type: "editResult", requestId, ok: true, change });
}

function onSetCells(requestId: number, cells: CellValue[], verify: RowBaseline[] | undefined): void {
  if (verify) ensureSpans(false);
  const rejected = new Set<number>();
  for (const check of verify ?? []) {
    const recordIndex = check.rowId + headerOffset;
    const valid = spans !== null && rawRows[check.rowId] !== undefined && recordIndex < spans.length;
    if (!valid || !sameFields(baselineFields(check.rowId), check.originalFields)) rejected.add(check.rowId);
  }
  for (const { rowId, columnIndex, value } of cells) {
    const row = rawRows[rowId];
    if (!row || rejected.has(rowId) || columnIndex < 0 || columnIndex >= headers.length) continue;
    noteBaseline(rowId, columnIndex, row[columnIndex], value);
    row[columnIndex] = value;
    invalidateColumn(columnIndex);
  }
  post({ type: "setCellsDone", requestId, rejectedRowIds: [...rejected] });
}

// Without a host account of the write, every cell that differs from the file is taken to have been written.
function editedRecords(): WrittenRecord[] {
  const records: WrittenRecord[] = [];
  if (!spans) return records;
  for (const rowId of originals.keys()) {
    const recordIndex = rowId + headerOffset;
    const reach = writeReach(rowId, 0);
    records.push({ recordIndex, fields: recordFieldsForWrite(baselineFields(rowId), rawRows[rowId].slice(0, reach), floorOf(recordIndex), headers.length) });
  }
  return records;
}

// Brings the spans, the retained text and the baselines in line with the file the host just wrote.
// The host says what it wrote; cells edited since are still edits against that file.
function onRebase(requestId: number, written: WrittenRecord[] | undefined): void {
  ensureSpans(true);
  const records: EditedRecord[] = (written ?? editedRecords()).map((w) => ({ index: w.recordIndex, fields: w.fields })).sort((a, b) => a.index - b.index);
  let patches: ReturnType<typeof textPatches> = [];
  if (spans) {
    const hostFloors = new Map((written ?? []).map((w) => [w.recordIndex, w.floor]));
    for (const { index } of records) {
      const floor = hostFloors.get(index);
      if (floor !== undefined) floors.set(index, floor);
      else if (!floors.has(index)) floors.set(index, spans.fieldCount[index]);
    }
    patches = textPatches(spans, records, delimiter, quoting);
    text = applyTextPatches(text, patches);
    spans = rebaseSpanTable(spans, records, delimiter, quoting);
    for (const { index, fields } of records) {
      const rowId = index - headerOffset;
      const row = rawRows[rowId];
      if (!row) continue;
      const changed = new Map<number, string>();
      for (let column = 0; column < headers.length; column++) {
        const baseline = fields[column] ?? "";
        if (row[column] !== baseline) changed.set(column, baseline);
      }
      if (changed.size > 0) originals.set(rowId, changed);
      else originals.delete(rowId);
    }
  }
  post({ type: "rebased", requestId, patches });
}

function onPage(requestId: number, page: number, pageSize: number): void {
  const view = currentView ?? rawRows.map((_, id) => id);
  const { start, end } = pageSlice(view.length, page, pageSize);
  const rows: { id: number; cells: string[] }[] = [];
  for (let i = start; i < end; i++) {
    const id = view[i];
    rows.push({ id, cells: rawRows[id] });
  }
  post({ type: "pageResult", requestId, rows });
}

self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  try {
    switch (msg.type) {
      case "init":
        onInit(msg.requestId, msg.text, msg.options, msg.floors);
        break;
      case "query":
        onQuery(msg.requestId, msg.quickSearch, msg.filterRules, msg.sortKeys);
        break;
      case "page":
        onPage(msg.requestId, msg.page, msg.pageSize);
        break;
      case "distinct":
        onDistinct(msg.requestId, msg.column);
        break;
      case "editCell":
        onEditCell(msg.requestId, msg.rowId, msg.columnIndex, msg.value);
        break;
      case "setCells":
        onSetCells(msg.requestId, msg.cells, msg.verify);
        break;
      case "rebase":
        onRebase(msg.requestId, msg.written);
        break;
    }
  } catch (err) {
    post({ type: "workerError", requestId: msg.requestId, message: err instanceof Error ? err.message : String(err) });
  }
});
