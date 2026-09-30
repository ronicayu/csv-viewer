# CSV Viewer

A read-only table viewer for CSV/TSV files in VS Code and its forks (Cursor, Windsurf).

*(screenshot placeholder — add a GIF or PNG of the table + detail view here before publishing)*

## Features

- **Table + detail view.** Each column is either shown in the table or moved to a per-row detail panel. Click a row's chevron (or the row itself) to expand it and see the detail-only fields as key/value pairs. Use the **Columns** button to choose which columns are in the table, with a search box and Show all / Hide all. Works correctly even for a column literally named `__proto__` (or `constructor`, `toString`, `hasOwnProperty`), and a visibility choice survives toggling "First row is header" off and back on.
- **Filtering.** A quick search box filters across every column. The **Filters** panel adds rules per column (or "any column") with operators — contains, equals, starts with, ends with, regex, is empty, and numeric `>`, `<`, `>=`, `<=` — each rule set to Include or Exclude, with case sensitivity and an enable checkbox. A rule whose column no longer exists, or that needs a value but doesn't have one yet, is ignored (shown with a "Column not found" / "Enter a value" hint) rather than silently hiding the whole file. Case-insensitive matching correctly folds Turkish İ and German ß. Right-click a cell to quick-add an include/exclude rule for that value.
- **A regex rule that runs too slowly is automatically disabled.** Filtering runs in a background worker, so a pathological regex (the classic catastrophic-backtracking kind, e.g. `(a+)+$` against an adversarial value) can never freeze the table. If a filter query containing an enabled regex rule doesn't answer within about 2 seconds, that rule is disabled — shown with a "Regex too slow — rule disabled" hint, ignored the same way an invalid regex is — and everything else keeps working. Edit the rule's pattern to give it another try.
- **Sorting.** Click a column header to cycle ascending → descending → none. Shift+click adds a secondary sort key (shown with a priority number). Use the **Sort by…** dropdown to sort by a detail-only column that has no visible header. Numeric vs. text comparison is computed once per cell up front, so mixed numeric/text columns sort consistently even at 500k+ rows.
- **Pagination.** A pager bar below the table — always visible, independent of table scroll — has First/Prev/Next/Last buttons, a "Page [ N ] of M" jump box, a "Rows X–Y of Z" range, and a page size selector (25/50/100/200/500, default 100). Quick search, filter, and sort changes jump back to page 1; changing column visibility keeps your place. Alt+→ / Alt+← move to the next/previous page. Rows render only the current page, so the view stays responsive even at 100k+ rows.
- **Separator.** A toolbar dropdown controls the field delimiter: Auto (shows what was detected, e.g. "Auto (;)"), Comma, Semicolon, Tab, Pipe, or Custom… for anything else (1–5 characters, e.g. a multi-character delimiter like `||`, or a literal space/tab — the custom input is never trimmed). `"` is rejected as a custom delimiter while "Quoted fields" is on (it conflicts with quoting); turn "Quoted fields" off to use it. Changing the separator re-parses the file, re-splits columns, and resets to page 1. Remembered per file; `.tsv`/`.tab` files default to Tab instead of auto-detecting.
- **Quoted fields.** A toolbar checkbox, on by default. If a file's quoting is malformed enough that rows get merged together, a dismissible warning banner appears above the table ("Quotes look malformed near row N…") with a **Treat quotes as plain text** button that turns this checkbox off and re-parses with every `"` as literal text.
- **Live reload.** Saving a change to the file — from another editor, another app, or a script — refreshes the view automatically, keeping your current page. Rapid successive saves are debounced into a single reload. If the file is deleted on disk, the viewer shows a warning but keeps displaying the last contents it loaded; it doesn't try to follow a rename to the file's new location either (see "Unsaved edits" below for why, and Settings for the rename case).
- **Unsaved edits are not reflected.** If you edit the same file in a text editor (side by side, say), the viewer only ever shows what's actually on disk — an edit you haven't saved yet won't appear in the viewer. This is a deliberate trade-off (see "Large files" below) rather than an oversight: save the edit and the viewer picks it up like any other on-disk change.
- **Large files.** Files over 50 MB show a "may be slow" warning but still open — verified in practice on files well over 100 MB. Files over 512 MB are rejected outright with an error, so an enormous file can't be loaded into memory and make the extension unresponsive.
- **Long cell values don't freeze the view.** A table cell shows at most the first 500 characters (plus "…"); the expanded detail view shows up to 10,000 characters plus a **Show all (N characters)** button that expands it in place (its tooltip warns if the value is over 1 MB, since showing something that large can be slow). Right-click quick-add always uses the full value, not the shortened display text.
- **Mixed line endings** (a file mixing CRLF/LF/lone CR) parse as one row per physical line, not merged together.
- Column visibility, filter rules, sort order, page size, separator choice, and the Quoted fields setting are remembered per file, keyed by its location. Renaming a file (or a folder containing CSV/TSV/TAB files) moves those remembered settings along with it.
- **Parsing** is powered by [Papa Parse](https://www.papaparse.com/), which is quote-aware: a stray `"` inside an unquoted field (an inch mark, `He said "hi"`) is treated as literal text instead of accidentally opening a quoted field and swallowing the rest of the file. Duplicate header names (e.g. `a,a,a_2`) are deduplicated so no two columns ever end up sharing a final name.
- **Parsing, filtering, and sorting run in a background worker**, off the main UI thread, so the table stays responsive — including while a slow filter or a huge sort is running — at 200k+ rows.
- Works in untrusted and virtual workspaces — reading only ever goes through VS Code's own filesystem API, never spawns a process or runs arbitrary code.

## Opening a file

- Right-click a `.csv`/`.tsv`/`.tab` file (any letter casing — `DATA.CSV`, `Sample.Tsv`, etc. all work) in the Explorer and choose **Open in CSV Viewer**.
- Or use the icon in the editor title bar, or the **Open in CSV Viewer** command from the Command Palette.
- The text editor stays the default; CSV Viewer is offered as an alternate editor. To make it the default for these extensions, configure `workbench.editorAssociations` (e.g. `"*.csv": "csvViewer.table"`).
- From inside the viewer, use **Open as Text** to switch back to the plain text editor for the same file — note that the text editor is where you'd make edits, since the viewer itself is read-only and doesn't reflect them until you save.

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
npm run test:integration # real VS Code (Extension Host) integration tests
npm run package          # produces the .vsix
```

A sample file with quoted commas, embedded newlines, numbers, and empty cells is at `samples/people.csv` for manual testing.

## License

MIT
