# Editing: design

Status: proposal, nothing implemented yet. Target: 0.8.0 for Phase 1 (see §4).

CSV Viewer is a reading tool: `docs/reviews/pm-review.md` put editing out of scope so the
listing could say "never modifies your file". This document adds editing without giving
that up: the viewer still never writes until the user saves, a save changes only the rows
the user touched, and nothing can be edited by accident. It assumes the architecture in
`docs/spec.md` (parsing in a Web Worker, the host only ships bytes) and keeps every
existing read-mode behaviour and test.

## 1. Goals and non-goals

Goals

- Fix a value in place without leaving the viewer, in the table or in a row's details;
  save with Cmd/Ctrl+S; undo and redo; the tab's dirty dot, "Save changes?" on close,
  Revert File and hot exit all behave like any VS Code editor.
- A save produces a **minimal diff**: untouched rows are byte-identical to the file
  (quoting style, trailing empties, blank lines included). The audience reads exports in
  VS Code and commits them; a one-cell edit must not re-quote 10,000 rows.
- Nothing is written to disk until Save. An edit can't happen by accident: editing is an
  explicit mode, and read mode keeps every current keyboard and mouse behaviour.
- No change to the performance targets in `docs/spec.md`: the parse/query/page hot path
  is untouched; editing adds work only when a cell is committed or the file is saved.

Non-goals for v1

- Spreadsheet features: formulas, multi-cell selection, drag-fill, find & replace.
- Column operations (add, delete, reorder) and header rename (Phase 2).
- Editing files over 50 MB (§2.9).
- Reflecting unsaved edits made in a side-by-side text editor (unchanged: the viewer shows
  what is on disk, see "Why readonly" in `docs/spec.md`).

## 2. User experience

### 2.1 Edit mode

A pencil icon button (`#edit-toggle`, codicon `edit`, `aria-pressed`) sits in the toolbar
after the expand/collapse toggle and before File format. Tooltip: "Edit cells" / "Stop
editing". It is a per-session switch: off every time a file is opened, not persisted. While
on, the button shows VS Code's pressed style (`--vscode-inputOption-activeBackground`).

The button is hidden when the `csvViewer.editing` setting is off, and shown disabled, with
the reason in its tooltip, when the file is too large (§2.9) or on a read-only file system
(`vscode.workspace.fs.isWritableFileSystem(uri.scheme) === false`).

Why a mode and not "always editable": Enter, Space and the arrow keys already have
documented meanings on a row (expand, collapse, move), a spreadsheet's type-to-replace is
exactly the accident a reading tool must not have, and a mode lets the keyboard model switch
wholesale instead of being bolted onto the row model. See §7.

Entry points into edit mode: the toolbar button, and **Edit Value…** in a cell's or detail
field's context menu (turns the mode on and opens that cell's editor in one gesture).

### 2.2 Editing in the table

In edit mode the table becomes an ARIA grid: `role="grid"` on the table, `role="gridcell"`
on data cells, and the roving tabindex moves from the row to **one cell** (the row model's
`focusedRowId` plus a new `focusedColumn`). In read mode nothing changes.

With a cell focused and no editor open:

| Key | Action |
| --- | --- |
| ← / → | previous / next cell in the row (no wrap) |
| ↑ / ↓ | same column, previous / next row |
| Home / End | first / last cell of the row; with Ctrl, first / last row of the page |
| Enter, F2 | open the editor with the caret at the end |
| any printable character | open the editor with that character replacing the value |
| Delete, Backspace | clear the cell (an edit) |
| Space | toggle the row's details (kept from read mode) |
| Shift+F10, ContextMenu | the cell's context menu |
| Tab | leaves the grid (ARIA grid convention; Tab never walks cells) |

Double-click on a cell opens its editor too. The editor is a single-line `<input
class="cell-editor">` filling the cell, styled with `--vscode-input-*` and
`--vscode-focusBorder`. While it is open:

