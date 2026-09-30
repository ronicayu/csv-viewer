// Shared types for parsing, filtering, sorting, and column state. No vscode
// or DOM imports here — this module (and the rest of src/core) is pure logic
// shared by the extension host and the webview bundle.

export interface ParseResult {
  headers: string[];
  rows: string[][];
  delimiter: string;
}

export type FilterOperator =
  | "contains"
  | "equals"
  | "startsWith"
  | "endsWith"
  | "regex"
  | "isEmpty"
  | "gt"
  | "lt"
  | "gte"
  | "lte";

export type FilterMode = "include" | "exclude";

export interface FilterRule {
  id: string;
  /** null means "(any column)" */
  column: string | null;
  operator: FilterOperator;
  value: string;
  mode: FilterMode;
  caseSensitive: boolean;
  enabled: boolean;
}

export type SortDirection = "asc" | "desc";

export interface SortKey {
  column: string;
  direction: SortDirection;
}

export interface ColumnVisibilityMap {
  [column: string]: boolean;
}

export interface ViewState {
  columnVisibility: ColumnVisibilityMap;
  filterRules: FilterRule[];
  quickSearch: string;
  sortKeys: SortKey[];
  firstRowIsHeader: boolean;
  /** Rows per page. Persisted; the current page number is not. A
   * missing/invalid value (state saved before pagination existed) is
   * normalized to 100 via core/paging's normalizePageSize. */
  pageSize: number;
  /**
   * Per-file separator choice. `""` means auto-detect. Stored values from
   * before this field existed lack it entirely — treated the same as `""`
   * (normalized in the webview on load).
   */
  delimiter: string;
}

export function createDefaultViewState(): ViewState {
  return {
    columnVisibility: {},
    filterRules: [],
    quickSearch: "",
    sortKeys: [],
    firstRowIsHeader: true,
    pageSize: 100,
    delimiter: "",
  };
}

// Messages exchanged between the extension host and the webview.

export interface LoadMessage {
  type: "load";
  fileKey: string;
  /** The whole document text, unparsed — parsing happens in the webview
   * (see docs/spec.md's Architecture section) so a large file is only
   * serialized across the postMessage boundary once, as a single string,
   * instead of parsed twice on the host and shipped as `string[][]`. */
  text: string;
  state: ViewState;
  defaultTableColumns: number;
  /** Delimiter to use when `state.delimiter` is `""` (auto): `"\t"` for
   * .tsv/.tab files, otherwise `""` (meaning fall through to real
   * auto-detection in parseCsv). */
  defaultDelimiter: string;
  /** TEST HOOK (see extension.ts / main.ts "BEGIN TEST HOOK" blocks): only
   * ever `true` when the extension host activated with
   * `CSV_VIEWER_TEST_HOOKS=1`. Tells the webview to also emit
   * `RenderedMessage`s so the integration suite can observe render
   * completion. Omitted (falsy) in every normal run. */
  testHooks?: boolean;
}

export interface ReadyMessage {
  type: "ready";
}

export interface SaveStateMessage {
  type: "saveState";
  state: ViewState;
}

export interface OpenAsTextMessage {
  type: "openAsText";
}

/** TEST HOOK: posted by the webview after each render, only when `load` was
 * flagged with `testHooks: true`. Never sent otherwise. */
export interface RenderedMessage {
  type: "rendered";
  rowCount: number;
  headers: string[];
}

export type HostToWebviewMessage = LoadMessage;
export type WebviewToHostMessage = ReadyMessage | SaveStateMessage | OpenAsTextMessage | RenderedMessage;
