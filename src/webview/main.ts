import { foldCase } from "../core/caseFold";
import type { DistinctValue } from "../core/distinct";
import { isRuleActive, isValidRule, regexErrorMessage } from "../core/filter";
import { cycleSortForColumn } from "../core/sort";
import {
  detailOnlyColumns,
  getColumnFlag,
  getVisibility,
  isAutoMarkdownColumn,
  isNumericColumn,
  normalizeColumnFlags,
  reconcileVisibility,
  setColumnFlag,
  setVisibility,
  visibleColumns,
} from "../core/columns";
import { formatJsonText, tryParseJsonValue } from "../core/json";
import { MARKDOWN_MAX_CHARS, looksLikeMarkdown } from "../core/markdownDetect";
import { renderMarkdown } from "../core/markdownRender";
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
  text: string;
  defaultDelimiter: string;
  headers: string[];
  totalRows: number;
  view: ViewState;
  defaultTableColumns: number;
  expanded: Set<number>;
  numericColumns: Set<string>;
  autoMarkdownColumns: Set<string>;
  focusedRowId: number | null;
  filteredCount: number;
  page: number;
  currentPageRows: WorkerRow[];
  detectedDelimiter: string;
  quoteProblems: { row: number }[];
  quoteBannerDismissed: boolean;
  timedOutRuleIds: Set<string>;
  testHooksEnabled: boolean;
  hintsSeen: Set<string>;
  fileDeletedName: string | null;
}

let state: AppState | null = null;
let searchDebounceHandle: number | undefined;

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
  <div id="values-popover" class="popover values-popover" role="dialog" aria-label="Filter by values" hidden>
    <p id="values-title" class="vp-title"></p>
    <input id="values-search" type="search" placeholder="Search values…" aria-label="Search values" />
    <div class="vp-links">
      <button id="values-select-all" type="button" class="link-btn">Select all</button>
      <button id="values-clear" type="button" class="link-btn">Clear</button>
      <span id="values-selected-count" class="vp-count"></span>
    </div>
    <div id="values-list" class="vp-list" role="group" aria-label="Values"></div>
    <p id="values-note-shown" class="vp-note" hidden></p>
    <p id="values-note-truncated" class="vp-note" hidden></p>
    <div class="vp-foot">
      <button id="values-cancel" type="button">Cancel</button>
      <button id="values-ok" type="button" class="primary">OK</button>
    </div>
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
const valuesPopover = document.getElementById("values-popover") as HTMLDivElement;
const valuesTitle = document.getElementById("values-title") as HTMLParagraphElement;
const valuesSearch = document.getElementById("values-search") as HTMLInputElement;
const valuesSelectAllBtn = document.getElementById("values-select-all") as HTMLButtonElement;
const valuesClearBtn = document.getElementById("values-clear") as HTMLButtonElement;
const valuesSelectedCount = document.getElementById("values-selected-count") as HTMLSpanElement;
const valuesList = document.getElementById("values-list") as HTMLDivElement;
const valuesNoteShown = document.getElementById("values-note-shown") as HTMLParagraphElement;
const valuesNoteTruncated = document.getElementById("values-note-truncated") as HTMLParagraphElement;
const valuesCancelBtn = document.getElementById("values-cancel") as HTMLButtonElement;
const valuesOkBtn = document.getElementById("values-ok") as HTMLButtonElement;
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

// ResizeObserver, because VS Code split-editor resizing does not fire a window resize event.
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

// Webview workers cannot load a vscode-resource URL directly; fetch its text and use a blob: URL.

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

async function ensureWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = (async () => createWorker(await getWorkerBlobUrl()))();
  }
  worker = await workerPromise;
  return worker;
}

async function respawnWorker(): Promise<Worker> {
  const blobUrl = await getWorkerBlobUrl();
  worker = createWorker(blobUrl);
  workerPromise = Promise.resolve(worker);
  return worker;
}

function postToWorker(message: WorkerRequest): void {
  worker?.postMessage(message);
}

let nextRequestId = 1;
let pendingInitRequestId = -1;
let pendingInitIsFreshParse = true;
let latestQueryRequestId = -1;
let latestPageRequestId = -1;
let queryInFlight = false;
let pendingPageAfterQuery: number | null = null;

let lastQueryKey: string | null = null;

// Watchdog starts at queryStarted, not at send, so time spent queued in the worker is not counted.
let riskyRulesByRequestId = new Map<number, FilterRule[]>();
let regexWatchdogHandles = new Map<number, number>();

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
  if (!rulesSent) return;
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

window.addEventListener("message", (event: MessageEvent<HostToWebviewMessage>) => {
  const message = event.data;
  if (message.type === "load") void onLoad(message);
  else if (message.type === "fileDeleted") onFileDeleted(message);
  else if (message.type === "fileRestored") onFileRestored();
});

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

function yieldFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

async function onLoad(message: LoadMessage): Promise<void> {
  const view = message.state;
  // Saved state from older versions may lack these fields.
  view.pageSize = normalizePageSize(view.pageSize);
  view.delimiter = typeof view.delimiter === "string" ? view.delimiter : "";
  view.quotes = typeof view.quotes === "boolean" ? view.quotes : true;
  view.markdownColumns = normalizeColumnFlags(view.markdownColumns);

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
    numericColumns: new Set<string>(),
    autoMarkdownColumns: new Set<string>(),
    focusedRowId: null,
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

function reparseFromText(options: { resetPage: boolean }): void {
  if (!state) return;
  const delimiterOption = resolveDelimiterOption(state.view.delimiter, state.defaultDelimiter);
  pendingPageAfterQuery = options.resetPage ? 1 : state.page;
  // Row ids are re-tokenized on re-parse, so expanded and focused ids no longer match the same rows.
  state.expanded = new Set<number>();
  state.focusedRowId = null;
  beginInit(state.text, { delimiter: delimiterOption, firstRowIsHeader: state.view.firstRowIsHeader, quotes: state.view.quotes }, true);
}

function beginInit(text: string, options: ParseOptionsMsg, isFreshParse: boolean): void {
  const requestId = nextRequestId++;
  pendingInitRequestId = requestId;
  pendingInitIsFreshParse = isFreshParse;
  lastQueryKey = null;
  resetRegexWatchdogState();
  // Timeout recovery re-parses identical text, so only a fresh parse discards the values picker.
  if (isFreshParse) discardValuesPicker();
  postToWorker({ type: "init", requestId, text, options });
}

function renderColumnsButton(): void {
  if (!state) return;
  const visible = visibleColumns(state.headers, state.view.columnVisibility).length;
  const total = state.headers.length;
  columnsBtn.textContent = `Columns ${visible}/${total}`;
  columnsBtn.title = `Columns in table: ${visible} of ${total}`;
}

function activeFilterRuleCount(): number {
  if (!state) return 0;
  return state.view.filterRules.filter((r) => r.enabled && isRuleActive(r, state!.headers) && !state!.timedOutRuleIds.has(r.id)).length;
}

function renderFiltersButton(): void {
  if (!state) return;
  const n = activeFilterRuleCount();
  filtersBtn.textContent = n > 0 ? `Filters • ${n}` : "Filters";
  syncFunnelStates();
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

function renderHintBanner(): void {
  if (!state) return;
  const n = detailOnlyColumns(state.headers, state.view.columnVisibility).length;
  const show = n > 0 && !state.hintsSeen.has("rowDetails");
  hintBanner.hidden = !show;
  if (!show) return;
  hintText.textContent = `${n} more column${n === 1 ? "" : "s"} are in each row's details. Click a row's arrow to expand it, or change which with Columns.`;
}

function markHintSeen(id: string): void {
  if (!state || state.hintsSeen.has(id)) return;
  state.hintsSeen.add(id);
  vscode.postMessage({ type: "hintSeen", id });
  if (id === "rowDetails") renderHintBanner();
}

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

// State saved before the `in` operator existed (or hand-edited) may lack `values`.
function ruleValues(rule: FilterRule): string[] {
  return Array.isArray(rule.values) ? rule.values : [];
}

const BLANKS_LABEL = "(Blanks)";

function summarizeValues(values: string[]): string {
  const text = values.map((v) => (v === "" ? BLANKS_LABEL : v)).join(", ");
  return text.length > 30 ? `${text.slice(0, 30)}…` : text;
}

function saveState(): void {
  if (!state) return;
  vscode.postMessage({ type: "saveState", state: state.view });
}

function notifyRendered(): void {
  if (!state || !state.testHooksEnabled) return;
  vscode.postMessage({ type: "rendered", rowCount: state.filteredCount, headers: state.headers });
}

function recordQuerySent(): void {
  if (!state || !state.testHooksEnabled) return;
  const w = window as unknown as { __workerQueryCount?: number };
  w.__workerQueryCount = (w.__workerQueryCount ?? 0) + 1;
}

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
    case "distinctResult":
      onDistinctResult(msg);
      break;
    case "workerError":
      // eslint-disable-next-line no-console
      console.error("csv-viewer: worker error:", msg.message);
      break;
  }
}

