import type { ColumnProfile } from "../core/columns";
import type { DistinctValue } from "../core/distinct";
import type { ByteReplacement, TextPatch } from "../core/csvEdit";
import type { CellChange, FilterRule, RecordFloor, SortKey, WrittenRecord } from "../core/types";

export interface ParseOptionsMsg {
  delimiter?: string;
  firstRowIsHeader: boolean;
  quotes: boolean;
}

// Asks for the first page to come back with the init result, so no query/page round trip is needed when nothing sorts or filters.
export interface FirstPageRequest {
  page: number;
  pageSize: number;
}

// Test hooks: smaller slices and a pause between them, to look at the screen while a file is still parsing.
export interface ParseTuning {
  sliceRecords?: number;
  sliceDelayMs?: number;
  // Abandon the slices for the whole-text parse after this many.
  rebuildAfterSlices?: number;
  // Hold back the init result (and the slices after it), so the file's bytes stay with the worker for a while.
  initResultDelayMs?: number;
}

export type WorkerRequest =
  // The file is `bytes` (transferred, and handed back in the init result) or, from tests, `text`. `byteLength` is the text's UTF-8 size when
  // the sender knows it, which lets the worker skip checking for non-ASCII.
  | { type: "init"; requestId: number; text?: string; bytes?: Uint8Array; byteLength?: number; options: ParseOptionsMsg; floors?: RecordFloor[]; firstPage?: FirstPageRequest; tuning?: ParseTuning }
  // Parses the text the worker already holds under new options.
  | { type: "reparse"; requestId: number; options: ParseOptionsMsg; floors?: RecordFloor[]; firstPage?: FirstPageRequest; tuning?: ParseTuning }
  | { type: "query"; requestId: number; quickSearch: string; filterRules: FilterRule[]; sortKeys: SortKey[] }
  | { type: "page"; requestId: number; page: number; pageSize: number }
  | { type: "distinct"; requestId: number; column: string }
  // `expected` is the value the sender saw in the cell; the edit is refused if the cell holds something else now.
  | { type: "editCell"; requestId: number; rowId: number; columnIndex: number; value: string; expected?: string }
  | { type: "setCells"; requestId: number; cells: CellValue[]; verify?: RowBaseline[] }
  | { type: "rebase"; requestId: number; written?: WrittenRecord[] };

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
      // With more than MANY_COLUMNS columns this is empty and `profileVerdicts` carries what the profiles decide, a byte per column.
      columnProfiles: ColumnProfile[];
      profileVerdicts?: Uint8Array;
      quoting: boolean;
      // Absent while the file is still being parsed; `parseDone` follows.
      spansOk?: boolean;
      // Set while the rows after the first slice are still being parsed: `totalRows` and `headers` are those of the slices so far.
      parsing?: boolean;
      // The first page of the unsorted, unfiltered rows, when asked for and the rows so far fill it.
      firstPage?: { page: number; rows: WorkerRow[] };
      // The bytes an `init` carried, handed back (the same view over the same transferred buffer).
      bytes?: Uint8Array;
    }
  | {
      type: "parseDone";
      requestId: number;
      totalRows: number;
      quoteProblems: { row: number }[];
      spansOk: boolean;
      // The slices were abandoned for a whole-text parse, so rows already sent may differ.
      rebuilt: boolean;
      // Present when the headers (or what the profiles saw) changed since the init result: a ragged file's widest row came later.
      headers?: string[];
      columnProfiles?: ColumnProfile[];
      profileVerdicts?: Uint8Array;
    }
  | { type: "queryStarted"; requestId: number }
  | { type: "filterDone"; requestId: number }
  | { type: "queryResult"; requestId: number; filteredCount: number }
  | { type: "pageResult"; requestId: number; rows: WorkerRow[] }
  | { type: "distinctResult"; requestId: number; column: string; values: DistinctValue[]; truncated: boolean }
  | { type: "editResult"; requestId: number; ok: true; change: CellChange | null }
  | { type: "editResult"; requestId: number; ok: false; reason: string; stale?: boolean }
  | { type: "setCellsDone"; requestId: number; rejectedRowIds: number[] }
  | { type: "rebased"; requestId: number; patches: TextPatch[]; bytePatches: ByteReplacement[] }
  | { type: "workerError"; requestId: number; message: string };

export const REGEX_TIMEOUT_MS = 2000;

export const WORKING_INDICATOR_DELAY_MS = 150;
