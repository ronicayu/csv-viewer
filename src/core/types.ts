// Shared types for parsing, filtering, sorting, and column state. No vscode
// or DOM imports here — this module (and the rest of src/core) is pure logic
// shared by the extension host and the webview bundle.

export interface ParseResult {
  headers: string[];
  rows: string[][];
  delimiter: string;
  /**
   * Data-row numbers (1-based, as the user sees them in the table) where
   * Papa reported a quote-related parse error (InvalidQuotes/MissingQuotes
   * etc.). Capped at the
   * first ~20. Empty when `quotes` parsing was off (see ParseOptions) or
   * when nothing looked malformed.
   */
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
  /**
   * Whether `"` opens a quoted field. Default (and normalized fallback for
   * stored state saved before this field existed) is `true`. When `false`,
   * every `"` in the file is literal text — a workaround for a file whose
   * quoting is malformed enough that Papa Parse merges rows together (see
   * ParseResult.quoteProblems and the "Quoted fields" toolbar checkbox).
   */
  quotes: boolean;
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
  /**
   * Ids of per-user hints the webview should treat as already-dismissed
   * (e.g. a one-time "N more columns are in each row's details" callout),
   * sourced from the host's globalState key `csvViewer.hintsSeen` — so a
   * hint dismissed once never comes back, in any file, even after
   * restarting the editor. The webview is the one deciding which hint ids
   * exist and when to show them; the host only persists the set it's told
   * about via HintSeenMessage.
   */
  hintsSeen: string[];
  /** TEST HOOK (see extension.ts / main.ts "BEGIN TEST HOOK" blocks): only
   * ever `true` when the extension host activated with
   * `CSV_VIEWER_TEST_HOOKS=1`. Tells the webview to also emit
   * `RenderedMessage`s so the integration suite can observe render
   * completion. Omitted (falsy) in every normal run. */
  testHooks?: boolean;
}

/**
 * Posted when the watched file is deleted on disk (after the usual
 * atomic-save grace period confirms it's actually gone, not just a
 * delete+recreate). The webview ignores unknown message types today, so
 * adding this is safe for a webview build that predates it. `name` is the
 * file's basename, matching the host's toast wording.
 */
export interface FileDeletedMessage {
  type: "fileDeleted";
  name: string;
}

/** Posted when a file previously reported via FileDeletedMessage reappears
 * on disk and has just been reloaded. */
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

/** Sent by the webview the first time a per-user hint (identified by a
 * stable id the webview chooses) is seen/dismissed, so the host can
 * remember it in globalState (`csvViewer.hintsSeen`) and include it in
 * every future `load` message's `hintsSeen` list. */
export interface HintSeenMessage {
  type: "hintSeen";
  id: string;
}

/** TEST HOOK: posted by the webview after each render, only when `load` was
 * flagged with `testHooks: true`. Never sent otherwise. */
export interface RenderedMessage {
  type: "rendered";
  rowCount: number;
  headers: string[];
}

export type HostToWebviewMessage = LoadMessage | FileDeletedMessage | FileRestoredMessage;
export type WebviewToHostMessage = ReadyMessage | SaveStateMessage | OpenAsTextMessage | HintSeenMessage | RenderedMessage;