function onInitResult(msg: { type: "initResult" } & WorkerResponse): void {
  if (!state) return;
  if (msg.requestId !== pendingInitRequestId) return;

  state.headers = msg.headers;
  state.detectedDelimiter = msg.detectedDelimiter;
  state.quoteProblems = msg.quoteProblems;
  state.totalRows = msg.totalRows;
  if (pendingInitIsFreshParse) state.quoteBannerDismissed = false;

  const previousVisibility = state.view.columnVisibility;
  const reconciled = reconcileVisibility(msg.headers, previousVisibility, state.defaultTableColumns, msg.columnProfiles);
  const visibilityChanged = !sameColumnVisibility(previousVisibility, reconciled);
  state.view.columnVisibility = reconciled;
  state.numericColumns = new Set(msg.headers.filter((_h, i) => isNumericColumn(msg.columnProfiles[i])));
  state.autoMarkdownColumns = new Set(msg.headers.filter((_h, i) => isAutoMarkdownColumn(msg.columnProfiles[i])));

  renderColumnsPopover();
  renderColumnsButton();
  renderFilterPanel();
  renderSeparatorControl();
  renderFormatButton();
  renderQuoteWarningBanner();
  renderHintBanner();

  if (visibilityChanged) saveState();

  // A timeout respawn kills the picker's pending distinct request, so ask again.
  if (valuesPicker && valuesPicker.items === null) requestDistinct();

  continueAfterInit();
}

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

function buildQueryKey(): string {
  if (!state) return "";
  const activeRules = state.view.filterRules
    .filter((r) => r.enabled && isRuleActive(r, state!.headers) && !state!.timedOutRuleIds.has(r.id))
    // `values` only matters to `in`; undefined is dropped by JSON.stringify.
    .map((r) => ({
      column: r.column,
      operator: r.operator,
      value: r.value,
      values: r.operator === "in" ? ruleValues(r) : undefined,
      mode: r.mode,
      caseSensitive: r.caseSensitive,
    }));
  return JSON.stringify({ q: state.view.quickSearch, rules: activeRules, sort: state.view.sortKeys });
}

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
    // A query for this key is already in flight; its onQueryResult consumes pendingPageAfterQuery.
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
  if (msg.requestId !== latestQueryRequestId) return;

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
  if (msg.requestId !== latestPageRequestId) return;
  state.currentPageRows = msg.rows;
  finishRender();
}

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

async function handleRegexTimeout(rulesSent: FilterRule[]): Promise<void> {
  if (!state) return;
  resetRegexWatchdogState(); // no other stale watchdog can fire during the respawn
  worker?.terminate();
  worker = null;

  for (const r of rulesSent) {
    if (r.enabled && r.operator === "regex" && isValidRule(r)) state.timedOutRuleIds.add(r.id);
  }
  renderFilterPanel();

  await respawnWorker();
  if (!state) return; // a load may have raced the respawn
  const delimiterOption = resolveDelimiterOption(state.view.delimiter, state.defaultDelimiter);
  beginInit(state.text, { delimiter: delimiterOption, firstRowIsHeader: state.view.firstRowIsHeader, quotes: state.view.quotes }, false);
}

function renderTableHead(): void {
  if (!state) return;
  const columns = visibleColumns(state.headers, state.view.columnVisibility);

  // Rebuilding the row drops focus; restore it by column name so keyboard sort cycling keeps working.
  let previousFocus: { column: string; kind: "sort" | "filter" } | null = null;
  if (document.activeElement instanceof HTMLElement && tableHead.contains(document.activeElement)) {
    const focusedColumn = document.activeElement.closest("th")?.dataset.column;
    if (focusedColumn !== undefined) {
      previousFocus = { column: focusedColumn, kind: document.activeElement.classList.contains("col-filter-btn") ? "filter" : "sort" };
    }
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

    const inner = document.createElement("div");
    inner.className = "th-inner";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "col-header-btn";
    btn.title = "Sort. Shift+click to add a secondary sort";

    const label = document.createElement("span");
    label.className = "col-header-label";
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
    inner.appendChild(btn);

    const funnel = document.createElement("button");
    funnel.type = "button";
    funnel.className = "col-filter-btn";
    const funnelLabel = `Filter ${column} by values`;
    funnel.title = funnelLabel;
    funnel.setAttribute("aria-label", funnelLabel);
    funnel.setAttribute("aria-haspopup", "dialog");
    funnel.setAttribute("aria-expanded", "false");
    const funnelIcon = document.createElement("span");
    funnelIcon.className = "codicon codicon-filter";
    funnelIcon.setAttribute("aria-hidden", "true");
    funnel.appendChild(funnelIcon);
    funnel.addEventListener("click", () => onFunnelClick(column));
    inner.appendChild(funnel);

    th.appendChild(inner);
    tr.appendChild(th);
  }

  tableHead.innerHTML = "";
  tableHead.appendChild(tr);
  syncFunnelStates();
  syncPickerExpanded();
  repositionValuesPicker();

  if (previousFocus !== null) {
    const th = tr.querySelector<HTMLTableCellElement>(`th.sortable[data-column="${CSS.escape(previousFocus.column)}"]`);
    th?.querySelector<HTMLButtonElement>(previousFocus.kind === "filter" ? ".col-filter-btn" : ".col-header-btn")?.focus();
  }
}

function columnHasActiveValuesRule(column: string): boolean {
  if (!state) return false;
  return state.view.filterRules.some((r) => r.operator === "in" && r.column === column && r.enabled && isRuleActive(r, state!.headers));
}

