# CSV Viewer — VS Code extension spec (v0.2)

Read-only table viewer for CSV/TSV files. Works in VS Code and its forks (Cursor, Windsurf) — target Open VSX + VS Code Marketplace, `engines.vscode: ^1.80.0`.

## Core features

### 1. Column visibility: table vs detail
- Each column is either **shown in table** or **detail-only**.
- Every table row has an expand chevron (and clicking the row toggles it). Expanded row shows a detail panel below it: key/value list of all **detail-only** columns for that row (label = header, value = cell, preserve newlines, wrap long text). If no columns are hidden, the detail panel shows all columns.
- **Columns** button in toolbar opens a popover: checkbox per column (checked = in table), a search box to filter the list, "Show all" / "Hide all" buttons, and drag-free up/down ordering is NOT required.
- Header context: right-click header → "Move to detail" (hide) is nice-to-have, skip if costly.
- Default visibility when a file is first opened: first N columns in table (setting `csvViewer.defaultTableColumns`, default 8), rest detail-only.
- Persist column visibility per file (keyed by file URI) in `workspaceState`. If the header row changes, keep settings for columns whose names still exist; new columns follow default rule.
- "Expand page" / "Collapse page" toolbar buttons — apply to the current page's rows only (see Pagination below).

### 2. Filtering (include + exclude)
- Toolbar: global quick search box (case-insensitive substring over all columns, debounced ~150ms).
- **Filter rules** panel: list of rules, add/remove. Each rule:
  - column: any single column, or "(any column)"
  - operator: `contains`, `equals`, `starts with`, `ends with`, `regex`, `is empty`, `>`, `<`, `>=`, `<=` (numeric operators compare as numbers; row fails if cell isn't numeric)
  - value (hidden for `is empty`)
  - mode toggle: **Include** / **Exclude** (exclude = row is dropped if it matches)
  - case-sensitive toggle (default off)
  - enabled checkbox (temporarily disable without deleting)
- All enabled rules combine with AND (include rules must all match; any matching exclude rule drops the row). Invalid regex → rule shown in error state and ignored, never crashes.
- Quick-add: in expanded detail or table cell, right-click a cell value → "Filter: include this value" / "Filter: exclude this value" (creates `equals` rule). Nice-to-have; implement if straightforward via a small custom context menu in the webview.
- Status bar in webview: "Showing X of Y rows".
- Persist filter rules per file alongside column settings.

### 3. Sort
- Click a table header: cycles asc → desc → none. Shift+click adds secondary sort keys (multi-sort); indicator shows direction and priority number when >1 key.
- Also sortable by detail-only columns via a "Sort by…" dropdown in the toolbar (since hidden columns have no header).
- Type-aware comparison: if both values parse as finite numbers (allow thousands separators? no — plain `Number()` after trim, reject empty), compare numerically; else compare with `localeCompare(undefined, { numeric: true, sensitivity: "base" })`. Empty cells always sort last regardless of direction. Stable sort (original row order breaks ties).
- Persist sort per file.

### 4. Pagination
- A pager bar sits below the table, always visible (the table area scrolls between the toolbar/status-bar and the pager, not the pager itself). Controls, left to right: First «, Prev ‹, "Page [ N ] of M" (N is a number input — Enter or blur jumps, clamps to 1..M, invalid input restores the current page), Next ›, Last », "Rows X–Y of Z" (Z = filtered count; "No matching rows" when Z = 0), and a page size select (25/50/100/200/500, default 100).
- Nav buttons disable via the `disabled` attribute when not applicable (First/Prev on page 1, Next/Last on the last page; all four when Z = 0).
- The top status text "Showing X of Y rows" is unaffected by pagination — it always reflects the full filtered count, not the current page.
- Page resets to 1 on quick search, filter rule, and sort changes. Column visibility changes and expand/collapse keep the current page. A live reload (`load` for the same fileKey) keeps the current page, clamped to the new page count.
- Changing page size keeps the first row currently shown visible: new page = `floor(firstRowIndex / newSize) + 1`. Changing page scrolls the table area back to top.
- "Expand all" / "Collapse all" (labeled "Expand page" / "Collapse page") apply to the current page's rows only; expanded state is keyed by row id, so it survives paging back and forth.
- Keyboard: Alt+→ / Alt+← move to the next/previous page when focus isn't in an input/select/textarea (so native text navigation and scrolling keys are untouched).
- `pageSize` is persisted per file as part of the view state; the current page number is not. A missing/invalid stored value (state saved before pagination existed) falls back to 100.
- Pure logic lives in `src/core/paging.ts` (`pageCount`, `clampPage`, `pageSlice`, `pageForRow`, `normalizePageSize`) — no DOM/vscode imports, unit-tested like the rest of `src/core`.

## Parsing
- Own RFC 4180 parser as a pure module (no vscode import): quoted fields, `""` escapes, newlines inside quotes, CRLF/LF/CR, BOM stripping, trailing newline not producing an empty row, ragged rows (pad short rows with "", extra cells get auto headers `column_N`).
- Delimiter: `.tsv`/`.tab` → tab; otherwise auto-detect among `, ; \t |` by sampling the first ~20 lines (most consistent non-zero count wins; default comma).
- First row is header. Duplicate/empty header names get made unique (`name`, `name_2`; empty → `column_N`). Toggle "First row is header" in toolbar (persisted per file); when off, headers are `column_1..N`.

## Architecture
- `CustomTextEditorProvider`, viewType `csvViewer.table`, selector `*.csv`, `*.tsv`, `*.tab`, **priority `option`** (text editor stays default). Commands: `csvViewer.open` ("Open in CSV Viewer") available in explorer context menu, editor title bar (icon) for csv/tsv files, and command palette; `csvViewer.openAsText` from inside the viewer.
- Setting `csvViewer.openByDefault` (bool, default false) — document in README that users can instead set `workbench.editorAssociations`. (If implementing dynamic priority is awkward, just document the association and skip the setting.)
- Live reload: when the underlying `TextDocument` changes (edited elsewhere / on disk), re-parse and post new data; keep UI state (visibility, filters, sort, current page clamped to the new count; expanded rows by index is fine to reset).
- Parsing happens in the extension host; webview receives `{ headers, rows, fileKey, state }`. Filtering/sorting/pagination runs in the webview (pure functions in a shared module, imported by the webview bundle and unit-tested in node).
- Webview → host messages: `ready`, `saveState(state)`, `openAsText`. Host → webview: `load(data)`.
- Webview: vanilla TypeScript + CSS, bundled with esbuild to `out/webview/main.js`. Strict CSP with nonce, `localResourceRoots` limited to `out/webview` + `media`. Use VS Code theme CSS variables (`--vscode-*`) only — must look right in light, dark, high-contrast.
- Performance: must stay responsive for 100k rows × 30 cols. Don't render all rows: pagination renders only the current page's rows (see Pagination above) instead of chunked/infinite-scroll rendering. Filter/sort over the full dataset; re-render the current page after changes. Sticky header row.
- Large files: if file > 50 MB, show a warning message and still try; no streaming needed in v0.1.

## Project layout / conventions (mirror ~/projects/markdown-collab-plugin)
- TypeScript strict, `tsconfig.json` (extension, commonjs, ES2022), separate `tsconfig.webview.json` (DOM lib, noEmit type-check).
- esbuild bundles: `out/extension.js` (platform node, external vscode), `out/webview/main.js` (iife, browser).
- Pure logic in `src/core/` (`csvParse.ts`, `filter.ts`, `sort.ts`, `columns.ts`, `paging.ts`, `types.ts`) — no DOM, no vscode imports.
- Unit tests: vitest, `src/test/**/*.test.ts`.
- Webview e2e: Playwright (`@playwright/test`, Chromium at `/opt/pw-browsers` via `PLAYWRIGHT_BROWSERS_PATH` if set; locally `npx playwright install chromium` is allowed only if no browser found). Harness loads the built `out/webview/main.js` into a page with a stubbed `acquireVsCodeApi`, posts a `load` message, then drives the UI.
- Scripts: `compile`, `watch`, `test`, `test:webview`, `package` (`vsce package --no-dependencies` producing a `.vsix`).
- README with features, screenshots placeholder, install-from-vsix instructions for VS Code and Cursor.
- `.vscodeignore` so the vsix only ships `out/`, `media/`, `package.json`, README, LICENSE (MIT), CHANGELOG.

## Acceptance
1. `npm run compile` clean, `tsc -p tsconfig.webview.json` clean.
2. `npm test` — unit tests cover: parser edge cases (quotes, escaped quotes, embedded newlines, CRLF, BOM, ragged rows, delimiter detection, duplicate headers); every filter operator × include/exclude × case sensitivity, invalid regex, any-column rule, AND semantics; sort numeric vs string, mixed, empties last in both directions, stability, multi-key; column default visibility + reconciliation after header change.
3. `npm run test:webview` — Playwright covers: toggling a column in the Columns popover moves it from table to detail; expanding a row shows detail-only fields; header click sort asc/desc/none + shift multi-sort; adding an exclude rule reduces row count and "Showing X of Y" updates; quick search; `saveState` message posted after changes; a 20k-row fixture pages through First/Prev/Next/Last/jump/page-size correctly and never grows past one page's rows on scroll; page resets on search/filter/sort but not on column-visibility changes; nav buttons disable at the bounds and at zero rows; a same-fileKey reload keeps the page, clamped.
4. `npm run package` produces a `.vsix`.
