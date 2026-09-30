# Changelog

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