function syncFunnelStates(): void {
  for (const funnel of tableHead.querySelectorAll<HTMLButtonElement>(".col-filter-btn")) {
    const column = funnel.closest("th")?.dataset.column;
    const active = column !== undefined && columnHasActiveValuesRule(column);
    funnel.classList.toggle("active", active);
    const icon = funnel.querySelector(".codicon");
    if (icon) icon.className = `codicon ${active ? "codicon-filter-filled" : "codicon-filter"}`;
  }
}

function onHeaderClick(column: string, shiftKey: boolean): void {
  if (!state) return;
  state.view.sortKeys = cycleSortForColumn(state.view.sortKeys, column, shiftKey);
  requery();
  saveState();
}

let rowMouseDownPos: { x: number; y: number } | null = null;

function onRowMouseDown(ev: MouseEvent): void {
  rowMouseDownPos = { x: ev.clientX, y: ev.clientY };
}

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

  // Read before innerHTML is cleared below, which would blur the focused element.
  const hadRowFocus = document.activeElement instanceof HTMLElement && document.activeElement.classList.contains("data-row");

  tableBody.innerHTML = "";
  const columns = visibleColumns(state.headers, state.view.columnVisibility);
  const fragment = document.createDocumentFragment();

  if (state.totalRows === 0) {
    fragment.appendChild(buildEmptyStateRow(columns.length + 1, "zero-file"));
  } else if (state.filteredCount === 0) {
    fragment.appendChild(buildEmptyStateRow(columns.length + 1, "zero-matches"));
  } else {
    if (columns.length === 0) fragment.appendChild(buildEmptyStateRow(1, "all-hidden"));
    const rovingRowId = determineRovingRowId();
    for (const row of state.currentPageRows) {
      fragment.appendChild(buildRowTr(row, columns, rovingRowId));
      fragment.appendChild(buildDetailTr(row, columns.length + 1));
    }
    state.focusedRowId = hadRowFocus ? state.currentPageRows[0].id : rovingRowId;
  }

  tableBody.appendChild(fragment);
  updateDetailViewportWidth();
  populateExpandedDetails(columns);

  if (hadRowFocus && state.currentPageRows.length > 0) focusRowById(state.focusedRowId);
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

function buildRowTr(row: WorkerRow, columns: string[], rovingRowId: number | null): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.className = "data-row";
  tr.dataset.rowId = String(row.id);
  tr.tabIndex = row.id === rovingRowId ? 0 : -1;
  const expanded = state!.expanded.has(row.id);
  tr.setAttribute("aria-expanded", String(expanded));

  const chevronTd = document.createElement("td");
  chevronTd.className = "chevron-col";
  const twisty = document.createElement("button");
  twisty.type = "button";
  twisty.className = "twisty";
  twisty.tabIndex = -1;
  const chevronIcon = document.createElement("span");
  chevronIcon.className = `codicon ${expanded ? "codicon-chevron-down" : "codicon-chevron-right"}`;
  chevronIcon.setAttribute("aria-hidden", "true");
  twisty.appendChild(chevronIcon);
  twisty.setAttribute("aria-expanded", String(expanded));
  twisty.setAttribute("aria-controls", `detail-row-${row.id}`);
  twisty.setAttribute("aria-label", `${expanded ? "Hide" : "Show"} details for row ${row.id + 1}`);
  twisty.addEventListener("click", (ev) => {
    ev.stopPropagation();
    toggleExpanded(row.id);
  });
  chevronTd.appendChild(twisty);
  tr.appendChild(chevronTd);

  const indexByHeader = new Map(state!.headers.map((h, i) => [h, i]));
  for (const column of columns) {
    const td = document.createElement("td");
    if (state!.numericColumns.has(column)) td.classList.add("numeric-cell");
    const value = row.cells[indexByHeader.get(column)!] ?? "";
    // Rendered text is capped: a multi-megabyte cell froze the webview. Quick-add uses the full value.
    td.textContent = truncateForTable(value).text;
    td.addEventListener("mouseenter", () => {
      if (td.title) return;
      if (td.scrollWidth > td.clientWidth) {
        td.title = value.slice(0, 500);
        td.classList.add("clipped-cell");
      }
    });
    td.addEventListener("contextmenu", (ev) => onCellContextMenu(ev, column, value, row));
    tr.appendChild(td);
  }

  tr.addEventListener("mousedown", onRowMouseDown);
  tr.addEventListener("click", (ev) => onRowClick(ev, row.id));
  return tr;
}

function determineRovingRowId(): number | null {
  if (!state || state.currentPageRows.length === 0) return null;
  const focusedRowId = state.focusedRowId;
  if (focusedRowId !== null && state.currentPageRows.some((r) => r.id === focusedRowId)) return focusedRowId;
  return state.currentPageRows[0].id;
}

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

// Call only once rowTr is attached; a detached element reports scrollWidth === clientWidth.
function clippedVisibleColumnsForRow(rowTr: HTMLTableRowElement, columns: string[]): Set<string> {
  const cells = Array.from(rowTr.children).slice(1) as HTMLTableCellElement[];
  const result = new Set<string>();
  cells.forEach((td, i) => {
    const column = columns[i];
    if (column !== undefined && td.scrollWidth > td.clientWidth) result.add(column);
  });
  return result;
}

// Batch layout reads before DOM writes; interleaving forces a layout per row with many rows expanded.
function populateExpandedDetails(columns: string[]): void {
  if (!state) return;
  const toPopulate: { row: WorkerRow; rowTr: HTMLTableRowElement; detailTr: HTMLTableRowElement }[] = [];
  for (const row of state.currentPageRows) {
    if (!state.expanded.has(row.id)) continue;
    const rowTr = tableBody.querySelector<HTMLTableRowElement>(`tr.data-row[data-row-id="${row.id}"]`);
    const detailTr = document.getElementById(`detail-row-${row.id}`) as HTMLTableRowElement | null;
    if (rowTr && detailTr) toPopulate.push({ row, rowTr, detailTr });
  }
  const clippedSets = toPopulate.map(({ rowTr }) => clippedVisibleColumnsForRow(rowTr, columns));
  toPopulate.forEach(({ row, detailTr }, i) => populateDetailContent(row, detailTr, columns, clippedSets[i]));
}

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

  // Fill <dd> values only once attached: line-clamp overflow is measured via scrollHeight.
  const pending: PendingDetailValue[] = [];

  if (detailOnly.length === 0 && alsoInTable.length === 0) {
    wrap.appendChild(buildDetailFieldList(row, state.headers, indexByHeader, pending));
  } else {
    if (detailOnly.length > 0) wrap.appendChild(buildDetailFieldList(row, detailOnly, indexByHeader, pending));
    if (alsoInTable.length > 0) {
      const heading = document.createElement("p");
      heading.className = "detail-group-heading";
      heading.textContent = "Also in table";
      wrap.appendChild(heading);
      wrap.appendChild(buildDetailFieldList(row, alsoInTable, indexByHeader, pending));
    }
  }

  for (const { dd, column, value } of pending) populateDetailValue(dd, column, value);
}

interface PendingDetailValue {
  dd: HTMLElement;
  column: string;
  value: string;
}

const detailFieldInfo = new WeakMap<HTMLElement, { column: string; value: string }>();

