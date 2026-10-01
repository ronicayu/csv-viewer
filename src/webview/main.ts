// CSV Viewer webview client. Vanilla TypeScript + DOM, no framework and no
// runtime dependencies. Receives the raw document text from the extension
// host and owns filtering, sorting, column visibility, and pagination.
//
// Parsing, filtering, and sorting run in a dedicated Web Worker
// (worker.ts), never on this (the main/UI) thread — see docs/spec.md's
// "Performance / Worker architecture" section. This file owns:
//   - creating/recreating the worker (via a Blob URL — a webview can't
//     load a vscode-resource: URL directly as a Worker script) and
//     talking to it (init/query/page request-response, with request ids
//     so a stale response can be dropped);
//   - the regex-timeout watchdog (terminate + respawn the worker if a
//     query containing an enabled regex rule doesn't answer in time);
//   - all DOM rendering, always from the worker's last answers — the
//     worker owns the full parsed/filtered/sorted data; this thread only
//     ever holds small summaries (headers, counts) plus the current
//     page's rows (with FULL, untruncated cell values — truncation is a
//     render-time-only concern, see src/core/truncate.ts).

import { isRuleActive, isValidRule, regexErrorMessage } from "../core/filter";
import { cycleSortForColumn } from "../core/sort";
import { detailOnlyColumns, getVisibility, reconcileVisibility, setVisibility, visibleColumns } from "../core/columns";
import { PAGE_SIZES, clampPage, normalizePageSize, pageCount, pageForRow, pageSlice } from "../core/paging";
import { DETAIL_WARN_CHARS, truncateForDetail, truncateForTable } from "../core/truncate";
import type {
  ColumnVisibilityMap,
  FilterMode,
  FilterOperator,
  FilterRule,
  HostToWebviewMessage,
  ViewState,
  WebviewToHostMessage,
  LoadMessage,
  FileDeletedMessage,
} from "../core/types";
import { REGEX_TIMEOUT_MS, WORKING_INDICATOR_DELAY_MS } from "./workerProtocol";
import type { ParseOptionsMsg, WorkerRequest, WorkerResponse, WorkerRow } from "./workerProtocol";

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewToHostMessage): void;
  setState(state: unknown): void;
  getState(): unknown;
};

const vscode = acquireVsCodeApi();

const SEARCH_DEBOUNCE_MS = 150;
const SEPARATOR_DEBOUNCE_MS = 300;
const FILTER_RULE_DEBOUNCE_MS = 150;

/** Presets for the "Separator" toolbar dropdown, in display order. Tab is
 * labeled with the word "Tab" rather than a literal tab character. */
const PRESET_DELIMITERS: { value: string; label: string }[] = [
  { value: ",", label: "Comma (,)" },
  { value: ";", label: "Semicolon (;)" },
  { value: "\t", label: "Tab" },
  { value: "|", label: "Pipe (|)" },
];
const CUSTOM_SENTINEL = "custom";

function delimiterDisplay(d: string): string {
  return d === "\t" ? "Tab" : d;
}

interface AppState {
  fileKey: string;
  /** The whole document text, held onto so the "first row is header"
   * toggle and separator changes can re-parse (in the worker) locally,
   * without a host round-trip. */
  text: string;
  /** `"\t"` for .tsv/.tab, else `""` — the delimiter to fall back to when
   * `view.delimiter` is `""` (auto). */
  defaultDelimiter: string;
  headers: string[];
  /** Total row count from the worker's last parse (before filtering). */
  totalRows: number;
  view: ViewState;
  defaultTableColumns: number;
  expanded: Set<number>;
  /** Row count after the last filter query — NOT the page size. */
  filteredCount: number;
  /** 1-based. Not persisted — only pageSize is. */
  page: number;
  /** Full (untruncated) rows for exactly the current page, as last
   * returned by the worker. Rendering (table cell / detail view)
   * truncates from these; quick-add and other consumers of the "real"
   * value always read from here too. */
  currentPageRows: WorkerRow[];
  /** The delimiter the worker's parseCsv actually used on the last parse
   * — shown in the "Auto (…)" option even when it was forced by
   * defaultDelimiter rather than truly auto-detected. */
  detectedDelimiter: string;
  /** Data-row numbers where the last parse found a quote problem (see
   * ParseResult.quoteProblems); drives the warning banner. */
  quoteProblems: { row: number }[];
  /** The warning banner is dismissible per-parse: reset to false on every
   * fresh parse (load or reparseFromText) so a *new* quote problem is
   * surfaced again even if the user dismissed an earlier one. */
  quoteBannerDismissed: boolean;
  /** Enabled regex rules whose last query attempt didn't answer within
   * REGEX_TIMEOUT_MS — ignored the same way an invalid regex is ignored
   * (see isRuleActive), and shown with a "Regex too slow" hint in the
   * filter panel, until the rule's value is edited. */
  timedOutRuleIds: Set<string>;
  /** TEST HOOK: mirrors `message.testHooks` from the last `load`. See the
   * "BEGIN TEST HOOK" block below. */
  testHooksEnabled: boolean;
  /** Per-user hint ids already dismissed/seen (see HintSeenMessage) — the
   * host's copy, echoed on every `load`, plus any id this session itself
   * just dismissed (so it doesn't flash back on a reload before the host's
   * next `load` catches up). */
  hintsSeen: Set<string>;
  /** Basename of the file currently reported deleted-on-disk via
   * `FileDeletedMessage`, or null. Cleared on `fileRestored` or the next
   * `load`. */
  fileDeletedName: string | null;
}

let state: AppState | null = null;
let searchDebounceHandle: number | undefined;

// ---- DOM skeleton -----------------------------------------------------

const app = document.getElementById("app")!;
app.innerHTML = `
  <div class="toolbar">
    <input id="quick-search" type="search" placeholder="Search all columns…" aria-label="Search all columns" />
    <button id="columns-btn" type="button" class="toolbar-text-btn" aria-haspopup="dialog" aria-expanded="false" aria-controls="columns-popover">Columns</button>
    <button id="filters-btn" type="button" class="toolbar-text-btn" aria-haspopup="dialog" aria-expanded="false" aria-controls="filter-panel">Filters</button>
    <button id="sort-btn" type="button" class="toolbar-text-btn" aria-haspopup="dialog" aria-expanded="false" aria-controls="sort-popover">Sort</button>
    <button id="expand-collapse-btn" type="button" class="icon-btn" title="Expand all rows on this page" aria-label="Expand all rows on this page"><span class="codicon codicon-expand-all" aria-hidden="true"></span></button>
    <button id="format-btn" type="button" class="icon-btn" aria-haspopup="dialog" aria-expanded="false" aria-controls="format-popover" title="File format" aria-label="File format"><span class="codicon codicon-settings-gear" aria-hidden="true"></span></button>
    <button id="open-as-text-btn" type="button" class="icon-btn" title="Open as Text" aria-label="Open as Text"><span class="codicon codicon-go-to-file" aria-hidden="true"></span></button>
  </div>
  <div id="working-indicator" class="working-indicator" hidden></div>
  <div id="file-deleted-banner" class="banner banner-warning" role="alert" hidden>
    <span class="codicon codicon-warning" aria-hidden="true"></span>
    <span id="file-deleted-text" class="banner-text"></span>
  </div>
  <div id="quote-warning-banner" class="banner banner-warning" role="alert" hidden>
    <span class="codicon codicon-warning" aria-hidden="true"></span>
    <span id="quote-warning-text" class="banner-text"></span>
    <button id="quote-warning-fix-btn" type="button" class="primary">Read Quotes as Plain Text</button>
    <button id="quote-warning-dismiss-btn" type="button" class="icon-btn" aria-label="Dismiss"><span class="codicon codicon-close" aria-hidden="true"></span></button>
  </div>
  <div id="hint-rowdetails-banner" class="banner banner-info" hidden>
    <span class="codicon codicon-info" aria-hidden="true"></span>
    <span id="hint-rowdetails-text" class="banner-text"></span>
    <button id="hint-rowdetails-dismiss-btn" type="button" class="icon-btn" aria-label="Dismiss"><span class="codicon codicon-close" aria-hidden="true"></span></button>
  </div>
  <div id="filtered-row" class="filtered-row" hidden>
    <span id="filtered-row-text"></span>
    <button id="filtered-clear-search-btn" type="button" hidden>Clear Search</button>
    <button id="filtered-turn-off-filters-btn" type="button" hidden>Turn Off Filters</button>
  </div>
  <div id="status-bar" class="visually-hidden" role="status"></div>
  <div id="columns-popover" class="popover" role="dialog" aria-label="Columns" hidden>
    <p class="popover-legend">Unchecked columns appear in row details.</p>
    <input id="columns-search" type="search" placeholder="Filter columns…" aria-label="Filter columns" />
    <div class="popover-actions">
      <button id="columns-show-all" type="button">All in Table</button>
      <button id="columns-hide-all" type="button">All in Details</button>
    </div>
    <div id="columns-list" class="columns-list"></div>
  </div>
  <div id="filter-panel" class="panel" role="dialog" aria-label="Filters" hidden>
    <p class="filter-panel-hint">Rows must match all rules.</p>
    <div id="filter-rules"></div>
    <p id="filter-panel-tip" class="filter-panel-hint" hidden>Tip: right-click any cell to filter by its value.</p>
    <button id="add-rule-btn" type="button">Add Rule</button>
  </div>
  <div id="sort-popover" class="popover" role="dialog" aria-label="Sort" hidden>
    <div id="sort-keys-list" class="sort-keys-list"></div>
    <div class="sort-add-row">
      <select id="sort-add-select" aria-label="Add sort column"></select>
    </div>
    <button id="sort-clear-btn" type="button" hidden>Clear Sort</button>
  </div>
  <div id="format-popover" class="popover" role="dialog" aria-label="File format" hidden>
    <label class="separator-label">Separator
      <select id="separator-select" aria-label="Separator"></select>
    </label>
    <input id="separator-custom" type="text" maxlength="5" placeholder="e.g. ||" aria-label="Custom separator" aria-describedby="separator-custom-error" hidden />
    <span id="separator-custom-error" class="rule-error-text" hidden></span>
    <label class="header-toggle-label">
      <input id="first-row-header" type="checkbox" checked />
      First row is header
    </label>
    <label class="quotes-toggle-label">
      <input id="quotes-checkbox" type="checkbox" checked />
      Quoted fields
    </label>
    <p class="quotes-explain">Treat "…" as quoting. Turn off if quotes in your data are literal text.</p>
  </div>
  <div id="table-scroll" class="table-scroll">
    <table id="table">
      <thead id="table-head"></thead>
      <tbody id="table-body"></tbody>
    </table>
  </div>
  <div id="pager-bar" class="pager-bar">
    <button id="pager-first-btn" type="button" class="icon-btn" title="First page" aria-label="First page"><span class="codicon codicon-chevron-left" aria-hidden="true"></span></button>
    <button id="pager-prev-btn" type="button" class="icon-btn" title="Previous page (Alt+←)" aria-label="Previous page"><span class="codicon codicon-chevron-left" aria-hidden="true"></span></button>
    <span class="pager-page-label">Page
      <input id="pager-page-input" type="number" min="1" step="1" aria-label="Page number" />
      of <span id="pager-page-count">1</span>
    </span>
    <button id="pager-next-btn" type="button" class="icon-btn" title="Next page (Alt+→)" aria-label="Next page"><span class="codicon codicon-chevron-right" aria-hidden="true"></span></button>
    <button id="pager-last-btn" type="button" class="icon-btn" title="Last page" aria-label="Last page"><span class="codicon codicon-chevron-right" aria-hidden="true"></span></button>
    <span id="pager-row-range" class="pager-row-range"></span>
    <label class="pager-size-label">Rows per page
      <select id="pager-page-size-select" aria-label="Rows per page"></select>
    </label>
  </div>
  <div id="context-menu" class="context-menu" role="menu" hidden></div>
`;

