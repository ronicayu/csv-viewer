# Changelog

## 0.1.0

Initial release.

- Read-only table viewer for `.csv`, `.tsv`, `.tab` files.
- Column visibility: show columns in the table or move them to a per-row detail panel; persisted per file.
- Filtering: quick search across all columns, plus a filter rules panel (contains/equals/starts with/ends with/regex/is empty/numeric comparisons), include or exclude, case sensitivity, enable/disable, quick-add from a cell's right-click menu.
- Sorting: click a header to cycle ascending/descending/none, shift+click for multi-key sort, a "Sort by…" dropdown for detail-only columns.
- Own RFC 4180-style CSV/TSV parser: quoted fields, escaped quotes, embedded newlines, CRLF/LF/CR, BOM stripping, delimiter auto-detection, ragged rows, duplicate/empty header handling.
- Chunked rendering with infinite scroll and a sticky header, built to stay responsive at 100k rows.
- Live reload when the underlying file changes on disk or in another editor.
