# CSV Viewer: UX review before first public release

Reviewed build: `stress-fixes` @ `f37dda2` (v0.3.0), 2026-10-01.
Reviewer stance: senior product designer. I judged how well each feature works for the stated audience: strangers on Marketplace/Open VSX, files under 5k rows, and wide files with long text cells. I did not judge whether a feature should exist.

## How this was rendered (read this first)

- **Harness.** The real built webview (`out/webview/main.js` + `main.css` + worker) runs in Playwright Chromium. A throwaway spec, `src/test/webview-e2e/review/uxReview.spec.ts` (uncommitted), drives it. Re-run with `npx playwright test src/test/webview-e2e/review --output=/tmp/cvux-pw`.
- **Themes are real, not approximated.** Light Modern, Dark Modern and Dark High Contrast values come from `microsoft/vscode@main`: `extensions/theme-defaults/themes/*.json` plus the color-registry defaults in `src/vs/platform/theme/common/colors/*.ts` and `workbench/common/theme.ts`. Registry colors that default to `null` are left undefined, because VS Code doesn't emit them either. That makes `main.css`'s `var()` fallbacks behave as they do in the product. Light+, Dark+ and HC Light were **checked numerically only** (no screenshots).
- **VS Code's own webview stylesheet is injected.** VS Code wraps every webview in a default stylesheet (`pre/index.html`, `@layer vscode-default`) that sets `body { padding: 0 20px }`. `main.css` resets `margin` but not `padding`, so the real product has a **20px gutter on each side**. I reproduced that. It is one reason the toolbar wraps even at 1280px. The existing `stress/visual.spec.ts` doesn't include this padding, so its screenshots are slightly too optimistic.
- **Native form controls.** VS Code does not set `color-scheme` on webviews, and neither does `main.css`. Checkboxes and the search field's clear button therefore render in the light scheme in every theme, as they do in the harness.
- **Real VS Code window screenshot: did not work.** An itest opened `samples/people.csv` in VS Code 1.139.1 (`--user-data-dir /tmp/cvux-ud`, since deleted) and switched themes. `screencapture -x` then failed with "could not create image from display", and fails the same way outside VS Code. The terminal has no macOS Screen Recording permission. I removed the itest. Tab chrome and real platform fonts are therefore not captured. Everything inside the webview is.
- **Screenshots** are under `docs/reviews/ux-screens/<theme>/<width>/NN-state.png`. Themes are `light-modern`, `dark-modern` and `hc-dark`; widths are `1280` and `700` (a side-by-side editor). The folder also holds the raw audits: `behavior-audit.json` (tab order, ARIA tree, click and selection probes), `toolbar-geometry.json`, and `<theme>/contrast.json` (computed contrast).

Fixtures: `samples/people.csv` (40 rows × 15 columns, 8 shown by the `defaultTableColumns` default). The generated "wide" file has 240 rows × 25 columns. `description` and `notes` are 2–4 KB of prose and fall inside the default 8 table columns. `support_history`, `call_transcript` and `internal_comments` hold 2–8 KB of prose, and `metadata_json` holds roughly 1 KB of minified JSON. A 200k-row file was used for the Working… indicator, which was caught in all three themes.

---

## 1. First impression (10-second test)

### people.csv (`dark-modern/1280/01-people-default.png`, `light-modern/1280/01-people-default.png`)

**Where the eye lands:** the row of five saturated blue buttons (Columns, Filters, Expand page, Collapse page, Open as Text). They are the loudest thing on screen, louder than the data. With VS Code's 20px gutter the toolbar wraps even at 1280px, leaving **Open as Text alone on a second row** like a stray.

**What's clear:** it's a table, the headers look clickable, and the pager at the bottom is familiar.

**What's unclear:**
- **The product's core idea is invisible.** 7 of 15 columns (manager, office, phone, notes, projects, rating, active) are hidden from the table, and nothing says so. The only clue is a ▶ glyph on each row, which reads as decoration. "Columns" doesn't show a count such as 8/15.
- **"Sort by… (none)"** looks like a required form field. Next to sortable headers it raises the question "which one do I use?"
- **The row count appears twice**: "Showing 40 of 40 rows" at the top and "Rows 1–40 of 40" at the bottom.
- "First row is header", "Separator: Auto (,)" and "Quoted fields" are parse settings you change about once per file, yet they get the same weight as Search and Filters.

### Wide fixture (`dark-modern/1280/03-wide-default.png` → `04-wide-expanded-top.png`)

**Where the eye lands:** the two prose columns, `description` and `notes`, each cut to about 40 characters with "…".

**The natural next move fails.** The user clicks the row to read the description. The detail panel opens with plan, country, priority, tags, score… and **neither description nor notes is in it** (`04-wide-expanded-top.png`). The detail panel shows only columns hidden from the table, so a long value in a *visible* column cannot be read anywhere in the viewer. Cells have no tooltip either. The only workaround is to open Columns and uncheck the column, which nobody will guess. This is the owner's primary file shape. **It is the #1 ship blocker.**

At 700px it gets worse (`dark-modern/700/04-wide-expanded-top.png`). The detail panel spans the full scrollable table width, so every line of prose runs off the right edge. Reading a paragraph means scrolling horizontally back and forth.

---

## 2. Information hierarchy and layout

### Toolbar