const quickSearchInput = document.getElementById("quick-search") as HTMLInputElement;
const columnsBtn = document.getElementById("columns-btn") as HTMLButtonElement;
const filtersBtn = document.getElementById("filters-btn") as HTMLButtonElement;
const sortBtn = document.getElementById("sort-btn") as HTMLButtonElement;
const expandCollapseBtn = document.getElementById("expand-collapse-btn") as HTMLButtonElement;
const expandCollapseIcon = expandCollapseBtn.querySelector(".codicon") as HTMLSpanElement;
const formatBtn = document.getElementById("format-btn") as HTMLButtonElement;
const firstRowHeaderCheckbox = document.getElementById("first-row-header") as HTMLInputElement;
const separatorSelect = document.getElementById("separator-select") as HTMLSelectElement;
const separatorCustomInput = document.getElementById("separator-custom") as HTMLInputElement;
const separatorCustomError = document.getElementById("separator-custom-error") as HTMLSpanElement;
const quotesCheckbox = document.getElementById("quotes-checkbox") as HTMLInputElement;
const quoteWarningBanner = document.getElementById("quote-warning-banner") as HTMLDivElement;
const quoteWarningText = document.getElementById("quote-warning-text") as HTMLSpanElement;
const quoteWarningFixBtn = document.getElementById("quote-warning-fix-btn") as HTMLButtonElement;
const quoteWarningDismissBtn = document.getElementById("quote-warning-dismiss-btn") as HTMLButtonElement;
const fileDeletedBanner = document.getElementById("file-deleted-banner") as HTMLDivElement;
const fileDeletedText = document.getElementById("file-deleted-text") as HTMLSpanElement;
const hintBanner = document.getElementById("hint-rowdetails-banner") as HTMLDivElement;
const hintText = document.getElementById("hint-rowdetails-text") as HTMLSpanElement;
const hintDismissBtn = document.getElementById("hint-rowdetails-dismiss-btn") as HTMLButtonElement;
const filteredRow = document.getElementById("filtered-row") as HTMLDivElement;
const filteredRowText = document.getElementById("filtered-row-text") as HTMLSpanElement;
const filteredClearSearchBtn = document.getElementById("filtered-clear-search-btn") as HTMLButtonElement;
const filteredTurnOffFiltersBtn = document.getElementById("filtered-turn-off-filters-btn") as HTMLButtonElement;
const openAsTextBtn = document.getElementById("open-as-text-btn") as HTMLButtonElement;
const columnsPopover = document.getElementById("columns-popover") as HTMLDivElement;
const columnsSearch = document.getElementById("columns-search") as HTMLInputElement;
const columnsShowAll = document.getElementById("columns-show-all") as HTMLButtonElement;
const columnsHideAll = document.getElementById("columns-hide-all") as HTMLButtonElement;
const columnsList = document.getElementById("columns-list") as HTMLDivElement;
const filterPanel = document.getElementById("filter-panel") as HTMLDivElement;
const filterRulesEl = document.getElementById("filter-rules") as HTMLDivElement;
const filterPanelTip = document.getElementById("filter-panel-tip") as HTMLParagraphElement;
const addRuleBtn = document.getElementById("add-rule-btn") as HTMLButtonElement;
const sortPopover = document.getElementById("sort-popover") as HTMLDivElement;
const sortKeysList = document.getElementById("sort-keys-list") as HTMLDivElement;
const sortAddSelect = document.getElementById("sort-add-select") as HTMLSelectElement;
const sortClearBtn = document.getElementById("sort-clear-btn") as HTMLButtonElement;
const formatPopover = document.getElementById("format-popover") as HTMLDivElement;
const statusBar = document.getElementById("status-bar") as HTMLDivElement;
const workingIndicator = document.getElementById("working-indicator") as HTMLDivElement;
const tableScroll = document.getElementById("table-scroll") as HTMLDivElement;
const tableEl = document.getElementById("table") as HTMLTableElement;
const tableHead = document.getElementById("table-head") as HTMLTableSectionElement;
const tableBody = document.getElementById("table-body") as HTMLTableSectionElement;
const contextMenu = document.getElementById("context-menu") as HTMLDivElement;
const pagerFirstBtn = document.getElementById("pager-first-btn") as HTMLButtonElement;
const pagerPrevBtn = document.getElementById("pager-prev-btn") as HTMLButtonElement;
const pagerNextBtn = document.getElementById("pager-next-btn") as HTMLButtonElement;
const pagerLastBtn = document.getElementById("pager-last-btn") as HTMLButtonElement;
const pagerPageInput = document.getElementById("pager-page-input") as HTMLInputElement;
const pagerPageCount = document.getElementById("pager-page-count") as HTMLSpanElement;
const pagerRowRange = document.getElementById("pager-row-range") as HTMLSpanElement;
const pagerPageSizeSelect = document.getElementById("pager-page-size-select") as HTMLSelectElement;

for (const size of PAGE_SIZES) {
  const option = document.createElement("option");
  option.value = String(size);
  option.textContent = String(size);
  pagerPageSizeSelect.appendChild(option);
}

// ---- Detail panel width (pinned to the visible scroll viewport) -----------
//
// A wide table scrolls horizontally inside #table-scroll; an expanded
// row's detail block is `position: sticky; left: 0` (see .detail-wrap in
// main.css) so it doesn't scroll sideways with it, but it still needs an
// explicit width to wrap prose *inside* what's actually visible rather
// than the table's full (scrolled) width. Kept in sync with
// #table-scroll's clientWidth via ResizeObserver — covers both window
// resizes and VS Code split-editor resizing, neither of which fires a
// plain `resize` event on `window`.
function updateDetailViewportWidth(): void {
  tableScroll.style.setProperty("--detail-viewport-w", `${tableScroll.clientWidth}px`);
}

if (typeof ResizeObserver !== "undefined") {
  const detailWidthObserver = new ResizeObserver(() => updateDetailViewportWidth());
  detailWidthObserver.observe(tableScroll);
} else {
  window.addEventListener("resize", updateDetailViewportWidth);
}
updateDetailViewportWidth();

// ---- Worker lifecycle ---------------------------------------------------
//
// The worker script can't be loaded from its vscode-resource/webview URI
// directly (workers can't fetch cross-scheme like that under the
// webview's CSP) — instead we fetch its *text* from that URI (allowed via
// `connect-src` in extension.ts's CSP) and load it from a `blob:` URL
// (allowed via `worker-src blob:`). The Playwright harness sets up an
// equivalent `data-worker-src` for the same code path to exercise (see
// harness.ts).

let worker: Worker | null = null;
let workerPromise: Promise<Worker> | null = null;
let workerBlobUrlPromise: Promise<string> | null = null;

async function getWorkerBlobUrl(): Promise<string> {
  if (!workerBlobUrlPromise) {
    workerBlobUrlPromise = (async () => {
      const src = app.dataset.workerSrc;
      if (!src) throw new Error("csv-viewer: #app is missing data-worker-src");
      const res = await fetch(src);
      const text = await res.text();
      const blob = new Blob([text], { type: "application/javascript" });
      return URL.createObjectURL(blob);
    })();
  }
  return workerBlobUrlPromise;
}

function createWorker(blobUrl: string): Worker {
  const w = new Worker(blobUrl);
  w.onmessage = handleWorkerMessage;
  return w;
}

/** Ensures a worker exists, creating it (once — concurrent callers share
 * the same in-flight creation) if needed. */
async function ensureWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = (async () => createWorker(await getWorkerBlobUrl()))();
  }
  worker = await workerPromise;
  return worker;
}

/** Replaces the current worker with a fresh one — used after terminating
 * a worker stuck in catastrophic regex backtracking. The blob URL itself
 * is already cached (its script never changes), so this resolves fast. */
async function respawnWorker(): Promise<Worker> {
  const blobUrl = await getWorkerBlobUrl();
  worker = createWorker(blobUrl);
  workerPromise = Promise.resolve(worker);
  return worker;
}

function postToWorker(message: WorkerRequest): void {
  worker?.postMessage(message);
}

// ---- Request bookkeeping (staleness guards + regex timeout) -----------

let nextRequestId = 1;
let pendingInitRequestId = -1;
let pendingInitIsFreshParse = true;
let latestQueryRequestId = -1;
let latestPageRequestId = -1;
let queryInFlight = false;
/** Set by an explicit page navigation that arrived while a query was
 * still in flight (e.g. clicking Next during a regex-timeout recovery) —
 * consumed by the next queryResult instead of `state.page`, so the UI
 * stays responsive to navigation even while the worker is busy/recovering. */
let pendingPageAfterQuery: number | null = null;

/** The canonical key (see buildQueryKey) of the last query actually SENT
 * to the worker — reset to null on every fresh `init`, since a new parse
 * invalidates whatever the worker's cached view meant before. Used by
 * runQuery to skip sending a redundant query when nothing that would
 * change the filtered/sorted result actually changed (e.g. an
 * inactive filter-rule edit). */
let lastQueryKey: string | null = null;

/**
 * requestId -> the rules sent with that query, tracked only for requests
 * that contain an enabled, syntactically-valid regex rule (i.e. ones "at
 * risk" of catastrophic backtracking). The actual per-request 2s watchdog
 * timer only starts once the WORKER confirms (via `queryStarted`) that it
 * has actually begun running that request's `applyFilters` — never from
 * when the request was merely sent — so a request that's simply queued
 * behind an earlier one (or behind a slow sort afterward — the watchdog
 * is disarmed by `filterDone`, before sorting even starts) is never
 * falsely penalized for time it spent waiting its turn in the worker's
 * single-threaded mailbox. See onQueryStarted/onFilterDone below.
 */
let riskyRulesByRequestId = new Map<number, FilterRule[]>();
let regexWatchdogHandles = new Map<number, number>();

/** Clears every pending regex-watchdog timer and tracked request — called
 * on every fresh `init` (a new parse/worker makes any old requestId
 * meaningless) and defensively at the start of a timeout's own recovery
 * (so no *other* stale watchdog can fire mid-respawn and race it). */
function resetRegexWatchdogState(): void {
  for (const handle of regexWatchdogHandles.values()) window.clearTimeout(handle);
  regexWatchdogHandles.clear();
  riskyRulesByRequestId.clear();
}

function armRegexWatchdogIfRisky(requestId: number, rulesSent: FilterRule[]): void {
  const risky = rulesSent.some((r) => r.enabled && r.operator === "regex" && isValidRule(r));
  if (risky) riskyRulesByRequestId.set(requestId, rulesSent);
}

function onQueryStarted(requestId: number): void {
  const rulesSent = riskyRulesByRequestId.get(requestId);
  if (!rulesSent) return; // nothing risky about this particular request
  const handle = window.setTimeout(() => {
    regexWatchdogHandles.delete(requestId);
    riskyRulesByRequestId.delete(requestId);
    if (!state) return;
    void handleRegexTimeout(rulesSent);
  }, REGEX_TIMEOUT_MS);
  regexWatchdogHandles.set(requestId, handle);
}

function onFilterDone(requestId: number): void {
  const handle = regexWatchdogHandles.get(requestId);
  if (handle !== undefined) {
    window.clearTimeout(handle);
    regexWatchdogHandles.delete(requestId);
  }
  riskyRulesByRequestId.delete(requestId);
}

// ---- "Working…" indicator ----------------------------------------------
//
// Shown only once an interactive request (filter/sort/search/page change)
// has been in flight for a while — never during the initial `load`
// (which already shows "Loading…" in the status bar).

let operationToken = 0;
let workingTimerHandle: number | undefined;

function startOperation(): void {
  operationToken++;
  const token = operationToken;
  window.clearTimeout(workingTimerHandle);
  workingTimerHandle = window.setTimeout(() => {
    if (operationToken === token) {
      workingIndicator.hidden = false;
      tableEl.setAttribute("aria-busy", "true");
    }
  }, WORKING_INDICATOR_DELAY_MS);
}

function endOperation(): void {
  window.clearTimeout(workingTimerHandle);
  workingIndicator.hidden = true;
  tableEl.removeAttribute("aria-busy");
}

// ---- Messaging (extension host) -----------------------------------------

window.addEventListener("message", (event: MessageEvent<HostToWebviewMessage>) => {
  const message = event.data;
  if (message.type === "load") void onLoad(message);
  else if (message.type === "fileDeleted") onFileDeleted(message);
  else if (message.type === "fileRestored") onFileRestored();
});

/** Shows the "deleted from disk" banner (see docs/reviews/ux-review.md
 * P2-8) — cleared by `onFileRestored` or the next `load` (see onLoad). */
function onFileDeleted(message: FileDeletedMessage): void {
  if (!state) return;
  state.fileDeletedName = message.name;
  renderFileDeletedBanner();
}

function onFileRestored(): void {
  if (!state) return;
  state.fileDeletedName = null;
  renderFileDeletedBanner();
}

