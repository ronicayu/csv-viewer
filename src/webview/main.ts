// CSV Viewer webview client. Vanilla TypeScript + DOM, no framework and no
// runtime dependencies. Receives parsed rows from the extension host and
// owns filtering, sorting, column visibility, and pagination.

import { applyFilters, isValidRule } from "../core/filter";
import { sortRows, cycleSortForColumn } from "../core/sort";
import { detailFieldsFor, reconcileVisibility, visibleColumns } from "../core/columns";
import { PAGE_SIZES, clampPage, normalizePageSize, pageCount, pageForRow, pageSlice } from "../core/paging";
import type { FilterOperator, FilterRule, HostToWebviewMessage, ViewState, WebviewToHostMessage } from "../core/types";

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewToHostMessage): void;
  setState(state: unknown): void;
  getState(): unknown;
};

const vscode = acquireVsCodeApi();

const SEARCH_DEBOUNCE_MS = 150;

interface RowWithId {
  id: number;
  cells: string[];
}

interface AppState {
  fileKey: string;
  headers: string[];
  rows: RowWithId[];
  view: ViewState;
  defaultTableColumns: number;
  expanded: Set<number>;
  filtered: RowWithId[];
  /** 1-based. Not persisted — only pageSize is. */
  page: number;
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

function onLoad(message: HostToWebviewMessage): void {
  const rows: RowWithId[] = message.rows.map((cells, id) => ({ id, cells }));
  const view = message.state;
  // Defense in depth: the host already reconciles column visibility and
  // normalizes pageSize before sending, but re-applying the same pure rules
  // here means a bare message (e.g. a test pushing one directly) still gets
  // sane defaults instead of silently misbehaving.
  view.columnVisibility = reconcileVisibility(message.headers, view.columnVisibility, message.defaultTableColumns);
  view.pageSize = normalizePageSize(view.pageSize);

  // A `load` for the same file the webview is already showing is a live
  // reload (the document changed on disk, or "first row is header" was
  // toggled and the host re-parsed) — keep the current page instead of
  // jumping back to page 1. It gets clamped to the new page count below.
  const isReload = state !== null && state.fileKey === message.fileKey;
  const previousPage = isReload ? state!.page : 1;

  state = {
    fileKey: message.fileKey,
    headers: message.headers,
    rows,
    view,
    defaultTableColumns: message.defaultTableColumns,
    expanded: new Set<number>(),
    filtered: [],
    page: previousPage,
  };
  firstRowHeaderCheckbox.checked = state.view.firstRowIsHeader;
  quickSearchInput.value = state.view.quickSearch;
  renderColumnsPopover();
  renderFilterPanel();
  recomputeAndRender();
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
  saveState(); // host re-parses and sends a fresh `load` on this change
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