| Key | Action |
| --- | --- |
| Enter | commit, focus the cell below |
| Shift+Enter | commit, focus the cell above |
| Tab / Shift+Tab | commit, focus the next / previous cell |
| Escape | cancel: the value is restored, focus stays on the cell |
| Cmd/Ctrl+Z | revert the input to the value it opened with (see §3.8 for why this is single-level) |
| Cmd/Ctrl+S | commit, then VS Code saves |
| blur (click elsewhere) | commit |

A commit that does not change the value is not an edit (no journal entry, no dirty flag). A
value containing a line break can't live in a single-line input: Enter/F2 on such a cell
expands the row and opens the detail field's editor instead (§2.3).

### 2.3 Editing in row details

In edit mode every detail field gets an edit button (codicon `edit`) next to its copy
button. Clicking it (or Enter/F2 on a multi-line table cell, above) replaces the value with
a `<textarea>` holding the **raw** value (never the formatted JSON or rendered Markdown),
auto-grown to its content up to ~12 lines, in the editor monospace font for JSON columns,
with **Save** / **Cancel** buttons underneath. Cmd/Ctrl+Enter commits, Escape cancels, blur
commits (the Cancel button uses `mousedown` + `preventDefault` so clicking it doesn't blur-
commit first). After a commit the field re-renders through the normal `populateDetailValue`
path, so a JSON or Markdown field is formatted again. Values over 1 MB are not editable in
place (the button is disabled with a tooltip); the 10,000-character display cap does not
apply to the textarea.

### 2.4 Unsaved-change markers and the Edits row

A cell whose current value differs from the value it had at load or at the last save gets
`td.cell-modified` (a 2px left border in `--vscode-editorGutter-modifiedBackground`); the
matching detail field's label gets the same dot. Markers come from a main-thread `baseline`
map (original value per edited cell, recorded on first edit), so undoing back to the
original clears the marker, and Save clears all of them.