function renderFileDeletedBanner(): void {
  if (!state) return;
  const name = state.fileDeletedName;
  fileDeletedBanner.hidden = name === null;
  if (name !== null) fileDeletedText.textContent = `"${name}" was deleted from disk. Showing the last loaded copy.`;
}

vscode.postMessage({ type: "ready" });

/** Resolve the delimiter option to pass to parseCsv: the per-file stored
 * choice takes precedence, then the host's defaultDelimiter (tab for
 * .tsv/.tab), else undefined (real auto-detection inside parseCsv). */
function resolveDelimiterOption(stateDelimiter: string, defaultDelimiter: string): string | undefined {
  if (stateDelimiter !== "") return stateDelimiter;
  if (defaultDelimiter !== "") return defaultDelimiter;
  return undefined;
}

function sameColumnVisibility(a: ColumnVisibilityMap, b: ColumnVisibilityMap): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => getVisibility(a, k) === getVisibility(b, k));
}

/** Yield one frame so a "Loading…" placeholder actually paints before a
 * potentially expensive parse (in the worker) starts. */
function yieldFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

async function onLoad(message: LoadMessage): Promise<void> {
  const view = message.state;
  // Defense in depth: normalize fields that might be missing from state
  // saved before they existed (or a bare message a test pushes directly)
  // instead of silently misbehaving.
  view.pageSize = normalizePageSize(view.pageSize);
  view.delimiter = typeof view.delimiter === "string" ? view.delimiter : "";
  view.quotes = typeof view.quotes === "boolean" ? view.quotes : true;

  // A `load` for the same file the webview is already showing is a live
  // reload (the document changed on disk) — keep the current page instead
  // of jumping back to page 1. It gets clamped to the new page count once
  // the fresh query answers.
  const isReload = state !== null && state.fileKey === message.fileKey;
  const previousPage = isReload ? state!.page : 1;

  statusBar.textContent = "Loading…";
  await yieldFrame();
  await ensureWorker();

  state = {
    fileKey: message.fileKey,
    text: message.text,
    defaultDelimiter: message.defaultDelimiter,
    headers: [],
    totalRows: 0,
    view,
    defaultTableColumns: message.defaultTableColumns,
    expanded: new Set<number>(),
    filteredCount: 0,
    page: previousPage,
    currentPageRows: [],
    detectedDelimiter: "",
    quoteProblems: [],
    quoteBannerDismissed: false,
    timedOutRuleIds: new Set<string>(),
    testHooksEnabled: message.testHooks === true,
    hintsSeen: new Set<string>(message.hintsSeen ?? []),
    fileDeletedName: null,
  };
  renderFileDeletedBanner();
  firstRowHeaderCheckbox.checked = state.view.firstRowIsHeader;
  quotesCheckbox.checked = state.view.quotes;
  quickSearchInput.value = state.view.quickSearch;

  pendingPageAfterQuery = previousPage;
  const delimiterOption = resolveDelimiterOption(view.delimiter, message.defaultDelimiter);
  beginInit(message.text, { delimiter: delimiterOption, firstRowIsHeader: view.firstRowIsHeader, quotes: view.quotes }, true);
}

/**
 * Re-parse `state.text` (in the worker) with the current view options
 * (separator, "first row is header") without a host round-trip,
 * reconciling column visibility against the new headers once the worker
 * answers. Used by both the separator control, the "Quoted fields"
 * checkbox, and the "first row is header" toggle.
 */
function reparseFromText(options: { resetPage: boolean }): void {
  if (!state) return;
  const delimiterOption = resolveDelimiterOption(state.view.delimiter, state.defaultDelimiter);
  pendingPageAfterQuery = options.resetPage ? 1 : state.page;
  // Row identity is re-tokenized from scratch, so previously expanded rows
  // (tracked by id) no longer correspond to the same content — reset, same
  // as a live reload does. Done synchronously (not gated on the worker's
  // answer) since the old ids are meaningless the moment we decide to
  // re-parse.
  state.expanded = new Set<number>();
  beginInit(state.text, { delimiter: delimiterOption, firstRowIsHeader: state.view.firstRowIsHeader, quotes: state.view.quotes }, true);
}

function beginInit(text: string, options: ParseOptionsMsg, isFreshParse: boolean): void {
  const requestId = nextRequestId++;
  pendingInitRequestId = requestId;
  pendingInitIsFreshParse = isFreshParse;
  lastQueryKey = null; // a fresh parse invalidates whatever the worker's cached view meant before
  resetRegexWatchdogState();
  postToWorker({ type: "init", requestId, text, options });
}

// ---- Columns/Filters/Sort toolbar badges, hint banner, filtered-summary
// row ---------------------------------------------------------------------
//
// These reflect state while their popover is CLOSED (Columns N/total,
// Filters • N, Sort • N — see docs/reviews/ux-review.md §2's regroup
// sketch) and must never change the toolbar's height, so they're always
// plain text/attribute updates on already-laid-out elements, never a
// reflow-causing insertion.

function renderColumnsButton(): void {
  if (!state) return;
  const visible = visibleColumns(state.headers, state.view.columnVisibility).length;
  const total = state.headers.length;
  columnsBtn.textContent = `Columns ${visible}/${total}`;
  columnsBtn.title = `Columns in table: ${visible} of ${total}`;
}

/** Rules that are enabled AND currently active (per isRuleActive) AND not
 * timed out — the same "will this rule actually do anything" definition
 * buildQueryKey uses, so the badge never disagrees with what's filtered. */
function activeFilterRuleCount(): number {
  if (!state) return 0;
  return state.view.filterRules.filter((r) => r.enabled && isRuleActive(r, state!.headers) && !state!.timedOutRuleIds.has(r.id)).length;
}

function renderFiltersButton(): void {
  if (!state) return;
  const n = activeFilterRuleCount();
  filtersBtn.textContent = n > 0 ? `Filters • ${n}` : "Filters";
}

function renderSortButton(): void {
  if (!state) return;
  const n = state.view.sortKeys.length;
  sortBtn.textContent = n > 0 ? `Sort • ${n}` : "Sort";
}

function separatorWord(effectiveDelimiter: string): string {
  switch (effectiveDelimiter) {
    case ",":
      return "comma";
    case ";":
      return "semicolon";
    case "\t":
      return "tab";
    case "|":
      return "pipe";
    case "":
      return "comma";
    default:
      return `"${effectiveDelimiter}"`;
  }
}

/** The File format icon button's tooltip states the current format in
 * full (e.g. "File format: comma, first row is header, quoted fields
 * on") since the button itself carries no text. */
function renderFormatButton(): void {
  if (!state) return;
  const effective = resolveDelimiterOption(state.view.delimiter, state.defaultDelimiter) ?? state.detectedDelimiter;
  const sep = separatorWord(effective);
  const headerPart = state.view.firstRowIsHeader ? "first row is header" : "no header row";
  const quotesPart = state.view.quotes ? "quoted fields on" : "quoted fields off";
  const label = `File format: ${sep}, ${headerPart}, ${quotesPart}`;
  formatBtn.title = label;
  formatBtn.setAttribute("aria-label", label);
}

/** Row-details hint: id "rowDetails" — shown once, while at least one
 * column is detail-only and the id isn't in state.hintsSeen; dismissed
 * (or the first row expansion) hides it for good via markHintSeen. */
function renderHintBanner(): void {
  if (!state) return;
  const n = detailOnlyColumns(state.headers, state.view.columnVisibility).length;
  const show = n > 0 && !state.hintsSeen.has("rowDetails");
  hintBanner.hidden = !show;
  if (!show) return;
  hintText.textContent = `${n} more column${n === 1 ? "" : "s"} are in each row's details. Click a row's arrow to expand it, or change which with Columns.`;
}

/** Marks a per-user hint as seen: hides it, remembers it for the rest of
 * this session, and (once per id) tells the host so it's included in
 * every future `load`'s hintsSeen (see HintSeenMessage). */
function markHintSeen(id: string): void {
  if (!state || state.hintsSeen.has(id)) return;
  state.hintsSeen.add(id);
  vscode.postMessage({ type: "hintSeen", id });
  if (id === "rowDetails") renderHintBanner();
}

/** The slim "Filtered: X of Y rows" row under the toolbar — shown whenever
 * search or an active filter rule is in play, regardless of whether it
 * actually reduced the row count (the pager's own "(filtered from N)"
 * suffix is the one gated on an actual reduction — see renderPagerBar). */
function renderFilteredRow(): void {
  if (!state) return;
  const searchActive = state.view.quickSearch !== "";
  const filtersActive = activeFilterRuleCount() > 0;
  const show = searchActive || filtersActive;
  filteredRow.hidden = !show;
  if (!show) return;
  filteredRowText.textContent = `Filtered: ${state.filteredCount.toLocaleString()} of ${state.totalRows.toLocaleString()} rows`;
  filteredClearSearchBtn.hidden = !searchActive;
  filteredTurnOffFiltersBtn.hidden = !filtersActive;
}

filteredClearSearchBtn.addEventListener("click", () => {
  if (!state) return;
  quickSearchInput.value = "";
  state.view.quickSearch = "";
  requery();
  saveState();
});

filteredTurnOffFiltersBtn.addEventListener("click", () => {
  if (!state) return;
  for (const r of state.view.filterRules) r.enabled = false;
  renderFilterPanel();
  requery();
  saveState();
});

hintDismissBtn.addEventListener("click", () => markHintSeen("rowDetails"));

