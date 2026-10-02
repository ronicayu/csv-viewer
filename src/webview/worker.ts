// CSV worker: owns parsing, filtering, and sorting off the main thread, so
// a catastrophic regex (e.g. `(a+)+$`) or a large filter/sort never freezes
// the UI. Reuses the same pure src/core modules the main thread used to
// call directly — no parsing/filtering/sorting semantics changed here,
// only *where* they run.
//
// Protocol (see workerProtocol.ts): the main thread sends `init` once per
// load/re-parse (the whole document text + parse options), then `query`
// messages (quickSearch/filterRules/sortKeys) whenever any of those change,
// then `page` messages to fetch just the current page's rows. `query`
// recomputes the filtered+sorted row order and caches it as `currentView`
// (row ids, in sorted order); a `page` request slices that cached view, so
// paging alone (Next/Prev/page-size change) never re-filters or re-sorts.
// Every response echoes back the request's `requestId` unchanged so the
// main thread can recognize and drop a stale response.
//
// `query` also posts `queryStarted` right before it begins `applyFilters`
// and `filterDone` right after — these bracket exactly the phase the main
// thread's regex-timeout watchdog measures (see main.ts), so a request
// that's merely queued behind an earlier one, or a slow sort *after*
// filtering, can never falsely trip it.
//
// `distinct` answers the "filter by values" picker with a column's distinct
// values and row counts over the whole parsed file (never the filtered
// view). The result is cached per column name — see `distinctCache` — until
// the next `init`.
//
// Sort keys per column (kind/num/collator rank) are cached here — see
// `sortKeyCache` — and reused across every subsequent query until the next
// `init`, since they're a pure function of the column's values, which
// don't change between queries on the same parse. Re-sorting a filtered
// subset after that is just cheap integer/rank comparisons (see
// `sortRowIdsByCachedKeys` in core/sort.ts) instead of re-deriving each
// cell's kind and re-running the collator over every distinct value again.
//
// Bundled by esbuild to out/webview/worker.js (browser/worker platform, its
// own entry point — see package.json's bundle:worker script). Loaded by
// the main thread via a Blob URL (see main.ts) since a webview can't load
// a vscode-resource: URL directly as a Worker script.

import { profileColumns } from "../core/columns";
import { parseCsv } from "../core/csvParse";
import { distinctValues, type DistinctResult } from "../core/distinct";
import { applyFilters } from "../core/filter";
import { buildColumnSortKeys, sortRowIdsByCachedKeys, type ResolvedCellSortKey } from "../core/sort";
import { pageSlice } from "../core/paging";
import type { FilterRule, SortDirection, SortKey } from "../core/types";
import type { WorkerRequest, WorkerResponse } from "./workerProtocol";

let headers: string[] = [];
/** Every parsed row, index === that row's stable id (matches the id
 * scheme main.ts used to assign itself: `parsed.rows.map((cells, id) =>
 * ({ id, cells }))`). Never mutated after `init` — only ever replaced
 * wholesale by a later `init`. */
let rawRows: string[][] = [];
/** Reference identity -> id, built once per `init`. Since `rawRows`'s row
 * arrays are never mutated or recreated, and `applyFilters` returns an
 * array of those same row-array references (never copies of the cells),
 * this recovers each filtered row's original id in O(1). */
let idByRowRef = new Map<string[], number>();
/** The most recently queried filtered+sorted row ids, or null before the
 * first `query`. A `page` request slices this without re-filtering/
 * re-sorting. */
let currentView: number[] | null = null;
/** Per-column resolved sort keys (kind/num/rank), built once — over the
 * *entire* dataset — the first time that column is used as a sort key,
 * and reused for every later query until the next `init` invalidates it
 * (a fresh parse changes row identities and values). Keyed by column
 * name. See core/sort.ts's buildColumnSortKeys doc comment for why keys
 * built over the full dataset still correctly order any filtered subset. */
let sortKeyCache = new Map<string, ResolvedCellSortKey[]>();
/** Per-column distinct values (see core/distinct.ts), keyed by column name
 * and reused when the picker is reopened; cleared by `init` since a fresh
 * parse changes the data. Counts cover every row, so no filter or sort
 * change can invalidate an entry. */
let distinctCache = new Map<string, DistinctResult>();

function post(message: WorkerResponse): void {
  (self as unknown as Worker).postMessage(message);
}

function onInit(requestId: number, text: string, options: { delimiter?: string; firstRowIsHeader: boolean; quotes: boolean }): void {
  const parsed = parseCsv(text, options);
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
  });
}

function getColumnSortKeys(columnIndex: number, columnName: string): ResolvedCellSortKey[] {
  const cached = sortKeyCache.get(columnName);
  if (cached) return cached;
  const built = buildColumnSortKeys(rawRows, columnIndex);
  sortKeyCache.set(columnName, built);
  return built;
}

function onQuery(requestId: number, quickSearch: string, filterRules: FilterRule[], sortKeys: SortKey[]): void {
  // Brackets exactly the filter phase — see workerProtocol.ts's doc
  // comments on these two message types for why that's what the main
  // thread's regex-timeout watchdog needs to measure, not send-to-answer.
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
    if (ci === undefined) continue; // stale sort key (e.g. after a separator change) — silently skipped, same as sortRows
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
    }
  } catch (err) {
    post({ type: "workerError", requestId: msg.requestId, message: err instanceof Error ? err.message : String(err) });
  }
});
