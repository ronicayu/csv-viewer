// CSV Viewer webview client. Vanilla TypeScript + DOM, no framework and no
// runtime dependencies. Receives parsed rows from the extension host and
// owns filtering, sorting, column visibility, and pagination.

import { parseCsv } from "../core/csvParse";
import { applyFilters, isValidRule } from "../core/filter";
import { sortRows, cycleSortForColumn } from "../core/sort";
import { detailFieldsFor, reconcileVisibility, visibleColumns } from "../core/columns";
import { PAGE_SIZES, clampPage, normalizePageSize, pageCount, pageForRow, pageSlice } from "../core/paging";
import type {
  ColumnVisibilityMap,
  FilterOperator,
  FilterRule,
  HostToWebviewMessage,
  ViewState,
  WebviewToHostMessage,
} from "../core/types";

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewToHostMessage): void;
  setState(state: unknown): void;
  getState(): unknown;
};

const vscode = acquireVsCodeApi();

const SEARCH_DEBOUNCE_MS = 150;
const SEPARATOR_DEBOUNCE_MS = 300;

/** Presets for the "Separator" toolbar dropdown, in display order. Tab is
 * labeled with the word "Tab" rather than a literal tab character. */
const PRESET_DELIMITERS: { value: string; label: string }[] = [
  { value: ",", label: "Comma ," },
  { value: ";", label: "Semicolon ;" },
  { value: "\t", label: "Tab" },
  { value: "|", label: "Pipe |" },
];
const CUSTOM_SENTINEL = "custom";

function delimiterDisplay(d: string): string {
  return d === "\t" ? "Tab" : d;
}

interface RowWithId {
  id: number;
  cells: string[];
}

interface AppState {
  fileKey: string;
  /** The whole document text, held onto so the "first row is header"
   * toggle and separator changes can re-parse locally without a host
   * round-trip. */
  text: string;
  /** `"\t"` for .tsv/.tab, else `""` — the delimiter to fall back to when
   * `view.delimiter` is `""` (auto). */
  defaultDelimiter: string;
  headers: string[];
  rows: RowWithId[];
  view: ViewState;
  defaultTableColumns: number;
  expanded: Set<number>;
  filtered: RowWithId[];
  /** 1-based. Not persisted — only pageSize is. */
  page: number;
  /** The delimiter parseCsv actually used on the last parse — shown in the
   * "Auto (…)" option even when it was forced by defaultDelimiter rather
   * than truly auto-detected. */
  detectedDelimiter: string;
}

let state: AppState | null = null;
let searchDebounceHandle: number | undefined;

// ---- DOM skeleton -----------------------------------------------------