function newRuleId(): string {
  return `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function saveState(): void {
  if (!state) return;
  vscode.postMessage({ type: "saveState", state: state.view });
}

// ---- BEGIN TEST HOOK (CSV_VIEWER_TEST_HOOKS) ------------------------------
// Inert unless the host set `testHooks: true` on the `load` message (which
// only happens when the extension host activated with
// CSV_VIEWER_TEST_HOOKS=1 — see extension.ts). Lets the integration suite
// observe render completion without scraping the DOM.
function notifyRendered(): void {
  if (!state || !state.testHooksEnabled) return;
  vscode.postMessage({ type: "rendered", rowCount: state.filteredCount, headers: state.headers });
}

/** TEST HOOK: number of `query` messages actually sent to the worker so
 * far in this session, exposed on `window` so a Playwright spec can
 * assert that a given interaction (e.g. an inactive filter-rule edit —
 * see runQuery's no-op skip) sent none, or that a real change sent
 * exactly one. Written only when testHooksEnabled (set via `load`'s
 * `testHooks` flag — see harness.ts). */
function recordQuerySent(): void {
  if (!state || !state.testHooksEnabled) return;
  const w = window as unknown as { __workerQueryCount?: number };
  w.__workerQueryCount = (w.__workerQueryCount ?? 0) + 1;
}
// ---- END TEST HOOK ---------------------------------------------------------

// ---- Worker responses ----------------------------------------------------

function handleWorkerMessage(event: MessageEvent<WorkerResponse>): void {
  const msg = event.data;
  switch (msg.type) {
    case "initResult":
      onInitResult(msg);
      break;
    case "queryStarted":
      onQueryStarted(msg.requestId);
      break;
    case "filterDone":
      onFilterDone(msg.requestId);
      break;
    case "queryResult":
      onQueryResult(msg);
      break;
    case "pageResult":
      onPageResult(msg);
      break;
    case "workerError":
      // Defensive only — src/core's own tests (including a fast-check
      // property test) establish that applyFilters/sortRows/parseCsv never
      // throw for any input shape, so this should never actually fire.
      // eslint-disable-next-line no-console
      console.error("csv-viewer: worker error:", msg.message);
      break;
  }
}

function onInitResult(msg: { type: "initResult" } & WorkerResponse): void {
  if (!state) return;
  if (msg.requestId !== pendingInitRequestId) return; // superseded by a newer load/reparse

  state.headers = msg.headers;
  state.detectedDelimiter = msg.detectedDelimiter;
  state.quoteProblems = msg.quoteProblems;
  state.totalRows = msg.totalRows;
  if (pendingInitIsFreshParse) state.quoteBannerDismissed = false;

  const previousVisibility = state.view.columnVisibility;
  const reconciled = reconcileVisibility(msg.headers, previousVisibility, state.defaultTableColumns);
  const visibilityChanged = !sameColumnVisibility(previousVisibility, reconciled);
  state.view.columnVisibility = reconciled;

  renderColumnsPopover();
  renderColumnsButton();
  renderFilterPanel();
  renderSeparatorControl();
  renderFormatButton();
  renderQuoteWarningBanner();
  renderHintBanner();

  // Only write state back if reconciliation actually changed the stored
  // visibility map — a plain reopen of a file whose visibility is already
  // settled shouldn't cause a write on every open.
  if (visibilityChanged) saveState();

  continueAfterInit();
}

/** Sends the next query using the view's current quickSearch/filterRules/
 * sortKeys (with any timed-out regex rules excluded), for whatever just
 * finished happening on the init side (a load, a reparse, or a
 * regex-timeout recovery — all three need exactly this same follow-up). */
function continueAfterInit(): void {
  if (!state) return;
  runQuery();
}

function sendQueryNow(): { requestId: number; rulesSent: FilterRule[] } {
  if (!state) return { requestId: -1, rulesSent: [] };
  const rulesSent = state.view.filterRules.filter((r) => !state!.timedOutRuleIds.has(r.id));
  const requestId = nextRequestId++;
  postToWorker({ type: "query", requestId, quickSearch: state.view.quickSearch, filterRules: rulesSent, sortKeys: state.view.sortKeys });
  recordQuerySent();
  return { requestId, rulesSent };
}

/**
 * A stable-enough (same-process) canonical representation of "what would
 * actually change the filtered/sorted result": quick search, the
 * *active* filter rules (enabled, isRuleActive, not timed-out — reduced
 * to only their semantic fields) and sort keys. Two states that produce
 * the same key are guaranteed to produce the same worker result, so
 * runQuery uses this to skip sending a redundant query — e.g. adding an
 * empty rule, or picking its column/operator before it has a value,
 * never changes which rules are *active*, so the key doesn't change
 * either.
 */
function buildQueryKey(): string {
  if (!state) return "";
  const activeRules = state.view.filterRules
    .filter((r) => r.enabled && isRuleActive(r, state!.headers) && !state!.timedOutRuleIds.has(r.id))
    .map((r) => ({ column: r.column, operator: r.operator, value: r.value, mode: r.mode, caseSensitive: r.caseSensitive }));
  return JSON.stringify({ q: state.view.quickSearch, rules: activeRules, sort: state.view.sortKeys });
}

/**
 * Sends a fresh query unless nothing that actually affects the
 * filtered/sorted result changed since the last query actually sent
 * (see buildQueryKey) — in which case the worker's cached view is
 * already correct, and this only needs to fetch the desired page
 * without paying a full re-filter-and-re-sort of the whole dataset for
 * no reason. Shared by `continueAfterInit` (always sends — `beginInit`
 * reset `lastQueryKey` to null, which the key string can never equal)
 * and `requery` (interactive filter/sort/search changes).
 */
function runQuery(): void {
  if (!state) return;
  const key = buildQueryKey();
  if (key === lastQueryKey) {
    if (!queryInFlight) {
      const desired = pendingPageAfterQuery ?? state.page;
      pendingPageAfterQuery = null;
      state.page = clampPage(desired, state.filteredCount, state.view.pageSize);
      startOperation();
      const requestId = nextRequestId++;
      latestPageRequestId = requestId;
      postToWorker({ type: "page", requestId, page: state.page, pageSize: state.view.pageSize });
    }
    // else: a query for this exact key is already in flight (or queued
    // behind an earlier one); its own onQueryResult will consume
    // pendingPageAfterQuery once it answers — nothing more to do here.
    return;
  }
  lastQueryKey = key;
  startOperation();
  queryInFlight = true;
  const { requestId, rulesSent } = sendQueryNow();
  latestQueryRequestId = requestId;
  armRegexWatchdogIfRisky(requestId, rulesSent);
}

function onQueryResult(msg: { type: "queryResult" } & WorkerResponse): void {
  if (!state) return;
  if (msg.requestId !== latestQueryRequestId) return; // stale — a newer query has since been sent

  state.filteredCount = msg.filteredCount;
  const desired = pendingPageAfterQuery ?? state.page;
  pendingPageAfterQuery = null;
  state.page = clampPage(desired, state.filteredCount, state.view.pageSize);
  queryInFlight = false;

  const requestId = nextRequestId++;
  latestPageRequestId = requestId;
  postToWorker({ type: "page", requestId, page: state.page, pageSize: state.view.pageSize });
}

function onPageResult(msg: { type: "pageResult" } & WorkerResponse): void {
  if (!state) return;
  if (msg.requestId !== latestPageRequestId) return; // stale — a newer page/query has since been sent
  state.currentPageRows = msg.rows;
  finishRender();
}

/** The single point where a completed worker round-trip becomes visible
 * DOM — head, body, status bar, and pager bar always update together, so
 * anything a test polls for (a sort indicator, a row count, "Showing X of
 * Y rows"...) is only ever observed once every other part of the same
 * render has already settled too. */
function finishRender(): void {
  renderTableHead();
  renderSortButton();
  renderSortPopover();
  renderTableBody();
  renderExpandCollapseButton();
  renderStatusBar();
  renderPagerBar();
  renderFilteredRow();
  endOperation();
  notifyRendered();
}

// ---- Regex timeout watchdog ----------------------------------------------
//
// armRegexWatchdogIfRisky/onQueryStarted/onFilterDone/resetRegexWatchdogState
// live up in the "Request bookkeeping" section above, next to the state
// they manage.

async function handleRegexTimeout(rulesSent: FilterRule[]): Promise<void> {
  if (!state) return;
  resetRegexWatchdogState(); // no other stale watchdog can fire during the respawn below
  worker?.terminate();
  worker = null;

  for (const r of rulesSent) {
    if (r.enabled && r.operator === "regex" && isValidRule(r)) state.timedOutRuleIds.add(r.id);
  }
  renderFilterPanel(); // show "Regex too slow — rule disabled" immediately

  await respawnWorker();
  if (!state) return; // a load/dispose could have raced this
  const delimiterOption = resolveDelimiterOption(state.view.delimiter, state.defaultDelimiter);
  beginInit(state.text, { delimiter: delimiterOption, firstRowIsHeader: state.view.firstRowIsHeader, quotes: state.view.quotes }, false);
}

// ---- Table head ----------------------------------------------------------

function renderTableHead(): void {
  if (!state) return;
  const columns = visibleColumns(state.headers, state.view.columnVisibility);

  // Restore focus to the header button of the same column after this
  // function rebuilds the whole <tr> — otherwise a keyboard-only user
  // cycling a column's sort direction with repeated Space/Enter loses
  // focus after the very first press (see keyboard.spec.ts). Matched by
  // the column's label text (not DOM position), since visibility changes
  // can reorder/remove columns between renders.
  let previousFocusColumn: string | null = null;
  if (document.activeElement instanceof HTMLElement && tableHead.contains(document.activeElement)) {
    previousFocusColumn = document.activeElement.closest("th")?.dataset.column ?? null;
  }

  const tr = document.createElement("tr");

  const chevronTh = document.createElement("th");
  chevronTh.className = "chevron-col";
  tr.appendChild(chevronTh);

  for (const column of columns) {
    const th = document.createElement("th");
    th.className = "sortable";
    th.dataset.column = column;

    const keyIndex = state.view.sortKeys.findIndex((k) => k.column === column);
    const key = keyIndex !== -1 ? state.view.sortKeys[keyIndex] : undefined;
    th.setAttribute("aria-sort", key ? (key.direction === "asc" ? "ascending" : "descending") : "none");

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "col-header-btn";
    btn.title = "Sort. Shift+click to add a secondary sort";

    const label = document.createElement("span");
    label.textContent = column;
    btn.appendChild(label);

    if (key) {
      const indicator = document.createElement("span");
      indicator.className = "sort-indicator";
      const icon = document.createElement("span");
      icon.className = `codicon ${key.direction === "asc" ? "codicon-arrow-up" : "codicon-arrow-down"}`;
      icon.setAttribute("aria-hidden", "true");
      indicator.appendChild(icon);
      if (state.view.sortKeys.length > 1) {
        const priority = document.createElement("span");
        priority.className = "sort-priority";
        priority.setAttribute("aria-hidden", "true");
        priority.textContent = String(keyIndex + 1);
        indicator.appendChild(priority);
      }
      const srText = document.createElement("span");
      srText.className = "visually-hidden";
      srText.textContent =
        state.view.sortKeys.length > 1
          ? `sorted ${key.direction === "asc" ? "ascending" : "descending"}, priority ${keyIndex + 1}`
          : `sorted ${key.direction === "asc" ? "ascending" : "descending"}`;
      indicator.appendChild(srText);
      btn.appendChild(indicator);
    }

    btn.addEventListener("click", (ev) => onHeaderClick(column, ev.shiftKey));
    btn.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        onHeaderClick(column, ev.shiftKey);
      }
    });
    th.appendChild(btn);
    tr.appendChild(th);
  }

  tableHead.innerHTML = "";
  tableHead.appendChild(tr);

  if (previousFocusColumn !== null) {
    const th = tr.querySelector<HTMLTableCellElement>(`th.sortable[data-column="${CSS.escape(previousFocusColumn)}"]`);
    th?.querySelector<HTMLButtonElement>(".col-header-btn")?.focus();
  }
}

function onHeaderClick(column: string, shiftKey: boolean): void {
  if (!state) return;
  state.view.sortKeys = cycleSortForColumn(state.view.sortKeys, column, shiftKey);
  requery();
  saveState();
}

// ---- Table body (one page at a time) --------------------------------------

/** Tracks the pointer position at `mousedown` on a data row, so the click
 * handler can tell a plain click from the tail end of a text-selection
 * drag (see onRowClick). Reset on every mousedown. */
let rowMouseDownPos: { x: number; y: number } | null = null;

function onRowMouseDown(ev: MouseEvent): void {
  rowMouseDownPos = { x: ev.clientX, y: ev.clientY };
}

/** A row click must not toggle the row when the user was actually
 * selecting text: ignore the click if a selection exists anywhere (e.g.
 * finishing a drag-select, or the word a double-click just selected), or
 * if the pointer moved more than 4px between mousedown and click (a drag,
 * even one that ends without a surviving selection). */
function onRowClick(ev: MouseEvent, rowId: number): void {
  const selection = window.getSelection();
  if (selection && selection.toString() !== "") return;
  if (rowMouseDownPos) {
    const dx = ev.clientX - rowMouseDownPos.x;
    const dy = ev.clientY - rowMouseDownPos.y;
    if (Math.hypot(dx, dy) > 4) return;
  }
  toggleExpanded(rowId);
}

function renderTableBody(): void {
  if (!state) return;
  tableBody.innerHTML = "";
  const columns = visibleColumns(state.headers, state.view.columnVisibility);
  const fragment = document.createDocumentFragment();

  if (state.totalRows === 0) {
    fragment.appendChild(buildEmptyStateRow(columns.length + 1, "zero-file"));
  } else if (state.filteredCount === 0) {
    fragment.appendChild(buildEmptyStateRow(columns.length + 1, "zero-matches"));
  } else {
    // All columns hidden: the data rows (and their arrows) still render —
    // expanding a row is still how you read it — but a banner above them
    // explains where the columns went and offers the fix, instead of
    // leaving a table of anonymous arrows with no context.
    if (columns.length === 0) fragment.appendChild(buildEmptyStateRow(1, "all-hidden"));
    for (const row of state.currentPageRows) {
      fragment.appendChild(buildRowTr(row, columns));
      fragment.appendChild(buildDetailTr(row, columns.length + 1));
    }
  }

  tableBody.appendChild(fragment);
  updateDetailViewportWidth();
  populateExpandedDetails(columns);
}

function buildEmptyStateRow(colSpan: number, kind: "zero-file" | "zero-matches" | "all-hidden"): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.className = "empty-state-row";
  const td = document.createElement("td");
  td.colSpan = colSpan;

  if (kind === "zero-file") {
    td.textContent = "This file has no data rows.";
  } else if (kind === "zero-matches") {
    const p = document.createElement("p");
    p.textContent = "No rows match.";
    td.appendChild(p);

    const actions = document.createElement("div");
    actions.className = "empty-state-actions";
    if (state!.view.quickSearch !== "") {
      const clearBtn = document.createElement("button");
      clearBtn.type = "button";
      clearBtn.textContent = "Clear Search";
      clearBtn.addEventListener("click", () => {
        if (!state) return;
        quickSearchInput.value = "";
        state.view.quickSearch = "";
        requery();
        saveState();
      });
      actions.appendChild(clearBtn);
    }
    if (state!.view.filterRules.some((r) => r.enabled)) {
      const turnOffBtn = document.createElement("button");
      turnOffBtn.type = "button";
      turnOffBtn.textContent = "Turn Off Filters";
      turnOffBtn.addEventListener("click", () => {
        if (!state) return;
        for (const r of state.view.filterRules) r.enabled = false;
        renderFilterPanel();
        requery();
        saveState();
      });
      actions.appendChild(turnOffBtn);
    }
    if (actions.childElementCount > 0) td.appendChild(actions);
  } else {
    const p = document.createElement("p");
    p.textContent = "All columns are in the row details. Click a row's arrow to open it, or choose table columns.";
    td.appendChild(p);

    const actions = document.createElement("div");
    actions.className = "empty-state-actions";
    const chooseBtn = document.createElement("button");
    chooseBtn.type = "button";
    chooseBtn.textContent = "Choose Columns";
    chooseBtn.addEventListener("click", () => openColumnsPopover(chooseBtn));
    actions.appendChild(chooseBtn);
    td.appendChild(actions);
  }

  tr.appendChild(td);
  return tr;
}

function buildRowTr(row: WorkerRow, columns: string[]): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.className = "data-row";
  tr.dataset.rowId = String(row.id);

  const chevronTd = document.createElement("td");
  chevronTd.className = "chevron-col";
  const expanded = state!.expanded.has(row.id);
  const twisty = document.createElement("button");
  twisty.type = "button";
  twisty.className = "twisty";
  const chevronIcon = document.createElement("span");
  chevronIcon.className = `codicon ${expanded ? "codicon-chevron-down" : "codicon-chevron-right"}`;
  chevronIcon.setAttribute("aria-hidden", "true");
  twisty.appendChild(chevronIcon);
  twisty.setAttribute("aria-expanded", String(expanded));
  twisty.setAttribute("aria-controls", `detail-row-${row.id}`);
  twisty.setAttribute("aria-label", `${expanded ? "Hide" : "Show"} details for row ${row.id + 1}`);
  twisty.addEventListener("click", (ev) => {
    ev.stopPropagation(); // don't also fire the <tr> click handler below
    toggleExpanded(row.id);
  });
  chevronTd.appendChild(twisty);
  tr.appendChild(chevronTd);

  const indexByHeader = new Map(state!.headers.map((h, i) => [h, i]));
  for (const column of columns) {
    const td = document.createElement("td");
    const value = row.cells[indexByHeader.get(column)!] ?? "";
    // Table cells render at most 500 characters — a huge (e.g. 15 MB
    // single-line) cell used to freeze rendering / trip VS Code's
    // unresponsive-webview watchdog. Quick-add (below) always uses the
    // FULL value; only the rendered text is truncated.
    td.textContent = truncateForTable(value).text;
    // A tooltip is only useful (and worth the DOM write) on a cell that's
    // actually clipped — set it lazily on first hover rather than
    // measuring every cell's scrollWidth on every render.
    td.addEventListener("mouseenter", () => {
      if (td.title) return;
      if (td.scrollWidth > td.clientWidth) {
        td.title = value.slice(0, 500);
        td.classList.add("clipped-cell");
      }
    });
    td.addEventListener("contextmenu", (ev) => onCellContextMenu(ev, column, value));
    tr.appendChild(td);
  }

  tr.addEventListener("mousedown", onRowMouseDown);
  tr.addEventListener("click", (ev) => onRowClick(ev, row.id));
  return tr;
}

/** Builds the (initially empty) detail <tr> — its content is filled in by
 * populateDetailContent, which needs the corresponding data row's cells
 * already laid out in the live document to measure clipping (see
 * clippedVisibleColumnsForRow), so it can't run until after this row is
 * actually attached. */
function buildDetailTr(row: WorkerRow, colSpan: number): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.className = "detail-row";
  tr.id = `detail-row-${row.id}`;
  tr.hidden = !state!.expanded.has(row.id);

  const td = document.createElement("td");
  td.colSpan = colSpan;
  const wrap = document.createElement("div");
  wrap.className = "detail-wrap";
  td.appendChild(wrap);
  tr.appendChild(td);
  return tr;
}

/** Which of `columns` (table-visible columns, in display order) are
 * visually clipped (ellipsis) in `rowTr`'s already-laid-out cells. Must
 * only be called after `rowTr` is attached to the live document — a
 * detached/fragment element always reports scrollWidth === clientWidth. */
function clippedVisibleColumnsForRow(rowTr: HTMLTableRowElement, columns: string[]): Set<string> {
  const cells = Array.from(rowTr.children).slice(1) as HTMLTableCellElement[]; // skip the chevron <td>
  const result = new Set<string>();
  cells.forEach((td, i) => {
    const column = columns[i];
    if (column !== undefined && td.scrollWidth > td.clientWidth) result.add(column);
  });
  return result;
}

/** Fills in the detail content for every currently-expanded row on this
 * page after a full render, batching every layout read (scrollWidth/
 * clientWidth, via clippedVisibleColumnsForRow) before any write
 * (populateDetailContent's DOM mutation) — reading and writing
 * interleaved row by row would force a synchronous layout recalculation
 * per row, which matters once "Expand page" has 100+ rows expanded at
 * once. */
function populateExpandedDetails(columns: string[]): void {
  if (!state) return;
  const toPopulate: { row: WorkerRow; rowTr: HTMLTableRowElement; detailTr: HTMLTableRowElement }[] = [];
  for (const row of state.currentPageRows) {
    if (!state.expanded.has(row.id)) continue;
    const rowTr = tableBody.querySelector<HTMLTableRowElement>(`tr.data-row[data-row-id="${row.id}"]`);
    const detailTr = document.getElementById(`detail-row-${row.id}`) as HTMLTableRowElement | null;
    if (rowTr && detailTr) toPopulate.push({ row, rowTr, detailTr });
  }
  const clippedSets = toPopulate.map(({ rowTr }) => clippedVisibleColumnsForRow(rowTr, columns)); // reads
  toPopulate.forEach(({ row, detailTr }, i) => populateDetailContent(row, detailTr, columns, clippedSets[i])); // writes
}

/**
 * Row details list detail-only (hidden) columns first, then a second
 * "Also in table" group for every table-visible column whose cell is
 * clipped or contains a line break — the only way to read a long value
 * that happens to live in a visible column (see docs/reviews/ux-review.md
 * P0-1). If nothing is hidden and nothing is clipped, falls back to
 * today's behavior: show every column.
 */
function populateDetailContent(row: WorkerRow, detailTr: HTMLTableRowElement, columns: string[], clippedColumns: Set<string>): void {
  if (!state) return;
  const wrap = detailTr.querySelector<HTMLDivElement>(".detail-wrap");
  if (!wrap) return;
  wrap.innerHTML = "";

  const indexByHeader = new Map(state.headers.map((h, i) => [h, i]));
  const detailOnly = detailOnlyColumns(state.headers, state.view.columnVisibility);
  const alsoInTable = columns.filter((c) => {
    if (clippedColumns.has(c)) return true;
    const value = row.cells[indexByHeader.get(c)!] ?? "";
    return value.includes("\n");
  });

  if (detailOnly.length === 0 && alsoInTable.length === 0) {
    wrap.appendChild(buildDetailFieldList(row, state.headers, indexByHeader));
    return;
  }
  if (detailOnly.length > 0) wrap.appendChild(buildDetailFieldList(row, detailOnly, indexByHeader));
  if (alsoInTable.length > 0) {
    const heading = document.createElement("p");
    heading.className = "detail-group-heading";
    heading.textContent = "Also in table";
    wrap.appendChild(heading);
    wrap.appendChild(buildDetailFieldList(row, alsoInTable, indexByHeader));
  }
}

function buildDetailFieldList(row: WorkerRow, fields: string[], indexByHeader: Map<string, number>): HTMLDListElement {
  const dl = document.createElement("dl");
  dl.className = "detail-fields";

  for (const field of fields) {
    const dt = document.createElement("dt");
    dt.textContent = field;

    const dd = document.createElement("dd");
    const value = row.cells[indexByHeader.get(field)!] ?? "";
    const { text, truncated, fullLength } = truncateForDetail(value);
    dd.appendChild(document.createTextNode(text));
    if (truncated) {
      const showAllBtn = document.createElement("button");
      showAllBtn.type = "button";
      showAllBtn.className = "show-all-btn link-btn";
      showAllBtn.textContent = `Show all (${fullLength.toLocaleString()} characters)`;
      if (fullLength > DETAIL_WARN_CHARS) {
        showAllBtn.title = "This value is very large — showing it in full may be slow.";
      }
      showAllBtn.addEventListener("click", () => {
        dd.textContent = value; // expands in place; removes the button too
      });
      dd.appendChild(showAllBtn);
    }
    dd.addEventListener("contextmenu", (ev) => onCellContextMenu(ev, field, value));

    dl.appendChild(dt);
    dl.appendChild(dd);
  }

  return dl;
}

function toggleExpanded(rowId: number): void {
  if (!state) return;
  const opening = !state.expanded.has(rowId);
  if (opening) state.expanded.add(rowId);
  else state.expanded.delete(rowId);
  // Expanding any row is one of the two ways the one-time "N more columns
  // are in each row's details" hint gets dismissed for good (see
  // docs/reviews/pm-review.md §3's first-run hint recommendation).
  if (opening) markHintSeen("rowDetails");
  renderExpandCollapseButton();

  const rowTr = tableBody.querySelector<HTMLTableRowElement>(`tr.data-row[data-row-id="${rowId}"]`);
  const detailTr = document.getElementById(`detail-row-${rowId}`) as HTMLTableRowElement | null;
  const twisty = rowTr?.querySelector<HTMLButtonElement>(".twisty");
  if (twisty) {
    const icon = twisty.querySelector(".codicon");
    if (icon) icon.className = `codicon ${opening ? "codicon-chevron-down" : "codicon-chevron-right"}`;
    twisty.setAttribute("aria-expanded", String(opening));
    twisty.setAttribute("aria-label", `${opening ? "Hide" : "Show"} details for row ${rowId + 1}`);
  }
  if (detailTr) {
    if (opening && rowTr) {
      const columns = visibleColumns(state.headers, state.view.columnVisibility);
      const row = state.currentPageRows.find((r) => r.id === rowId);
      if (row) populateDetailContent(row, detailTr, columns, clippedVisibleColumnsForRow(rowTr, columns));
    }
    detailTr.hidden = !opening;
  }
}

// ---- Status bar ----------------------------------------------------------

function renderStatusBar(): void {
  if (!state) return;
  statusBar.textContent = `Showing ${state.filteredCount.toLocaleString()} of ${state.totalRows.toLocaleString()} rows`;
}

// ---- Pager bar ----------------------------------------------------------

/** True while the user has typed into the page-number box and not yet
 * committed it (Enter/blur). Renders landing meanwhile must not overwrite
 * what they're typing. */
let pageInputDirty = false;

function renderPagerBar(): void {
  if (!state) return;
  const total = state.filteredCount;
  const size = state.view.pageSize;
  const count = pageCount(total, size);
  const { start, end } = pageSlice(total, state.page, size);

  if (!pageInputDirty) pagerPageInput.value = String(state.page);
  pagerPageInput.max = String(count);
  pagerPageCount.textContent = String(count);
  pagerPageSizeSelect.value = String(size);
  // The pager's range text is now the single VISIBLE row count (the old
  // separate status-line text stays only as a visually-hidden live region
  // — see #status-bar/renderStatusBar). "(filtered from N)" only appears
  // when search/filters actually reduced the set, not merely while one is
  // active with no effect — see docs/reviews/ux-review.md §2/§4.
  const filtered = total !== state.totalRows;
  const suffix = filtered ? ` (filtered from ${state.totalRows.toLocaleString()})` : "";
  pagerRowRange.textContent =
    total === 0 ? `0 rows${suffix}` : `${(start + 1).toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()} rows${suffix}`;

  const noRows = total === 0;
  pagerFirstBtn.disabled = noRows || state.page <= 1;
  pagerPrevBtn.disabled = noRows || state.page <= 1;
  pagerNextBtn.disabled = noRows || state.page >= count;
  pagerLastBtn.disabled = noRows || state.page >= count;
  pagerPageInput.disabled = noRows;
}

/** Requests page `page` (clamped in range) from the worker. If a query is
 * still in flight (e.g. mid regex-timeout recovery), the request is
 * queued rather than dropped: the main thread stays responsive to the
 * click immediately (the page-number input updates optimistically) and
 * the actual fetch happens as soon as the in-flight query settles.
 *
 * `force` skips the "page number unchanged, nothing to do" shortcut —
 * needed when the page *size* changed but happens to land back on the
 * same page *number* (e.g. shrinking the page size while already on
 * page 1), where the rows themselves are still different and must be
 * re-fetched even though `state.page` itself didn't move. */
function requestPage(page: number, force = false): void {
  if (!state) return;
  if (queryInFlight) {
    pendingPageAfterQuery = page;
    pagerPageInput.value = String(page);
    return;
  }
  const clamped = clampPage(page, state.filteredCount, state.view.pageSize);
  if (!force && clamped === state.page) {
    renderPagerBar(); // still resync e.g. the page-number input's text
    notifyRendered();
    return;
  }
  state.page = clamped;
  startOperation();
  const requestId = nextRequestId++;
  latestPageRequestId = requestId;
  postToWorker({ type: "page", requestId, page: clamped, pageSize: state.view.pageSize });
  tableScroll.scrollTop = 0;
}

pagerFirstBtn.addEventListener("click", () => requestPage(1));
pagerPrevBtn.addEventListener("click", () => {
  if (state) requestPage(state.page - 1);
});
pagerNextBtn.addEventListener("click", () => {
  if (state) requestPage(state.page + 1);
});
pagerLastBtn.addEventListener("click", () => {
  if (state) requestPage(pageCount(state.filteredCount, state.view.pageSize));
});

function commitPageInput(): void {
  if (!state) return;
  pageInputDirty = false;
  const raw = pagerPageInput.value.trim();
  const parsed = raw === "" ? NaN : Number(raw);
  if (!Number.isFinite(parsed)) {
    renderPagerBar(); // invalid input: restore the current page
    return;
  }
  requestPage(parsed);
}

pagerPageInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    commitPageInput();
  }
});
pagerPageInput.addEventListener("input", () => {
  pageInputDirty = true;
});
pagerPageInput.addEventListener("blur", commitPageInput);

pagerPageSizeSelect.addEventListener("change", () => {
  if (!state) return;
  const oldSize = state.view.pageSize;
  const { start: firstRowIndex } = pageSlice(state.filteredCount, state.page, oldSize);
  const newSize = normalizePageSize(Number(pagerPageSizeSelect.value));

  state.view.pageSize = newSize;
  saveState();
  requestPage(pageForRow(firstRowIndex, newSize), true);
});

// ---- Quick search ----------------------------------------------------------

quickSearchInput.addEventListener("input", () => {
  if (!state) return;
  const value = quickSearchInput.value;
  window.clearTimeout(searchDebounceHandle);
  searchDebounceHandle = window.setTimeout(() => {
    if (!state) return;
    state.view.quickSearch = value;
    requery();
    saveState();
  }, SEARCH_DEBOUNCE_MS);
});

// ---- First row is header ----------------------------------------------------------

firstRowHeaderCheckbox.addEventListener("change", () => {
  if (!state) return;
  state.view.firstRowIsHeader = firstRowHeaderCheckbox.checked;
  // Re-parses (in the worker) from the text already held in state (no
  // host round trip); keeps the current page, same as the old
  // host-driven reload did.
  reparseFromText({ resetPage: false });
  saveState();
});

// ---- Separator ----------------------------------------------------------

/** Render the Separator dropdown's options (including the live "Auto (…)"
 * label) and select the value matching the current state, revealing the
 * custom input when the stored delimiter isn't one of the presets. */
/** True while the user has picked "Custom…" and hasn't yet applied a value
 * (or picked something else). A re-render triggered by an unrelated parse
 * result must not reset the control out from under them. */
let separatorCustomEditing = false;

function renderSeparatorControl(): void {
  if (!state) return;
  separatorSelect.innerHTML = "";

  const autoOption = document.createElement("option");
  autoOption.value = "";
  autoOption.textContent = `Auto (${delimiterDisplay(state.detectedDelimiter)})`;
  separatorSelect.appendChild(autoOption);

  for (const preset of PRESET_DELIMITERS) {
    const option = document.createElement("option");
    option.value = preset.value;
    option.textContent = preset.label;
    separatorSelect.appendChild(option);
  }

  const customOption = document.createElement("option");
  customOption.value = CUSTOM_SENTINEL;
  customOption.textContent = "Custom…";
  separatorSelect.appendChild(customOption);

  if (separatorCustomEditing) {
    separatorSelect.value = CUSTOM_SENTINEL;
    separatorCustomInput.hidden = false;
    return;
  }

  const current = state.view.delimiter;
  const isPreset = current === "" || PRESET_DELIMITERS.some((p) => p.value === current);
  separatorSelect.value = isPreset ? current : CUSTOM_SENTINEL;
  separatorCustomInput.hidden = isPreset;
  // Not trimmed: a stored delimiter of exactly " " (a single space) or "\t"
  // must round-trip back into the input as typed, not as "".
  if (!isPreset) separatorCustomInput.value = current;
  hideSeparatorCustomError();
  renderFormatButton();
}

function hideSeparatorCustomError(): void {
  separatorCustomError.hidden = true;
  separatorCustomError.innerHTML = "";
  separatorCustomError.classList.remove("input-error-box");
  separatorCustomInput.removeAttribute("aria-invalid");
}

/** `"` conflicts with Papa's quoteChar while "Quoted fields" is on (see
 * the separatorCustomInput 'input' handler below) — shown with a "Turn
 * off" link that both unchecks Quoted fields and applies `pendingValue`
 * in one click, instead of making the user do it in two steps. */
