import { MANY_COLUMNS, PROFILE_SAMPLE_ROWS, profileColumns, profileVerdicts, type ColumnProfile } from "../core/columns";
import { applyTextPatches, recordFieldsForWrite, type ByteReplacement, rebaseSpanTable, textPatches, type EditedRecord } from "../core/csvEdit";
import { parseCsv } from "../core/csvParse";
import { PARSE_SLICE_RECORDS, ProgressiveParse } from "../core/progressiveParse";
import { isWellFormedUtf16, serializeField, serializeRecord } from "../core/csvSerialize";
import { distinctValues, type DistinctResult } from "../core/distinct";
import { filterCacheKey, filterRowIds } from "../core/filter";
import { buildColumnSortKeys, sortRowIdsByCachedKeys, type ResolvedCellSortKey } from "../core/sort";
import { pageSlice } from "../core/paging";
import { EOL_TEXT, addByteOffsets, type SpanTable } from "../core/recordSpans";
import type { CellChange, FilterRule, RecordFloor, SortDirection, SortKey, WrittenRecord } from "../core/types";
import type { CellValue, FirstPageRequest, ParseOptionsMsg, ParseTuning, RowBaseline, WorkerRequest, WorkerResponse, WorkerRow } from "./workerProtocol";

let headers: string[] = [];
let rawRows: string[][] = [];
let currentView: number[] | null = null;
// Built the first time a sort asks for a column by name; with very many columns that is too slow to do on every query.
let columnIndexByName: Map<string, number> | null = null;
let sortKeyCache = new Map<string, ResolvedCellSortKey[]>();
let distinctCache = new Map<string, DistinctResult>();
// The ids that passed the last query's filter, so a sort-only change does not filter again. Never mutated: sorting works on a copy.
let filterCache: { key: string; ids: number[] } | null = null;

// Kept for the document's lifetime: span slicing and the per-commit re-parse need the text the spans describe.
let text = "";
let textBytes: number | undefined;
let spans: SpanTable | null = null;
let spansOk = false;
let delimiter = ",";
let quoting = true;
let quotesRequested = true;
let firstRowIsHeader = true;
// Smallest field count a record may be written with: its count when first touched, which survives saves so an undo can shrink a record back.
let floors = new Map<number, number>();
let headerOffset = 0;
// Baseline value of every cell that differs from the file; an entry is dropped when the cell returns to it.
let originals = new Map<number, Map<number, string>>();

const PARSE_STEP_MS = 8;

// The rest of a file whose first slice has been shown: the remaining slices run between messages, and anything that needs the whole table
// finishes them first (ensureParsed).
interface ParseJob {
  requestId: number;
  parse: ProgressiveParse;
  channel: MessageChannel;
  timer: ReturnType<typeof setTimeout> | undefined;
  // What the main thread has been told, to say what changed at the end.
  reportedHeaders: string[];
  profiledRows: number;
}

let parseJob: ParseJob | null = null;
let sliceRecords = PARSE_SLICE_RECORDS;
let sliceDelayMs = 0;
let latestInitRequestId = -1;

function post(message: WorkerResponse, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(message, transfer);
}

const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

interface InitSource {
  text?: string;
  bytes?: Uint8Array;
  byteLength?: number;
}

function onInit(
  requestId: number,
  source: InitSource,
  options: ParseOptionsMsg,
  initialFloors: RecordFloor[] | undefined,
  firstPage: FirstPageRequest | undefined,
  tuning: ParseTuning | undefined,
): void {
  // Not fatal: the host has already decided whether the file is valid UTF-8, and this is the string it would have sent.
  text = source.text ?? decoder.decode(source.bytes!);
  textBytes = source.bytes ? source.bytes.byteLength : source.byteLength;
  beginParse(requestId, options, initialFloors, firstPage, tuning, source.bytes);
}

// A format change re-parses the text this worker already holds, so nothing crosses the thread again.
function onReparse(requestId: number, options: ParseOptionsMsg, initialFloors: RecordFloor[] | undefined, firstPage: FirstPageRequest | undefined, tuning: ParseTuning | undefined): void {
  beginParse(requestId, options, initialFloors, firstPage, tuning, undefined);
}

