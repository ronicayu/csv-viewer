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
}

export function createDefaultViewState(): ViewState {
  return {
    columnVisibility: {},
    filterRules: [],
    quickSearch: "",
    sortKeys: [],
    firstRowIsHeader: true,
  };
}

// Messages exchanged between the extension host and the webview.

export interface LoadMessage {
  type: "load";
  fileKey: string;
  headers: string[];
  rows: string[][];
  state: ViewState;
  defaultTableColumns: number;
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

export type HostToWebviewMessage = LoadMessage;
export type WebviewToHostMessage = ReadyMessage | SaveStateMessage | OpenAsTextMessage;
