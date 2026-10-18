import type { ColumnProfile } from "../core/columns";
import type { DistinctValue } from "../core/distinct";
import type { CellChange, FilterRule, SortKey } from "../core/types";

export interface ParseOptionsMsg {
  delimiter?: string;
  firstRowIsHeader: boolean;
  quotes: boolean;
}

export type WorkerRequest =
  | { type: "init"; requestId: number; text: string; options: ParseOptionsMsg }
  | { type: "query"; requestId: number; quickSearch: string; filterRules: FilterRule[]; sortKeys: SortKey[] }
  | { type: "page"; requestId: number; page: number; pageSize: number }
  | { type: "distinct"; requestId: number; column: string }
  | { type: "editCell"; requestId: number; rowId: number; columnIndex: number; value: string }
  | { type: "setCells"; requestId: number; cells: CellValue[]; verify?: RowBaseline[] }
  | { type: "rebase"; requestId: number };

export interface CellValue {
  rowId: number;
  columnIndex: number;
  value: string;
}

// A restored edit applies only if its row still parses to these baseline fields.
export interface RowBaseline {
  rowId: number;
  originalFields: string[];
}

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
      columnProfiles: ColumnProfile[];
      quoting: boolean;
      spansOk: boolean;
    }
  | { type: "queryStarted"; requestId: number }
  | { type: "filterDone"; requestId: number }
  | { type: "queryResult"; requestId: number; filteredCount: number }
  | { type: "pageResult"; requestId: number; rows: WorkerRow[] }
  | { type: "distinctResult"; requestId: number; column: string; values: DistinctValue[]; truncated: boolean }
  | { type: "editResult"; requestId: number; ok: true; change: CellChange | null }
  | { type: "editResult"; requestId: number; ok: false; reason: string }
  | { type: "setCellsDone"; requestId: number; rejectedRowIds: number[] }
  | { type: "rebased"; requestId: number; text: string }
  | { type: "workerError"; requestId: number; message: string };

export const REGEX_TIMEOUT_MS = 2000;

export const WORKING_INDICATOR_DELAY_MS = 150;
