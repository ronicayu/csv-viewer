// Message protocol between the webview main thread (main.ts) and the CSV
// worker (worker.ts). The worker owns the parsed rows; the main thread only
// ever holds the current page's rows (with full, untruncated cell values —
// truncation happens at render time, see src/core/truncate.ts) plus small
// summary numbers (headers, counts). Every request carries a `requestId`
// (a monotonically increasing counter from the main thread) that the
// worker echoes back unchanged, so the main thread can recognize and drop
// a stale response — e.g. an older quick-search query whose result arrives
// after a newer one was already sent.
//
// Kept dependency-free (no vscode/DOM) so it can be imported by both
// main.ts (browser/DOM bundle) and worker.ts (Worker global scope bundle)
// without pulling either into the other.

import type { ColumnProfile } from "../core/columns";
import type { DistinctValue } from "../core/distinct";
import type { FilterRule, SortKey } from "../core/types";

export interface ParseOptionsMsg {
  delimiter?: string;
  firstRowIsHeader: boolean;
  quotes: boolean;
}

export type WorkerRequest =
  | { type: "init"; requestId: number; text: string; options: ParseOptionsMsg }
  | { type: "query"; requestId: number; quickSearch: string; filterRules: FilterRule[]; sortKeys: SortKey[] }
  | { type: "page"; requestId: number; page: number; pageSize: number }
  /** Distinct values (with row counts) of one column, for the "filter by
   * values" picker. Counted over every parsed row, NOT the currently
   * filtered view — the picker lists what the file contains, so a value
   * hidden by another filter can still be ticked. An unknown column answers
   * with an empty list. */
  | { type: "distinct"; requestId: number; column: string };

export interface WorkerRow {
  id: number;
  cells: string[];
}

export type WorkerResponse =
  | {
      type: "initResult";
      requestId: number;
      headers: string[];
      detectedDelimiter: string;
      quoteProblems: { row: number }[];
      totalRows: number;
      /** One profile per header, in the same order, sampled over the
       * first PROFILE_SAMPLE_ROWS data rows — see src/core/columns.ts.
       * Drives the smart default column split and numeric-column
       * right-alignment. */
      columnProfiles: ColumnProfile[];
    }
  /** Posted right before the worker begins `applyFilters` for this
   * request — i.e. once it has actually started running, not merely been
   * received. The main thread only starts its regex-timeout watchdog once
   * this arrives, so a request that's simply queued behind an earlier one
   * (or behind a slow sort — see `filterDone`) is never penalized for
   * time it spent waiting its turn in the worker's single-threaded
   * mailbox. */
  | { type: "queryStarted"; requestId: number }
  /** Posted right after `applyFilters` finishes for this request, before
   * `sortRows` runs — this is what disarms the regex-timeout watchdog.
   * The watchdog covers only the filter phase (where a catastrophic
   * regex actually runs); a slow sort afterward, even on a huge dataset,
   * is a different (and separately handled — see the sort-key cache in
   * worker.ts) performance concern and must never falsely trip it. */
  | { type: "filterDone"; requestId: number }
  | { type: "queryResult"; requestId: number; filteredCount: number }
  | { type: "pageResult"; requestId: number; rows: WorkerRow[] }
  | { type: "distinctResult"; requestId: number; column: string; values: DistinctValue[]; truncated: boolean }
  | { type: "workerError"; requestId: number; message: string };

/** How long the main thread waits, after a `query` request containing an
 * enabled regex rule actually starts running (`queryStarted`) and before
 * it finishes filtering (`filterDone`), before assuming the worker is
 * stuck (catastrophic regex backtracking) and terminating it. See
 * main.ts's regex-timeout handling. */
export const REGEX_TIMEOUT_MS = 2000;

/** After a request has been in flight this long with no response, show
 * the "Working…" indicator. */
export const WORKING_INDICATOR_DELAY_MS = 150;
