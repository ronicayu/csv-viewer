import { profileColumns } from "../core/columns";
import { parseCsv } from "../core/csvParse";
import { distinctValues, type DistinctResult } from "../core/distinct";
import { applyFilters } from "../core/filter";
import { buildColumnSortKeys, sortRowIdsByCachedKeys, type ResolvedCellSortKey } from "../core/sort";
import { pageSlice } from "../core/paging";
import type { FilterRule, SortDirection, SortKey } from "../core/types";
import type { WorkerRequest, WorkerResponse } from "./workerProtocol";

let headers: string[] = [];
let rawRows: string[][] = [];
// applyFilters returns the original row arrays, so reference identity recovers each row's id.
let idByRowRef = new Map<string[], number>();
let currentView: number[] | null = null;
let sortKeyCache = new Map<string, ResolvedCellSortKey[]>();
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