function showSeparatorQuoteConflictError(pendingValue: string): void {
  separatorCustomError.innerHTML = "";
  const icon = document.createElement("span");
  icon.className = "codicon codicon-error";
  icon.setAttribute("aria-hidden", "true");
  separatorCustomError.appendChild(icon);
  separatorCustomError.appendChild(document.createTextNode('Can\'t use " while Quoted fields is on. '));
  const turnOffBtn = document.createElement("button");
  turnOffBtn.type = "button";
  turnOffBtn.className = "link-btn";
  turnOffBtn.textContent = "Turn Off";
  turnOffBtn.addEventListener("click", () => {
    if (!state) return;
    quotesCheckbox.checked = false;
    state.view.quotes = false;
    hideSeparatorCustomError();
    applySeparatorChange(pendingValue);
  });
  separatorCustomError.appendChild(turnOffBtn);
  separatorCustomError.classList.add("input-error-box");
  separatorCustomError.hidden = false;
  separatorCustomInput.setAttribute("aria-invalid", "true");
}

function applySeparatorChange(delimiter: string): void {
  if (!state) return;
  separatorCustomEditing = false;
  state.view.delimiter = delimiter;
  reparseFromText({ resetPage: true });
  saveState();
}

separatorSelect.addEventListener("change", () => {
  if (!state) return;
  const value = separatorSelect.value;
  if (value === CUSTOM_SENTINEL) {
    // Reveal the input but don't reparse until the user actually types a
    // custom delimiter — picking "Custom…" alone changes nothing yet.
    separatorCustomEditing = true;
    separatorCustomInput.hidden = false;
    separatorCustomInput.value = "";
    hideSeparatorCustomError();
    separatorCustomInput.focus();
    return;
  }
  applySeparatorChange(value);
});