function beginParse(
  requestId: number,
  options: ParseOptionsMsg,
  initialFloors: RecordFloor[] | undefined,
  firstPage: FirstPageRequest | undefined,
  tuning: ParseTuning | undefined,
  bytes: Uint8Array | undefined,
): void {
  endParseJob();
  sliceRecords = tuning?.sliceRecords ?? PARSE_SLICE_RECORDS;
  sliceDelayMs = tuning?.sliceDelayMs ?? 0;
  latestInitRequestId = requestId;
  const parse = new ProgressiveParse(text, options, sliceRecords, tuning?.rebuildAfterSlices);
  parse.step();
  delimiter = parse.delimiter;
  quoting = parse.quoting;
  quotesRequested = options.quotes;
  firstRowIsHeader = options.firstRowIsHeader;
  originals = new Map();
  floors = new Map((initialFloors ?? []).map((f) => [f.recordIndex, f.floor]));
  headers = parse.headers();
  rawRows = parse.rows;
  headerOffset = options.firstRowIsHeader && headers.length > 0 ? 1 : 0;
  spans = null;
  spansOk = false;
  currentView = null;
  columnIndexByName = null;
  sortKeyCache = new Map();
  distinctCache = new Map();
  filterCache = null;

  let page: { page: number; rows: WorkerRow[] } | undefined;
  if (parse.done) {
    finishSpans(parse);
  } else {
    const job: ParseJob = { requestId, parse, channel: new MessageChannel(), timer: undefined, reportedHeaders: headers, profiledRows: Math.min(PROFILE_SAMPLE_ROWS, rawRows.length) };
    parseJob = job;
    if (firstPage && firstPage.page === 1 && rawRows.length >= firstPage.pageSize) {
      page = { page: 1, rows: rawRows.slice(0, firstPage.pageSize).map((cells, id) => ({ id, cells })) };
    }
    job.channel.port1.onmessage = () => stepParseJob(job);
  }

  const answer = (): void => {
    if (latestInitRequestId !== requestId) return;
    post(
      {
        type: "initResult",
        requestId,
        headers,
        detectedDelimiter: parse.delimiter,
        quoteProblems: parse.quoteProblems(),
        totalRows: rawRows.length,
        ...profilesForMain(),
        quoting,
        spansOk: parseJob ? undefined : spansOk,
        parsing: parseJob ? true : undefined,
        firstPage: page,
        bytes,
      },
      bytes ? [bytes.buffer as ArrayBuffer] : [],
    );
    if (parseJob) scheduleStep(parseJob);
  };
  if (tuning?.initResultDelayMs) setTimeout(answer, tuning.initResultDelayMs);
  else answer();
}

function profilesForMain(): { columnProfiles: ColumnProfile[]; profileVerdicts?: Uint8Array } {
  const profiles = profileColumns(headers, rawRows);
  return headers.length > MANY_COLUMNS ? { columnProfiles: [], profileVerdicts: profileVerdicts(profiles) } : { columnProfiles: profiles };
}

function reportSpanMismatch(found: number, expected: number): void {
  // eslint-disable-next-line no-console
  console.error(`csv-viewer: record splitter found ${found} records but the parser found ${expected}; editing is disabled`);
}

function finishSpans(parse: ProgressiveParse): void {
  spans = parse.spans();
  const expected = parse.rows.length + headerOffset;
  spansOk = spans.length === expected;
  if (!spansOk) reportSpanMismatch(spans.length, expected);
}

// Slices are chained through a MessageChannel: unlike setTimeout it is not clamped to 4 ms, and unlike a microtask it lets queued requests run between slices.
function scheduleStep(job: ParseJob): void {
  if (sliceDelayMs > 0) job.timer = setTimeout(() => stepParseJob(job), sliceDelayMs);
  else job.channel.port2.postMessage(null);
}

function endParseJob(): void {
  if (!parseJob) return;
  if (parseJob.timer !== undefined) clearTimeout(parseJob.timer);
  parseJob.channel.port1.close();
  parseJob = null;
}

function stepParseJob(job: ParseJob): void {
  if (parseJob !== job) return;
  const deadline = performance.now() + PARSE_STEP_MS;
  let done = false;
  do {
    done = job.parse.step();
  } while (!done && sliceDelayMs === 0 && performance.now() < deadline);
  filterCache = null;
  if (done) finishParseJob(job);
  else scheduleStep(job);
}

function finishParseJob(job: ParseJob): void {
  const { parse } = job;
  endParseJob();
  filterCache = null;
  rawRows = parse.rows;
  const finalHeaders = parse.headers();
  const changed = parse.rebuilt || finalHeaders.length !== job.reportedHeaders.length || finalHeaders.some((h, i) => h !== job.reportedHeaders[i]);
  const resample = job.profiledRows < Math.min(PROFILE_SAMPLE_ROWS, rawRows.length);
  headers = finalHeaders;
  headerOffset = firstRowIsHeader && headers.length > 0 ? 1 : 0;
  delimiter = parse.delimiter;
  quoting = parse.quoting;
  finishSpans(parse);
  post({
    type: "parseDone",
    requestId: job.requestId,
    totalRows: rawRows.length,
    quoteProblems: parse.quoteProblems(),
    spansOk,
    rebuilt: parse.rebuilt,
    ...(changed || resample ? { headers, ...profilesForMain() } : {}),
  });
}

// Anything that needs every row finishes the parse in one go.
function ensureParsed(): void {
  const job = parseJob;
  if (!job) return;
  job.parse.runToEnd();
  finishParseJob(job);
}

function ensureSpans(withBytes: boolean): void {
  ensureParsed();
  if (withBytes && spans && !spans.byteStart) addByteOffsets(spans, text, textBytes);
}

