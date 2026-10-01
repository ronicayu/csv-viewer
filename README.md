# CSV Viewer: Table + Row Details

Read wide CSV and TSV files in VS Code, Cursor, and Windsurf without scrolling sideways.
Keep the columns you scan in the table; expand any row to read everything else —
long notes, descriptions, JSON — in full.

![Picking table columns, then expanding a row to read its notes and JSON](media/hero.png)

## Open a file

Right-click a `.csv` / `.tsv` / `.tab` file in the Explorer and choose **Open in CSV
Viewer**, or click the table icon in the editor title bar, or use the **Open in CSV
Viewer** command from the Command Palette.

The first time a CSV, TSV, or TAB file opens as plain text, CSV Viewer asks once:
**View "filename.csv" as a table?**, with three choices — **Open as Table** (just this
file), **Always for CSV Files** (makes the viewer the default editor for these
extensions from then on), and **Don't Ask Again**. Any answer, including dismissing
the prompt, means it won't ask again; turn it off up front with the
`csvViewer.suggestOnOpen` setting.

You can also make the viewer the default editor yourself at any time, for one file or
every file of a kind, through **Open With… → Configure default editor**. Either way,
the plain text editor is still one click away: use **Open as Text** in the editor
title bar to switch back for the same file — the viewer is read-only by design, so
that's where you'd make edits.

- **Table + row details.** Each column is either in the table or in a per-row detail
  panel; choose which with **Columns**.
- **Find rows fast.** Search all columns, or add include/exclude rules (contains,
  equals, regex, numeric comparisons…). Right-click any value to filter by it.
- **Sort** by clicking a header; Shift+click adds a second key.
- **Handles messy exports.** Detects comma, semicolon, tab, or pipe; warns and offers a
  one-click fix when quotes look malformed; picks up changes made on disk.
- **Stays responsive at scale.** Parsing, filtering, and sorting run off the main
  thread, so a huge file or a slow filter never freezes the view.
- **Read-only and private.** Never modifies your file, no telemetry, no network, works
  in untrusted and virtual workspaces.

## Reading wide files

Every column starts out either shown in the table or moved to a row's detail panel.
Click a row (or its chevron) to expand it and see its detail-only fields as key/value
pairs. Use the **Columns** button to choose which columns are in the table — it opens
a popover with a search box and **Show all** / **Hide all** buttons. The split is
remembered per file. By default, the first `csvViewer.defaultTableColumns` columns
(8) start in the table and the rest start as detail-only.

## Filtering and sorting

A quick search box filters across every column, including ones that aren't in the
table. The **Filters** panel adds rules per column (or "any column") with operators —
contains, equals, starts with, ends with, regex, is empty, and numeric `>`, `<`, `>=`,
`<=` — each set to include or exclude, with case sensitivity and an enable checkbox.
Right-click a cell to quick-add an include/exclude rule for that value. A rule that
can't currently apply (its column was removed, or it needs a value it doesn't have
yet) is skipped rather than hiding everything, with a hint explaining why.

Click a column header to cycle ascending → descending → none; Shift+click adds a
second sort key. Use the **Sort by…** dropdown to sort by a column that's currently
detail-only.

## File format

A **Separator** dropdown controls the field delimiter: Auto (shows what was detected),
Comma, Semicolon, Tab, Pipe, or Custom. **First row is header** controls whether the
first line is treated as column names. **Quoted fields**, on by default, treats `"` as
opening a quoted field; if a file's quoting is malformed enough that rows run
together, a dismissible banner appears with a **Treat quotes as plain text** button
that turns this off and re-parses with every `"` as literal text.

## Limits

- The viewer is read-only. It never modifies the file on disk.
- It shows whatever is actually saved on disk — an edit you haven't saved yet in
  another editor won't appear until you save it.
- Files over 50 MB show a "may be slow" warning but still open.
- Files over 512 MB are rejected outright, so a huge file can't make the extension
  unresponsive.
- Values with decimal commas (e.g. `12,50`) sort and compare as text, not numbers.

## Privacy

CSV Viewer has no telemetry and makes no network requests. Reading a file only ever
goes through VS Code's own filesystem API — no arbitrary code execution, no writes, no
spawned processes — so it works in untrusted and virtual workspaces.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `csvViewer.defaultTableColumns` | `8` | Number of leading columns shown in the table by default when a file is first opened. |
| `csvViewer.suggestOnOpen` | `true` | Ask whether to view a CSV/TSV/TAB file as a table the first time it's opened as plain text. |

## Works well with

- [Rainbow CSV](https://marketplace.visualstudio.com/items?itemName=mechatroner.rainbow-csv) colors a CSV's columns right in the text editor.
- [Edit CSV](https://marketplace.visualstudio.com/items?itemName=janisdd.vscode-edit-csv) opens an editable grid.

CSV Viewer is for reading: use it alongside either of those for coloring or editing.

See [CHANGELOG.md](CHANGELOG.md) for release notes, and [open an issue](https://github.com/ronicayu/csv-viewer/issues) for bugs or requests.

## License

MIT