let separatorDebounceHandle: number | undefined;
separatorCustomInput.addEventListener("input", () => {
  window.clearTimeout(separatorDebounceHandle);
  separatorDebounceHandle = window.setTimeout(() => {
    if (!state) return;
    // Deliberately NOT trimmed: a single space or a tab is a valid
    // 1-character delimiter someone might actually type here. An empty
    // input (truly empty, not whitespace) still falls back to Auto.
    const value = separatorCustomInput.value;
    if (value === "") {
      hideSeparatorCustomError();
      applySeparatorChange("");
      return;
    }
    // `"` is Papa's quoteChar whenever quoting is on, so requesting it as
    // the delimiter too would conflict — reject it with an inline error
    // instead of silently falling back to auto-detected comma. With
    // quoting off (state.view.quotes === false), there's no conflict, so
    // `"` is allowed as an ordinary delimiter.
    if (state.view.quotes && value.includes('"')) {
      showSeparatorQuoteConflictError(value);
      return;
    }
    hideSeparatorCustomError();
    applySeparatorChange(value);
  }, SEPARATOR_DEBOUNCE_MS);
});

// ---- Quoted fields --------------------------------------------------------

/** Show/hide the malformed-quotes warning banner above the table. Hidden
 * whenever quoting is off (nothing to warn about — every `"` is already
 * literal), there are no quote problems, or the user dismissed it for this
 * parse. */
function renderQuoteWarningBanner(): void {
  if (!state) return;
  const shouldShow = state.view.quotes && state.quoteProblems.length > 0 && !state.quoteBannerDismissed;
  quoteWarningBanner.hidden = !shouldShow;
  if (!shouldShow) return;
  const firstRow = state.quoteProblems[0].row;
  quoteWarningText.textContent = `Quotes look malformed near row ${firstRow}. Rows after it may be merged into one.`;
}

quotesCheckbox.addEventListener("change", () => {
  if (!state) return;
  state.view.quotes = quotesCheckbox.checked;
  reparseFromText({ resetPage: true });
  saveState();
});

quoteWarningFixBtn.addEventListener("click", () => {
  if (!state) return;
  state.view.quotes = false;
  quotesCheckbox.checked = false;
  reparseFromText({ resetPage: true });
  saveState();
});

quoteWarningDismissBtn.addEventListener("click", () => {
  if (!state) return;
  state.quoteBannerDismissed = true;
  renderQuoteWarningBanner();
});

// ---- Open as text ----------------------------------------------------------

openAsTextBtn.addEventListener("click", () => {
  vscode.postMessage({ type: "openAsText" });
});

// ---- Expand/collapse all (current page only) -------------------------------
//
// Purely local: the current page's rows (with full cell values) are
// already cached in state.currentPageRows, so this never needs the worker.
// One toggle button, not two — it shows "collapse" once every row on the
// page is expanded, "expand" otherwise (see docs/reviews/ux-review.md §2's
// regroup sketch / copy table).

function pageFullyExpanded(): boolean {
  if (!state || state.currentPageRows.length === 0) return false;
  return state.currentPageRows.every((row) => state!.expanded.has(row.id));
}

function renderExpandCollapseButton(): void {
  const collapse = pageFullyExpanded();
  expandCollapseIcon.className = `codicon ${collapse ? "codicon-collapse-all" : "codicon-expand-all"}`;
  const label = collapse ? "Collapse all rows on this page" : "Expand all rows on this page";
  expandCollapseBtn.title = label;
  expandCollapseBtn.setAttribute("aria-label", label);
}

expandCollapseBtn.addEventListener("click", () => {
  if (!state) return;
  if (pageFullyExpanded()) {
    for (const row of state.currentPageRows) state.expanded.delete(row.id);
  } else {
    for (const row of state.currentPageRows) state.expanded.add(row.id);
  }
  renderTableBody();
  renderExpandCollapseButton();
  notifyRendered();
});

// ---- Sort popover (replaces the old "Sort by…" select + direction button) --
//
// Lists every current sort key in priority order (direction toggle +
// remove), an "Add sort column" select listing every column not already a
// key — INCLUDING detail-only ones, which have no header to click — and a
// "Clear sort" button once there's at least one key. Header click/
// Shift+click (onHeaderClick, above) mutate the exact same
// state.view.sortKeys and always requery(), so this stays in sync with the
// header UI automatically via finishRender's renderSortPopover() call.

