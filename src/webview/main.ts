// CSV Viewer webview client. Vanilla TypeScript + DOM, no framework and no
// runtime dependencies. Receives parsed rows from the extension host and
// owns filtering, sorting, column visibility, and chunked rendering.

import { applyFilters, isValidRule } from "../core/filter";
import { sortRows, cycleSortForColumn } from "../core/sort";
import { detailFieldsFor, reconcileVisibility, visibleColumns } from "../core/columns";
import type { FilterOperator, FilterRule, HostToWebviewMessage, ViewState, WebviewToHostMessage } from "../core/types";

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewToHostMessage): void;
  setState(state: unknown): void;
  getState(): unknown;
};

const vscode = acquireVsCodeApi();

const CHUNK_SIZE = 200;
const SCROLL_THRESHOLD_PX = 300;
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
  renderedCount: number;
}

let state: AppState | null = null;
let nextRuleId = 1;
let searchDebounceHandle: number | undefined;

// ---- DOM skeleton -----------------------------------------------------

const app = document.getElementById("app")!;
app.innerHTML = `
  <div class="toolbar">
    <input id="quick-search" type="search" placeholder="Search all columns…" aria-label="Search all columns" />
    <button id="columns-btn" type="button">Columns</button>
    <button id="filters-btn" type="button">Filters</button>
    <button id="expand-all-btn" type="button">Expand all</button>
    <button id="collapse-all-btn" type="button">Collapse all</button>
    <label class="sort-by-label">Sort by…
      <select id="sort-by-select" aria-label="Sort by column"></select>
    </label>
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
  <div id="context-menu" class="context-menu" hidden></div>
`;

const quickSearchInput = document.getElementById("quick-search") as HTMLInputElement;
const columnsBtn = document.getElementById("columns-btn") as HTMLButtonElement;
const filtersBtn = document.getElementById("filters-btn") as HTMLButtonElement;
const expandAllBtn = document.getElementById("expand-all-btn") as HTMLButtonElement;
const collapseAllBtn = document.getElementById("collapse-all-btn") as HTMLButtonElement;
const sortBySelect = document.getElementById("sort-by-select") as HTMLSelectElement;
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

// ---- Messaging ----------------------------------------------------------

window.addEventListener("message", (event: MessageEvent<HostToWebviewMessage>) => {
  const message = event.data;
  if (message.type === "load") onLoad(message);
});

vscode.postMessage({ type: "ready" });

function onLoad(message: HostToWebviewMessage): void {
  const rows: RowWithId[] = message.rows.map((cells, id) => ({ id, cells }));
  const view = message.state;
  // Defense in depth: the host already reconciles column visibility before
  // sending, but re-applying the same pure rule here means a header that's
  // missing from the map (a first load, or a test pushing a bare message)
  // still gets the default-N-columns rule instead of silently showing
  // everything.
  view.columnVisibility = reconcileVisibility(message.headers, view.columnVisibility, message.defaultTableColumns);
  state = {
    fileKey: message.fileKey,
    headers: message.headers,
    rows,
    view,
    defaultTableColumns: message.defaultTableColumns,
    expanded: new Set<number>(),
    filtered: [],
    renderedCount: 0,
  };
  firstRowHeaderCheckbox.checked = state.view.firstRowIsHeader;
  quickSearchInput.value = state.view.quickSearch;
  renderColumnsPopover();
  renderSortBySelect();
  renderFilterPanel();
  recomputeAndRender();
}

function saveState(): void {
  if (!state) return;
  vscode.postMessage({ type: "saveState", state: state.view });
}

// ---- Derived rows (filter + sort while preserving row identity) --------

function recomputeAndRender(): void {
  if (!state) return;
  const idByCells = new Map<string[], number>();
  for (const row of state.rows) idByCells.set(row.cells, row.id);

  const filteredCells = applyFilters(state.headers, state.rows.map((r) => r.cells), state.view.quickSearch, state.view.filterRules);
  const sortedCells = sortRows(filteredCells, state.headers, state.view.sortKeys);

  state.filtered = sortedCells.map((cells) => ({ id: idByCells.get(cells)!, cells }));
  state.renderedCount = Math.min(CHUNK_SIZE, state.filtered.length);

  renderTableHead();
  renderTableBodyFresh();
  renderStatusBar();
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
  recomputeAndRender();
  saveState();
}

