import { profileColumns } from "../core/columns";
import { fieldsForWrite, isRecordEdited, rebaseSpans, spliceText, type EditedRecord } from "../core/csvEdit";
import { parseCsv } from "../core/csvParse";
import { serializeField, serializeRecord } from "../core/csvSerialize";
import { distinctValues, type DistinctResult } from "../core/distinct";
import { applyFilters } from "../core/filter";
import { buildColumnSortKeys, sortRowIdsByCachedKeys, type ResolvedCellSortKey } from "../core/sort";
import { pageSlice } from "../core/paging";
import { EOL_TEXT, SpanTableBuilder, addByteOffsets, scanRecords, splitRecordsToTable, type SpanTable } from "../core/recordSpans";
import type { CellChange, FilterRule, SortDirection, SortKey } from "../core/types";
import type { CellValue, RowBaseline, WorkerRequest, WorkerResponse } from "./workerProtocol";

let headers: string[] = [];
let rawRows: string[][] = [];
// applyFilters returns the original row arrays, so reference identity recovers each row's id.
let idByRowRef = new Map<string[], number>();
let currentView: number[] | null = null;
let sortKeyCache = new Map<string, ResolvedCellSortKey[]>();
let distinctCache = new Map<string, DistinctResult>();

// Kept for the document's lifetime: span slicing and the per-commit re-parse need the text the spans describe.
let text = "";
let spans: SpanTable | null = null;
let spansOk = false;
let delimiter = ",";
let quoting = true;
let headerOffset = 0;
// Baseline value of every cell that differs from the file; an entry is dropped when the cell returns to it.
let originals = new Map<number, Map<number, string>>();

// Past this size the span pass would hold up the first render, so it runs in slices after the initial queries and edits finish it on demand.
const SYNC_SPANS_MAX_CHARS = 8 * 1024 * 1024;
const SPAN_SLICE_MS = 8;
const SPAN_SLICE_RECORDS = 1024;

interface SpanJob {
  requestId: number;
  builder: SpanTableBuilder;
  pos: number;
  expectedRecords: number;
}

let spanJob: SpanJob | null = null;

function post(message: WorkerResponse): void {
  (self as unknown as Worker).postMessage(message);
}

function onInit(requestId: number, source: string, options: { delimiter?: string; firstRowIsHeader: boolean; quotes: boolean }): void {
  const parsed = parseCsv(source, options);
  text = source;
  delimiter = parsed.delimiter;
  quoting = parsed.quoting;
  originals = new Map();
  headerOffset = options.firstRowIsHeader && parsed.headers.length > 0 ? 1 : 0;
  spans = null;
  spansOk = false;
  spanJob = null;
  const expectedRecords = parsed.rows.length + headerOffset;
  if (source.length <= SYNC_SPANS_MAX_CHARS) {
    spans = splitRecordsToTable(source, { delimiter, quotes: quoting });
    spansOk = spans.length === expectedRecords;
    if (!spansOk) reportSpanMismatch(spans.length, expectedRecords);
  } else {
    const job: SpanJob = { requestId, builder: new SpanTableBuilder(), pos: 0, expectedRecords };
    spanJob = job;
    setTimeout(() => stepSpanJob(job), 0);
  }
  headers = parsed.headers;
  rawRows = parsed.rows;
  idByRowRef = new Map();
  rawRows.forEach((cells, id) => idByRowRef.set(cells, id));
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

function finishSpanJob(job: SpanJob): void {
  spans = job.builder.finish();
  spansOk = spans.length === job.expectedRecords;
  spanJob = null;
  if (!spansOk) reportSpanMismatch(spans.length, job.expectedRecords);
  post({ type: "spansReady", requestId: job.requestId, spansOk });
}

function stepSpanJob(job: SpanJob): void {
  if (spanJob !== job) return;
  const deadline = performance.now() + SPAN_SLICE_MS;
  do {
    job.pos = scanRecords(text, { delimiter, quotes: quoting }, job.builder.push, job.pos, SPAN_SLICE_RECORDS);
  } while (job.pos < text.length && performance.now() < deadline);
  if (job.pos < text.length) setTimeout(() => stepSpanJob(job), 0);
  else finishSpanJob(job);
}

// Anything that needs the spans before the background pass is done finishes it in one go.
function ensureSpans(withBytes: boolean): void {
  const job = spanJob;
  if (job) {
    job.pos = scanRecords(text, { delimiter, quotes: quoting }, job.builder.push, job.pos);
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
  const filtered = applyFilters(headers, rawRows, quickSearch, filterRules);
  post({ type: "filterDone", requestId });

  const ids: number[] = [];
  for (const cells of filtered) {
    const id = idByRowRef.get(cells);
    if (id !== undefined) ids.push(id);
  }

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

function writtenFields(rowId: number, columnIndex: number, value: string): string[] {
  const recordIndex = rowId + headerOffset;
  const fieldCount = spans!.fieldCount[recordIndex];
  const current = rawRows[rowId].slice(0, Math.max(fieldCount, columnIndex + 1));
  current[columnIndex] = value;
  return fieldsForWrite(current, fieldCount);
}

// An edit is accepted only if the record's text still parses to its baseline and the new record parses back to what we mean to write.
function rejectionReason(rowId: number, columnIndex: number, value: string): string | null {
  if (!spans || !spansOk) return "this file's rows couldn't be matched to its text";
  const recordIndex = rowId + headerOffset;
  if (recordIndex >= spans.length) return "the row's text couldn't be matched exactly";
  const eol = EOL_TEXT[spans.eol[recordIndex]];

  const reparsed = parseCsv(recordText(recordIndex, true), { delimiter, firstRowIsHeader: false, quotes: quoting });
  if (reparsed.rows.length !== 1 || !sameFields(reparsed.rows[0], baselineFields(rowId))) {
    return "the row's text couldn't be matched exactly";
  }

  if (serializeField(value, delimiter, quoting) === null) {
    return "with Quoted fields off, a value can't contain the separator or a line break";
  }
  const fields = writtenFields(rowId, columnIndex, value);
  if (fields.length === 1 && fields[0] === "") return "an empty value would remove this row from a one-column file";
  const written = parseCsv(serializeRecord(fields, delimiter, quoting) + eol, { delimiter, firstRowIsHeader: false, quotes: quoting });
  if (written.rows.length !== 1 || !sameFields(written.rows[0], fields)) {
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

// Brings the span tables and the retained text in line with the file the host just wrote.
function onRebase(requestId: number): void {
  ensureSpans(true);
  const edited: EditedRecord[] = [];
  if (spans) {
    for (const rowId of [...originals.keys()].sort((a, b) => a - b)) {
      const recordIndex = rowId + headerOffset;
      const fieldCount = spans.fieldCount[recordIndex];
      const reach = Math.max(fieldCount, ...[...originals.get(rowId)!.keys()].map((column) => column + 1));
      const fields = fieldsForWrite(rawRows[rowId].slice(0, reach), fieldCount);
      if (isRecordEdited(baselineFields(rowId), fields)) edited.push({ index: recordIndex, fields });
    }
    text = spliceText(text, spans, edited, delimiter, quoting);
    spans = rebaseSpans(spans, edited, delimiter, quoting);
  }
  originals = new Map();
  post({ type: "rebased", requestId, text });
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
        onInit(msg.requestId, msg.text, msg.options);
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
        onRebase(msg.requestId);
        break;
    }
  } catch (err) {
    post({ type: "workerError", requestId: msg.requestId, message: err instanceof Error ? err.message : String(err) });
  }
});
