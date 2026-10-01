# Changelog

## 0.4.0

**Added**
- First-run prompt: the first time a CSV/TSV/TAB file opens as plain text, CSV Viewer
  asks once whether to view it as a table, with an "always open CSV files this way"
  option (`csvViewer.suggestOnOpen` setting).
- "Open as Text" action in the editor title while the viewer is active.
- Malformed-quote warning banner with a one-click "Treat quotes as plain text" fix,
  and a "Quoted fields" option to turn quoting off entirely.

**Changed**
- Renamed to "CSV Viewer: Table + Row Details" to stand out from similarly-named
  extensions.
- Opens files up to 512 MB (previously capped by VS Code's own ~50 MB text-sync
  limit); the "may be slow" warning above 50 MB is unchanged.
- Shows the file's actual on-disk contents after every save, not just on open.
- Stays responsive on large files: parsing, filtering, and sorting run in the
  background, a slow regex filter is automatically skipped instead of freezing the
  view, and very long cell values are truncated with a "Show all" option.
- Declares support for untrusted and virtual workspaces.

**Fixed**
- Mixed line endings, duplicate header names, and inconsistent numeric/text sorting
  are all fixed.
- A filter rule that can no longer apply (missing column, no value yet) is skipped
  with a hint instead of hiding every row.
- Uppercase and mixed-case extensions (`DATA.CSV`, `Sample.Tsv`, …) now open correctly
  everywhere.
- Renaming a file or folder keeps its remembered column/filter/sort settings.

<!-- webview UX changes are added here by the integrator -->

See [docs/engineering-notes-0.4.0.md](docs/engineering-notes-0.4.0.md) for the full
implementation-level detail behind this release.

## 0.3.0

- **Parsing switched to Papa Parse.** Fixes a real bug in the hand-written tokenizer: a stray `"` inside an unquoted field (an inch mark like `1,5" screen,TV`, or `He said "hi"`) used to flip the parser into quoted mode and swallow the rest of the file into one cell. Papa Parse only treats `"` as opening a quoted field when it's the first character of the field.
- The `parseCsv(text, options)` API is unchanged (BOM strip, header dedupe, empty-header → `column_N`, ragged-row padding, extra cells get `column_N` headers, `firstRowIsHeader`), but delimiter auto-detection is now quote-aware (correctly ignores delimiter-like characters inside quoted fields when guessing) and supports multi-character custom delimiters (e.g. `||`). `detectDelimiter` and the old tokenizer were removed; the delimiter actually used is returned on every parse.
- Blank lines (no characters at all) are skipped everywhere — a trailing newline no longer adds an empty row, and neither does a fully blank line in the middle of a file. A line with only delimiters (e.g. `,,,`) is still a real row of empty fields, not skipped.
- **Parsing moved into the webview**, and now happens once instead of twice. Previously the extension host parsed the file (to compute state) and parsed it again (to send `rows`/`headers`), then serialized `rows: string[][]` across the postMessage boundary — measured at 3.3s to first render for a 31 MB / 100k-row file in real VS Code. The host now sends the raw document `text` once; the webview parses it. A "Loading…" placeholder shows immediately and yields a frame before the parse starts, so it actually paints for large files.
- `onDidChangeTextDocument` is now debounced 300ms per panel, so editing the file in a side-by-side text editor doesn't re-send a large file on every keystroke.
- Toggling "First row is header" and changing the separator (below) now re-parse locally in the webview from the text it already holds — no host round-trip.
- The 50 MB large-file warning now estimates size via `document.getText().length` instead of `Buffer.byteLength(...)`, which is cheaper and good enough for a warning threshold.
- **New: a "Separator" toolbar control.** Auto (shows the detected delimiter, e.g. "Auto (;)"), Comma, Semicolon, Tab, Pipe, or Custom… (a 1–5 character delimiter, applied after a short debounce; an empty custom value falls back to Auto). Persisted per file; precedence is the stored per-file choice, then the host's default for `.tsv`/`.tab` (tab), then real auto-detection. Changing it re-parses, re-splits columns, reconciles column visibility, and resets to page 1; filters and sort are kept as-is (a rule or sort key pointing at a column that no longer exists simply matches/sorts nothing, same as before).
- Added `papaparse` as a runtime dependency and `@types/papaparse` as a dev dependency. It's bundled into `out/webview/main.js` by esbuild (self-contained, so `vsce package --no-dependencies` still works) — the extension host bundle (`out/extension.js`) no longer parses at all and doesn't include it.

## 0.2.0

- **Pagination** replaces infinite scroll. A pager bar below the table (always visible, independent of table scroll) has First/Prev/Next/Last, a "Page [ N ] of M" jump box, a "Rows X–Y of Z" range (or "No matching rows"), and a page size selector (25/50/100/200/500, default 100).
- Quick search, filter rule changes, and sort changes reset to page 1; column visibility changes and a live reload keep the current page (clamped to the new page count).
- Changing page size keeps the first currently-visible row in view. Changing page scrolls the table area back to top.
- "Expand all" / "Collapse all" are now "Expand page" / "Collapse page" — they act on the current page's rows only. Expanded state is still keyed by row id, so it survives paging back and forth.
- Keyboard shortcut Alt+→ / Alt+← for next/prev page, ignored while focus is in a form control.
- `pageSize` is persisted per file as part of the view state; a missing/invalid stored value (from before this release) falls back to 100.

## 0.1.0

Initial release.

- Read-only table viewer for `.csv`, `.tsv`, `.tab` files.
- Column visibility: show columns in the table or move them to a per-row detail panel; persisted per file.
- Filtering: quick search across all columns, plus a filter rules panel (contains/equals/starts with/ends with/regex/is empty/numeric comparisons), include or exclude, case sensitivity, enable/disable, quick-add from a cell's right-click menu.
- Sorting: click a header to cycle ascending/descending/none, shift+click for multi-key sort, a "Sort by…" dropdown for detail-only columns.
- Own RFC 4180-style CSV/TSV parser: quoted fields, escaped quotes, embedded newlines, CRLF/LF/CR, BOM stripping, delimiter auto-detection, ragged rows, duplicate/empty header handling.
- Chunked rendering with infinite scroll and a sticky header, built to stay responsive at 100k rows.
- Live reload when the underlying file changes on disk or in another editor.