const app = document.getElementById("app")!;
app.innerHTML = `
  <div class="toolbar">
    <input id="quick-search" type="search" placeholder="Search all columns…" aria-label="Search all columns" />
    <button id="columns-btn" type="button">Columns</button>
    <button id="filters-btn" type="button">Filters</button>
    <button id="expand-all-btn" type="button">Expand page</button>
    <button id="collapse-all-btn" type="button">Collapse page</button>
    <label class="sort-by-label">Sort by…
      <select id="sort-by-select" aria-label="Sort by column"></select>
    </label>
    <button id="sort-dir-btn" type="button" aria-label="Toggle sort direction" hidden>▲</button>
    <label class="header-toggle-label">
      <input id="first-row-header" type="checkbox" checked />
      First row is header
    </label>
    <label class="separator-label">Separator
      <select id="separator-select" aria-label="Separator"></select>
    </label>
    <input id="separator-custom" type="text" maxlength="5" placeholder="e.g. ||" aria-label="Custom separator" hidden />
    <button id="open-as-text-btn" type="button">Open as Text</button>
  </div>
  <div id="columns-popover" class="popover" hidden>
    <input id="columns-search" type="search" placeholder="Filter columns…" aria-label="Filter columns" />
    <div class="popover-actions">
      <button id="columns-show-all" type="button">Show all</button>
      <button id="columns-hide-all" type="button">Hide all</button>
    </div>
    <div id="columns-list" class="columns-list"></div>
  </div>
  <div id="filter-panel" class="panel" hidden>
    <div id="filter-rules"></div>
    <button id="add-rule-btn" type="button">+ Add rule</button>
  </div>
  <div id="status-bar" class="status-bar"></div>
  <div id="table-scroll" class="table-scroll">
    <table id="table">
      <thead id="table-head"></thead>
      <tbody id="table-body"></tbody>
    </table>
  </div>
  <div id="pager-bar" class="pager-bar">
    <button id="pager-first-btn" type="button" title="First page">«</button>
    <button id="pager-prev-btn" type="button" title="Previous page (Alt+←)">‹</button>
    <span class="pager-page-label">Page
      <input id="pager-page-input" type="number" min="1" step="1" aria-label="Page number" />
      of <span id="pager-page-count">1</span>
    </span>
    <button id="pager-next-btn" type="button" title="Next page (Alt+→)">›</button>
    <button id="pager-last-btn" type="button" title="Last page">»</button>
    <span id="pager-row-range" class="pager-row-range"></span>
    <label class="pager-size-label">Rows per page
      <select id="pager-page-size-select" aria-label="Rows per page"></select>
    </label>
  </div>
  <div id="context-menu" class="context-menu" hidden></div>
`;

const quickSearchInput = document.getElementById("quick-search") as HTMLInputElement;
const columnsBtn = document.getElementById("columns-btn") as HTMLButtonElement;
const filtersBtn = document.getElementById("filters-btn") as HTMLButtonElement;
const expandAllBtn = document.getElementById("expand-all-btn") as HTMLButtonElement;
const collapseAllBtn = document.getElementById("collapse-all-btn") as HTMLButtonElement;
const sortBySelect = document.getElementById("sort-by-select") as HTMLSelectElement;
const sortDirBtn = document.getElementById("sort-dir-btn") as HTMLButtonElement;
const firstRowHeaderCheckbox = document.getElementById("first-row-header") as HTMLInputElement;
const separatorSelect = document.getElementById("separator-select") as HTMLSelectElement;
const separatorCustomInput = document.getElementById("separator-custom") as HTMLInputElement;
const openAsTextBtn = document.getElementById("open-as-text-btn") as HTMLButtonElement;
const columnsPopover = document.getElementById("columns-popover") as HTMLDivElement;
const columnsSearch = document.getElementById("columns-search") as HTMLInputElement;
const columnsShowAll = document.getElementById("columns-show-all") as HTMLButtonElement;
const columnsHideAll = document.getElementById("columns-hide-all") as HTMLButtonElement;
const columnsList = document.getElementById("columns-list") as HTMLDivElement;
const filterPanel = document.getElementById("filter-panel") as HTMLDivElement;
const filterRulesEl = document.getElementById("filter-rules") as HTMLDivElement;
const addRuleBtn = document.getElementById("add-rule-btn") as HTMLButtonElement;
const statusBar = document.getElementById("status-bar") as HTMLDivElement;
const tableScroll = document.getElementById("table-scroll") as HTMLDivElement;
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

// ---- Messaging ----------------------------------------------------------

window.addEventListener("message", (event: MessageEvent<HostToWebviewMessage>) => {
  const message = event.data;
  if (message.type === "load") onLoad(message);
});

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
  return aKeys.every((k) => a[k] === b[k]);
}

/** Yield one frame so a "Loading…" placeholder actually paints before a
 * potentially expensive parse blocks the main thread. */
function yieldFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