While the document is dirty a slim row (`#edits-row`, same pattern as `#filtered-row`, so
the toolbar's height never changes) reads **"3 cells changed · Undo · Redo · Discard all"**.
Undo/Redo post `requestUndo`/`requestRedo` and the host runs VS Code's own `undo`/`redo`
commands; Discard all asks "Discard 3 changes?" (host-side modal) and reverts (§2.6).

### 2.5 Save, undo, redo, revert, close

All of these are VS Code's: Cmd/Ctrl+S and File > Save call the provider's save; Ctrl+Z /
Ctrl+Shift+Z / Ctrl+Y and Edit > Undo/Redo call the undo/redo callbacks of the edits the
provider reported; File > Revert File calls revert; closing a dirty tab prompts; hot exit
backs the document up and restores it on restart; Save As writes to the chosen path and
re-targets the tab. `files.autoSave` applies to custom editors too, so with it on every
commit is followed by a save (each save serializes the whole file — see §3.9).

Undo/redo granularity: one committed cell = one undoable step. Undoing a change whose row is
not on the current page jumps to the page holding it when the row is in the current
filtered view, otherwise the Edits row says "Change undone in a row hidden by the current
filter".

### 2.6 Filters, sort, search and pages while editing

An edit does not re-run the query. The row stays where it is, even if its new value no
longer matches a filter or would sort elsewhere, until the next thing that queries anyway
(a search, filter or sort change). This is what spreadsheets do with a filtered range, and
it keeps rows from jumping away from under the cursor on commit. Paging keeps working
(it slices the worker's cached view by row id). The `(filtered from N)` count can therefore
be stale between an edit and the next query; Phase 2 adds a "View is out of date —
Refresh" affordance.

The values picker's per-column cache and the sort-key cache are invalidated for the edited
column, so the next picker open or sort is correct.

### 2.7 The file changing on disk

Today a change on disk reloads the viewer. While the document is dirty it must not: the
watcher instead sends `fileChangedWhileDirty` and the webview shows a banner —
`"‹name›" changed on disk. Your unsaved edits are kept.` with a **Reload from disk
(discards your edits)** button that reverts. A clean document reloads as today.

On save, the host compares the file's `mtime` with the one it loaded (or last wrote). If it
differs, a modal warning asks `"‹name›" has changed on disk since it was loaded. Overwrite
it?` [Overwrite] [Cancel]; Cancel fails the save with that message. A file deleted on disk
(the existing banner) saves without a prompt, recreating it, as the text editor does.

**Open as Text** while dirty: the text editor would show the on-disk file, not the edits, so
the host first asks "Save changes before opening as text?" [Save and Open] [Open Without
Saving] [Cancel].

### 2.8 File format controls while dirty

Separator, "First row is header" and "Quoted fields" re-tokenize the file, which changes
row identities and would discard the worker's edits. In Phase 1 the File format popover's
controls are disabled while the document is dirty, with the note "Save or discard your
edits to change the file format." (Phase 3 lifts this by serializing first, §4.)

### 2.9 Limits and guards

- **Editing is available for files up to 50 MB** (the existing `LARGE_FILE_BYTES`). Above
  it the toggle is disabled: every save and every hot-exit backup serializes the whole file
  through the worker (§3.9), and the memory for the source text, the rows and the output
  all at once is what the 512 MB read limit was meant to avoid.
- **Quoted fields off**: with quoting off there is no way to write a value containing the
  separator or a line break, so the editor refuses such a commit with an inline error
  (`--vscode-inputValidation-errorBorder`): "Can't contain ‹separator› or a line break
  while Quoted fields is off."
- **First row is header off**: the synthesized `column_N` headers are never written; the
  header row (there is none) can't be edited.
- **Synthesized header names** (`a_2`, `column_3` from dedupe and ragged rows) are display
  names; the file's own header text is what gets written. Phase 2's header rename edits the
  raw header cell.
- Read-only file systems: the toggle is disabled ("This file system is read-only").
- Untrusted and virtual workspaces stay supported: a write goes through `workspace.fs` to
  the user's own file, which is what restricted mode permits.

### 2.10 Setting

`csvViewer.editing` (boolean, default `true`): "Allow editing cells in the viewer (adds an
Edit button to the toolbar). Turn off to keep the viewer strictly read-only." Changing it
takes effect on open viewers (the host re-sends `editable`).

## 3. Architecture

### 3.1 Provider: `CustomEditorProvider`

`CsvEditorProvider` changes from `CustomReadonlyEditorProvider<CsvDocument>` to
`CustomEditorProvider<CsvDocument>`. Same `viewType`, same `package.json` entry, same
`retainContextWhenHidden: true` (now required: a hidden tab must still answer a Save All or
a backup) and `supportsMultipleEditorsPerDocument: false`. It gains:

- `onDidChangeCustomDocument`: fired once per committed edit with `{ document, label,
  undo, redo }`. VS Code owns the undo stack, the dirty flag and the save point.
- `saveCustomDocument`, `saveCustomDocumentAs`, `revertCustomDocument`,
  `backupCustomDocument`, and `openCustomDocument` now honours `openContext.backupId`.

Not `CustomTextEditorProvider`: it would hand dirty tracking and undo to VS Code for free
and keep a side-by-side text editor in sync, but it is exactly what 0.4.0 moved away from
because VS Code never syncs a document above its ~50 MB text ceiling, and reading large
files is the product. Owning the edit model is the price of keeping that.

### 3.2 Who holds what

| Where | Holds | Why |
| --- | --- | --- |
| Worker (`worker.ts`) | the materialized rows; applies every op; serializes on request; retains `sourceText` and the parse options | the host never parses (`docs/spec.md`), and the main thread never holds more than a page |
| Webview main thread (`main.ts`) | the current page, the `baseline` for markers, and `journal: Edit[]` — every op applied since the last `load`, in order | the journal is replayed onto a fresh worker after a regex-timeout respawn (§3.6), and drives the markers |
| Host (`extension.ts`) | `CsvDocument`: the edit closures VS Code calls, `editCount`/`savedEditCount` for its own dirty check (the watcher and the save prompt), `hadBom`, the loaded `mtime`, the backup uri | VS Code talks only to the host; the host never needs the data, only the journal and the bytes it gets back |

Undo and redo are always **host-initiated**: VS Code calls the closure, the host sends
`applyEdit` to the webview. Ctrl+Z pressed inside the webview reaches the host through VS
Code's keybinding forwarding (§3.8), never through webview code, so there is one path.

### 3.3 Edit operations — `src/core/edits.ts` (pure)

```ts
export type EditOp =
  | { kind: "setCell"; rowId: number; column: number; before: string; after: string }
  // Phase 2:
  | { kind: "insertRow"; rowId: number; afterRowId: number | null; cells: string[] }
  | { kind: "deleteRow"; rowId: number; afterRowId: number | null; cells: string[] }
  | { kind: "setHeader"; column: number; before: string; after: string };

/** One user action, undone and redone as a unit. */
export interface Edit { id: number; label: string; ops: EditOp[] }

export function invertOp(op: EditOp): EditOp;   // setCell swaps before/after; insert <-> delete
export function invertEdit(edit: Edit): Edit;   // inverted ops, reversed
```

Columns are addressed by index into the parse's (padded) header list, not by name: names
like `a_2` are synthetic and Phase 2 renames them. Every op carries enough to be applied
and inverted without consulting any other state (`before` on `setCell`, `cells` and the
anchor on row ops), so a journal can be replayed onto a fresh parse of the same text and
VS Code's undo closures need no lookup. Row ids are allocated on the main thread (a counter
seeded from `totalRows`) and travel inside the op, so an undone insert re-inserts the same
id.

