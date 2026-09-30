# Changelog

## Unreleased

Bug fixes found by the adversarial "stress" test suites (`src/test/stress/*.test.ts`, `src/test/webview-e2e/stress/*.spec.ts`):

- **Mixed line endings.** A file mixing CRLF, LF, and lone CR line endings used to silently merge rows and leak newline characters into cell values (Papa Parse only sniffs one newline style per file). `parseCsv` now normalizes every line ending to `\n` before parsing. This also normalizes a CRLF/CR embedded inside a quoted field down to `\n` — a deliberate, documented tradeoff, not a regression.
- **Malformed quotes.** A quote that opens after a delimiter, closes, and has more text before the next delimiter (e.g. `h,"b"c,d`) still makes Papa swallow the rest of the row/file into one field while quoting is on — that's kept as-is (the decision was to keep Papa, not hand-roll different quote handling). What's new: `ParseResult.quoteProblems` reports the affected data rows, the webview shows a dismissible warning banner ("Quotes look malformed near row N…") with a **Treat quotes as plain text** button, and a new "Quoted fields" toolbar checkbox (`ViewState.quotes`, default `true`) lets quoting be turned off entirely so every `"` is parsed as literal text.
- **Header dedupe collision.** `"a,a,a_2"` used to dedupe to two columns both named `a_2` (aliasing each other's data); the generated `_N` suffix now always skips any name already claimed by another final header, literal or generated, so every header is guaranteed unique.
- **Sort comparator wasn't a total order.** Mixed numeric/text columns could produce visibly wrong, non-transitive sort orders (Array.sort's contract requires a consistent total order). `sortRows` now precomputes one canonical sort key (empty/numeric/text) per cell per sort column up front, instead of re-deriving numeric-vs-text per pairwise comparison. A 3-key sort of 500k × 20 rows still completes in well under 1.2s.
- **`__proto__` header couldn't be hidden.** A column literally named `__proto__` could never be recorded as hidden (`Object.prototype`'s `__proto__` accessor silently no-ops a plain-object write of a non-object value) and always rendered as visible. `columnVisibility` maps now write via `Object.defineProperty` and read only via a safe `getVisibility`/`hasVisibility` helper; already-persisted state keeps working since `JSON.parse` (unlike a runtime bracket assignment) creates a real own `__proto__` property.
- **Custom separator input.** The custom delimiter input used to be trimmed, so a single space or tab could never actually be applied (silently fell back to Auto). It's no longer trimmed. `"` is now rejected with an inline error while "Quoted fields" is on (it conflicts with Papa's quote character); it's allowed once "Quoted fields" is off.
- **Header toggle lost visibility.** Toggling "First row is header" off and back on used to silently reset any customized column visibility, because reconciliation only compared against the *immediately previous* header set. `reconcileVisibility` now merges — it carries every previous entry forward regardless of the current header list — so a setting survives the round trip.
- **Case folding.** Case-insensitive matching (filter operators and quick search) now goes through a shared `foldCase`, which correctly folds Turkish İ (dropping the stray combining dot `toLowerCase` leaves behind) and German ß → `ss`, so e.g. `STRASSE` matches `straße`.
- **Numeric parsing.** Filter's numeric operators used to accept anything plain `Number()` does, including hex (`0x10`) and `Infinity`/`NaN` text. A shared, stricter `parseNumber` (also now used by sort) accepts only real decimal numbers (optionally scientific notation), rejecting hex, thousands separators, and currency/percent symbols.
- **Filter rules that couldn't apply used to filter out everything.** A rule whose column no longer existed, or that needed a value but had none, used to be applied as "matches nothing" — which, for an include rule, dropped every row in the file. Both cases are now ignored (no effect), with a "Column not found" / "Enter a value" hint in the Filters panel, via a shared `isRuleActive` helper that the UI and `applyFilters` both use.

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