// ---- Table body (chunked rendering) --------------------------------------

function renderTableBodyFresh(): void {
  if (!state) return;
  tableBody.innerHTML = "";
  appendRows(0, state.renderedCount);
}

function appendRows(start: number, end: number): void {
  if (!state) return;
  const columns = visibleColumns(state.headers, state.view.columnVisibility);
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

tableScroll.addEventListener("scroll", () => {
  if (!state) return;
  const { scrollTop, scrollHeight, clientHeight } = tableScroll;
  if (scrollHeight - (scrollTop + clientHeight) > SCROLL_THRESHOLD_PX) return;
  if (state.renderedCount >= state.filtered.length) return;

  const nextEnd = Math.min(state.renderedCount + CHUNK_SIZE, state.filtered.length);
  appendRows(state.renderedCount, nextEnd);
  state.renderedCount = nextEnd;
});

// ---- Status bar ----------------------------------------------------------

function renderStatusBar(): void {
  if (!state) return;
  statusBar.textContent = `Showing ${state.filtered.length} of ${state.rows.length} rows`;
}

// ---- Quick search ----------------------------------------------------------

quickSearchInput.addEventListener("input", () => {
  if (!state) return;
  const value = quickSearchInput.value;
  window.clearTimeout(searchDebounceHandle);
  searchDebounceHandle = window.setTimeout(() => {
    if (!state) return;
    state.view.quickSearch = value;
    recomputeAndRender();
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

// ---- Expand all / collapse all ----------------------------------------------------------

expandAllBtn.addEventListener("click", () => {
  if (!state) return;
  for (const row of state.filtered) state.expanded.add(row.id);
  renderTableBodyFresh();
});

collapseAllBtn.addEventListener("click", () => {
  if (!state) return;
  state.expanded.clear();
  renderTableBodyFresh();
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
}

sortBySelect.addEventListener("change", () => {
  if (!state) return;
  const column = sortBySelect.value;
  state.view.sortKeys = column === "" ? [] : [{ column, direction: "asc" }];
  recomputeAndRender();
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
      recomputeAndRender();
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
    id: `rule-${nextRuleId++}`,
    column: null,
    operator: "contains",
    value: "",
    mode: "include",
    caseSensitive: false,
    enabled: true,
  };
  state.view.filterRules.push(rule);
  renderFilterPanel();
  recomputeAndRender();
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
  if (!isValidRule(rule)) row.classList.add("rule-error");

  const enabledCheckbox = document.createElement("input");
  enabledCheckbox.type = "checkbox";
  enabledCheckbox.checked = rule.enabled;
  enabledCheckbox.title = "Enabled";
  enabledCheckbox.addEventListener("change", () => {
    rule.enabled = enabledCheckbox.checked;
    recomputeAndRender();
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
    recomputeAndRender();
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
    row.classList.toggle("rule-error", !isValidRule(rule));
    recomputeAndRender();
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
    row.classList.toggle("rule-error", !isValidRule(rule));
    recomputeAndRender();
    saveState();
  });
  row.appendChild(valueInput);

  const caseCheckbox = document.createElement("input");
  caseCheckbox.type = "checkbox";
  caseCheckbox.checked = rule.caseSensitive;
  caseCheckbox.title = "Case-sensitive";
  caseCheckbox.addEventListener("change", () => {
    rule.caseSensitive = caseCheckbox.checked;
    recomputeAndRender();
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
    recomputeAndRender();
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
    recomputeAndRender();
    saveState();
  });
  row.appendChild(removeBtn);

  if (!isValidRule(rule)) {
    const error = document.createElement("span");
    error.className = "rule-error-text";
    error.textContent = "Invalid regex — rule ignored";
    row.appendChild(error);
  }

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
    id: `rule-${nextRuleId++}`,
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
  recomputeAndRender();
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
  }
});