async function onLoad(message: HostToWebviewMessage): Promise<void> {
  const view = message.state;
  // Defense in depth: normalize fields that might be missing from state
  // saved before they existed (or a bare message a test pushes directly)
  // instead of silently misbehaving.
  view.pageSize = normalizePageSize(view.pageSize);
  view.delimiter = typeof view.delimiter === "string" ? view.delimiter : "";

  // A `load` for the same file the webview is already showing is a live
  // reload (the document changed on disk) — keep the current page instead
  // of jumping back to page 1. It gets clamped to the new page count below.
  const isReload = state !== null && state.fileKey === message.fileKey;
  const previousPage = isReload ? state!.page : 1;

  statusBar.textContent = "Loading…";
  await yieldFrame();

  const delimiterOption = resolveDelimiterOption(view.delimiter, message.defaultDelimiter);
  const parsed = parseCsv(message.text, { delimiter: delimiterOption, firstRowIsHeader: view.firstRowIsHeader });

  const previousVisibility = view.columnVisibility;
  const reconciled = reconcileVisibility(parsed.headers, previousVisibility, message.defaultTableColumns);
  const visibilityChanged = !sameColumnVisibility(previousVisibility, reconciled);
  view.columnVisibility = reconciled;

  state = {
    fileKey: message.fileKey,
    text: message.text,
    defaultDelimiter: message.defaultDelimiter,
    headers: parsed.headers,
    rows: parsed.rows.map((cells, id) => ({ id, cells })),
    view,
    defaultTableColumns: message.defaultTableColumns,
    expanded: new Set<number>(),
    filtered: [],
    page: previousPage,
    detectedDelimiter: parsed.delimiter,
  };
  firstRowHeaderCheckbox.checked = state.view.firstRowIsHeader;
  quickSearchInput.value = state.view.quickSearch;
  renderColumnsPopover();
  renderFilterPanel();
  renderSeparatorControl();
  recomputeAndRender();

  // Only write state back if reconciliation actually changed the stored
  // visibility map — a plain reopen of a file whose visibility is already
  // settled shouldn't cause a write on every open.
  if (visibilityChanged) saveState();
}

/**
 * Re-parse `state.text` with the current view options (separator, "first
 * row is header") without a host round-trip, reconciling column visibility
 * against the new headers. Used by both the separator control and the
 * "first row is header" toggle.
 */
function reparseFromText(options: { resetPage: boolean }): void {
  if (!state) return;
  const delimiterOption = resolveDelimiterOption(state.view.delimiter, state.defaultDelimiter);
  const parsed = parseCsv(state.text, { delimiter: delimiterOption, firstRowIsHeader: state.view.firstRowIsHeader });

  state.headers = parsed.headers;
  state.rows = parsed.rows.map((cells, id) => ({ id, cells }));
  state.detectedDelimiter = parsed.delimiter;
  state.view.columnVisibility = reconcileVisibility(parsed.headers, state.view.columnVisibility, state.defaultTableColumns);
  // Row identity is re-tokenized from scratch, so previously expanded rows
  // (tracked by id) no longer correspond to the same content — reset, same
  // as a live reload does.
  state.expanded = new Set<number>();

  renderColumnsPopover();
  renderFilterPanel();
  renderSeparatorControl();
  recomputeAndRender({ resetPage: options.resetPage });
}

