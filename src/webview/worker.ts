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
// recomputes the filtered+sorted row order and caches it as `currentView`;
// a `page` request slices that cached view, so paging alone (Next/Prev/
// page-size change) never re-filters or re-sorts. Every response echoes
// back the request's `requestId` unchanged so the main thread can
// recognize and drop a stale response.
//
// Bundled by esbuild to out/webview/worker.js (browser/worker platform, its
// own entry point — see package.json's bundle:worker script). Loaded by
// the main thread via a Blob URL (see main.ts) since a webview can't load
// a vscode-resource: URL directly as a Worker script.

import { parseCsv } from "../core/csvParse";
import { applyFilters } from "../core/filter";
import { sortRows } from "../core/sort";
import { pageSlice } from "../core/paging";
import type { FilterRule, SortKey } from "../core/types";
import type { WorkerRequest, WorkerResponse } from "./workerProtocol";

let headers: string[] = [];
/** Every parsed row, index === that row's stable id (matches the id
 * scheme main.ts used to assign itself: `parsed.rows.map((cells, id) =>
 * ({ id, cells }))`). Never mutated after `init` — only ever replaced
 * wholesale by a later `init`. */
let rawRows: string[][] = [];
/** Reference identity -> id, built once per `init`. Since `rawRows`'s row
 * arrays are never mutated or recreated, and `applyFilters`/`sortRows`
 * return arrays of those same row-array references (never copies of the
 * cells), this recovers each result row's original id in O(1). */
let idByRowRef = new Map<string[], number>();
/** The most recently queried filtered+sorted view (row-array references
 * into `rawRows`), or null before the first `query`. A `page` request
 * slices this without re-filtering/re-sorting. */
let currentView: string[][] | null = null;

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

  post({
    type: "initResult",
    requestId,
    headers,
    detectedDelimiter: parsed.delimiter,
    quoteProblems: parsed.quoteProblems,
    totalRows: rawRows.length,
  });
}

function onQuery(requestId: number, quickSearch: string, filterRules: FilterRule[], sortKeys: SortKey[]): void {
  const filtered = applyFilters(headers, rawRows, quickSearch, filterRules);
  const sorted = sortRows(filtered, headers, sortKeys);
  currentView = sorted;
  post({ type: "queryResult", requestId, filteredCount: sorted.length });
}

function onPage(requestId: number, page: number, pageSize: number): void {
  const view = currentView ?? rawRows;
  const { start, end } = pageSlice(view.length, page, pageSize);
  const rows: { id: number; cells: string[] }[] = [];
  for (let i = start; i < end; i++) {
    const cells = view[i];
    const id = idByRowRef.get(cells);
    // Defensive: every row in `view` is always a reference from `rawRows`,
    // so `id` should never be undefined — but never crash the worker (and
    // the whole pipeline with it) over a single bad row.
    if (id !== undefined) rows.push({ id, cells });
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
    }
  } catch (err) {
    post({ type: "workerError", requestId: msg.requestId, message: err instanceof Error ? err.message : String(err) });
  }
});