Measured (`toolbar-geometry.json`, Light Modern, with VS Code's gutter):

| Viewport | Toolbar height | Rows | Table height left |
|---|---|---|---|
| 1280 | 73px | 2 | 666px |
| 900 | 73px | 2 | 666px |
| 700 | 107px | 3 | 632px |
| 500 | 141px | 4 | 562px |

- Nine controls sit in one flex row with no grouping, no separators and no priority, so wrapping is arbitrary. At 1280 "Open as Text" is orphaned. At 700 the row splits mid-group: "Sort by…" lands on row 2 and "Quoted fields" on row 3 (`dark-modern/700/03-wide-default.png`).
- **The layout shifts while you work.** Setting a sort reveals the ▲ direction button and widens the select, and "Quoted fields" jumps to the next row (compare `dark-modern/1280/01-people-default.png` with `15-multi-sort.png`). A Custom separator error inserts a full-width red line that pushes "Quoted fields" and "Open as Text" down a row (`dark-modern/1280/13-separator-error.png`).
- **Every button is a primary button.** `main.css` styles every `<button>` with `--vscode-button-background`, so the toolbar has 5 primary buttons, the pager 4, and there are more in popovers (Show all, Hide all, + Add rule, Include, ✕). VS Code's own UI uses one primary action per surface; toolbars use icon actions or secondary buttons. This is the single biggest "doesn't feel native" signal.

**Proposed regrouping.** Group by frequency of use: search, view and parse. The bottom bar becomes the single source of counts.

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ [⌕ Search all columns…        ] [Columns 8/25 ▾] [Filters • 2 ▾] [Sort ▾]   ⤢  ⚙  ⎘   │  <- one row ≥ 560px
└──────────────────────────────────────────────────────────────────────────────────────┘
  ⤢ = Expand/Collapse all on page (one toggle, icon button)
  ⚙ = "File format" popover:  Separator [Auto (,) ▾] [custom]
                               ☑ First row is header
                               ☑ Quoted fields   (and the " error lives here, under its input)
  ⎘ = Open as Text (icon button, tooltip "Open as Text (read-only viewer → text editor)")

 [2 filters active · Clear]   <- slim chip row, only when search/filters are active
 ┌ table ────────────────────────────────────────────────────────────────────────────┐
 └───────────────────────────────────────────────────────────────────────────────────┘
 [«][‹] Page [3] of 3 [›][»]   201–240 of 240 rows (filtered from 1,000)  Working…   Rows per page [100▾]
```

- "Sort ▾" opens a small popover that lists the current sort keys in priority order. Each key has a direction toggle and a remove button, plus an "Add sort column" select that includes hidden columns. It replaces "Sort by…" and the ▲ button, makes multi-sort visible and editable, and stops the reflow.
- With "Columns 8/25" and "Filters • 2", the hidden state shows while popovers are closed.
- Drop the top status line. The bottom bar already carries the counts, and the chip row carries "filtered" state.

### Popovers and panels
- **Fixed `top: 42px`.** At every real width the toolbar is at least 73px tall, so both popovers **cover the toolbar's second row**. The Filters panel hides "Open as Text" and "Quoted fields" at 1280 (`dark-modern/1280/09-filters-panel.png`). At 700 the Columns popover covers Separator (`dark-modern/700/08-columns-popover.png`). Anchor to the trigger's `getBoundingClientRect().bottom + 4`.
- **The Columns popover sits at the far right**, about 700px from its button at 1280 (`08-columns-popover.png`). Anchor its left edge to the button.
- **The Filters "panel" is 420px wide** despite `left:8px; right:8px`, because `.popover, .panel { max-width: 420px }` applies to both. Every rule therefore wraps to two lines (`09-filters-panel.png`). Remove `max-width` for `.panel` so a rule fits on one line at ≥ 700px.

### Status line, pager, sticky header
- Remove the duplicate count (see above). Format numbers with `toLocaleString()`: "Showing 200000 of 200000 rows" (`18-working-indicator.png`) should read "200,000".
- The pager is well placed (always visible, independent of scroll). The four glyph buttons are blue blocks; see §5.
- **The sticky header loses its bottom border once content scrolls under it**, because `border-collapse` borders don't stick. In `05-wide-expanded-json.png` and `06-wide-show-all.png`, prose runs right up against the header with no divider. Fix: `th { box-shadow: inset 0 -1px 0 var(--vscode-panel-border); }`.

### Column widths and truncation in the table
- `max-width: 320px` with ellipsis makes the 500-character cap invisible: you see about 45 characters either way. That's fine for scanning, **as long as the full value can be reached** (P0-1).
- Numeric columns (salary, score, mrr_usd) are left-aligned. Right-align columns the worker already classifies as numeric for sorting; scanning magnitudes gets much easier.
- At 700px the table scrolls horizontally with no affordance. The column "ow…" is simply cut (`light-modern/700/12-last-page.png`). Add a right-edge fade, or pin the chevron and first column (`position: sticky; left: 0`).

### Detail panel (key/value)
- **Prose:** `pre-wrap` with `max-width: 900px` is the right call, and line length is comfortable at 1280 (`04-wide-expanded-top.png`). But one wide row expands to 2–3 screens. With **Expand page**, 100 such rows make roughly 250 screens of scroll and you see only one row (`07-wide-expand-page.png`). Fix: clamp each value to 6 lines (`-webkit-line-clamp`) with a per-field "More". The existing 10k "Show all" then becomes the second step.
- **JSON:** a wall of minified text wrapped at arbitrary points, in the proportional UI font (`05-wide-expanded-json.png`). If a value starts with `{`/`[` and `JSON.parse` succeeds, render it with `JSON.stringify(v, null, 2)` in `var(--vscode-editor-font-family)`. Effort S; payoff is large for the owner's files.
- **Containment:** the expanded block has no background or indent. In Light Modern it blends into the next row (`light-modern/1280/02-people-expanded.png`). Add `background: var(--vscode-editorWidget-background)` or a 2px left rule, and indent the `<dl>` to start under the first data column, not under the chevron.
- **Width at 700px:** see P0-2. The `<dl>` must be pinned to the visible viewport, not to the table's scroll width.
- Empty values show a bare key ("office" in `02-people-expanded.png`). Render a dim "—", so "empty" is distinguishable from "didn't load".

---

## 3. Interaction patterns

| Pattern | What works | Trap | Fix |
|---|---|---|---|
| **Row click = expand** | Large target; the README says so. | **Drag-selecting text in a cell expands the row.** Verified: drag across `dana.garcia@example.com` selected it *and* expanded the row (`behavior-audit.json`: `rowExpandedAfterDragSelect: true`). With the context menu also hijacked (below), copying a value is a fight. | In the row click handler, return early if `getSelection().toString() !== ""` or if the pointer moved > 4px between `mousedown` and `click`. |
| **Chevron ▶/▼** | Universal metaphor. | A `<span>`, so it isn't focusable and has no `aria-expanded`. Rendered in full foreground at the same weight as data, so it looks like content. ▶ is U+25B6, which has an emoji presentation; on Windows with Segoe UI Emoji fallback it can render as a coloured emoji (unverified here; check on Windows). | A `<button class="twisty" aria-expanded aria-label="Show details for row 1000">` holding a codicon `chevron-right`/`chevron-down` (or an inline SVG) in `--vscode-icon-foreground`. |
| **Header click / Shift-click** | Asc → desc → none cycle; ▲1/▼2 priority numbers; keyboard Enter/Space works and keeps focus (`headerAfterEnter`). | Shift-click is undiscoverable (no tooltip, no hint). `role="button"` on `<th>` destroys column-header semantics (§6). | `title="Sort · Shift+click to add as a secondary sort"`. Put a `<button>` *inside* the `<th>`; set `aria-sort` on the `<th>`. |
| **"Sort by…" + ▲** | Needed for hidden columns. | Shows only the primary key. Picking a column from it **silently discards** a multi-sort built with Shift-click. It duplicates header sorting for visible columns. Toggling it reflows the toolbar. | The "Sort ▾" popover from §2. |
| **Popovers** (Columns, Filters) | Escape closes them; toggling one closes the other. | **No outside-click close** (verified `columnsStillOpenAfterOutsideClick: true`). A click on a row *through* an open popover expands that row (`rowExpandedByClickWhilePopoverOpen: true`). Focus doesn't move into the popover on open. **Escape drops focus to `<body>`** (`afterEscapeFocus: "BODY"`), so a keyboard user has to Tab from the top again. No arrow and no anchoring (§2). | Close on `pointerdown` outside. On open, focus the first field. On Escape, refocus the trigger. Add `aria-expanded` and `aria-controls` on the trigger and `role="dialog" aria-label` on the popover. |
| **Filter rule row** (7 controls) | Instant validation hints; an inactive rule never hides the whole file. That is genuinely thoughtful. | Wraps to 2 lines in the 420px panel. The enable checkbox, column select and operator select have **no accessible names**. "Aa" is a checkbox labelled "Aa". **Rules AND together but nothing says so.** Two quick-add "include" rules on the same column (status = active, then status = trial) return zero rows, which is a natural thing to try. | Sentence layout: `[Keep ▾] rows where [status ▾] [equals ▾] [value] [Aa] [✕]` with the enable toggle at the far left. Header line "Rows must match **all** rules." Or decide that include rules on the same column OR together (product call; at minimum, state the rule). |
| **Include/Exclude as a button** | One click to flip. | A button labelled with its *current state* is ambiguous: does clicking "Include" mean "make it include"? It isn't `aria-pressed`, and it's another primary-blue block. | Make it the first select of the rule: **Keep / Hide**. It reads as a sentence and its state is unambiguous. |
| **Right-click quick-add** | Fast once known; uses the full value. | **Undiscoverable**, with no hint anywhere. It **replaces the native context menu**, so right-click → Copy is gone. Labels don't say which column or value (`14-context-menu.png`). Not reachable by keyboard (no Shift+F10 / ContextMenu key). | Menu: **Copy value** · **Show only rows where department = "Support"** · **Hide rows where department = "Support"**. Add a hint in the empty Filters panel: "Tip: right-click any cell to filter by its value." Handle the ContextMenu key on the focused row. |
| **Page input** | Commit on Enter or blur; invalid input restores the old value; clamped. | `type=number` spinners are tiny. Fine. | — |
| **Alt+←/→** | Guarded against inputs. | VS Code forwards *every* webview keydown to the workbench (`pre/index.html` `handleInnerKeydown`), even after `preventDefault`. On **Windows, Alt+← / Alt+→ are VS Code's Go Back / Go Forward**, so paging may also jump to another editor. Unverified on Windows; verify before release. | If it conflicts, use PageUp/PageDown when the table has focus, or Ctrl+Alt+←/→ and contribute it as a real keybinding with a `when` clause on `activeCustomEditorId == csvViewer.table`. |
| **Cmd/Ctrl+F** | — | VS Code's webview shim `preventDefault`s Find, and the extension doesn't set `enableFindWidget`, so **Cmd+F does nothing**. Every user will try it. | Listen for Cmd/Ctrl+F in the webview and focus the quick search (S). |
| **Escape** | Closes everything, everywhere. | In the quick-search field, Escape also clears the query (native `type=search` behaviour), so one key clears search *and* closes panels. Acceptable. | Return focus to the trigger (above). |
| **Debounce** | 150ms search and filter, 300ms custom separator: feels instant, no jank (the worker keeps the UI live even at 200k rows). | — | Keep. |
| **Double-click a word** | Selects the word and leaves the row's state unchanged (it toggles twice). | The row flickers open and closed. | Fixed by the selection guard above. |

---

## 4. States and copy

### States

| State | Screenshot | Verdict |
|---|---|---|
| Loading | (not captured; it's the status-line text "Loading…") | Fine for small files. For 50MB+ files, say what's loading: "Loading people.csv (52 MB)…". |
| Working… | `*/1280/18-working-indicator.png` | Italic, small, far right of the status row: far from the header you just clicked, and the stale table isn't dimmed. Use VS Code's idiom instead: a 2px indeterminate bar under the toolbar in `--vscode-progressBar-background`, plus `aria-busy="true"` on the table. Respect `body.vscode-reduce-motion` by showing a static bar. |
| Zero results | `dark-modern/1280/11-zero-results.png` | **Weak.** Headers over a blank void, with "No matching rows" in the bottom-right corner. Render an empty-state row in the table body: "No rows match "zzqx…". [Clear search] [Turn off 2 filters]". |
| Hide all columns | `dark-modern/1280/16-hide-all.png` | 40 lone ▶ glyphs centred in an empty table. Show "All columns are in the row details. Click a row to open it, or [choose table columns]." Or render a single row-number column. |
| Truncated cell + Show all | `dark-modern/1280/06-wide-show-all.png` | Good concept. "Show all (14374 characters)" needs a thousands separator. It's another primary button inside prose; make it a text link in `--vscode-textLink-foreground`. |
| Quote banner | `*/1280/10-quote-banner.png` | **Best state in the product:** it names the problem, offers a one-click fix and can be dismissed. It has no icon, and "row 2" is ambiguous (data row or file line?). The ✕ is a primary-blue square. |
| Regex too slow | `*/1280/09-filters-panel.png` | It says "rule disabled" while the rule's **Enabled checkbox is still ticked**, which contradicts itself. |
| Column not found | `09-filters-panel.png` | **The column select shows blank**, because the missing column isn't among the options. The user can't tell *which* column was missing, so they can't fix it. Add a disabled option "legacy_owner (missing)". |
| Enter a value | `09-filters-panel.png` | Dashed outline plus hint. Good, appropriately softer than the error states. |
| Separator `"` error | `dark-modern/1280/13-separator-error.png`, `…/700/13-separator-error.png` | The error wraps to the start of the next toolbar row, far from its input, and reflows the toolbar. It isn't linked to the input (no `aria-invalid` or `aria-describedby`). Move it inside the File format popover, directly under its input. |
| Deleted file | (host toast only) | The toast "CSV Viewer: File was deleted — showing last loaded contents." doesn't name the file. Once dismissed, nothing in the viewer says the data is stale. Show an inline banner in the quote-banner style: "people.csv was deleted from disk. Showing the last loaded copy." |

### Copy audit (current → proposed)

| Where | Current | Proposed | Why |
|---|---|---|---|
| Toolbar label | Sort by… | **Sort** (button opening the sort popover) | An ellipsis on a label wrongly implies a dialog; "(none)" reads like a form field. |
| Toolbar | Expand page / Collapse page | **Expand all** ⇄ **Collapse all** (one toggle; tooltip "…rows on this page") | Two buttons for one binary state. "page" is ambiguous with the pager. |
| Toolbar checkbox | First row is header | **First row is header** (keep; move into File format) | Clear; just mis-placed. |
| Toolbar checkbox | Quoted fields | **Quoted fields** (keep) + tooltip: "Treat "…" as quoting. Turn off if quotes in your data are literal text." | The label is jargon without the tooltip. |
| Separator options | Comma , / Semicolon ; / Pipe \| | **Comma (,) / Semicolon (;) / Pipe (\|)** | Match the "Auto (,)" style already used. |
| Separator error | " is the quote character — turn off Quoted fields to use it | **Can't use " while Quoted fields is on.** [Turn off] | Shorter, with an action. |
| Banner | Quotes look malformed near row 2 — rows after it may be merged. | **⚠ Unclosed quote near row 2 (line 3). Rows after it may be merged into one.** | Names the actual problem; disambiguates row vs line. |
| Banner button | Treat quotes as plain text | **Read quotes as plain text** | It describes what happens to *reading*; nothing is modified. |
| Status | Showing 40 of 40 rows | (remove; the pager shows "1–40 of 40 rows", plus "filtered from N" when filtered) | Duplicate. |
| Pager | No matching rows | (keep in pager) + body empty state (above) | — |
| Columns popover | Show all / Hide all | **Show all in table / Move all to details**, plus a one-line header: "Unchecked columns appear in row details." | "Hide" suggests the data disappears; it actually moves. This is the core concept, so say it. |
| Filters | + Add rule | **Add rule** (codicon `add` + text) | — |
| Filters | (any column) | **Any column** | — |
| Filters | value (placeholder) | **Value** | Sentence case like every other placeholder. |
| Filters | Aa (checkbox) | **Aa** toggle, tooltip **Match Case** | VS Code's Find widget term. |
| Filters | Include / Exclude (button) | **Keep / Hide** (select, first control) | State vs action ambiguity. |
| Filters | > < >= <= | **> (number)**, etc. | Says they're numeric, which matters for "10" vs "9". |
| Rule hints | Regex too slow — rule disabled | **Skipped: pattern took over 2 s. Edit it to retry.** | Never say "disabled" while the checkbox says enabled. |
| | Invalid regex — rule ignored | **Skipped: invalid regex (<engine message>)** | Include the reason. |
| | Column not found — rule ignored | **Skipped: column "legacy_owner" isn't in this file** | Name it. |
| | Enter a value — rule ignored | **Enter a value** | Softer hint; "ignored" is implied by the dashed style. |
| Context menu | Filter: include this value / Filter: exclude this value | **Copy value** · **Show only rows where department = "Support"** · **Hide rows where department = "Support"** | Concrete; restores Copy. |
| Show all button | Show all (14374 characters) | **Show all 14,374 characters** | Number formatting. |
| Show all tooltip | This value is very large — showing it in full may be slow. | Keep. | Good. |
| Sort dir aria | Toggle sort direction | **Sort ascending / Sort descending** (dynamic) | Announce the action. |
| Pager buttons | « ‹ › » (accessible name is the glyph; see §6) | aria-label **First page / Previous page / Next page / Last page** | Screen readers currently read "left-pointing double angle quotation mark". |
| Host toast | CSV Viewer: File was deleted — showing last loaded contents. | **CSV Viewer: "people.csv" was deleted. Showing the last loaded contents.** | Name the file; sentence case after the colon, matching the other toasts. |
| Casing | "Open as Text" (Title) vs "Show all", "Hide all", "Expand page" (sentence) | Pick one. VS Code buttons are mostly Title Case ("Open Settings"); commands must be. Recommend **Title Case for buttons**, sentence case for hints and labels. | Consistency. |

---

## 5. Visual design

### Theme fidelity
- **HC Dark** (`hc-dark/1280/*.png`) is the most native-looking theme, because every button falls back to black with a `contrastBorder` outline. Focus is a clear orange `#F38518` ring. All text is ≥ 8.5:1.
- **Dark Modern / Light Modern:** colors are correct, but the blue-button wall and light-scheme native checkboxes break the illusion. In Dark Modern the unchecked boxes in the Columns popover are white squares (`dark-modern/1280/08-columns-popover.png`). Fix with one rule: `body.vscode-dark, body.vscode-high-contrast:not(.vscode-high-contrast-light) { color-scheme: dark; }`. Even better, style checkboxes with `--vscode-checkbox-background/border/foreground`, as VS Code's own checkboxes do.
- **Light Modern** sets `descriptionForeground` equal to `foreground` (#3B3B3B). Status text, dt keys, sort indicators and hints therefore have **no tonal hierarchy**; only weight separates key from value. That's VS Code's choice, so don't fight it. But it means hierarchy must come from size, weight and spacing, not color.
- **Light+ / Dark+ (numeric only):** `input.border` is `null` in both, so `main.css` falls back to `panel.border` (#808080 at 35%). In Light+ that is **1.5:1** on white: the search box is a white field on a white page with a near-invisible edge. Fallback chain: `var(--vscode-input-border, var(--vscode-settings-textInputBorder, var(--vscode-dropdown-border)))`.

### Contrast (computed in-page via `getComputedStyle`, alpha composited; `*/contrast.json`)

| Element | Light Modern | Dark Modern | HC Dark | Light+ / Dark+ (computed) | Verdict |
|---|---|---|---|---|---|
| Table text | 11.2 | 10.26 | 21 | — | ✅ |
| Chevron ▶ | 11.2 | 10.26 | 21 | — | ✅ (too *strong*; see icons) |
| Sort indicator / status / dt / toolbar labels (`descriptionForeground`) | 11.2 | 6.08 | 9.96 | 4.88 / 5.76 | ✅ |
| **Rule error text** (`errorForeground`, 0.9em ≈ 11.7px) | **3.35** (#F85149 on #FFF) | **3.88** (on panel #313131) | 8.55 | 7.5 / 4.49 | ❌ AA (4.5) fails in both Modern themes, the defaults for new users |
| **Separator error** | **3.35** | 4.92 | 8.55 | 7.5 / — | ❌ Light Modern |
| Rule hint (`descriptionForeground` on panel) | 11.2 | 4.80 | 9.96 | — / 4.26 | ⚠ Dark+ just under AA |
| **Search placeholder** (unthemed Chromium #757575) | 4.61 | **2.82** | 4.56 | — | ❌ Dark Modern. Fix: `::placeholder { color: var(--vscode-input-placeholderForeground) }` → 4.51 |
| Quote banner text | 10.09 | 8.81 | 21 | 11.38 / — | ✅ |
| Quote banner border | 2.86 | 5.76 | 10.55 | — | ⚠ Light (decorative) |
| Primary button label | 6.31 | 4.53 | 21 | 4.51 / 6.4 | ✅ (barely in Dark Modern) |
| Disabled pager glyph vs its faded fill | 1.56 | 3.52 | 5.28 | — | Exempt, but the pale-blue disabled buttons in Light Modern still look like buttons (`light-modern/1280/01-people-default.png`) |
| Focus ring vs page | 6.31 | 3.64 | 8.18 | 3.35 / 3.96 | ✅ ≥ 3:1 |
| Input border vs page (non-text) | 1.57 | 1.49 | 10.55 | 1.5 / — | ⚠ Theme-defined; same as VS Code's own inputs, except the Light+ fallback above |
| Row separator (`panel.border`) | 1.26 | 1.16 | 21 | 1.5 / 1.62 | OK: matches VS Code lists, which rely on hover rather than rules |

**Error-text fix:** use VS Code's inputValidation pattern. Put full-size text in the normal foreground inside a box with `--vscode-inputValidation-errorBackground` and `--vscode-inputValidation-errorBorder`, with an `error` codicon in `errorForeground`. The icon only needs 3:1 as a non-text element. Every theme then passes.

### Spacing rhythm
The base rhythm is 4/6/8/10px: toolbar gap 8, pager gap 10, rule gap 6, cell padding 4/8. Pick 4 and 8 only. The toolbar's 26px-tall buttons beside 24px-tall selects and 13px checkboxes produce the ragged row heights visible in every toolbar screenshot. Make every toolbar control 24px tall. VS Code's action bar uses 22px hit targets.

### Icons
Text glyphs (▶ ▼ ▲ « ‹ › » ✕) render at different weights and baselines per platform font, and ▶ risks emoji presentation on Windows. The rest of VS Code uses codicons. Shipping `@vscode/codicons` (CSS plus a ~80KB font, loaded via `webview.asWebviewUri`, allowed by the existing CSP's `font-src`) gives `chevron-right`, `chevron-down`, `arrow-up`, `arrow-down`, `chevron-left`, `chevron-right`, `debug-step-back`-style "first/last" (or `arrow-left`/`arrow-right` with a bar), `close`, `filter`, `columns`/`split-horizontal`, `settings-gear`, `go-to-file`, `warning`, `error` and `add`. Use `--vscode-icon-foreground` for icon buttons, with a transparent background and `--vscode-toolbar-hoverBackground` on hover. That one change converts the toolbar and pager to native-looking icon actions.

### Focus rings
- Present on every control, ≥ 3:1 in all themes (`*/1280/17*-focus-*.png`). In Dark Modern `focusBorder` (#0078D4) is **identical to the primary button fill**, so on a focused button the ring reads as a 1px-larger button rather than a ring (`dark-modern/700/17b-focus-columns-btn.png`). Secondary or icon buttons fix this for free.
- Rings show on **mouse** clicks too, because `main.css` uses `:focus`, not `:focus-visible`. After clicking Filters or a header, a ring lingers (`09-filters-panel.png`, `15-multi-sort.png`). Switch to `:focus-visible`.

### Density vs VS Code's own tables
- The **Keybindings editor** is the closest analogue: search box with in-field toggles, a header row, ~24px rows, and codicon twisties. Our rows are ~25px, which is right.
- The **Problems panel**: 22px rows, twisty chevrons in `icon-foreground` at about 70% weight, no row rules, a filter box with a funnel badge when filters are active. Borrow the **badge-on-filter** idiom.
- The **Settings editor**: one prominent search, scoped chips (`@modified`) under it, everything else secondary. That's the model for the toolbar regroup.

---

## 6. Accessibility

### Keyboard-only walkthrough (`behavior-audit.json → tabOrder`)
Tab order: Search → Columns → Filters → Expand page → Collapse page → Sort by → First row is header → Separator → Quoted fields → Open as Text → **8 column headers** → page input → rows per page → (loops).

- ❌ **Rows are not reachable.** No row, chevron or cell is focusable (`rowsFocusable: false`), so **a keyboard user cannot open a row's details**, the product's core feature, and cannot reach right-click quick-add.
- ❌ Pager « ‹ › » are skipped when disabled (correct). When enabled they come *before* the page input in DOM order, which is fine.
- ✅ Headers: Enter/Space sorts and focus is preserved across re-render.
- ❌ Popovers: focus stays on the trigger when one opens; Escape sends focus to `<body>`.
- ❌ The filter panel opened by quick-add doesn't take focus.

**Fix:** make the chevron a real `<button>` (P0, S). Then add row-level roving focus: ↑/↓ moves between rows, →/Enter expands, ← collapses, Shift+F10 opens the quick-add menu (P1, M). That mirrors VS Code's tree keyboard model.

### ARIA present / missing (`ariaSnapshot` in `behavior-audit.json`)
- ✅ Labels: search, Sort-by select, Separator, Custom separator, page input, rows-per-page, Dismiss, Remove rule.
- ❌ **Header semantics destroyed:** `<th role="button">` makes the tree show one `columnheader` (the empty chevron column) and the rest as buttons named "id▲", "first_name"… Cells lose their header association, and "▲" is read as "black up-pointing triangle". Fix: `<th aria-sort="ascending|descending|none"><button>id</button><span aria-hidden>▲</span></th>`, and announce multi-sort priority as visually-hidden text ("sorted ascending, priority 1").
- ❌ **Expand state:** no `aria-expanded`. The detail row is a separate `<tr>` with no `aria-controls` or label.
- ❌ **Pager names are glyphs:** accessible names are "«", "‹", "›", "»", because text content overrides `title`. Add `aria-label`.
- ❌ **No live region:** `liveRegions: []`. Result counts, "Working…", rule hints and the quote banner are never announced. Make `#status-bar` (or the pager range) `role="status"`, and give the banner `role="alert"`.
- ❌ Filter rule controls: the enable checkbox is named only by `title`, the column and operator selects have **no name**, the case checkbox is named "Aa", and the mode toggle isn't `aria-pressed`.
- ❌ The Columns and Filters buttons have no `aria-expanded`, `aria-haspopup` or `aria-controls`; the popovers have no role.
- ❌ The separator error isn't tied to its input (`aria-invalid`, `aria-describedby`).

### Screen-reader story today
"Search all columns, search. Columns, button. … id black up-pointing triangle, button. …" Then the table is read as rows of cells with no header association. Pressing a chevron is impossible. Changing the search announces nothing. **Not usable.**

### Reduced motion
There are no transitions or animations (`transitionsOrAnimations: false`), so nothing to do today. If the progress bar from §4 is added, gate its animation on `body.vscode-reduce-motion`.

### High contrast
Solid (§5). The remaining gaps: native checkboxes show Chrome's blue accent instead of HC styling, and hover uses a 10% white wash with no `contrastActiveBorder` outline (VS Code's HC lists outline the hovered row). Add `tr.data-row:hover { outline: 1px dashed var(--vscode-contrastActiveBorder) }`. The variable is undefined outside HC, so it's a no-op elsewhere.

---

## 7. Prioritized change list

Effort: **S** < half a day, **M** 1–2 days, **L** > 2 days (solo dev).

### P0: ship blockers for a public release

| # | Problem | Fix | Effort | Evidence |
|---|---|---|---|---|
| P0-1 | **Long text in a visible column can't be read anywhere.** The table cuts at ~45 chars, the detail panel lists only hidden columns, and cells have no tooltip. This is the owner's primary file shape. | Detail panel lists hidden columns, then a "Shown in table" group with every visible column whose value was truncated or contains a newline (the same truncation check already exists). Add `title` (first 500 chars) on truncated cells. | S–M | `dark-modern/1280/03-wide-default.png` → `04-wide-expanded-top.png` (description/notes absent) |
| P0-2 | **Detail panel is clipped and scrolls horizontally with the table** whenever the table is wider than the editor (any side-by-side layout). Every prose line runs off-screen. | Pin the `<dl>` to the scroll viewport: `position: sticky; left: 0; width: var(--viewport-w)`, with `--viewport-w` set from `tableScroll.clientWidth` via a ResizeObserver. | S–M | `dark-modern/700/04-wide-expanded-top.png` |
| P0-3 | **Keyboard users can't expand rows.** Tab skips every row, and there's no `aria-expanded`. | Chevron becomes `<button aria-expanded aria-controls aria-label="Show details for row N">` with a codicon. | S | `behavior-audit.json` (`rowsFocusable: false`, tab order) |
| P0-4 | **Copying a value is a trap.** Drag-selecting text toggles the row, and right-click replaces the native menu, which has no Copy. | Ignore row clicks when a selection exists or the pointer moved. Add **Copy value** as the first context-menu item. | S | `behavior-audit.json` (`rowExpandedAfterDragSelect: true`), `dark-modern/1280/14-context-menu.png` |
| P0-5 | **Column headers are exposed as buttons, not headers**; sort state is a spoken glyph; pager buttons are named "«" "‹" "›" "»"; nothing is announced. Together the table is unusable with a screen reader. | `<th aria-sort>` with an inner `<button>`. `aria-label` on pager buttons. `role="status"` on the count. | S | `behavior-audit.json` (`ariaSnapshot`) |

### P1: fix before or right after launch

| # | Problem | Fix | Effort | Evidence |
|---|---|---|---|---|
| P1-1 | Every button is primary blue: about 12 blue blocks on screen, doesn't read as VS Code, and the focus ring merges with the fill in Dark Modern. | Default `button` to `--vscode-button-secondary*`. Make toolbar, pager, ✕ and sort-direction transparent icon buttons (codicons). Keep primary only for "Read quotes as plain text". | S–M | `*/1280/01-people-default.png` |
| P1-2 | Toolbar: 9 ungrouped controls, 2 rows at 1280, 3 at 700; it reflows when a sort is set or a separator error appears. | The regroup in §2: Search · Columns n/N · Filters •n · Sort ▾ · ⤢ · File format ⚙ · Open as Text. | M | `toolbar-geometry.json`, `dark-modern/1280/15-multi-sort.png`, `13-separator-error.png` |
| P1-3 | Popovers sit at a fixed `top:42px` and cover the toolbar; Columns opens about 700px from its button; no outside-click close; clicks pass through to rows; Escape loses focus. | Anchor to the trigger. Close on outside `pointerdown`. Focus in on open, return to the trigger on close. Add `aria-expanded`. | S | `dark-modern/1280/08-columns-popover.png`, `09-filters-panel.png`, `behavior-audit.json` |
| P1-4 | Filters panel capped at 420px, so every rule wraps to 2 lines. Rules AND together silently (two quick-add includes on one column → 0 rows). Include/Exclude button is ambiguous. Selects are unlabelled. | Remove `max-width` on `.panel`. Sentence layout `[Keep/Hide] rows where [col] [op] [value] [Aa] [✕]`. Header line "Rows must match all rules". Add `aria-label`s. | M | `*/1280/09-filters-panel.png` |
| P1-5 | Active filters, search and hidden columns are invisible while panels are closed. | Badges: "Filters • 2", "Columns 8/25". A chip row "2 filters active · Clear" above the table. | S | `dark-modern/1280/03-wide-default.png` |
| P1-6 | "Column not found" shows a **blank** column select; "Regex too slow — rule disabled" shows a ticked Enabled box. | Add a disabled option "legacy_owner (missing)". Use the copy from §4 ("Skipped: …"). | S | `*/1280/09-filters-panel.png` |
| P1-7 | Error text fails AA in both Modern themes (3.35 / 3.88); the search placeholder is 2.82 in Dark Modern. | inputValidation box pattern plus an icon; `::placeholder { color: var(--vscode-input-placeholderForeground) }`. | S | `light-modern/contrast.json`, `dark-modern/contrast.json` |
| P1-8 | Native checkboxes are light-scheme in dark themes (white boxes). | `color-scheme: dark` for `body.vscode-dark` and HC dark. | S | `dark-modern/1280/08-columns-popover.png` |
| P1-9 | Zero results shows a blank table; Hide all shows a column of lone ▶. | Empty-state rows with actions (Clear search / Turn off filters / Choose table columns). | S | `dark-modern/1280/11-zero-results.png`, `16-hide-all.png` |
| P1-10 | JSON blobs are an unreadable wrapped wall; Expand page on prose-heavy rows makes ~250 screens. | Pretty-print parseable JSON in the editor font. Clamp detail values to 6 lines with a per-field "More". | S–M | `dark-modern/1280/05-wide-expanded-json.png`, `07-wide-expand-page.png` |
| P1-11 | Cmd/Ctrl+F does nothing (VS Code swallows it; no find widget). | Focus quick search on Cmd/Ctrl+F. | S | code: `extension.ts` (no `enableFindWidget`) |
| P1-12 | Alt+←/→ likely collides with Go Back / Go Forward on Windows (all webview keydowns are forwarded to the workbench). | Verify on Windows. If it collides, move to PageUp/PageDown in the table, or a contributed keybinding with a `when` clause. | S | `pre/index.html` `handleInnerKeydown` |
| P1-13 | Row-level keyboard model is missing (after P0-3). | Roving tabindex: ↑/↓ moves, →/← expands/collapses, Shift+F10 opens the quick-add menu. | M | `behavior-audit.json` |
| P1-14 | "Sort by…" shows only the primary key and silently wipes a Shift-click multi-sort. | Sort popover listing all keys (part of P1-2). | M | `dark-modern/1280/15-multi-sort.png` |

### P2: polish

| # | Problem | Fix | Effort | Evidence |
|---|---|---|---|---|
| P2-1 | Text glyph icons (▶ ▼ « ‹ › » ✕) vary across platforms; ▶ may render as an emoji on Windows. | Codicons (comes with P1-1). | S | all |
| P2-2 | Focus rings appear on mouse click. | `:focus` → `:focus-visible`. | S | `dark-modern/1280/09-filters-panel.png`, `15-multi-sort.png` |
| P2-3 | Duplicate counts (top status line and pager); unformatted numbers (200000, 14374). | Drop the top line; use `toLocaleString()` everywhere. | S | `dark-modern/1280/18-working-indicator.png`, `06-wide-show-all.png` |
| P2-4 | The sticky header has no divider once content scrolls under it. | `th { box-shadow: inset 0 -1px 0 var(--vscode-panel-border) }`. | S | `dark-modern/1280/05-wide-expanded-json.png` |
| P2-5 | The expanded detail block blends into the next row in Light Modern; empty values show a bare key. | `editorWidget-background` tint or a left rule; dim "—" for empty values. | S | `light-modern/1280/02-people-expanded.png` |
| P2-6 | Numeric columns are left-aligned. | Right-align numeric columns, using the worker's existing classification. | S–M | `dark-modern/1280/01-people-default.png` |
| P2-7 | Working… is far from the user's focus and the table isn't dimmed. | 2px progress bar under the toolbar plus `aria-busy`. | S | `*/1280/18-working-indicator.png` |
| P2-8 | A deleted file is signalled only by a toast that doesn't name the file. | Inline banner naming the file. | S | `extension.ts` |
| P2-9 | Quote banner: no icon; "row 2" is ambiguous; the ✕ is a primary-blue square. | ⚠ codicon; "row 2 (line 3)"; icon-button ✕. | S | `*/1280/10-quote-banner.png` |
| P2-10 | VS Code's injected `body { padding: 0 20px }` wastes 40px of toolbar and table width. | `body { padding: 0 }` in `main.css`, with 8px inner padding on the toolbar and pager. | S | `toolbar-geometry.json` |
| P2-11 | Light+ input border falls back to `panel.border` (1.5:1). | Fallback chain via `settings.textInputBorder` and `dropdown.border`. | S | §5 numbers |
| P2-12 | No horizontal-scroll affordance at narrow widths. | Right-edge fade, or a sticky first column. | S–M | `light-modern/700/12-last-page.png` |
| P2-13 | Inconsistent casing (Title vs sentence) and the "rule ignored"/"rule disabled" mix. | Apply the copy table in §4. | S | — |

### What's already good (keep it)
- The worker architecture keeps the UI responsive at 200k rows. Clicking Next during a stuck regex still works.
- Filter rules never silently hide the whole file. The four hint states exist, which is rare in tools like this; they just need clearer copy.
- The quote banner has a one-click fix. "Auto (,)" shows what was detected. "Show all (N characters)" warns before huge values.
- Using theme variables only makes HC nearly correct with no extra work.
- Headers keep keyboard focus across sort re-renders.