function buildDetailFieldList(
  row: WorkerRow,
  fields: string[],
  indexByHeader: Map<string, number>,
  pending: PendingDetailValue[],
): HTMLDListElement {
  const dl = document.createElement("dl");
  dl.className = "detail-fields";

  for (const field of fields) {
    const value = row.cells[indexByHeader.get(field)!] ?? "";

    const dt = document.createElement("dt");
    const label = document.createElement("span");
    label.className = "detail-field-label";
    label.textContent = field;
    dt.appendChild(label);
    dt.appendChild(buildFieldCopyButton(field, value));

    const dd = document.createElement("dd");
    pending.push({ dd, column: field, value });
    detailFieldInfo.set(dd, { column: field, value });
    dd.addEventListener("contextmenu", (ev) => onCellContextMenu(ev, field, value, row));

    dl.appendChild(dt);
    dl.appendChild(dd);
  }

  return dl;
}

function buildFieldCopyButton(field: string, rawValue: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "icon-btn field-copy-btn";
  btn.setAttribute("aria-label", `Copy ${field} value`);
  const icon = document.createElement("span");
  icon.className = "codicon codicon-copy";
  icon.setAttribute("aria-hidden", "true");
  btn.appendChild(icon);
  let confirmHandle: number | undefined;
  btn.addEventListener("click", () => {
    void copyToClipboard(rawValue);
    window.clearTimeout(confirmHandle);
    icon.className = "codicon codicon-check";
    confirmHandle = window.setTimeout(() => {
      icon.className = "codicon codicon-copy";
    }, 1000);
  });
  return btn;
}

function emptyValueNode(): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "detail-empty-value";
  span.textContent = "—";
  return span;
}

function isMarkdownColumn(column: string): boolean {
  if (!state) return false;
  const explicit = getColumnFlag(state.view.markdownColumns, column);
  return explicit !== undefined ? explicit : state.autoMarkdownColumns.has(column);
}

const MARKDOWN_LINK_MIN_CHARS = 60;

function setColumnMarkdown(column: string, markdown: boolean, sourceDd: HTMLElement): void {
  if (!state) return;
  setColumnFlag(state.view.markdownColumns, column, markdown);
  for (const dd of tableBody.querySelectorAll<HTMLElement>("tr.detail-row:not([hidden]) dd")) {
    const info = detailFieldInfo.get(dd);
    if (!info || info.column !== column) continue;
    populateDetailValue(dd, info.column, info.value, dd === sourceDd);
  }
  sourceDd.querySelector<HTMLButtonElement>(".format-toggle-btn:not([hidden])")?.focus();
  saveState();
}

function populateDetailValue(dd: HTMLElement, column: string, rawValue: string, keepMarkdownLink = false): void {
  dd.innerHTML = "";
  if (rawValue === "") {
    dd.appendChild(emptyValueNode());
    return;
  }

  const parsedJson = tryParseJsonValue(rawValue);
  const isJson = parsedJson !== null;
  const formatted = isJson ? formatJsonText(rawValue) : "";
  const markdownCapable = !isJson && rawValue.length <= MARKDOWN_MAX_CHARS;
  const markdownMode = markdownCapable && isMarkdownColumn(column);
  const showMarkdownLink =
    markdownCapable && !markdownMode && (keepMarkdownLink || rawValue.includes("\n") || rawValue.length > MARKDOWN_LINK_MIN_CHARS || looksLikeMarkdown(rawValue));

  let formatMode: "raw" | "formatted" = isJson ? "formatted" : "raw";
  let charExpanded = false;
  let heightExpanded = false;

  const valueText = document.createElement("span");
  valueText.className = "detail-value-text";
  valueText.hidden = markdownMode;
  dd.appendChild(valueText);

  // Block-level HTML cannot live inside the span above, so rendered Markdown gets its own block.
  const markdownBlock = document.createElement("div");
  markdownBlock.className = "detail-value-md";
  markdownBlock.hidden = !markdownMode;
  dd.appendChild(markdownBlock);

  const controls = document.createElement("div");
  controls.className = "detail-value-controls";
  dd.appendChild(controls);

  const formatToggle = document.createElement("button");
  formatToggle.type = "button";
  formatToggle.className = "link-btn format-toggle-btn";
  formatToggle.classList.toggle("md-toggle-btn", !isJson);
  formatToggle.hidden = !(isJson || markdownMode || showMarkdownLink);
  controls.appendChild(formatToggle);

  const heightToggle = document.createElement("button");
  heightToggle.type = "button";
  heightToggle.className = "link-btn height-toggle-btn";
  heightToggle.hidden = true;
  controls.appendChild(heightToggle);

  const charToggle = document.createElement("button");
  charToggle.type = "button";
  charToggle.className = "link-btn show-all-btn";
  charToggle.hidden = true;
  controls.appendChild(charToggle);

  function currentSource(): string {
    return formatMode === "formatted" ? formatted : rawValue;
  }

  function render(): void {
    const source = currentSource();
    const { text, truncated, fullLength } = truncateForDetail(source);
    const shown = charExpanded ? source : text;
    let clampEl: HTMLElement;
    let clampClass: string;
    if (markdownMode) {
      // The only innerHTML fed from cell content; renderMarkdown escapes raw HTML and restricts links.
      markdownBlock.innerHTML = renderMarkdown(shown);
      valueText.textContent = "";
      clampEl = markdownBlock;
      clampClass = "detail-value-md-clamped";
    } else {
      valueText.textContent = shown;
      valueText.classList.toggle("detail-value-json", isJson && formatMode === "formatted");
      clampEl = valueText;
      clampClass = "detail-value-clamped";
    }

    // Measure overflow unclamped; scrollHeight right after adding the clamp class can be stale.
    clampEl.classList.remove(clampClass);
    const lineHeight = parseFloat(getComputedStyle(clampEl).lineHeight) || parseFloat(getComputedStyle(clampEl).fontSize) * 1.2 || 16;
    const overflowing = clampEl.scrollHeight > lineHeight * 6 + 1;
    clampEl.classList.toggle(clampClass, !heightExpanded);

    // `hidden` keeps textContent, so hidden controls are cleared to keep it out of the dd's text.
    if (isJson) formatToggle.textContent = formatMode === "formatted" ? "Raw" : "Formatted";
    else formatToggle.textContent = markdownMode ? "Raw" : showMarkdownLink ? "Markdown" : "";

    charToggle.hidden = !truncated;
    if (truncated) {
      charToggle.textContent = charExpanded ? "Show less" : `Show all (${fullLength.toLocaleString()} characters)`;
      if (!charExpanded && fullLength > DETAIL_WARN_CHARS) {
        charToggle.title = "This value is very large — showing it in full may be slow.";
      } else {
        charToggle.removeAttribute("title");
      }
    } else {
      charToggle.textContent = "";
      charToggle.removeAttribute("title");
    }

    heightToggle.hidden = !overflowing;
    heightToggle.textContent = overflowing ? (heightExpanded ? "Less" : "More") : "";
  }

  formatToggle.addEventListener("click", () => {
    if (!isJson) {
      setColumnMarkdown(column, !markdownMode, dd);
      return;
    }
    formatMode = formatMode === "formatted" ? "raw" : "formatted";
    charExpanded = false;
    heightExpanded = false;
    render();
  });
  heightToggle.addEventListener("click", () => {
    heightExpanded = !heightExpanded;
    render();
  });
  charToggle.addEventListener("click", () => {
    charExpanded = !charExpanded;
    render();
  });

  render();
}

