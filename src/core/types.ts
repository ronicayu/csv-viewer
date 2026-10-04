export interface ParseResult {
  headers: string[];
  rows: string[][];
  delimiter: string;
  quoteProblems: { row: number }[];
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
  | "lte"
  | "in";

export type FilterMode = "include" | "exclude";

export interface FilterRule {
  id: string;
  column: string | null;
  operator: FilterOperator;
  value: string;
  // Optional because state saved before the "in" operator existed lacks it.
  values?: string[];
  mode: FilterMode;
  caseSensitive: boolean;
  enabled: boolean;
}

export type SortDirection = "asc" | "desc";

export interface SortKey {
  column: string;
  direction: SortDirection;
}

// Access only through the __proto__-safe helpers in columns.ts, never map[header].
export interface ColumnFlagMap {
  [column: string]: boolean;
}

export type ColumnVisibilityMap = ColumnFlagMap;

export interface ViewState {
  columnVisibility: ColumnVisibilityMap;
  filterRules: FilterRule[];
  quickSearch: string;
  sortKeys: SortKey[];
  firstRowIsHeader: boolean;
  pageSize: number;
  delimiter: string;
  quotes: boolean;
  markdownColumns: ColumnFlagMap;
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
    quotes: true,
    markdownColumns: {},
  };
}

export interface LoadMessage {
  type: "load";
  fileKey: string;
  // Unparsed on purpose: the webview parses it, so a large file crosses postMessage once as one string.
  text: string;
  state: ViewState;
  defaultTableColumns: number;
  defaultDelimiter: string;
  hintsSeen: string[];
  testHooks?: boolean;
}

export interface FileDeletedMessage {
  type: "fileDeleted";
  name: string;
}

export interface FileRestoredMessage {
  type: "fileRestored";
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

export interface HintSeenMessage {
  type: "hintSeen";
  id: string;
}

export interface RenderedMessage {
  type: "rendered";
  rowCount: number;
  headers: string[];
}

export type HostToWebviewMessage = LoadMessage | FileDeletedMessage | FileRestoredMessage;
export type WebviewToHostMessage = ReadyMessage | SaveStateMessage | OpenAsTextMessage | HintSeenMessage | RenderedMessage;
