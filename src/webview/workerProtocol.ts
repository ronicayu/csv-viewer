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

import type { FilterRule, SortKey } from "../core/types";

export interface ParseOptionsMsg {
  delimiter?: string;
  firstRowIsHeader: boolean;
  quotes: boolean;
}

export type WorkerRequest =
  | { type: "init"; requestId: number; text: string; options: ParseOptionsMsg }
  | { type: "query"; requestId: number; quickSearch: string; filterRules: FilterRule[]; sortKeys: SortKey[] }
  | { type: "page"; requestId: number; page: number; pageSize: number };

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
    }
  | { type: "queryResult"; requestId: number; filteredCount: number }
  | { type: "pageResult"; requestId: number; rows: WorkerRow[] }
  | { type: "workerError"; requestId: number; message: string };

/** How long the main thread waits for a `query` response before assuming
 * the worker is stuck (catastrophic regex backtracking) and terminating
 * it. See main.ts's regex-timeout handling. */
export const REGEX_TIMEOUT_MS = 2000;

/** After a request has been in flight this long with no response, show
 * the "Working…" indicator. */
export const WORKING_INDICATOR_DELAY_MS = 150;
