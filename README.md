# CSV Viewer

A read-only table viewer for CSV/TSV files in VS Code and its forks (Cursor, Windsurf).

*(screenshot placeholder — add a GIF or PNG of the table + detail view here before publishing)*

## Features

- **Table + detail view.** Each column is either shown in the table or moved to a per-row detail panel. Click a row's chevron (or the row itself) to expand it and see the detail-only fields as key/value pairs. Use the **Columns** button to choose which columns are in the table, with a search box and Show all / Hide all.
- **Filtering.** A quick search box filters across every column. The **Filters** panel adds rules per column (or "any column") with operators — contains, equals, starts with, ends with, regex, is empty, and numeric `>`, `<`, `>=`, `<=` — each rule set to Include or Exclude, with case sensitivity and an enable checkbox. Right-click a cell to quick-add an include/exclude rule for that value.
- **Sorting.** Click a column header to cycle ascending → descending → none. Shift+click adds a secondary sort key (shown with a priority number). Use the **Sort by…** dropdown to sort by a detail-only column that has no visible header.
- **Pagination.** A pager bar below the table — always visible, independent of table scroll — has First/Prev/Next/Last buttons, a "Page [ N ] of M" jump box, a "Rows X–Y of Z" range, and a page size selector (25/50/100/200/500, default 100). Quick search, filter, and sort changes jump back to page 1; changing column visibility keeps your place. Alt+→ / Alt+← move to the next/previous page. Rows render only the current page, so the view stays responsive even at 100k+ rows. Files over 50 MB show a warning but still open.
- **Separator.** A toolbar dropdown controls the field delimiter: Auto (shows what was detected, e.g. "Auto (;)"), Comma, Semicolon, Tab, Pipe, or Custom… for anything else (1–5 characters, e.g. a multi-character delimiter like `||`). Changing it re-parses the file, re-splits columns, and resets to page 1. Remembered per file; `.tsv`/`.tab` files default to Tab instead of auto-detecting.
- **Live reload.** Editing the file on disk or in another editor refreshes the view automatically, keeping your current page.
- Column visibility, filter rules, sort order, page size, and separator choice are remembered per file.
- **Parsing** is powered by [Papa Parse](https://www.papaparse.com/), which is quote-aware: a stray `"` inside an unquoted field (an inch mark, `He said "hi"`) is treated as literal text instead of accidentally opening a quoted field and swallowing the rest of the file.

## Opening a file

- Right-click a `.csv`/`.tsv`/`.tab` file in the Explorer and choose **Open in CSV Viewer**.
- Or use the icon in the editor title bar, or the **Open in CSV Viewer** command from the Command Palette.
- The text editor stays the default; CSV Viewer is offered as an alternate editor. To make it the default for these extensions, configure `workbench.editorAssociations` (e.g. `"*.csv": "csvViewer.table"`).
- From inside the viewer, use **Open as Text** to switch back to the plain text editor for the same file.

## Settings

| Setting                          | Default | Description                                                                 |
| --------------------------------- | ------- | ----------------------------------------------------------------------------- |
| `csvViewer.defaultTableColumns`   | `8`     | Number of leading columns shown in the table by default on first open.       |

## Installing from a `.vsix`

Build the package with `npm run package`, which produces `csv-viewer-0.3.0.vsix`.

**VS Code:** Extensions view → `···` menu → **Install from VSIX…** → select the file. Or from the command line: `code --install-extension csv-viewer-0.3.0.vsix`.

**Cursor:** Extensions view → `···` menu → **Install from VSIX…** → select the file. Or from the command line: `cursor --install-extension csv-viewer-0.3.0.vsix`.

## Development

```sh
npm install
npm run compile          # tsc + esbuild bundles for extension host and webview
npm run typecheck:webview
npm test                 # vitest unit tests for src/core
npm run test:webview     # Playwright e2e tests against the built webview bundle
npm run package          # produces the .vsix
```

A sample file with quoted commas, embedded newlines, numbers, and empty cells is at `samples/people.csv` for manual testing.

## License

MIT