function getColumnSortKeys(columnIndex: number, columnName: string): ResolvedCellSortKey[] {
  const cached = sortKeyCache.get(columnName);
  if (cached) return cached;
  const built = buildColumnSortKeys(rawRows, columnIndex);
  sortKeyCache.set(columnName, built);
  return built;
}

function onQuery(requestId: number, quickSearch: string, filterRules: FilterRule[], sortKeys: SortKey[]): void {
  ensureParsed();
  // queryStarted/filterDone bracket only the filter phase, which is what the regex watchdog times.
  post({ type: "queryStarted", requestId });
  const key = filterCacheKey(headers, quickSearch, filterRules);
  const filterCached = filterCache?.key === key;
  if (!filterCached) filterCache = { key, ids: filterRowIds(headers, rawRows, quickSearch, filterRules) };
  const ids = filterCache!.ids;
  post({ type: "filterDone", requestId });

  const sortColumns: { direction: SortDirection; keys: ResolvedCellSortKey[] }[] = [];
  for (const key of sortKeys) {
    columnIndexByName ??= new Map(headers.map((h, i) => [h, i]));
    const ci = columnIndexByName.get(key.column);
    if (ci === undefined) continue; // stale key, e.g. after a separator change
    sortColumns.push({ direction: key.direction, keys: getColumnSortKeys(ci, key.column) });
  }

  const sortedIds = sortRowIdsByCachedKeys(ids, sortColumns);
  currentView = sortedIds;
  post({ type: "queryResult", requestId, filteredCount: sortedIds.length, filterCached });
}

function onDistinct(requestId: number, column: string): void {
  ensureParsed();
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

// A cell changed: the keys and distinct values of its column are stale, and so are the ids that passed a filter.
function invalidateColumn(columnIndex: number): void {
  filterCache = null;
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
const UNPAIRED_SURROGATE_SENTENCE = "a value can't contain an unpaired surrogate character, which a UTF-8 file cannot hold";

// An edit is accepted only if the record's text still parses to its baseline and the new record parses back to what we mean to write.
function rejectionReason(rowId: number, columnIndex: number, value: string): string | null {
  if (!spans || !spansOk) return "this file's rows couldn't be matched to its text";
  if (!isWellFormedUtf16(value)) return UNPAIRED_SURROGATE_SENTENCE;
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

function onEditCell(requestId: number, rowId: number, columnIndex: number, value: string, expected: string | undefined): void {
  ensureSpans(true);
  const row = rawRows[rowId];
  if (!row || columnIndex < 0 || columnIndex >= headers.length) {
    post({ type: "editResult", requestId, ok: false, reason: "no such cell" });
    return;
  }
  const oldValue = row[columnIndex];
  // The row the sender saw may not be the row with this id any more (the rows were parsed again under it).
  if (expected !== undefined && oldValue !== expected) {
    post({ type: "editResult", requestId, ok: false, reason: "the file was read again while you were editing", stale: true });
    return;
  }
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
  ensureParsed();
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
  filterCache = null;
  const records: EditedRecord[] = (written ?? editedRecords()).map((w) => ({ index: w.recordIndex, fields: w.fields })).sort((a, b) => a.index - b.index);
  let patches: ReturnType<typeof textPatches> = [];
  let bytePatches: ByteReplacement[] = [];
  if (spans) {
    const hostFloors = new Map((written ?? []).map((w) => [w.recordIndex, w.floor]));
    for (const { index } of records) {
      const floor = hostFloors.get(index);
      if (floor !== undefined) floors.set(index, floor);
      else if (!floors.has(index)) floors.set(index, spans.fieldCount[index]);
    }
    patches = textPatches(spans, records, delimiter, quoting);
    // The same replacements in bytes, for the thread that holds the file as bytes (offsets exist: ensureSpans(true)).
    const encoder = new TextEncoder();
    bytePatches = patches.map((patch, i) => ({ byteStart: spans!.byteStart![records[i].index], byteEnd: spans!.byteEnd![records[i].index], bytes: encoder.encode(patch.text) }));
    if (textBytes !== undefined) for (const b of bytePatches) textBytes += b.bytes.length - (b.byteEnd - b.byteStart);
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
  post({ type: "rebased", requestId, patches, bytePatches });
}

function onPage(requestId: number, page: number, pageSize: number): void {
  // A page asked for while the parse is still going is served from the rows so far only if they cover it.
  if (currentView === null && page * pageSize > rawRows.length) ensureParsed();
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
        onInit(msg.requestId, { text: msg.text, bytes: msg.bytes, byteLength: msg.byteLength }, msg.options, msg.floors, msg.firstPage, msg.tuning);
        break;
      case "reparse":
        onReparse(msg.requestId, msg.options, msg.floors, msg.firstPage, msg.tuning);
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
        onEditCell(msg.requestId, msg.rowId, msg.columnIndex, msg.value, msg.expected);
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