function renderSortPopover(): void {
  if (!state) return;
  sortKeysList.innerHTML = "";

  state.view.sortKeys.forEach((key, i) => {
    const row = document.createElement("div");
    row.className = "sort-key-row";

    const priority = document.createElement("span");
    priority.className = "sort-key-priority";
    priority.textContent = String(i + 1);
    row.appendChild(priority);

    const columnLabel = document.createElement("span");
    columnLabel.className = "sort-key-column";
    columnLabel.textContent = key.column;
    row.appendChild(columnLabel);

    const dirBtn = document.createElement("button");
    dirBtn.type = "button";
    dirBtn.className = "icon-btn sort-key-dir-btn";
    const dirIcon = document.createElement("span");
    dirIcon.className = `codicon ${key.direction === "asc" ? "codicon-arrow-up" : "codicon-arrow-down"}`;
    dirIcon.setAttribute("aria-hidden", "true");
    dirBtn.appendChild(dirIcon);
    const dirLabel = key.direction === "asc" ? "Sort ascending" : "Sort descending";
    dirBtn.title = dirLabel;
    dirBtn.setAttribute("aria-label", dirLabel);
    dirBtn.addEventListener("click", () => {
      if (!state) return;
      const keys = state.view.sortKeys.slice();
      keys[i] = { ...keys[i], direction: keys[i].direction === "asc" ? "desc" : "asc" };
      state.view.sortKeys = keys;
      requery();
      saveState();
    });
    row.appendChild(dirBtn);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "icon-btn sort-key-remove-btn";
    removeBtn.innerHTML = '<span class="codicon codicon-close" aria-hidden="true"></span>';
    removeBtn.setAttribute("aria-label", `Remove ${key.column} from sort`);
    removeBtn.addEventListener("click", () => {
      if (!state) return;
      state.view.sortKeys = state.view.sortKeys.filter((_, idx) => idx !== i);
      requery();
      saveState();
    });
    row.appendChild(removeBtn);

    sortKeysList.appendChild(row);
  });

  const usedColumns = new Set(state.view.sortKeys.map((k) => k.column));
  sortAddSelect.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Add sort column…";
  sortAddSelect.appendChild(placeholder);
  for (const header of state.headers) {
    if (usedColumns.has(header)) continue;
    const option = document.createElement("option");
    option.value = header;
    option.textContent = header;
    sortAddSelect.appendChild(option);
  }
  sortAddSelect.value = "";

  sortClearBtn.hidden = state.view.sortKeys.length === 0;
}

sortAddSelect.addEventListener("change", () => {
  if (!state) return;
  const column = sortAddSelect.value;
  if (column === "") return;
  state.view.sortKeys = [...state.view.sortKeys, { column, direction: "asc" as const }];
  requery();
  saveState();
});

sortClearBtn.addEventListener("click", () => {
  if (!state) return;
  state.view.sortKeys = [];
  requery();
  saveState();
});

// ---- Popover positioning & focus management --------------------------------
//
// The Columns, Filters, Sort and File format popovers all share this:
// anchored under their trigger button (not a fixed top/right offset),
// clamped inside the viewport, re-clamped on resize; opening one closes
// every other one; opening moves focus to the popover's first field;
// outside-click and Escape close it — Escape also returns focus to the
// trigger, an outside click does not (the user clicked somewhere else on
// purpose).

const ALL_POPOVERS: HTMLElement[] = [columnsPopover, filterPanel, sortPopover, formatPopover];
const POPOVER_TRIGGERS: HTMLButtonElement[] = [columnsBtn, filtersBtn, sortBtn, formatBtn];

let activePopoverEl: HTMLElement | null = null;
let activePopoverTrigger: HTMLButtonElement | null = null;

/** Anchors `el` (already un-hidden, so it has real dimensions) under
 * `trigger`, then clamps inside the viewport with an 8px margin, flipping
 * above the trigger instead of overflowing the bottom edge. Both
 * `.popover`/`.panel` are `position: fixed` (see main.css), so viewport
 * coordinates from getBoundingClientRect apply directly. */
function positionPopoverNear(el: HTMLElement, trigger: HTMLElement): void {
  const margin = 8;
  const triggerRect = trigger.getBoundingClientRect();
  el.style.left = `${triggerRect.left}px`;
  el.style.top = `${triggerRect.bottom + 4}px`;

  const elRect = el.getBoundingClientRect();
  let left = triggerRect.left;
  let top = triggerRect.bottom + 4;
  if (left + elRect.width > window.innerWidth - margin) left = Math.max(margin, window.innerWidth - margin - elRect.width);
  if (left < margin) left = margin;
  if (top + elRect.height > window.innerHeight - margin) top = Math.max(margin, triggerRect.top - 4 - elRect.height);
  if (top < margin) top = margin;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function repositionOpenPopover(): void {
  if (activePopoverEl && !activePopoverEl.hidden && activePopoverTrigger) positionPopoverNear(activePopoverEl, activePopoverTrigger);
}

window.addEventListener("resize", repositionOpenPopover);

/** Closes whichever popover is open. `returnFocusToTrigger` is true only
 * for Escape — an outside click deliberately moved focus/attention
 * elsewhere, so it shouldn't be yanked back. */
function closeAllPopovers(returnFocusToTrigger = false): void {
  const trigger = activePopoverTrigger;
  for (const el of ALL_POPOVERS) el.hidden = true;
  for (const btn of POPOVER_TRIGGERS) btn.setAttribute("aria-expanded", "false");
  activePopoverEl = null;
  activePopoverTrigger = null;
  if (returnFocusToTrigger) trigger?.focus();
}

/** Opens `el`, anchored under `trigger`; focuses `el`'s first field unless
 * `focusSelector` names a more specific one (Columns wants its search box
 * focused first, not the legend paragraph). */
function openPopover(el: HTMLElement, trigger: HTMLButtonElement, focusSelector = "input, select, button"): void {
  closeAllPopovers();
  el.hidden = false;
  trigger.setAttribute("aria-expanded", "true");
  activePopoverEl = el;
  activePopoverTrigger = trigger;
  positionPopoverNear(el, trigger);
  el.querySelector<HTMLElement>(focusSelector)?.focus();
}

function openColumnsPopover(trigger: HTMLButtonElement = columnsBtn): void {
  openPopover(columnsPopover, trigger, "#columns-search");
}

function openFilterPanel(trigger: HTMLButtonElement = filtersBtn): void {
  openPopover(filterPanel, trigger, "#filter-rules input, #filter-rules select, #add-rule-btn");
}

function openSortPopover(trigger: HTMLButtonElement = sortBtn): void {
  openPopover(sortPopover, trigger, ".sort-key-dir-btn, #sort-add-select");
}

function openFormatPopover(trigger: HTMLButtonElement = formatBtn): void {
  openPopover(formatPopover, trigger, "#separator-select");
}

// Outside clicks are intercepted in the CAPTURE phase (before the click
// reaches its target's own bubble-phase listener) so a click on a row
// *through* an open popover closes the popover WITHOUT also toggling
// that row — stopping propagation here means the row's own "click"
// listener (attached directly to the row, fired later in the dispatch
// order) never runs for this event.
document.addEventListener(
  "click",
  (ev) => {
    const openEl = activePopoverEl && !activePopoverEl.hidden ? activePopoverEl : null;
    if (!openEl) return;
    const target = ev.target as Node;
    if (openEl.contains(target)) return; // inside the open popover itself
    if (contextMenu.contains(target)) return; // the cell context menu has its own click handling
    // Let any trigger button's own click handler run normally — it
    // already calls closeAllPopovers() before opening (or closes if it's
    // the same trigger toggling itself shut), so this correctly switches
    // straight from one popover to another.
    if (target instanceof Element && POPOVER_TRIGGERS.some((btn) => btn.contains(target))) return;
    // Only a row click needs its OWN action suppressed (the documented
    // "no row toggling through an open popover" trap) — every other
    // control (pager, headers, toolbar) should still do its own thing;
    // the popover closing is just a side effect of clicking elsewhere.
    if (target instanceof Element && target.closest("tr.data-row")) {
      ev.stopPropagation();
      ev.preventDefault();
    }
    closeAllPopovers();
  },
  true,
);

// ---- Columns popover ----------------------------------------------------------
//
// Purely local: visibility doesn't change which rows match or their
// order, only which columns render — always re-rendered from the already-
// cached state.currentPageRows, no worker round-trip.

columnsBtn.addEventListener("click", () => {
  if (activePopoverEl === columnsPopover) {
    closeAllPopovers();
    return;
  }
  openColumnsPopover(columnsBtn);
});

sortBtn.addEventListener("click", () => {
  if (activePopoverEl === sortPopover) {
    closeAllPopovers();
    return;
  }
  openSortPopover(sortBtn);
});

formatBtn.addEventListener("click", () => {
  if (activePopoverEl === formatPopover) {
    closeAllPopovers();
    return;
  }
  openFormatPopover(formatBtn);
});

function renderColumnsPopover(): void {
  if (!state) return;
  const filter = columnsSearch.value.trim().toLowerCase();
  columnsList.innerHTML = "";

  for (const header of state.headers) {
    if (filter !== "" && !header.toLowerCase().includes(filter)) continue;
    const label = document.createElement("label");
    label.className = "column-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = getVisibility(state.view.columnVisibility, header) !== false;
    checkbox.addEventListener("change", () => {
      if (!state) return;
      setVisibility(state.view.columnVisibility, header, checkbox.checked);
      renderLocalOnly(); // column visibility keeps the current page
      saveState();
    });
    label.appendChild(checkbox);
    const span = document.createElement("span");
    span.textContent = header;
    label.appendChild(span);
    columnsList.appendChild(label);
  }
}

/** Re-renders head/body from already-known state (no worker round-trip) —
 * for changes that only affect which columns/fields are shown, not which
 * rows match or their order. */
function renderLocalOnly(): void {
  renderTableHead();
  renderTableBody();
  renderExpandCollapseButton();
  renderColumnsButton();
  renderHintBanner();
  notifyRendered();
}

columnsSearch.addEventListener("input", renderColumnsPopover);

columnsShowAll.addEventListener("click", () => {
  if (!state) return;
  for (const header of state.headers) setVisibility(state.view.columnVisibility, header, true);
  renderColumnsPopover();
  renderLocalOnly();
  saveState();
});

columnsHideAll.addEventListener("click", () => {
  if (!state) return;
  for (const header of state.headers) setVisibility(state.view.columnVisibility, header, false);
  renderColumnsPopover();
  renderLocalOnly();
  saveState();
});

// ---- Filter rules panel ----------------------------------------------------------

const OPERATORS: { value: FilterOperator; label: string; needsValue: boolean }[] = [
  { value: "contains", label: "contains", needsValue: true },
  { value: "equals", label: "equals", needsValue: true },
  { value: "startsWith", label: "starts with", needsValue: true },
  { value: "endsWith", label: "ends with", needsValue: true },
  { value: "regex", label: "regex", needsValue: true },
  { value: "isEmpty", label: "is empty", needsValue: false },
  { value: "gt", label: "> (number)", needsValue: true },
  { value: "lt", label: "< (number)", needsValue: true },
  { value: "gte", label: ">= (number)", needsValue: true },
  { value: "lte", label: "<= (number)", needsValue: true },
];

/** Sends the next filter/sort/search query, always resetting to page 1 —
 * every interactive change here (quick search, a filter rule, a sort
 * key) is documented to reset the page. */
function requery(): void {
  if (!state) return;
  pendingPageAfterQuery = 1;
  runQuery();
}

/**
 * Debounced (150ms) requery, shared across every filter-rule control —
 * not just the value text box. Configuring one rule is rarely a single
 * field: picking a column, then an operator, then typing a value are
 * each their own DOM event, and at scale (hundreds of thousands of rows)
 * each undebounced requery() re-filters AND re-sorts the full dataset in
 * the worker — with sort keys from an earlier interaction still active,
 * even an "inactive rule, nothing really changed yet" intermediate step
 * pays that full cost. Coalescing the whole gesture into the query that
 * reflects its *final* state (same as quick search already does) is what
 * keeps "add/change a filter rule" under its latency target at scale;
 * `syncRuleError()` (the error/hint display) is called separately and
 * immediately at every call site, never debounced, so error feedback
 * stays instant regardless.
 */
let filterDebounceHandle: number | undefined;
function debouncedRequery(): void {
  window.clearTimeout(filterDebounceHandle);
  filterDebounceHandle = window.setTimeout(() => {
    requery();
    saveState();
  }, FILTER_RULE_DEBOUNCE_MS);
}

filtersBtn.addEventListener("click", () => {
  if (activePopoverEl === filterPanel) {
    closeAllPopovers();
    return;
  }
  openFilterPanel(filtersBtn);
});

addRuleBtn.addEventListener("click", () => {
  if (!state) return;
  const rule: FilterRule = {
    id: newRuleId(),
    column: null,
    operator: "contains",
    value: "",
    mode: "include",
    caseSensitive: false,
    enabled: true,
  };
  state.view.filterRules.push(rule);
  renderFilterPanel();
  debouncedRequery();
});

function renderFilterPanel(): void {
  if (!state) return;
  filterRulesEl.innerHTML = "";
  for (const rule of state.view.filterRules) filterRulesEl.appendChild(buildRuleRow(rule));
  filterPanelTip.hidden = state.view.filterRules.length > 0;
  renderFiltersButton();
}

/** Sentence-ordered rule row: `[enabled] [Keep|Hide] rows where [column]
 * [condition] [value] [Aa] [✕]` (see docs/reviews/ux-review.md §2/§4 and
 * the owner's §5 layout). `mode` is a select ("Keep"/"Hide") now, not a
 * toggle button — the stored rule field is still `mode: "include" |
 * "exclude"`. */
function buildRuleRow(rule: FilterRule): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "rule-row";

  const enabledCheckbox = document.createElement("input");
  enabledCheckbox.type = "checkbox";
  enabledCheckbox.checked = rule.enabled;
  enabledCheckbox.setAttribute("aria-label", "Rule enabled");
  enabledCheckbox.title = "Rule enabled";
  enabledCheckbox.addEventListener("change", () => {
    rule.enabled = enabledCheckbox.checked;
    syncRuleError();
    debouncedRequery();
  });
  row.appendChild(enabledCheckbox);

  const modeSelect = document.createElement("select");
  modeSelect.className = "mode-select";
  modeSelect.setAttribute("aria-label", "Keep or hide");
  const keepOption = document.createElement("option");
  keepOption.value = "include";
  keepOption.textContent = "Keep";
  modeSelect.appendChild(keepOption);
  const hideOption = document.createElement("option");
  hideOption.value = "exclude";
  hideOption.textContent = "Hide";
  modeSelect.appendChild(hideOption);
  modeSelect.value = rule.mode;
  modeSelect.addEventListener("change", () => {
    rule.mode = modeSelect.value as FilterMode;
    debouncedRequery();
  });
  row.appendChild(modeSelect);

  const rowsWhere = document.createElement("span");
  rowsWhere.className = "rule-row-text";
  rowsWhere.textContent = "rows where";
  row.appendChild(rowsWhere);

  const columnSelect = document.createElement("select");
  columnSelect.setAttribute("aria-label", "Column");
  const anyOption = document.createElement("option");
  anyOption.value = "";
  anyOption.textContent = "Any column";
  columnSelect.appendChild(anyOption);
  for (const header of state!.headers) {
    const option = document.createElement("option");
    option.value = header;
    option.textContent = header;
    columnSelect.appendChild(option);
  }
  // A rule whose column no longer exists (header renamed/removed, or a
  // separator change produced different headers) shows that column as a
  // disabled option instead of leaving the select looking blank — so the
  // user can tell *which* column was missing (see syncRuleError below).
  if (rule.column !== null && !state!.headers.includes(rule.column)) {
    const missingOption = document.createElement("option");
    missingOption.value = rule.column;
    missingOption.textContent = `${rule.column} (missing)`;
    missingOption.disabled = true;
    columnSelect.appendChild(missingOption);
  }
  columnSelect.value = rule.column ?? "";
  columnSelect.addEventListener("change", () => {
    rule.column = columnSelect.value === "" ? null : columnSelect.value;
    syncRuleError();
    debouncedRequery();
  });
  row.appendChild(columnSelect);

  const operatorSelect = document.createElement("select");
  operatorSelect.setAttribute("aria-label", "Condition");
  for (const op of OPERATORS) {
    const option = document.createElement("option");
    option.value = op.value;
    option.textContent = op.label;
    operatorSelect.appendChild(option);
  }
  operatorSelect.value = rule.operator;
  operatorSelect.addEventListener("change", () => {
    rule.operator = operatorSelect.value as FilterOperator;
    valueInput.hidden = rule.operator === "isEmpty";
    state?.timedOutRuleIds.delete(rule.id);
    syncRuleError();
    debouncedRequery();
  });
  row.appendChild(operatorSelect);

  const valueInput = document.createElement("input");
  valueInput.type = "text";
  valueInput.value = rule.value;
  valueInput.hidden = rule.operator === "isEmpty";
  valueInput.placeholder = "Value";
  valueInput.addEventListener("input", () => {
    rule.value = valueInput.value;
    // Editing the value clears a "too slow" mark immediately — the rule
    // gets a fresh chance the next time it's actually queried.
    state?.timedOutRuleIds.delete(rule.id);
    syncRuleError(); // instant feedback, never debounced
    debouncedRequery();
  });
  row.appendChild(valueInput);

  const caseCheckbox = document.createElement("input");
  caseCheckbox.type = "checkbox";
  caseCheckbox.checked = rule.caseSensitive;
  caseCheckbox.setAttribute("aria-label", "Match case");
  caseCheckbox.title = "Match Case";
  caseCheckbox.addEventListener("change", () => {
    rule.caseSensitive = caseCheckbox.checked;
    debouncedRequery();
  });
  const caseLabel = document.createElement("label");
  caseLabel.className = "inline-checkbox-label";
  caseLabel.appendChild(caseCheckbox);
  caseLabel.appendChild(document.createTextNode("Aa"));
  row.appendChild(caseLabel);

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "remove-rule-btn icon-btn";
  removeBtn.innerHTML = '<span class="codicon codicon-close" aria-hidden="true"></span>';
  removeBtn.setAttribute("aria-label", "Remove rule");
  removeBtn.addEventListener("click", () => {
    if (!state) return;
    state.view.filterRules = state.view.filterRules.filter((r) => r.id !== rule.id);
    state.timedOutRuleIds.delete(rule.id);
    renderFilterPanel();
    debouncedRequery();
  });
  row.appendChild(removeBtn);

  const error = document.createElement("span");
  error.className = "rule-error-text";
  row.appendChild(error);

  // isRuleActive (src/core/filter.ts) is the single source of truth for
  // "will this rule do anything", shared with applyFilters (in the
  // worker), so the hint shown here always agrees with what's actually
  // being filtered. A timed-out regex rule is checked first (strongest,
  // most specific state); then an invalid regex and a missing column
  // (same strong styling); a missing value is a softer, "you're not done
  // yet" hint.
  function syncRuleError(): void {
    if (!state) return;
    const timedOut = state.timedOutRuleIds.has(rule.id);
    const regexInvalid = !timedOut && !isValidRule(rule);
    const columnMissing = !timedOut && !regexInvalid && rule.column !== null && state.headers.indexOf(rule.column) === -1;
    const needsValue = !timedOut && !regexInvalid && !columnMissing && rule.operator !== "isEmpty" && rule.value === "";
    // isRuleActive is the single source of truth applyFilters itself uses
    // for "does this rule do anything"; gating on it here (rather than
    // just the checks above) keeps the UI from silently drifting out of
    // sync with applyFilters if either is ever changed alone. A
    // timed-out rule is also inactive from the worker's perspective (it's
    // excluded from the query entirely — see sendQueryNow), even though
    // isRuleActive itself doesn't know about that webview-only concept.
    const inactive = timedOut || !isRuleActive(rule, state.headers);
    row.classList.toggle("rule-error", inactive && (timedOut || regexInvalid || columnMissing));
    row.classList.toggle("rule-hint", inactive && needsValue);
    error.innerHTML = "";
    let message: string | null = null;
    if (timedOut) message = "Skipped: pattern took over 2 s. Edit it to retry.";
    else if (regexInvalid) message = `Skipped: invalid regex (${regexErrorMessage(rule.value) ?? "unknown error"})`;
    else if (columnMissing) message = `Skipped: column "${rule.column}" isn't in this file`;
    else if (needsValue) message = "Enter a value";
    if (message !== null) {
      if (timedOut || regexInvalid || columnMissing) {
        const icon = document.createElement("span");
        icon.className = "codicon codicon-error";
        icon.setAttribute("aria-hidden", "true");
        error.appendChild(icon);
      }
      error.appendChild(document.createTextNode(message));
    }
    error.hidden = !inactive;
    renderFiltersButton();
  }
  syncRuleError();

  return row;
}