function newRuleId(): string {
  return `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function saveState(): void {
  if (!state) return;
  vscode.postMessage({ type: "saveState", state: state.view });
}

// ---- Derived rows (filter + sort while preserving row identity) --------

/**
 * Re-derives `state.filtered` from the raw rows plus quick search/filter
 * rules/sort, then reconciles the current page against the (possibly
 * changed) result. Quick search, filter rule, and sort changes pass
 * `resetPage: true` so the page goes back to 1; everything else (column
 * visibility, a live reload) keeps the current page, clamped in range.
 */
function recomputeAndRender(options: { resetPage?: boolean } = {}): void {
  if (!state) return;
  const idByCells = new Map<string[], number>();
  for (const row of state.rows) idByCells.set(row.cells, row.id);

  const filteredCells = applyFilters(state.headers, state.rows.map((r) => r.cells), state.view.quickSearch, state.view.filterRules);
  const sortedCells = sortRows(filteredCells, state.headers, state.view.sortKeys);

  state.filtered = sortedCells.map((cells) => ({ id: idByCells.get(cells)!, cells }));
  state.page = options.resetPage ? 1 : clampPage(state.page, state.filtered.length, state.view.pageSize);

  renderTableHead();
  renderSortBySelect();
  renderTableBody();
  renderStatusBar();
  renderPagerBar();
}

// ---- Table head ----------------------------------------------------------

function renderTableHead(): void {
  if (!state) return;
  const columns = visibleColumns(state.headers, state.view.columnVisibility);
  const tr = document.createElement("tr");

  const chevronTh = document.createElement("th");
  chevronTh.className = "chevron-col";
  tr.appendChild(chevronTh);

  for (const column of columns) {
    const th = document.createElement("th");
    th.className = "sortable";
    th.tabIndex = 0;
    th.setAttribute("role", "button");

    const label = document.createElement("span");
    label.textContent = column;
    th.appendChild(label);

    const keyIndex = state.view.sortKeys.findIndex((k) => k.column === column);
    if (keyIndex !== -1) {
      const key = state.view.sortKeys[keyIndex];
      const indicator = document.createElement("span");
      indicator.className = "sort-indicator";
      indicator.textContent = key.direction === "asc" ? "▲" : "▼";
      if (state.view.sortKeys.length > 1) indicator.textContent += String(keyIndex + 1);
      th.appendChild(indicator);
    }

    th.addEventListener("click", (ev) => onHeaderClick(column, ev.shiftKey));
    th.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        onHeaderClick(column, ev.shiftKey);
      }
    });
    tr.appendChild(th);
  }

  tableHead.innerHTML = "";
  tableHead.appendChild(tr);
}

function onHeaderClick(column: string, shiftKey: boolean): void {
  if (!state) return;
  state.view.sortKeys = cycleSortForColumn(state.view.sortKeys, column, shiftKey);
  recomputeAndRender({ resetPage: true });
  saveState();
}

// ---- Table body (one page at a time) --------------------------------------

function renderTableBody(): void {
  if (!state) return;
  tableBody.innerHTML = "";
  const columns = visibleColumns(state.headers, state.view.columnVisibility);
  const { start, end } = pageSlice(state.filtered.length, state.page, state.view.pageSize);
  const fragment = document.createDocumentFragment();

  for (let i = start; i < end; i++) {
    const row = state.filtered[i];
    fragment.appendChild(buildRowTr(row, columns));
    fragment.appendChild(buildDetailTr(row, columns.length + 1));
  }

  tableBody.appendChild(fragment);
}

function buildRowTr(row: RowWithId, columns: string[]): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.className = "data-row";
  tr.dataset.rowId = String(row.id);

  const chevronTd = document.createElement("td");
  chevronTd.className = "chevron-col";
  const chevron = document.createElement("span");
  chevron.className = "chevron";
  chevron.textContent = state!.expanded.has(row.id) ? "▼" : "▶";
  chevronTd.appendChild(chevron);
  tr.appendChild(chevronTd);

  const indexByHeader = new Map(state!.headers.map((h, i) => [h, i]));
  for (const column of columns) {
    const td = document.createElement("td");
    const value = row.cells[indexByHeader.get(column)!] ?? "";
    td.textContent = value;
    td.addEventListener("contextmenu", (ev) => onCellContextMenu(ev, column, value));
    tr.appendChild(td);
  }

  tr.addEventListener("click", () => toggleExpanded(row.id));
  return tr;
}

function buildDetailTr(row: RowWithId, colSpan: number): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.className = "detail-row";
  tr.hidden = !state!.expanded.has(row.id);

  const td = document.createElement("td");
  td.colSpan = colSpan;

  const dl = document.createElement("dl");
  dl.className = "detail-fields";
  const fields = detailFieldsFor(state!.headers, state!.view.columnVisibility);
  const indexByHeader = new Map(state!.headers.map((h, i) => [h, i]));

  for (const field of fields) {
    const dt = document.createElement("dt");
    dt.textContent = field;
    const dd = document.createElement("dd");
    const value = row.cells[indexByHeader.get(field)!] ?? "";
    dd.textContent = value;
    dd.addEventListener("contextmenu", (ev) => onCellContextMenu(ev, field, value));
    dl.appendChild(dt);
    dl.appendChild(dd);
  }

  td.appendChild(dl);
  tr.appendChild(td);
  return tr;
}

function toggleExpanded(rowId: number): void {
  if (!state) return;
  if (state.expanded.has(rowId)) state.expanded.delete(rowId);
  else state.expanded.add(rowId);

  const rowTr = tableBody.querySelector<HTMLTableRowElement>(`tr.data-row[data-row-id="${rowId}"]`);
  const detailTr = rowTr?.nextElementSibling as HTMLTableRowElement | null;
  if (rowTr) {
    const chevron = rowTr.querySelector(".chevron");
    if (chevron) chevron.textContent = state.expanded.has(rowId) ? "▼" : "▶";
  }
  if (detailTr) detailTr.hidden = !state.expanded.has(rowId);
}

// ---- Status bar ----------------------------------------------------------

function renderStatusBar(): void {
  if (!state) return;
  statusBar.textContent = `Showing ${state.filtered.length} of ${state.rows.length} rows`;
}

// ---- Pager bar ----------------------------------------------------------

function renderPagerBar(): void {
  if (!state) return;
  const total = state.filtered.length;
  const size = state.view.pageSize;
  const count = pageCount(total, size);
  const { start, end } = pageSlice(total, state.page, size);

  pagerPageInput.value = String(state.page);
  pagerPageInput.max = String(count);
  pagerPageCount.textContent = String(count);
  pagerPageSizeSelect.value = String(size);
  pagerRowRange.textContent = total === 0 ? "No matching rows" : `Rows ${start + 1}–${end} of ${total}`;

  const noRows = total === 0;
  pagerFirstBtn.disabled = noRows || state.page <= 1;
  pagerPrevBtn.disabled = noRows || state.page <= 1;
  pagerNextBtn.disabled = noRows || state.page >= count;
  pagerLastBtn.disabled = noRows || state.page >= count;
  pagerPageInput.disabled = noRows;
}

/** Jump to `page` (clamped in range), re-rendering only if it actually
 * changes, and scroll the table area back to top. */
function goToPage(page: number): void {
  if (!state) return;
  const clamped = clampPage(page, state.filtered.length, state.view.pageSize);
  if (clamped === state.page) {
    renderPagerBar(); // still resync e.g. the page-number input's text
    return;
  }
  state.page = clamped;
  renderTableBody();
  renderPagerBar();
  tableScroll.scrollTop = 0;
}

pagerFirstBtn.addEventListener("click", () => goToPage(1));
pagerPrevBtn.addEventListener("click", () => {
  if (state) goToPage(state.page - 1);
});
pagerNextBtn.addEventListener("click", () => {
  if (state) goToPage(state.page + 1);
});
pagerLastBtn.addEventListener("click", () => {
  if (state) goToPage(pageCount(state.filtered.length, state.view.pageSize));
});

function commitPageInput(): void {
  if (!state) return;
  const raw = pagerPageInput.value.trim();
  const parsed = raw === "" ? NaN : Number(raw);
  if (!Number.isFinite(parsed)) {
    renderPagerBar(); // invalid input: restore the current page
    return;
  }
  goToPage(parsed);
}

pagerPageInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    commitPageInput();
  }
});
pagerPageInput.addEventListener("blur", commitPageInput);

pagerPageSizeSelect.addEventListener("change", () => {
  if (!state) return;
  const oldSize = state.view.pageSize;
  const { start: firstRowIndex } = pageSlice(state.filtered.length, state.page, oldSize);
  const newSize = normalizePageSize(Number(pagerPageSizeSelect.value));

  state.view.pageSize = newSize;
  state.page = clampPage(pageForRow(firstRowIndex, newSize), state.filtered.length, newSize);

  renderTableBody();
  renderPagerBar();
  tableScroll.scrollTop = 0;
  saveState();
});

// ---- Quick search ----------------------------------------------------------

quickSearchInput.addEventListener("input", () => {
  if (!state) return;
  const value = quickSearchInput.value;
  window.clearTimeout(searchDebounceHandle);
  searchDebounceHandle = window.setTimeout(() => {
    if (!state) return;
    state.view.quickSearch = value;
    recomputeAndRender({ resetPage: true });
    saveState();
  }, SEARCH_DEBOUNCE_MS);
});

// ---- First row is header ----------------------------------------------------------

firstRowHeaderCheckbox.addEventListener("change", () => {
  if (!state) return;
  state.view.firstRowIsHeader = firstRowHeaderCheckbox.checked;
  // Re-parses locally from the text already held in state (no host round
  // trip); keeps the current page, same as the old host-driven reload did.
  reparseFromText({ resetPage: false });
  saveState();
});

// ---- Separator ----------------------------------------------------------

/** Render the Separator dropdown's options (including the live "Auto (…)"
 * label) and select the value matching the current state, revealing the
 * custom input when the stored delimiter isn't one of the presets. */
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

  const current = state.view.delimiter;
  const isPreset = current === "" || PRESET_DELIMITERS.some((p) => p.value === current);
  separatorSelect.value = isPreset ? current : CUSTOM_SENTINEL;
  separatorCustomInput.hidden = isPreset;
  if (!isPreset) separatorCustomInput.value = current;
}

function applySeparatorChange(delimiter: string): void {
  if (!state) return;
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
    separatorCustomInput.hidden = false;
    separatorCustomInput.value = "";
    separatorCustomInput.focus();
    return;
  }
  applySeparatorChange(value);
});

let separatorDebounceHandle: number | undefined;
separatorCustomInput.addEventListener("input", () => {
  window.clearTimeout(separatorDebounceHandle);
  separatorDebounceHandle = window.setTimeout(() => {
    // An empty custom value falls back to Auto.
    applySeparatorChange(separatorCustomInput.value.trim());
  }, SEPARATOR_DEBOUNCE_MS);
});

// ---- Open as text ----------------------------------------------------------

openAsTextBtn.addEventListener("click", () => {
  vscode.postMessage({ type: "openAsText" });
});

// ---- Expand page / collapse page (current page only) ----------------------

expandAllBtn.addEventListener("click", () => {
  if (!state) return;
  const { start, end } = pageSlice(state.filtered.length, state.page, state.view.pageSize);
  for (let i = start; i < end; i++) state.expanded.add(state.filtered[i].id);
  renderTableBody();
});

collapseAllBtn.addEventListener("click", () => {
  if (!state) return;
  const { start, end } = pageSlice(state.filtered.length, state.page, state.view.pageSize);
  for (let i = start; i < end; i++) state.expanded.delete(state.filtered[i].id);
  renderTableBody();
});

// ---- Sort by… dropdown (for detail-only columns, which have no header) ------

function renderSortBySelect(): void {
  if (!state) return;
  sortBySelect.innerHTML = "";
  const noneOption = document.createElement("option");
  noneOption.value = "";
  noneOption.textContent = "(none)";
  sortBySelect.appendChild(noneOption);

  for (const header of state.headers) {
    const option = document.createElement("option");
    option.value = header;
    option.textContent = header;
    sortBySelect.appendChild(option);
  }

  const primary = state.view.sortKeys[0];
  sortBySelect.value = primary ? primary.column : "";
  sortDirBtn.hidden = !primary;
  sortDirBtn.textContent = primary?.direction === "desc" ? "▼" : "▲";
  sortDirBtn.title = primary?.direction === "desc" ? "Descending" : "Ascending";
}

sortBySelect.addEventListener("change", () => {
  if (!state) return;
  const column = sortBySelect.value;
  state.view.sortKeys = column === "" ? [] : [{ column, direction: "asc" }];
  recomputeAndRender({ resetPage: true });
  saveState();
});

sortDirBtn.addEventListener("click", () => {
  if (!state || state.view.sortKeys.length === 0) return;
  const [primary, ...rest] = state.view.sortKeys;
  state.view.sortKeys = [{ ...primary, direction: primary.direction === "asc" ? "desc" : "asc" }, ...rest];
  recomputeAndRender({ resetPage: true });
  saveState();
});

// ---- Columns popover ----------------------------------------------------------

columnsBtn.addEventListener("click", () => {
  filterPanel.hidden = true;
  columnsPopover.hidden = !columnsPopover.hidden;
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
    checkbox.checked = state.view.columnVisibility[header] !== false;
    checkbox.addEventListener("change", () => {
      if (!state) return;
      state.view.columnVisibility[header] = checkbox.checked;
      recomputeAndRender(); // column visibility keeps the current page
      saveState();
    });
    label.appendChild(checkbox);
    const span = document.createElement("span");
    span.textContent = header;
    label.appendChild(span);
    columnsList.appendChild(label);
  }
}

columnsSearch.addEventListener("input", renderColumnsPopover);

columnsShowAll.addEventListener("click", () => {
  if (!state) return;
  for (const header of state.headers) state.view.columnVisibility[header] = true;
  renderColumnsPopover();
  recomputeAndRender();
  saveState();
});

columnsHideAll.addEventListener("click", () => {
  if (!state) return;
  for (const header of state.headers) state.view.columnVisibility[header] = false;
  renderColumnsPopover();
  recomputeAndRender();
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
  { value: "gt", label: ">", needsValue: true },
  { value: "lt", label: "<", needsValue: true },
  { value: "gte", label: ">=", needsValue: true },
  { value: "lte", label: "<=", needsValue: true },
];

filtersBtn.addEventListener("click", () => {
  columnsPopover.hidden = true;
  filterPanel.hidden = !filterPanel.hidden;
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
  recomputeAndRender({ resetPage: true });
  saveState();
});

function renderFilterPanel(): void {
  if (!state) return;
  filterRulesEl.innerHTML = "";
  for (const rule of state.view.filterRules) filterRulesEl.appendChild(buildRuleRow(rule));
}

function buildRuleRow(rule: FilterRule): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "rule-row";

  const enabledCheckbox = document.createElement("input");
  enabledCheckbox.type = "checkbox";
  enabledCheckbox.checked = rule.enabled;
  enabledCheckbox.title = "Enabled";
  enabledCheckbox.addEventListener("change", () => {
    rule.enabled = enabledCheckbox.checked;
    recomputeAndRender({ resetPage: true });
    saveState();
  });
  row.appendChild(enabledCheckbox);

  const columnSelect = document.createElement("select");
  const anyOption = document.createElement("option");
  anyOption.value = "";
  anyOption.textContent = "(any column)";
  columnSelect.appendChild(anyOption);
  for (const header of state!.headers) {
    const option = document.createElement("option");
    option.value = header;
    option.textContent = header;
    columnSelect.appendChild(option);
  }
  columnSelect.value = rule.column ?? "";
  columnSelect.addEventListener("change", () => {
    rule.column = columnSelect.value === "" ? null : columnSelect.value;
    recomputeAndRender({ resetPage: true });
    saveState();
  });
  row.appendChild(columnSelect);

  const operatorSelect = document.createElement("select");
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
    syncRuleError();
    recomputeAndRender({ resetPage: true });
    saveState();
  });
  row.appendChild(operatorSelect);

  const valueInput = document.createElement("input");
  valueInput.type = "text";
  valueInput.value = rule.value;
  valueInput.hidden = rule.operator === "isEmpty";
  valueInput.placeholder = "value";
  valueInput.addEventListener("input", () => {
    rule.value = valueInput.value;
    syncRuleError();
    recomputeAndRender({ resetPage: true });
    saveState();
  });
  row.appendChild(valueInput);

  const caseCheckbox = document.createElement("input");
  caseCheckbox.type = "checkbox";
  caseCheckbox.checked = rule.caseSensitive;
  caseCheckbox.title = "Case-sensitive";
  caseCheckbox.addEventListener("change", () => {
    rule.caseSensitive = caseCheckbox.checked;
    recomputeAndRender({ resetPage: true });
    saveState();
  });
  const caseLabel = document.createElement("label");
  caseLabel.className = "inline-checkbox-label";
  caseLabel.appendChild(caseCheckbox);
  caseLabel.appendChild(document.createTextNode("Aa"));
  row.appendChild(caseLabel);

  const modeToggle = document.createElement("button");
  modeToggle.type = "button";
  modeToggle.className = "mode-toggle";
  modeToggle.textContent = rule.mode === "include" ? "Include" : "Exclude";
  modeToggle.addEventListener("click", () => {
    rule.mode = rule.mode === "include" ? "exclude" : "include";
    modeToggle.textContent = rule.mode === "include" ? "Include" : "Exclude";
    recomputeAndRender({ resetPage: true });
    saveState();
  });
  row.appendChild(modeToggle);

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "remove-rule-btn";
  removeBtn.textContent = "✕";
  removeBtn.setAttribute("aria-label", "Remove rule");
  removeBtn.addEventListener("click", () => {
    if (!state) return;
    state.view.filterRules = state.view.filterRules.filter((r) => r.id !== rule.id);
    renderFilterPanel();
    recomputeAndRender({ resetPage: true });
    saveState();
  });
  row.appendChild(removeBtn);

  const error = document.createElement("span");
  error.className = "rule-error-text";
  error.textContent = "Invalid regex — rule ignored";
  row.appendChild(error);

  function syncRuleError(): void {
    const invalid = !isValidRule(rule);
    row.classList.toggle("rule-error", invalid);
    error.hidden = !invalid;
  }
  syncRuleError();

  return row;
}

// ---- Quick-add filter via cell context menu ----------------------------------------------------------

function onCellContextMenu(ev: MouseEvent, column: string, value: string): void {
  ev.preventDefault();
  contextMenu.innerHTML = "";

  const includeItem = document.createElement("button");
  includeItem.type = "button";
  includeItem.textContent = "Filter: include this value";
  includeItem.addEventListener("click", () => addQuickFilter(column, value, "include"));

  const excludeItem = document.createElement("button");
  excludeItem.type = "button";
  excludeItem.textContent = "Filter: exclude this value";
  excludeItem.addEventListener("click", () => addQuickFilter(column, value, "exclude"));

  contextMenu.appendChild(includeItem);
  contextMenu.appendChild(excludeItem);
  contextMenu.style.left = `${ev.pageX}px`;
  contextMenu.style.top = `${ev.pageY}px`;
  contextMenu.hidden = false;
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
  filterPanel.hidden = false;
  recomputeAndRender({ resetPage: true });
  saveState();
}

document.addEventListener("click", (ev) => {
  if (contextMenu.hidden) return;
  if (!contextMenu.contains(ev.target as Node)) contextMenu.hidden = true;
});

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    contextMenu.hidden = true;
    columnsPopover.hidden = true;
    filterPanel.hidden = true;
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
    goToPage(state.page + (ev.key === "ArrowRight" ? 1 : -1));
  }
});