function toggleExpanded(rowId: number): void {
  if (!state) return;
  const opening = !state.expanded.has(rowId);
  if (opening) state.expanded.add(rowId);
  else state.expanded.delete(rowId);
  if (opening) markHintSeen("rowDetails");
  renderExpandCollapseButton();

  const rowTr = tableBody.querySelector<HTMLTableRowElement>(`tr.data-row[data-row-id="${rowId}"]`);
  const detailTr = document.getElementById(`detail-row-${rowId}`) as HTMLTableRowElement | null;
  rowTr?.setAttribute("aria-expanded", String(opening));
  const twisty = rowTr?.querySelector<HTMLButtonElement>(".twisty");
  if (twisty) {
    const icon = twisty.querySelector(".codicon");
    if (icon) icon.className = `codicon ${opening ? "codicon-chevron-down" : "codicon-chevron-right"}`;
    twisty.setAttribute("aria-expanded", String(opening));
    twisty.setAttribute("aria-label", `${opening ? "Hide" : "Show"} details for row ${rowId + 1}`);
  }
  if (detailTr) {
    // Unhide before populating: the height-clamp measurement needs layout, which display: none lacks.
    detailTr.hidden = !opening;
    if (opening && rowTr) {
      const columns = visibleColumns(state.headers, state.view.columnVisibility);
      const row = state.currentPageRows.find((r) => r.id === rowId);
      if (row) populateDetailContent(row, detailTr, columns, clippedVisibleColumnsForRow(rowTr, columns));
    }
  }
}

function focusRowById(rowId: number | null): void {
  if (!state || rowId === null) return;
  state.focusedRowId = rowId;
  const rows = tableBody.querySelectorAll<HTMLTableRowElement>("tr.data-row");
  rows.forEach((tr) => {
    tr.tabIndex = Number(tr.dataset.rowId) === rowId ? 0 : -1;
  });
  tableBody.querySelector<HTMLTableRowElement>(`tr.data-row[data-row-id="${rowId}"]`)?.focus();
}

function focusRowAtIndex(index: number): void {
  if (!state || state.currentPageRows.length === 0) return;
  const clamped = Math.max(0, Math.min(index, state.currentPageRows.length - 1));
  focusRowById(state.currentPageRows[clamped].id);
}

function moveRowFocus(delta: number): void {
  if (!state || state.currentPageRows.length === 0) return;
  const currentIndex = state.currentPageRows.findIndex((r) => r.id === state!.focusedRowId);
  focusRowAtIndex((currentIndex === -1 ? 0 : currentIndex) + delta);
}

function onRowKeyDown(ev: KeyboardEvent): void {
  if (!state) return;
  const tr = (ev.target as HTMLElement).closest<HTMLTableRowElement>("tr.data-row");
  if (!tr) return;
  const rowId = Number(tr.dataset.rowId);

  switch (ev.key) {
    case "ArrowDown":
      ev.preventDefault();
      moveRowFocus(1);
      break;
    case "ArrowUp":
      ev.preventDefault();
      moveRowFocus(-1);
      break;
    case "Home":
      ev.preventDefault();
      focusRowAtIndex(0);
      break;
    case "End":
      ev.preventDefault();
      focusRowAtIndex(state.currentPageRows.length - 1);
      break;
    case "ArrowRight":
      ev.preventDefault();
      if (!state.expanded.has(rowId)) toggleExpanded(rowId);
      break;
    case "ArrowLeft":
      ev.preventDefault();
      if (state.expanded.has(rowId)) toggleExpanded(rowId);
      break;
    case "Enter":
    case " ":
      ev.preventDefault();
      toggleExpanded(rowId);
      break;
    case "F10":
      if (ev.shiftKey) {
        ev.preventDefault();
        openRowContextMenu(rowId, tr);
      }
      break;
    case "ContextMenu":
      ev.preventDefault();
      openRowContextMenu(rowId, tr);
      break;
  }
}

tableBody.addEventListener("keydown", onRowKeyDown);

function renderStatusBar(): void {
  if (!state) return;
  statusBar.textContent = `Showing ${state.filteredCount.toLocaleString()} of ${state.totalRows.toLocaleString()} rows`;
}

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

// `force` refetches when a page-size change lands on the same page number but different rows.
function requestPage(page: number, force = false): void {
  if (!state) return;
  if (queryInFlight) {
    pendingPageAfterQuery = page;
    pagerPageInput.value = String(page);
    return;
  }
  const clamped = clampPage(page, state.filteredCount, state.view.pageSize);
  if (!force && clamped === state.page) {
    renderPagerBar();
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
    renderPagerBar();
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

firstRowHeaderCheckbox.addEventListener("change", () => {
  if (!state) return;
  state.view.firstRowIsHeader = firstRowHeaderCheckbox.checked;
  reparseFromText({ resetPage: false });
  saveState();
});

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
    // Deliberately not trimmed: a single space or tab is a valid delimiter.
    const value = separatorCustomInput.value;
    if (value === "") {
      hideSeparatorCustomError();
      applySeparatorChange("");
      return;
    }
    // A double quote is the quote char while quoting is on, so it cannot also be the delimiter.
    if (state.view.quotes && value.includes('"')) {
      showSeparatorQuoteConflictError(value);
      return;
    }
    hideSeparatorCustomError();
    applySeparatorChange(value);
  }, SEPARATOR_DEBOUNCE_MS);
});

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

openAsTextBtn.addEventListener("click", () => {
  vscode.postMessage({ type: "openAsText" });
});

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

const ALL_POPOVERS: HTMLElement[] = [columnsPopover, filterPanel, sortPopover, formatPopover, valuesPopover];
const POPOVER_TRIGGERS: HTMLButtonElement[] = [columnsBtn, filtersBtn, sortBtn, formatBtn];

let activePopoverEl: HTMLElement | null = null;
let activePopoverTrigger: HTMLButtonElement | null = null;

function positionPopoverNear(el: HTMLElement, trigger: HTMLElement): void {
  positionPopoverAtRect(el, trigger.getBoundingClientRect());
}

function positionPopoverAtRect(el: HTMLElement, triggerRect: { left: number; top: number; bottom: number }): void {
  const margin = 8;
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
  repositionValuesPicker();
}

window.addEventListener("resize", repositionOpenPopover);

function closeAllPopovers(returnFocusToTrigger = false): void {
  const trigger = activePopoverTrigger;
  discardValuesPicker();
  for (const el of ALL_POPOVERS) el.hidden = true;
  for (const btn of POPOVER_TRIGGERS) btn.setAttribute("aria-expanded", "false");
  activePopoverEl = null;
  activePopoverTrigger = null;
  if (returnFocusToTrigger) trigger?.focus();
}

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

// Capture phase, so a click on a row through an open popover closes it without also toggling the row.
document.addEventListener(
  "click",
  (ev) => {
    const openEl = activePopoverEl && !activePopoverEl.hidden ? activePopoverEl : null;
    if (!openEl && !valuesPicker) return;
    const target = ev.target as Node;
    if (valuesPicker) {
      if (valuesPopover.contains(target)) return;
      if (valuesPicker.anchor === "panel" && filterPanel.contains(target) && !isValuesTrigger(target)) {
        discardValuesPicker();
        return;
      }
    }
    if (openEl && openEl.contains(target)) return;
    if (contextMenu.contains(target)) return;
    if (target instanceof Element && POPOVER_TRIGGERS.some((btn) => btn.contains(target))) return;
    if (isValuesTrigger(target)) return;
    if (target instanceof Element && target.closest("tr.data-row")) {
      ev.stopPropagation();
      ev.preventDefault();
    }
    closeAllPopovers();
  },
  true,
);

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
      renderLocalOnly();
      saveState();
    });
    label.appendChild(checkbox);
    const span = document.createElement("span");
    span.textContent = header;
    label.appendChild(span);
    columnsList.appendChild(label);
  }
}

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