### 3.4 Host ↔ webview messages (`src/core/types.ts`)

```ts
// LoadMessage gains:
editable: boolean;
editableReason?: "setting" | "tooLarge" | "readonlyFs";

// host -> webview
| { type: "editable"; editable: boolean; reason?: ... }   // setting or fs changed after load
| { type: "applyEdit"; edit: Edit; source: "undo" | "redo" }
| { type: "serialize"; requestId: number }
| { type: "saved" }                                       // reset baseline, clear markers
| { type: "fileChangedWhileDirty"; name: string }

// webview -> host
| { type: "edit"; edit: Edit }
| { type: "serializeResult"; requestId: number; text: string }
| { type: "serializeError"; requestId: number; message: string }
| { type: "requestUndo" } | { type: "requestRedo" } | { type: "requestRevert" }
| { type: "editorOpen"; open: boolean }                   // fallback only, see §3.8
```

### 3.5 Worker protocol (`src/webview/workerProtocol.ts`)

```ts
| { type: "applyEdits"; requestId: number; ops: EditOp[] }   -> { type: "editsApplied"; requestId; totalRows }
| { type: "serialize";  requestId: number }                  -> { type: "serializeResult"; requestId; text }
| { type: "locateRow";  requestId: number; rowId: number }   -> { type: "rowLocated"; requestId; viewIndex }  // -1: not in view
```

`init` is unchanged on the wire; the worker now keeps `sourceText` and the parse options
it was given (one extra copy of the text, bounded by the 50 MB editing cap).

Phase 1 worker model: `rawRows` stays `string[][]` with `id === index`. `setCell` mutates
`rawRows[rowId][column]` in place — the row array's identity is unchanged, so `idByRowRef`
and `applyFilters` keep working untouched. It records the id in `modifiedRowIds`, and
invalidates `sortKeyCache` and `distinctCache` for that column only. `currentView` is kept
(§2.6). The `columnProfiles` are not recomputed.

Phase 2 (row ops) needs ids decoupled from positions: `rowById: Map<number, string[]>`
plus the file-ordered array; `onPage` resolves cells by id; `buildColumnSortKeys` becomes
id-addressed (an array indexed by id with holes for deleted rows), and an insert or delete
drops the whole sort-key cache. The row number shown to the user (`row.id + 1` today)
becomes the position in the file-ordered array.

### 3.6 Flows