// ---- Quick-add filter via cell context menu ----------------------------------------------------------

/** Writes `value` to the clipboard, falling back to a hidden-textarea +
 * execCommand("copy") when the async Clipboard API is unavailable or
 * denied (e.g. no clipboard-write permission in the test context). */
async function copyToClipboard(value: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {
    // fall through to the execCommand fallback below
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    document.execCommand("copy");
  } finally {
    textarea.remove();
  }
}

/** The quick-add menu's rule uses the full, untruncated value; only the
 * menu item's own label is shortened so a long cell value doesn't blow
 * out the menu's width. */
function truncateForMenuLabel(value: string, maxChars = 40): string {
  return value.length > maxChars ? value.slice(0, maxChars) + "…" : value;
}

function onCellContextMenu(ev: MouseEvent, column: string, value: string): void {
  ev.preventDefault();
  contextMenu.innerHTML = "";

  const copyItem = document.createElement("button");
  copyItem.type = "button";
  copyItem.setAttribute("role", "menuitem");
  copyItem.textContent = "Copy value";
  copyItem.addEventListener("click", () => {
    void copyToClipboard(value);
    contextMenu.hidden = true;
  });
  contextMenu.appendChild(copyItem);
  contextMenu.appendChild(document.createElement("hr"));

  const label = truncateForMenuLabel(value);
  const includeItem = document.createElement("button");
  includeItem.type = "button";
  includeItem.setAttribute("role", "menuitem");
  includeItem.textContent = `Show only rows where ${column} = "${label}"`;
  includeItem.addEventListener("click", () => addQuickFilter(column, value, "include"));

  const excludeItem = document.createElement("button");
  excludeItem.type = "button";
  excludeItem.setAttribute("role", "menuitem");
  excludeItem.textContent = `Hide rows where ${column} = "${label}"`;
  excludeItem.addEventListener("click", () => addQuickFilter(column, value, "exclude"));

  contextMenu.appendChild(includeItem);
  contextMenu.appendChild(excludeItem);
  // The menu is `position: fixed` (see main.css), so viewport-relative
  // client coordinates are what it needs — not page coordinates, which
  // would drift from the pointer once the table has scrolled.
  contextMenu.style.left = `${ev.clientX}px`;
  contextMenu.style.top = `${ev.clientY}px`;
  contextMenu.hidden = false;
  clampContextMenuToViewport(ev.clientX, ev.clientY);
}

/** Clamps the (already-shown) context menu inside the viewport, flipping
 * left/up instead of overflowing right/bottom — measured only after the
 * menu is visible and laid out, since its size is otherwise unknown. */
function clampContextMenuToViewport(x: number, y: number): void {
  const rect = contextMenu.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  let left = x;
  let top = y;
  if (left + rect.width > viewportWidth) left = Math.max(0, viewportWidth - rect.width);
  if (top + rect.height > viewportHeight) top = Math.max(0, viewportHeight - rect.height);

  contextMenu.style.left = `${left}px`;
  contextMenu.style.top = `${top}px`;
}

function addQuickFilter(column: string, value: string, mode: "include" | "exclude"): void {
  if (!state) return;
  const rule: FilterRule = {
    id: newRuleId(),
    column,
    operator: "equals",
    value,
    mode,
    caseSensitive: false,
    enabled: true,
  };
  state.view.filterRules.push(rule);
  contextMenu.hidden = true;
  renderFilterPanel();
  openFilterPanel(filtersBtn);
  requery();
  saveState();
}

document.addEventListener("click", (ev) => {
  if (contextMenu.hidden) return;
  if (!contextMenu.contains(ev.target as Node)) contextMenu.hidden = true;
});

document.addEventListener("keydown", (ev) => {
  // Cmd/Ctrl+F focuses and selects the quick search box, instead of doing
  // nothing — VS Code's webview shim swallows the browser's native Find
  // (see docs/reviews/ux-review.md §3), and every user tries this.
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "f") {
    ev.preventDefault();
    quickSearchInput.focus();
    quickSearchInput.select();
    return;
  }

  if (ev.key === "Escape") {
    contextMenu.hidden = true;
    if (activePopoverEl) closeAllPopovers(true);
    return;
  }

  // Alt+←/→ change pages, but only when focus isn't in a form control —
  // otherwise this would steal the native cursor/selection behavior those
  // keys have inside inputs, selects, and textareas.
  if (ev.altKey && (ev.key === "ArrowLeft" || ev.key === "ArrowRight")) {
    const tag = (ev.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (!state) return;
    ev.preventDefault();
    requestPage(state.page + (ev.key === "ArrowRight" ? 1 : -1));
  }
});