const OPERATORS: { value: FilterOperator; label: string; needsValue: boolean }[] = [
  { value: "contains", label: "contains", needsValue: true },
  { value: "equals", label: "equals", needsValue: true },
  { value: "in", label: "is any of", needsValue: false },
  { value: "startsWith", label: "starts with", needsValue: true },
  { value: "endsWith", label: "ends with", needsValue: true },
  { value: "regex", label: "regex", needsValue: true },
  { value: "isEmpty", label: "is empty", needsValue: false },
  { value: "gt", label: "> (number)", needsValue: true },
  { value: "lt", label: "< (number)", needsValue: true },
  { value: "gte", label: ">= (number)", needsValue: true },
  { value: "lte", label: "<= (number)", needsValue: true },
];

function requery(): void {
  if (!state) return;
  pendingPageAfterQuery = 1;
  runQuery();
}

// Shared debounce: an undebounced requery re-filters and re-sorts the whole dataset in the worker.
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
  syncPickerExpanded();
}

function buildRuleRow(rule: FilterRule): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "rule-row";
  row.dataset.ruleId = rule.id;

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
    if (rule.values !== undefined) rule.values = [];
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
    syncValueControls();
    state?.timedOutRuleIds.delete(rule.id);
    syncRuleError();
    debouncedRequery();
  });
  row.appendChild(operatorSelect);

  const valueInput = document.createElement("input");
  valueInput.type = "text";
  valueInput.value = rule.value;
  valueInput.placeholder = "Value";
  valueInput.addEventListener("input", () => {
    rule.value = valueInput.value;
    state?.timedOutRuleIds.delete(rule.id);
    syncRuleError();
    debouncedRequery();
  });
  row.appendChild(valueInput);

  const valuesBtn = document.createElement("button");
  valuesBtn.type = "button";
  valuesBtn.className = "values-btn";
  valuesBtn.setAttribute("aria-haspopup", "dialog");
  valuesBtn.setAttribute("aria-expanded", "false");
  valuesBtn.addEventListener("click", () => {
    if (!state) return;
    if (valuesPicker && valuesPicker.anchor === "panel" && valuesPicker.ruleId === rule.id) {
      closeValuesPicker(false);
      return;
    }
    if (rule.column === null) return;
    openValuesPicker({ column: rule.column, ruleId: rule.id, anchor: "panel" });
  });
  row.appendChild(valuesBtn);

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

  function syncValueControls(): void {
    const isIn = rule.operator === "in";
    valueInput.hidden = rule.operator === "isEmpty" || isIn;
    caseLabel.hidden = isIn;
    valuesBtn.hidden = !isIn;
  }
  syncValueControls();

  function syncValuesBtn(): void {
    const values = ruleValues(rule);
    valuesBtn.disabled = rule.column === null;
    valuesBtn.replaceChildren();
    const text = document.createElement("span");
    text.className = "values-btn-text";
    if (values.length === 0) {
      text.textContent = "Choose values…";
    } else {
      text.appendChild(document.createTextNode(summarizeValues(values)));
      const count = document.createElement("span");
      count.className = "muted";
      count.textContent = ` (${values.length})`;
      text.appendChild(count);
    }
    const chevron = document.createElement("span");
    chevron.className = "codicon codicon-chevron-down";
    chevron.setAttribute("aria-hidden", "true");
    valuesBtn.appendChild(text);
    valuesBtn.appendChild(chevron);
  }

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

  function syncRuleError(): void {
    if (!state) return;
    const timedOut = state.timedOutRuleIds.has(rule.id);
    const regexInvalid = !timedOut && !isValidRule(rule);
    const columnMissing = !timedOut && !regexInvalid && rule.column !== null && state.headers.indexOf(rule.column) === -1;
    const usable = !timedOut && !regexInvalid && !columnMissing;
    const isIn = rule.operator === "in";
    const needsValue = usable && !isIn && rule.operator !== "isEmpty" && rule.value === "";
    const needsColumn = usable && isIn && rule.column === null;
    const needsValues = usable && isIn && rule.column !== null && ruleValues(rule).length === 0;
    const inactive = timedOut || !isRuleActive(rule, state.headers);
    row.classList.toggle("rule-error", inactive && (timedOut || regexInvalid || columnMissing));
    row.classList.toggle("rule-hint", inactive && (needsValue || needsColumn || needsValues));
    error.innerHTML = "";
    let message: string | null = null;
    if (timedOut) message = "Skipped: pattern took over 2 s. Edit it to retry.";
    else if (regexInvalid) message = `Skipped: invalid regex (${regexErrorMessage(rule.value) ?? "unknown error"})`;
    else if (columnMissing) message = `Skipped: column "${rule.column}" isn't in this file`;
    else if (needsValue) message = "Enter a value";
    else if (needsColumn) message = "Choose a column";
    else if (needsValues) message = "Choose values";
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
    syncValuesBtn();
    renderFiltersButton();
  }
  syncRuleError();

  return row;
}

const VALUES_MAX_RENDERED = 500;
const VALUES_MAX_LABEL_CHARS = 80;

interface ValuesPickerState {
  column: string;
  ruleId: string | null;
  mode: FilterMode;
  anchor: "funnel" | "panel" | "point";
  point: { x: number; y: number } | null;
  requestId: number;
  items: DistinctValue[] | null;
  truncated: boolean;
  selected: Set<string>;
  search: string;
}

let valuesPicker: ValuesPickerState | null = null;

function findFunnel(column: string): HTMLButtonElement | null {
  return tableHead.querySelector<HTMLButtonElement>(`th.sortable[data-column="${CSS.escape(column)}"] .col-filter-btn`);
}

function findValuesBtn(ruleId: string | null): HTMLButtonElement | null {
  if (ruleId === null) return null;
  return filterRulesEl.querySelector<HTMLButtonElement>(`.rule-row[data-rule-id="${CSS.escape(ruleId)}"] .values-btn`);
}

function isValuesTrigger(target: Node): boolean {
  return target instanceof Element && target.closest(".col-filter-btn, .values-btn") !== null;
}

function firstValuesRule(column: string): FilterRule | undefined {
  return state?.view.filterRules.find((r) => r.operator === "in" && r.column === column);
}

function syncPickerExpanded(): void {
  const p = valuesPicker;
  for (const funnel of tableHead.querySelectorAll<HTMLButtonElement>(".col-filter-btn")) {
    const expanded = p !== null && p.anchor === "funnel" && funnel.closest("th")?.dataset.column === p.column;
    funnel.setAttribute("aria-expanded", String(expanded));
  }
  for (const btn of filterRulesEl.querySelectorAll<HTMLButtonElement>(".values-btn")) {
    const expanded = p !== null && p.anchor === "panel" && btn.closest<HTMLElement>(".rule-row")?.dataset.ruleId === p.ruleId;
    btn.setAttribute("aria-expanded", String(expanded));
  }
}

function repositionValuesPicker(): void {
  const p = valuesPicker;
  if (!p || valuesPopover.hidden) return;
  const anchorEl = p.anchor === "funnel" ? findFunnel(p.column) : p.anchor === "panel" ? findValuesBtn(p.ruleId) : null;
  if (anchorEl) positionPopoverNear(valuesPopover, anchorEl);
  else if (p.point) positionPopoverAtRect(valuesPopover, { left: p.point.x, top: p.point.y, bottom: p.point.y - 4 });
}

