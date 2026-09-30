# CSV Viewer — VS Code extension spec (v0.3)

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
- `src/core/csvParse.ts` (pure module, no vscode/DOM import) wraps [Papa Parse](https://www.papaparse.com/) as the tokenizer: quote-aware (`"` only opens a quoted field as the first character of a field — a stray mid-field `"`, e.g. an inch mark or `He said "hi"`, is literal text, not a quote-open), `""` escapes, newlines inside quotes, CRLF/LF/CR, BOM stripping, ragged rows (pad short rows with "", extra cells get auto headers `column_N`).
- `parseCsv(text, options)` public API is unchanged in shape: BOM strip, header dedupe (`name`, `name_2`), empty header → `column_N`, ragged-row padding, extra cells → `column_N` headers, `firstRowIsHeader` option. It returns `{ headers, rows, delimiter }` where `delimiter` is the delimiter actually used (from Papa's `ParseResult.delimiter`), so the UI can show it (e.g. "Auto (;)").
- Blank lines (no characters at all) are skipped everywhere — via Papa's `skipEmptyLines: true` — both a trailing newline (no spurious empty row) and a fully blank line in the middle of the file. A line with only delimiters (e.g. `,,,`) is a real row of empty fields and is not skipped; this is a deliberate, documented choice, not an oversight.
- Delimiter: `ParseOptions.delimiter` — empty string or `undefined` means auto-detect via Papa's quote-aware guessing among `delimitersToGuess: [",", ";", "\t", "|"]`; a non-empty string (of any length, so multi-character delimiters like `||` are supported) forces that delimiter. `.tsv`/`.tab` files are given `"\t"` as the host's `defaultDelimiter`, used when no per-file separator is stored (see Custom separator, below). The old line-based `detectDelimiter` export and hand-written `tokenize` were removed along with the hand-written tokenizer; nothing needs a standalone delimiter guesser anymore since `parseCsv` returns the one it used.
- First row is header. Duplicate/empty header names get made unique (`name`, `name_2`; empty → `column_N`). Toggle "First row is header" in toolbar (persisted per file); when off, headers are `column_1..N`. Toggling it re-parses locally in the webview from the text already held in memory — no host round-trip.

### Custom separator
- Toolbar "Separator" dropdown: `Auto (<detected>)` (e.g. `Auto (;)`, with a tab rendered as the word "Tab"), `Comma ,`, `Semicolon ;`, `Tab`, `Pipe |`, and `Custom…`. Custom reveals a small text input (1–5 chars, applied on input after a 300ms debounce); an empty custom value falls back to Auto.
- Persisted per file in `ViewState.delimiter` (`""` = auto). Values stored before this field existed lack it entirely — treated the same as `""`.
- Precedence when resolving what to actually parse with: the stored per-file choice, else the host's `defaultDelimiter` (tab for `.tsv`/`.tab`), else real auto-detection.
- Changing the separator re-parses locally from the held text, reconciles column visibility (new header names follow the default-N rule — a name that existed before, even coincidentally, keeps its prior visibility), resets to page 1, and posts `saveState`. Filter rules and sort keys are left as-is: a rule or sort key pointing at a column that no longer exists simply matches/sorts nothing, same pre-existing behavior as a header rename.

## Architecture
- `CustomTextEditorProvider`, viewType `csvViewer.table`, selector `*.csv`, `*.tsv`, `*.tab`, **priority `option`** (text editor stays default). Commands: `csvViewer.open` ("Open in CSV Viewer") available in explorer context menu, editor title bar (icon) for csv/tsv files, and command palette; `csvViewer.openAsText` from inside the viewer.
- Setting `csvViewer.openByDefault` (bool, default false) — document in README that users can instead set `workbench.editorAssociations`. (If implementing dynamic priority is awkward, just document the association and skip the setting.)
- Live reload: when the underlying `TextDocument` changes (edited elsewhere / on disk), the host re-sends the document text (debounced 300ms per panel, cancelled on dispose — so editing in a side-by-side text editor doesn't re-send a large file on every keystroke) and the webview re-parses; keep UI state (visibility, filters, sort, current page clamped to the new count; expanded rows by index is fine to reset).
- **Parsing happens in the webview, not the host** (changed from v0.2, for performance — see below). The host never calls `parseCsv`; it only reads `document.getText()` and ships the whole text once per load/reload. Webview → host messages: `ready`, `saveState(state)`, `openAsText`. Host → webview: `load({ fileKey, text, state, defaultTableColumns, defaultDelimiter })` — `text` is the whole document text (not `headers`/`rows`), and `defaultDelimiter` is `"\t"` for `.tsv`/`.tab`, else `""`.
- The webview parses `text` with `parseCsv` in its `load` handler, showing "Loading…" in the status bar and yielding one frame (`requestAnimationFrame`/`setTimeout 0`) first so the placeholder actually paints before a large parse blocks the main thread. It reconciles column visibility itself (the host no longer does — `defaultVisibility`/`reconcileVisibility` are webview-only now) and only posts `saveState` back if reconciliation actually changed the stored visibility map, so a plain reopen of an already-settled file doesn't write on every open. The webview holds onto `text` in its in-memory state so the "first row is header" toggle and separator changes (see Custom separator, above) can re-parse locally without another host round-trip.
- Filtering/sorting/pagination runs in the webview (pure functions in a shared module, imported by the webview bundle and unit-tested in node).
- Why: measured in real VS Code 1.139 against a 31 MB / 100k-row × 30-col file, the old host-parses-twice-then-ships-`rows:string[][]` design cost ~3.3s to first render (~1.2s to parse twice on the host, ~1.5s to serialize 3M strings across the postMessage boundary). Parsing once, in the webview, from a single `text` string removes both costs.
- Webview: vanilla TypeScript + CSS, bundled with esbuild to `out/webview/main.js`. Strict CSP with nonce, `localResourceRoots` limited to `out/webview` + `media`. Use VS Code theme CSS variables (`--vscode-*`) only — must look right in light, dark, high-contrast.
- Performance: must stay responsive for 100k rows × 30 cols. Don't render all rows: pagination renders only the current page's rows (see Pagination above) instead of chunked/infinite-scroll rendering. Filter/sort over the full dataset; re-render the current page after changes. Sticky header row.
- Large files: if file > 50 MB (estimated via `document.getText().length`, cheaper than `Buffer.byteLength`), show a warning message and still try; no streaming needed in v0.1.

## Project layout / conventions (mirror ~/projects/markdown-collab-plugin)
- TypeScript strict, `tsconfig.json` (extension, commonjs, ES2022), separate `tsconfig.webview.json` (DOM lib, noEmit type-check).
- esbuild bundles: `out/extension.js` (platform node, external vscode — no longer imports `csvParse`/papaparse now that parsing is webview-only), `out/webview/main.js` (iife, browser — bundles `papaparse`, self-contained so `vsce package --no-dependencies` still works).
- Pure logic in `src/core/` (`csvParse.ts`, `filter.ts`, `sort.ts`, `columns.ts`, `paging.ts`, `types.ts`) — no DOM, no vscode imports. `csvParse.ts` depends on `papaparse` (a runtime dependency; `@types/papaparse` is dev-only) but is otherwise still pure/no-DOM, so it unit-tests in node and bundles into the webview unchanged.
- Unit tests: vitest, `src/test/**/*.test.ts`.
- Webview e2e: Playwright (`@playwright/test`, Chromium at `/opt/pw-browsers` via `PLAYWRIGHT_BROWSERS_PATH` if set; locally `npx playwright install chromium` is allowed only if no browser found). Harness loads the built `out/webview/main.js` into a page with a stubbed `acquireVsCodeApi`, posts a `load` message, then drives the UI. `bootAndLoad(page, { headers, rows, fileKey, state, defaultTableColumns, defaultDelimiter? })` keeps the convenient headers/rows fixture shape specs have always used, serializing to CSV `text` under the hood via `Papa.unparse` (matching the real `load` message shape); `bootAndLoadText` takes raw text directly for specs exercising parsing itself.
- Scripts: `compile`, `watch`, `test`, `test:webview`, `package` (`vsce package --no-dependencies` producing a `.vsix`).
- README with features, screenshots placeholder, install-from-vsix instructions for VS Code and Cursor.
- `.vscodeignore` so the vsix only ships `out/`, `media/`, `package.json`, README, LICENSE (MIT), CHANGELOG.

## Acceptance
1. `npm run compile` clean, `tsc -p tsconfig.webview.json` clean.
2. `npm test` — unit tests cover: parser edge cases (quotes, escaped quotes, embedded newlines, CRLF, BOM, ragged rows, delimiter auto-detection via Papa, duplicate headers, the stray-mid-field-quote regression, multi-character custom delimiters, semicolon-delimited European decimals, quoted text containing many `;`, blank-line handling); every filter operator × include/exclude × case sensitivity, invalid regex, any-column rule, AND semantics; sort numeric vs string, mixed, empties last in both directions, stability, multi-key; column default visibility + reconciliation after header change.
3. `npm run test:webview` — Playwright covers: toggling a column in the Columns popover moves it from table to detail; expanding a row shows detail-only fields; header click sort asc/desc/none + shift multi-sort; adding an exclude rule reduces row count and "Showing X of Y" updates; quick search; `saveState` message posted after changes; a 20k-row fixture pages through First/Prev/Next/Last/jump/page-size correctly and never grows past one page's rows on scroll; page resets on search/filter/sort but not on column-visibility changes; nav buttons disable at the bounds and at zero rows; a same-fileKey reload keeps the page, clamped; the Separator dropdown shows the detected delimiter, re-parses on Comma/Custom…/`||`, honors a stored `state.delimiter` and the host's `defaultDelimiter`; a stray-quote fixture renders as 3 cells end to end.
4. `npm run package` produces a `.vsix`.
