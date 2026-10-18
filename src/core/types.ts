import type { Eol } from "./recordSpans";

export interface ParseResult {
  headers: string[];
  rows: string[][];
  delimiter: string;
  quoteProblems: { row: number }[];
  quoting: boolean;
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

export type ReadOnlyReason = "setting" | "encoding" | "filesystem" | "spans";

export interface RecordInfo {
  charStart: number;
  charEnd: number;
  byteStart: number;
  byteEnd: number;
  eol: Eol;
  fieldCount: number;
  originalText: string;
  // The record's baseline fields, before padding to the header width.
  originalFields: string[];
}

export interface CellChange {
  rowId: number;
  recordIndex: number;
  columnIndex: number;
  // Display name only, for the undo stack's label; the host never parses headers.
  column: string;
  oldValue: string;
  newValue: string;
  record: RecordInfo;
  format: { delimiter: string; quoting: boolean };
}

export interface PendingRecordEdit {
  recordIndex: number;
  originalFields: string[];
  fields: string[];
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
  baseVersion: number;
  editable: boolean;
  readOnlyReason?: ReadOnlyReason;
  pendingEdits: PendingRecordEdit[];
}

export interface FileDeletedMessage {
  type: "fileDeleted";
  name: string;
}

export interface FileRestoredMessage {
  type: "fileRestored";
}

export interface FileChangedOnDiskMessage {
  type: "fileChangedOnDisk";
  name: string;
}

export interface SetEditableMessage {
  type: "setEditable";
  editable: boolean;
  readOnlyReason?: ReadOnlyReason;
}

export interface AppliedCell {
  rowId: number;
  columnIndex: number;
  value: string;
  // The baseline value, so the webview can set or clear the unsaved mark without asking the worker.
  original: string;
}

export interface ApplyEditsMessage {
  type: "applyEdits";
  baseVersion: number;
  // Which stack operation this is, for the screen-reader announcement.
  kind?: "undo" | "redo";
  cells: AppliedCell[];
}

// What the host actually wrote for each record, so the webview rebases to the saved file even if edits landed during the write.
export interface WrittenRecord {
  recordIndex: number;
  fields: string[];
}

export interface SavedMessage {
  type: "saved";
  baseVersion: number;
  // Absent means everything the webview has edited was written.
  written?: WrittenRecord[];
}

export interface FlushEditsMessage {
  type: "flushEdits";
  baseVersion: number;
}

export interface TestEditCellMessage {
  type: "testEditCell";
  rowId: number;
  columnIndex: number;
  value: string;
}

export interface TestOpenEditorMessage {
  type: "testOpenEditor";
  rowId: number;
  columnIndex: number;
}

export interface TestGetCellMessage {
  type: "testGetCell";
  rowId: number;
  columnIndex: number;
}

export interface TestPressKeyMessage {
  type: "testPressKey";
  key: string;
  // Ctrl, or Cmd on macOS.
  primary?: boolean;
  shift?: boolean;
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

export interface EditMessage {
  type: "edit";
  baseVersion: number;
  change: CellChange;
}

export interface RevertMessage {
  type: "revert";
}

export interface FlushedMessage {
  type: "flushed";
  baseVersion: number;
}

export interface SyncedMessage {
  type: "synced";
  baseVersion: number;
}

export interface ResyncMessage {
  type: "resync";
}

// Sent when restored edits no longer match the file's records, so the host forgets them.
export interface EditsDroppedMessage {
  type: "editsDropped";
  recordIndexes: number[];
}

export interface TestCellValueMessage {
  type: "testCellValue";
  rowId: number;
  columnIndex: number;
  value: string | null;
  edited: boolean;
}

export type HostToWebviewMessage =
  | LoadMessage
  | FileDeletedMessage
  | FileRestoredMessage
  | FileChangedOnDiskMessage
  | SetEditableMessage
  | ApplyEditsMessage
  | SavedMessage
  | FlushEditsMessage
  | TestEditCellMessage
  | TestOpenEditorMessage
  | TestGetCellMessage
  | TestPressKeyMessage;

export type WebviewToHostMessage =
  | ReadyMessage
  | SaveStateMessage
  | OpenAsTextMessage
  | HintSeenMessage
  | RenderedMessage
  | EditMessage
  | RevertMessage
  | FlushedMessage
  | SyncedMessage
  | ResyncMessage
  | EditsDroppedMessage
  | TestCellValueMessage;