function onFunnelClick(column: string): void {
  if (!state) return;
  if (valuesPicker && valuesPicker.anchor === "funnel" && valuesPicker.column === column) {
    closeValuesPicker(false);
    return;
  }
  openValuesPicker({ column, ruleId: firstValuesRule(column)?.id ?? null, anchor: "funnel" });
}

function openValuesPickerFromMenu(column: string, x: number, y: number): void {
  const ruleId = firstValuesRule(column)?.id ?? null;
  if (findFunnel(column)) openValuesPicker({ column, ruleId, anchor: "funnel" });
  else openValuesPicker({ column, ruleId, anchor: "point", point: { x, y } });
}

function openValuesPicker(opts: {
  column: string;
  ruleId: string | null;
  anchor: ValuesPickerState["anchor"];
  point?: { x: number; y: number };
}): void {
  if (!state) return;
  if (opts.anchor === "panel") discardValuesPicker();
  else closeAllPopovers();

  const rule = opts.ruleId === null ? undefined : state.view.filterRules.find((r) => r.id === opts.ruleId);
  const mode: FilterMode = rule?.mode ?? "include";
  const title = mode === "exclude" ? `Hide rows where “${opts.column}” is any of` : `Filter “${opts.column}” by values`;
  valuesPicker = {
    column: opts.column,
    ruleId: rule?.id ?? null,
    mode,
    anchor: opts.anchor,
    point: opts.point ?? null,
    requestId: -1,
    items: null,
    truncated: false,
    selected: new Set<string>(),
    search: "",
  };
  valuesTitle.textContent = title;
  valuesPopover.setAttribute("aria-label", title);
  valuesSearch.value = "";
  valuesPopover.hidden = false;
  renderValuesPicker();
  syncPickerExpanded();
  repositionValuesPicker();
  valuesSearch.focus();
  requestDistinct();
}

function requestDistinct(): void {
  const p = valuesPicker;
  if (!p) return;
  p.requestId = nextRequestId++;
  postToWorker({ type: "distinct", requestId: p.requestId, column: p.column });
}

function onDistinctResult(msg: Extract<WorkerResponse, { type: "distinctResult" }>): void {
  const p = valuesPicker;
  if (!state || !p || msg.requestId !== p.requestId || msg.column !== p.column) return;
  const rule = p.ruleId === null ? undefined : state.view.filterRules.find((r) => r.id === p.ruleId);
  if (rule) {
    // Rule values the file no longer has stay listed (count 0) so they can be unticked.
    const listed = new Set(msg.values.map((v) => v.value));
    const missing = [...new Set(ruleValues(rule))].filter((v) => !listed.has(v)).map((value) => ({ value, count: 0 }));
    p.items = [...missing, ...msg.values];
    p.selected = new Set(ruleValues(rule));
  } else {
    p.items = msg.values;
    p.selected = new Set(msg.values.map((v) => v.value));
  }
  p.truncated = msg.truncated;
  renderValuesPicker();
  repositionValuesPicker();
}

function valueDisplayText(value: string): string {
  if (value === "") return BLANKS_LABEL;
  return value.length > VALUES_MAX_LABEL_CHARS ? `${value.slice(0, VALUES_MAX_LABEL_CHARS)}…` : value;
}

function shownValues(p: ValuesPickerState): DistinctValue[] {
  if (!p.items) return [];
  if (p.search === "") return p.items;
  const needle = foldCase(p.search);
  return p.items.filter((item) => foldCase(item.value === "" ? BLANKS_LABEL : item.value).includes(needle));
}

function renderValuesSelection(): void {
  const p = valuesPicker;
  if (!p) return;
  valuesSelectedCount.textContent = p.items ? `${p.selected.size} of ${p.items.length} selected` : "";
  valuesOkBtn.disabled = p.items === null || p.selected.size === 0;
}

function renderValuesPicker(): void {
  const p = valuesPicker;
  if (!p) return;
  valuesList.replaceChildren();
  valuesNoteShown.hidden = true;
  valuesNoteTruncated.hidden = true;

  if (p.items === null) {
    const loading = document.createElement("p");
    loading.className = "vp-empty";
    loading.textContent = "Loading values…";
    valuesList.appendChild(loading);
    valuesSelectAllBtn.textContent = "Select all";
    valuesSelectAllBtn.disabled = true;
    valuesClearBtn.disabled = true;
    renderValuesSelection();
    return;
  }

  const shown = shownValues(p);
  valuesSelectAllBtn.textContent = `Select all ${shown.length}`;
  valuesSelectAllBtn.disabled = false;
  valuesClearBtn.disabled = false;

  if (shown.length === 0) {
    const none = document.createElement("p");
    none.className = "vp-empty";
    none.textContent = "No values match";
    valuesList.appendChild(none);
  }
  const fragment = document.createDocumentFragment();
  for (const item of shown.slice(0, VALUES_MAX_RENDERED)) {
    const label = document.createElement("label");
    label.className = item.value === "" ? "vp-row blank" : "vp-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = p.selected.has(item.value);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) p.selected.add(item.value);
      else p.selected.delete(item.value);
      renderValuesSelection();
    });
    const text = document.createElement("span");
    text.className = "v";
    text.textContent = valueDisplayText(item.value);
    if (item.value.length > VALUES_MAX_LABEL_CHARS) text.title = item.value.slice(0, 500);
    const count = document.createElement("span");
    count.className = "n";
    count.textContent = item.count.toLocaleString();
    label.appendChild(checkbox);
    label.appendChild(text);
    label.appendChild(count);
    fragment.appendChild(label);
  }
  valuesList.appendChild(fragment);

  if (shown.length > VALUES_MAX_RENDERED) {
    valuesNoteShown.textContent = `Showing the first ${VALUES_MAX_RENDERED} of ${shown.length}. Search to narrow.`;
    valuesNoteShown.hidden = false;
  }
  if (p.truncated) {
    valuesNoteTruncated.textContent = "This column has more than 10,000 distinct values; only the first 10,000 are listed.";
    valuesNoteTruncated.hidden = false;
  }
  renderValuesSelection();
}

valuesSearch.addEventListener("input", () => {
  if (!valuesPicker) return;
  valuesPicker.search = valuesSearch.value;
  renderValuesPicker();
});

valuesSelectAllBtn.addEventListener("click", () => {
  const p = valuesPicker;
  if (!p) return;
  for (const item of shownValues(p)) p.selected.add(item.value);
  renderValuesPicker();
});

valuesClearBtn.addEventListener("click", () => {
  const p = valuesPicker;
  if (!p) return;
  for (const item of shownValues(p)) p.selected.delete(item.value);
  renderValuesPicker();
});

valuesCancelBtn.addEventListener("click", () => closeValuesPicker(true));
valuesOkBtn.addEventListener("click", () => applyValuesPicker());

// Ignore Enter that only commits an IME composition; buttons keep their native Enter behaviour.
valuesPopover.addEventListener("keydown", (ev) => {
  if (ev.key !== "Enter" || ev.isComposing || !(ev.target instanceof HTMLInputElement)) return;
  ev.preventDefault();
  if (!valuesOkBtn.disabled) applyValuesPicker();
});