**Commit a cell.** The webview validates (§2.9), builds `Edit { ops: [setCell] }`, applies
it optimistically (patches `currentPageRows`, the `<td>`, the marker), posts `applyEdits`
to the worker, appends to `journal`, clears `lastQueryKey` (so the next query really
runs), and posts `edit` to the host. The host pushes the edit onto `CsvDocument`, bumps
`editCount`, and fires `onDidChangeCustomDocument` with closures that send `applyEdit` with
`invertEdit(edit)` (undo) or `edit` (redo).

**Undo / redo.** VS Code calls the closure → host adjusts `editCount` and sends
`applyEdit` → webview applies to the worker, appends the applied (inverse) edit to
`journal`, updates `baseline`/markers, and re-renders the row if it is on the page;
otherwise `locateRow` → jump to that page or show the notice (§2.5).

**Save.** `saveCustomDocument` → stat and compare `mtime` (§2.7) → `serialize` to the
webview → worker builds the text (§3.7) → `serializeResult` back (30 s timeout, else the
save fails with the reason) → host encodes UTF-8, re-adds the BOM if `hadBom`
(`TextDecoder` strips it on load, so the webview never sees it), `workspace.fs.writeFile`,
re-stats and sets `lastLoaded` to the new size/mtime so the watcher's own change event is
skipped by the existing unchanged-file check, sets `savedEditCount = editCount`, sends
`saved`. Save As is the same with the destination uri; VS Code re-targets the tab.

**Backup / restore.** `backupCustomDocument` runs the same serialize and writes
`{ "v": 1, "baseMtime": number, "text": string }` to `context.destination`, returning
`{ id, delete }`. `openCustomDocument(uri, { backupId })` records the backup uri; the first
`postLoad` reads it instead of the file and takes `lastLoaded.mtime` from `baseMtime`, so a
change made while VS Code was closed is still caught by the save prompt. VS Code marks a
document restored from a backup dirty itself (spike, §8). The undo history and markers are
gone after a restore — same as text editors lose nothing but we have no persisted journal;
the restored text is the new base.

**Revert.** `revertCustomDocument` → re-read the file → `postLoad(true)` → `editCount =
savedEditCount = 0`. A fresh `load` always clears the webview's `journal` and `baseline`.
Each `load` also bumps a host-side `generation` captured by the edit closures, so an undo of
an edit from before a revert is a no-op instead of applying an old op to a new parse.

**Reload while dirty.** `scheduleReload` → `postLoad(false)` checks `editCount !==
savedEditCount` first; dirty → `fileChangedWhileDirty`, clean → today's reload. The
banner's button posts `requestRevert` → host runs `workbench.action.files.revert` (only VS
Code's own revert resets its dirty flag and save point).

**Regex-timeout respawn.** `respawnWorker` re-inits from `state.text`, which is the
unedited source. In `onInitResult` with `pendingInitIsFreshParse === false`, the main
thread replays `journal` (flattened ops) via `applyEdits` before re-sending the pending
query or `distinct`. A regex timeout during editing therefore loses nothing; an e2e test
covers it.

### 3.7 Serialization — `src/core/csvSerialize.ts` (pure)

Minimal diff by **record spans**: every record of the file is either copied verbatim from
the source or re-serialized because it changed.

```ts
export interface RecordSpan { start: number; end: number; rawLength: number }
/** Record boundaries over the normalized text, tokenized exactly as parseCsv tokenizes
 * (Papa Parse in step mode: `meta.cursor` after each record). Index 0 is the header
 * record when firstRowIsHeader. */
export function recordSpans(text: string, options: ParseOptions): { normalized: string; spans: RecordSpan[] };
export function serializeCell(value: string, delimiter: string, quotes: boolean): string;
export function serializeRow(cells: string[], width: number, delimiter: string, quotes: boolean): string;
export function serializeDocument(input: {
  text: string;                       // the text the worker was init'ed with
  options: ParseOptions;              // the parse options actually used (delimiter resolved)
  rows: { id: number; cells: string[] }[];   // current rows in file order
  modifiedRowIds: Set<number>;        // rows whose cells differ from the parse (inserted ones too)
  header: { cells: string[]; modified: boolean } | null;
}): string;
```