function discardValuesPicker(): void {
  valuesPicker = null;
  valuesPopover.hidden = true;
  syncPickerExpanded();
}

function focusPickerOrigin(p: ValuesPickerState): void {
  if (p.anchor === "funnel") {
    findFunnel(p.column)?.focus();
  } else if (p.anchor === "panel") {
    const btn = findValuesBtn(p.ruleId);
    if (btn) btn.focus();
    else if (!filterPanel.hidden) addRuleBtn.focus();
  }
}

function closeValuesPicker(returnFocus: boolean): void {
  const p = valuesPicker;
  discardValuesPicker();
  if (returnFocus && p) focusPickerOrigin(p);
}

function applyValuesPicker(): void {
  const p = valuesPicker;
  if (!state || !p || p.items === null || p.selected.size === 0) return;
  const values = p.items.filter((item) => p.selected.has(item.value)).map((item) => item.value);
  const rule = p.ruleId === null ? undefined : state.view.filterRules.find((r) => r.id === p.ruleId);
  const mode = rule?.mode ?? "include";
  const everything = !p.truncated && values.length === p.items.length;

  if (mode === "include" && everything) {
    if (rule) {
      state.view.filterRules = state.view.filterRules.filter((r) => r.id !== rule.id);
      state.timedOutRuleIds.delete(rule.id);
    }
  } else if (rule) {
    rule.values = values;
    rule.enabled = true;
  } else {
    state.view.filterRules.push({
      id: newRuleId(),
      column: p.column,
      operator: "in",
      value: "",
      values,
      mode: "include",
      caseSensitive: false,
      enabled: true,
    });
  }

  discardValuesPicker();
  renderFilterPanel();
  requery();
  saveState();
  // Focus after the panel re-render, which rebuilds the rule rows.
  focusPickerOrigin(p);
}

async function copyToClipboard(value: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {
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

function truncateForMenuLabel(value: string, maxChars = 40): string {
  return value.length > maxChars ? value.slice(0, maxChars) + "…" : value;
}

let contextMenuInvoker: HTMLElement | null = null;

function closeContextMenu(): void {
  contextMenu.hidden = true;
  const invoker = contextMenuInvoker;
  contextMenuInvoker = null;
  invoker?.focus();
}

function onCellContextMenu(ev: MouseEvent, column: string, value: string, row: WorkerRow): void {
  ev.preventDefault();
  contextMenu.innerHTML = "";
  contextMenuInvoker = null;

  const copyItem = document.createElement("button");
  copyItem.type = "button";
  copyItem.setAttribute("role", "menuitem");
  copyItem.textContent = "Copy Value";
  copyItem.addEventListener("click", () => {
    void copyToClipboard(value);
    closeContextMenu();
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

  const valuesItem = document.createElement("button");
  valuesItem.type = "button";
  valuesItem.setAttribute("role", "menuitem");
  valuesItem.textContent = `Filter ${column} by Values…`;
  valuesItem.addEventListener("click", () => {
    closeContextMenu();
    openValuesPickerFromMenu(column, ev.clientX, ev.clientY);
  });

  contextMenu.appendChild(includeItem);
  contextMenu.appendChild(excludeItem);
  contextMenu.appendChild(valuesItem);
  contextMenu.appendChild(document.createElement("hr"));
  for (const item of buildCopyRowItems(row)) contextMenu.appendChild(item);

  // position: fixed needs client coordinates; page coordinates drift once the table has scrolled.
  contextMenu.style.left = `${ev.clientX}px`;
  contextMenu.style.top = `${ev.clientY}px`;
  contextMenu.hidden = false;
  clampContextMenuToViewport(ev.clientX, ev.clientY);
}

function rowToCsvLine(headers: string[], row: WorkerRow): string {
  const quote = (field: string): string => (/[",\r\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field);
  return headers.map((_, i) => quote(row.cells[i] ?? "")).join(",");
}

function rowToJsonText(headers: string[], row: WorkerRow): string {
  // Null prototype so a header named `__proto__` becomes an ordinary key.
  const obj: Record<string, string> = Object.create(null);
  headers.forEach((h, i) => {
    obj[h] = row.cells[i] ?? "";
  });
  return JSON.stringify(obj, null, 2);
}

function buildCopyRowItems(row: WorkerRow): HTMLButtonElement[] {
  const csvItem = document.createElement("button");
  csvItem.type = "button";
  csvItem.setAttribute("role", "menuitem");
  csvItem.textContent = "Copy Row as CSV";
  csvItem.addEventListener("click", () => {
    void copyToClipboard(rowToCsvLine(state!.headers, row));
    closeContextMenu();
  });

  const jsonItem = document.createElement("button");
  jsonItem.type = "button";
  jsonItem.setAttribute("role", "menuitem");
  jsonItem.textContent = "Copy Row as JSON";
  jsonItem.addEventListener("click", () => {
    void copyToClipboard(rowToJsonText(state!.headers, row));
    closeContextMenu();
  });

  return [csvItem, jsonItem];
}

function openRowContextMenu(rowId: number, anchorEl: HTMLTableRowElement): void {
  if (!state) return;
  const row = state.currentPageRows.find((r) => r.id === rowId);
  if (!row) return;
  contextMenu.innerHTML = "";
  for (const item of buildCopyRowItems(row)) contextMenu.appendChild(item);

  const rect = anchorEl.getBoundingClientRect();
  contextMenu.style.left = `${rect.left}px`;
  contextMenu.style.top = `${rect.bottom}px`;
  contextMenu.hidden = false;
  clampContextMenuToViewport(rect.left, rect.bottom);
  contextMenuInvoker = anchorEl;
  contextMenu.querySelector<HTMLButtonElement>("button")?.focus();
}

contextMenu.addEventListener("keydown", (ev) => {
  const items = Array.from(contextMenu.querySelectorAll<HTMLButtonElement>("button"));
  if (items.length === 0) return;
  const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
  if (ev.key === "ArrowDown") {
    ev.preventDefault();
    items[(currentIndex + 1 + items.length) % items.length]?.focus();
  } else if (ev.key === "ArrowUp") {
    ev.preventDefault();
    items[(currentIndex - 1 + items.length) % items.length]?.focus();
  } else if (ev.key === "Escape") {
    ev.preventDefault();
    ev.stopPropagation();
    closeContextMenu();
  }
});

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
  closeContextMenu();
  renderFilterPanel();
  openFilterPanel(filtersBtn);
  requery();
  saveState();
}

document.addEventListener("click", (ev) => {
  if (contextMenu.hidden) return;
  if (!contextMenu.contains(ev.target as Node)) closeContextMenu();
});

document.addEventListener("keydown", (ev) => {
  // VS Code's webview swallows the native Find shortcut, so focus the quick search box instead.
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "f") {
    ev.preventDefault();
    quickSearchInput.focus();
    quickSearchInput.select();
    return;
  }

  if (ev.key === "Escape") {
    if (!contextMenu.hidden) closeContextMenu();
    if (valuesPicker) {
      closeValuesPicker(true);
      return;
    }
    if (activePopoverEl) closeAllPopovers(true);
    return;
  }

  // Skip form controls: Alt+←/→ has native cursor and selection behaviour inside them.
  if (ev.altKey && (ev.key === "ArrowLeft" || ev.key === "ArrowRight")) {
    const tag = (ev.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (!state) return;
    ev.preventDefault();
    requestPage(state.page + (ev.key === "ArrowRight" ? 1 : -1));
  }
});