Verified before writing this (Papa Parse 5.5 in node): in step mode `meta.cursor` yields
exact `[previousCursor, cursor)` slices including each record's own line ending; a blank
line attaches to the following record's span; step and batch mode agree record for record
(quoted newlines, escaped quotes, `skipEmptyLines`); 200k × 30 cells take ~0.6 s in step
mode (batch mode took ~1.2 s on the same input). Spans are computed **at save time**, so
the parse hot path stays untouched; using Papa for the spans (not a hand-written scanner)
is what guarantees the same segmentation `parseCsv` produced, malformed quotes included.

Algorithm:

1. `recordSpans` over the source (`normalized` = BOM stripped, line endings → `\n`, the
   same `normalizeLineEndings` the parser uses).
2. Line ending: `\r\n` if the first line break in the source is CRLF, else `\n`.
3. For each record in file order: untouched → `normalized.slice(start, end)`; modified →
   `serializeRow(cells, width, delimiter, quotes) + "\n"` with `width =
   max(rawLength, lastNonEmptyIndex + 1)` so a short (ragged) row stays short unless the
   user filled a cell beyond its end; inserted → the same with the header's width; deleted
   → nothing. An untouched header is copied verbatim, so dedupe/`column_N` names never
   reach the file.
4. A trailing newline is kept iff the source had one.
5. If the line ending is CRLF, replace every `\n` in the output with `\r\n` (the
   normalized text has only `\n`; in-quote line breaks follow the file's style).

Quoting with quotes on: a cell is quoted iff it contains the delimiter, `"`, `\n` or `\r`,
with `"` doubled (RFC 4180; Papa does not trim, so leading/trailing spaces need no
quotes). With quotes off cells are written verbatim; the editor already refused anything
unrepresentable (§2.9). The delimiter is the one the parse actually used, including the
`"`-as-delimiter workaround.

Documented normalizations the first save of a *modified* file applies, all of which the
parser already applies when reading: mixed line endings become the file's dominant style,
a lone `\r` becomes a line ending, a CRLF inside quotes follows the file's style. Untouched
rows are otherwise byte-identical. Properties to test with fast-check: `parseCsv(serialize(
edited)) ≡ edited rows`; untouched rows byte-identical; zero edits ⇒ output equals the
normalized source; round-trips of values holding the delimiter, quotes, line breaks,
leading/trailing spaces, empties and `__proto__`.

Alternative rejected: full re-serialization with `Papa.unparse` — simpler, but every row
whose export quoted unnecessarily (very common) would change on a one-cell edit.

### 3.8 Keyboard forwarding and Ctrl+Z

VS Code's webview wrapper (`pre/index.html`, `handleInnerKeydown`) forwards every keydown
to the workbench, and calls `preventDefault()` on undo/redo chords, so **no input inside
any webview has native text undo**, and Ctrl+Z always reaches the workbench's `undo`,
which for an active custom editor calls the document's undo callback. Two consequences:

- With no cell editor open this is exactly right and needs no webview code.
- With a cell editor open the chord must revert the input (single level, §2.2) and must
  **not** also reach the document. The wrapper's listener is attached to the inner frame's
  `window`; a `document`-level keydown listener that calls `stopPropagation()` on undo/redo
  chords while an editor is open keeps the event from reaching it. This is spike 1 (§8):
  the integration suite must show `undo` is not invoked while an editor is open. Fallback
  if forwarding can't be suppressed: the webview posts `editorOpen`, the host sets a context
  key `csvViewer.cellEditorOpen`, and contributed keybindings map the undo/redo chords to a
  no-op command `when: csvViewer.cellEditorOpen && activeCustomEditorId == csvViewer.table`.

Cmd/Ctrl+S inside an editor commits and lets the event through so VS Code saves. Escape
with an editor open cancels it before the global handler's popover logic runs. Cmd/Ctrl+C
on a focused cell (no editor) copies its full value via the existing `copyToClipboard`;
paste is Phase 3 (clipboard read permissions in webviews need their own spike).

### 3.9 Performance budget

- Toggling edit mode: attribute/role/tabindex updates over the current page, no data
  re-render.
- Commit: one `<td>` patch, one O(1) worker message, one O(1) host message. No query.
- Undo/redo: the same, plus at most one `page` fetch.
- Save or backup of a 50 MB file: ~0.6 s for spans + ~0.3 s slicing/joining in the worker,
  one ~50 MB string copy to the host, one write. Target: under 3 s, with the working
  indicator shown while the worker is busy (it is single-threaded, so a query waits). This
  cost per backup is the reason editing stops at 50 MB.
- First render, filter, sort and page targets are unaffected: `init`/`query`/`page` are
  untouched, and `applyEdits` only drops cache entries.

## 4. Phasing

**Phase 1 — 0.8.0: cells.** Provider switch (§3.1); `edits.ts`, `csvSerialize.ts`;
`applyEdits`/`serialize`/`locateRow` in the worker; Edit mode, the cell grid model and the
inline editor (§2.2); detail-field textarea (§2.3); markers and the Edits row (§2.4); save,
Save As, undo/redo, revert, backup/restore (§3.6); dirty-aware watcher and save conflict
prompt (§2.7); Open as Text prompt; File format locked while dirty (§2.8); 50 MB cap,
quotes-off validation, read-only fs detection (§2.9); the setting (§2.10); journal replay on
respawn; Edit Value… in the context menu; README/CHANGELOG/spec/manifest (§6).

**Phase 2 — 0.9.0: rows and headers.** Insert Row Above/Below, Duplicate Row, Delete Row
in the row and cell context menus (and Ctrl+Shift+- / Ctrl+- style chords to be chosen);
id-addressed worker model (§3.5); row numbers as file positions; header rename
(double-click a header in edit mode, `setHeader`, rewrites the raw header cell; disabled
when "First row is header" is off); "View is out of date — Refresh" after an edit touches a
filtered or sorted column.

**Phase 3 — later.** Multi-cell paste (TSV from the clipboard, needs the clipboard-read
spike); find & replace; add/remove columns; fill down; re-parse while dirty (serialize, then
`init` with id remapping); editing above 50 MB with a streamed save.

## 5. Test plan

Unit (vitest, `src/test`):
- `edits.test.ts`: `invertOp`/`invertEdit` are involutions; applying an edit then its
  inverse restores the rows (fast-check over random ops).
- `csvSerialize.test.ts`: `recordSpans` agrees with `parseCsv` row for row on every parser
  fixture (quoted newlines, escaped quotes, blank lines, ragged rows, BOM, CRLF/LF/CR mix,
  quotes off, `"` delimiter workaround, multi-character delimiters); the properties in
  §3.7; width rule for ragged rows; trailing newline kept/absent; CRLF output; header never
  rewritten unless modified.

Webview e2e (Playwright, `src/test/webview-e2e/editing.spec.ts` + a stress spec):
- The toggle: hidden/disabled per `editable`/`editableReason`; read mode unchanged (the
  existing keyboard specs keep passing with the toggle off).
- Grid model: every key in §2.2's tables; focus survives a re-render; Tab leaves the grid;
  double-click opens the editor; Escape restores; no-op commit posts nothing.
- A commit posts `edit` with the right op, patches the cell, sets the marker, and the
  worker reflects it (sort by that column, open its values picker, search for the new
  value); an unchanged query key does not re-run; the row stays put after an edit that no
  longer matches the filter.
- `applyEdit` from the host (undo/redo): on-page row patched, off-page row jumps,
  filtered-out row shows the notice; markers clear when a cell returns to its baseline;
  `saved` clears all markers.
- Detail textarea: raw value for JSON and Markdown fields, Cmd/Ctrl+Enter / Escape /
  blur / Cancel without blur-commit, re-formatting after commit, the 1 MB guard.
- Quotes-off validation error; File format controls disabled while dirty; the
  `fileChangedWhileDirty` banner; `serialize` answers with the minimal-diff text for a
  fixture with mixed quoting; journal replay after a regex timeout (edit, trigger the
  catastrophic regex, assert the edit survives); `__proto__`-named columns.
- Stress: 200k × 30 — toggling edit mode, committing, and `serialize` within budget.

Integration (real VS Code, `src/test/integration/suite/editing.itest.ts`):
- After a simulated `edit` the tab is dirty (`vscode.window.tabGroups` → `isDirty`),
  `undo`/`redo` commands call the closures and send `applyEdit` (via `getOutgoing`), save
  writes the expected bytes (minimal diff, BOM kept, CRLF kept) and the watcher does not
  reload after our own write; Revert File re-sends `load` and clears dirty; Save As writes
  the destination; backup/restore (write a backup, reopen with `backupId`); the save
  conflict prompt when the file changed; the dirty document not reloading on an external
  change but sending `fileChangedWhileDirty`; `csvViewer.editing: false` → `editable:
  false` in `load`; a > 50 MB file → `tooLarge`; spike 1's Ctrl+Z assertion.

## 6. Docs, manifest and marketing

- `package.json`: description → "… expand any row to read long text and JSON. Filter, sort,
  edit cells, live reload."; keywords add `edit`, `editor`; the `csvViewer.editing`
  setting; version 0.8.0.
- README: "The viewer is read-only; Open as Text … to make edits" → describe Edit mode;
  the "Read-only and private" bullet → "Private, and only writes when you save: nothing
  touches your file until Cmd/Ctrl+S, and a save changes only the rows you edited"; a new
  "Editing" section (mode, keys, markers, limits); Limits → "Editing is available up to
  50 MB"; the "Works well with" paragraph → Edit CSV for heavy editing, this one for
  reading and quick fixes; the Settings table.
- CHANGELOG 0.8.0, user-facing lines only.
- `docs/spec.md`: first line ("Read-only table viewer…"), a new "Editing" section under
  Core features, the Architecture section (provider, messages, worker protocol, the
  serializer), Acceptance.
- `CONTRIBUTING.md` / engineering notes: the keyboard-forwarding finding (§3.8) once
  spike 1 settles it.

## 7. Decisions and alternatives considered

1. **`CustomEditorProvider`, not `CustomTextEditorProvider`.** Keeps reading above 50 MB
   (the reason 0.4.0 switched); the cost is owning save/undo/backup, which §3.6 keeps thin
   because VS Code still owns the stack and the dirty flag.
2. **An explicit Edit mode.** Always-editable grids are what every competitor does; here
   read mode's keyboard model, the "nothing by accident" promise and the ability to ship
   without touching existing specs win. Edit Value… in the context menu keeps it one
   gesture away.
3. **Minimal-diff serialization via record spans**, not `Papa.unparse` (§3.7).
4. **Edits are applied in the worker**, not in a host-side model: the host never parses,
   and a model on the host would mean a second copy of every file and a second parser
   bundle.
5. **The view goes stale after an edit** instead of re-querying (§2.6).
6. **50 MB cap** (§2.9) rather than a streamed save in v1.
7. **File format locked while dirty** rather than id remapping in v1 (§2.8).
8. **Undo is host-initiated only** (§3.2): no webview-side undo stack to keep in sync.

## 8. Spikes to run before Phase 1 coding

1. Ctrl+Z inside an open cell editor does not reach the document's undo (§3.8); if it
   does, implement the context-key fallback.
2. A document opened with `openContext.backupId` is marked dirty by VS Code without any
   provider call (expected per the API docs), and the shapes VS Code passes.
3. What VS Code does to the undo stack on `revertCustomDocument` (the `generation` guard in
   §3.6 handles the case where it keeps the stack).
4. `workspace.fs.isWritableFileSystem` for the schemes that matter (`file`, `vscode-remote`,
   `vscode-vfs`), to set `readonlyFs` correctly.
