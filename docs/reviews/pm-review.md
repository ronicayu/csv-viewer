# CSV Viewer: PM review before the first public release

- **Reviewed:** branch `stress-fixes` at `f37dda2` (unreleased; `package.json` still says 0.3.0), 2026-10-01.
- **How:** I read README, CHANGELOG, docs/spec.md, package.json and `src/webview/main.ts`/`main.css`. I walked the real built webview in Chromium with the Playwright harness, using VS Code Light/Dark Modern theme variables. Fixtures: `samples/people.csv` (40 rows × 15 cols) and a generated helpdesk-style export (`test-results/pm-review/tickets-wide.csv`, 40 rows × 14 cols, with long descriptions, ~15k-char notes and JSON payloads up to 12.8k chars).
- **Screenshots:** `test-results/pm-review/*.png`. That folder is gitignored and Playwright wipes `test-results/` on every run, so copy it somewhere before running the test suite again.
- **Not exercised:** the extension host in real VS Code, Cursor or Windsurf. Statements about editor-title, context-menu and "Open With" behavior come from `package.json` plus known VS Code behavior and are marked *(inferred)*.
- **Competitor numbers:** pulled live from the Marketplace gallery API and the Open VSX API on 2026-10-01. Competitor feature claims come from their listings, not hands-on use.

---

## 1. Positioning

### Who it's for and the job it does

**Who:** developers and analysts in VS Code and its forks (Cursor, Windsurf) who get CSV exports from tools like CRMs, helpdesks, admin panels, LLM eval runs or analytics, and need to *read* them. They aren't trying to edit or transform the data. These files are usually small (under 5k rows) but **wide**, with a few columns you scan (id, status, owner, date) and a few you *read* (notes, description, JSON payload, error message).

**The job:** "Let me scan the rows by the columns I care about, and read the long fields of any one row in full, without scrolling sideways or opening Excel."

**One-line pitch:** *Read wide CSVs without scrolling sideways. Keep the key columns in the table and expand any row to read the rest, long text and JSON included.*

### The competitive landscape (installs as of 2026-10-01)

| Extension | Marketplace installs | Open VSX downloads | What it is | Where it leaves room for us |
|---|---|---|---|---|
| Rainbow CSV (`mechatroner.rainbow-csv`) | 24.1M | 3.23M | Column colouring in the text editor, plus RBQL queries and a lint. No grid. | It isn't a table. It's a complement, not a substitute: lots of our users will have it installed. Say "works alongside Rainbow CSV". |
| Spreadsheet/Excel Viewer (`GrapeCity.gc-excelviewer`) | 6.8M | 233k | Editable grid (Wijmo) | The publisher's listing says it's **no longer actively maintained**. The **Open VSX build is frozen at v4.2.58 (Aug 2023)** while the Marketplace has v4.2.66. It has the lowest rating in the set (3.38/5). |
| Edit CSV (`janisdd.vscode-edit-csv`) | 2.5M | 271k | Editable grid opened by command | Its own listing says it "does not scale very well" with large files, and it doesn't pick up external file changes. Column hiding is settings-only (`initiallyHiddenColumnNames`), with no per-row detail. |
| Data Wrangler (`ms-toolsai.datawrangler`) | 2.3M | **not on Open VSX** | Pandas-backed data-prep tool | Needs Python, Pandas and the Python/Jupyter extensions even for a plain CSV. Cursor and Windsurf users can't get it from Open VSX. |
| Data Preview (`RandomFractalsInc.vscode-data-preview`) | 792k | 38k (last build 2020) | Grid and charts | Unmaintained: last Marketplace update 2023-04, last Open VSX build 2020. |
| CSV to Table (`phplasma.csv-to-table`) | 821k | **not on Open VSX** | Converts to a static ASCII table | Not an interactive viewer. |
| CSV (`ReprEng.csv`) | 613k | 273k (in sync) | Editable grid that **registers as the default editor** for .csv/.tsv/.tab/.psv (no `priority`, so it defaults to `default`). Has sticky header, sort and clipboard copy. | **The sharpest direct competitor:** maintained, on both registries, and opens automatically. Its listing mentions no column hiding, filter rules or detail view (not verified hands-on). |
| XLSX, CSV, TSV & Markdown Editor (`Muhammad-Ahmad.xlsx-viewer`) | 143k | **403k** | Styled editor | Notable because it has more downloads on Open VSX than on the Marketplace. That's evidence the forks' audience is real and under-served. |

VS Code itself still ships no CSV table preview.

### Our actual differentiator

1. **The table + per-row detail split.** I found no other extension with an interactive "these columns in the table, the rest in an expandable per-row panel" model. Edit CSV's settings-only hide list is the closest thing. This is real white space, and it's exactly the owner's use case.
2. **Read-only, no setup, no network, safe anywhere.** It works in untrusted and virtual workspaces, needs no Python, and has no telemetry. That's useful positioning against Data Wrangler and the editable grids.
3. **Maintained and Open VSX-native** while two of the big incumbents (Excel Viewer, Data Preview) are stale there and two others (Data Wrangler, CSV to Table) are absent.
4. Include/exclude filter rules and multi-key sort. These are good, but table stakes for a grid, not a differentiator.

### Is the differentiator visible in the first 10 seconds?

**No, on all three surfaces:**

- **Listing:** the description leads with "Read-only table viewer for CSV/TSV files, with column visibility, filtering, sorting, and pagination". That's a generic feature list opening on a limitation. There's no screenshot (README line 5 is a text placeholder) and no icon. "Column visibility" doesn't say "detail panel". The display name "CSV Viewer" is also already taken by `mefisto04.csv-viewer` (41k installs), so in search we're one of several identical names.
- **First open:** the user sees plain text, because the editor has priority `option` (see section 3).
- **In the viewer:** the table looks like every other grid. `people-first-look-light-1280.png` shows 8 columns and an unlabeled ▶ on each row. Nothing tells you that **7 of the 15 columns aren't shown** or where they went. The only cues are a tiny ▶ and a "Columns" button that looks like every other blue button. A user who never clicks a row never discovers the product's core idea.

---

## 2. Marketplace listing audit

| Item | Current | Verdict |
|---|---|---|
| `displayName` | `CSV Viewer` | **Fix.** It's identical to `mefisto04.csv-viewer` (41k installs) and close to many others ("CSV Table View", "CSV & Excel Viewer"…). The Marketplace may reject an exact duplicate display name on first publish (verify). Even if it doesn't, nobody can tell us apart in search. Proposed: **"CSV Viewer: Table + Row Details"**. That keeps the search term and says what's different. Changing `displayName` later is allowed; changing `name`/`publisher` (the ID) is not, so settle the ID now. |
| `description` | "Read-only table viewer for CSV/TSV files, with column visibility, filtering, sorting, and pagination." | **Rewrite** (below). Lead with the job, not with "read-only". |
| `keywords` | csv, tsv, table, viewer, data | **Expand:** `csv`, `tsv`, `tab`, `table`, `viewer`, `preview`, `grid`, `columns`, `filter`, `sort`, `json`, `wide`, `data`. Don't add "excel" or "xlsx": we don't open spreadsheets, and the resulting reviews would hurt. |
| `categories` | Visualization, Other | Use `["Visualization", "Data Science"]`. Data Wrangler and Data Preview sit in Data Science, so that's where people browse for CSV tools. Drop "Other". |
| `icon` | **None.** No `icon` field and no media folder. | **Blocker.** Both registries show a generic placeholder, and in a list of CSV tools that reads as abandoned. You need a 128×128 PNG (SVG is not accepted as the extension icon). |
| `galleryBanner` | none | Optional. Add `{ "color": "#1f1f1f", "theme": "dark" }` once the icon exists. |
| `publisher` | `ronica` | You need a Marketplace publisher with that ID, and the Open VSX **namespace `ronica` doesn't exist yet** (API returns 404, checked 2026-10-01). The final extension ID will be `ronica.csv-viewer`. Fine, but decide now: the ID is permanent. |
| repository / homepage / bugs | Set, pointing at public `github.com/ronicayu/csv-viewer` | OK. Add GitHub topics to the repo (currently none). |
| `license` | MIT, LICENSE file present | OK. |
| `pricing` | absent | Add `"pricing": "Free"` (shown in the listing). |
| `qna` | absent, so the Marketplace Q&A tab is on | Set `"qna": false` so questions go to GitHub issues instead of an unmonitored Q&A tab. |
| `engines.vscode` | `^1.80.0` | OK for current Cursor/Windsurf bases. |
| README hero | `*(screenshot placeholder — add a GIF or PNG …)*` | **Blocker.** This is the first thing on the listing page. |
| README body | One 13-bullet wall. Several bullets are engineering notes: `__proto__` headers, Turkish İ / ß case folding, regex watchdog internals, Papa Parse quote rules, the 512 MB hard limit, the vsix install instructions for 0.3.0, and the Development section. | **Rewrite.** The first screen should be pitch → GIF → how to open → 6 bullets. Move limits to a short "Limits" section, and engineering detail to `docs/` or CONTRIBUTING. |
| CHANGELOG | The "Unreleased" section is ~17 KB of implementation detail (`buildColumnSortKeys`, `queryStarted`/`filterDone` messages, `.vscodeignore` contents). The Marketplace shows it as a tab. | **Should-fix.** Rename it to `## 0.4.0` and lead with five user-facing lines ("Stays responsive with slow regex filters and 200k-row files", "Long cells no longer freeze the view; Show all for huge values", "Warning + one-click fix for malformed quotes", "Mixed line endings parsed correctly", "Opens files up to 512 MB"). Keep the detail in commits or `docs/`. |
| vsix contents | 11 files, 114 KB, with `--no-dependencies` (papaparse is bundled). I verified with `vsce ls` and a test package. | OK. Optional: exclude `out/**/*.map` (~240 KB uncompressed, more than half the payload). |

### Proposed `description` (about 160 chars, so it isn't cut off in search results)

> Read wide CSV/TSV files without scrolling sideways: keep key columns in the table, expand any row to read long text and JSON. Filter, sort, live reload.

### Proposed README first screen

```markdown
# CSV Viewer: Table + Row Details

Read wide CSV and TSV files in VS Code, Cursor, and Windsurf without scrolling sideways.
Keep the columns you scan in the table; expand any row to read everything else —
long notes, descriptions, JSON — in full.

![Picking table columns, then expanding a row to read its notes and JSON](media/hero.gif)

**Open a file:** right-click a `.csv` / `.tsv` → **Open in CSV Viewer**, or click the
table icon in the editor title bar. To open CSVs this way every time:
**Open With… → Configure default editor for '*.csv' → CSV Viewer**.

- **Columns → table or details.** Choose which columns stay in the table; the rest
  appear when you expand a row.
- **Find rows fast.** Search all columns, or add include/exclude rules
  (contains, equals, regex, >, <, is empty…). Right-click any value to filter by it.
- **Sort** by clicking a header; Shift+click to add a second key.
- **Just works on messy exports.** Detects comma, semicolon, tab, pipe; warns and
  offers a fix when quotes are malformed; reloads when the file changes on disk.
- **Read-only and private.** Never modifies your file, no telemetry, no network,
  works in untrusted workspaces.

Pairs well with Rainbow CSV (colourised text) and Edit CSV (editing). This one is for reading.
```

The GIF should be ~8 seconds and show the differentiator: open a wide file → click a row → notes/JSON visible → Columns → move one column. Record it in a real editor with a dark theme, not in the harness.

---

## 3. First-run and discoverability

The custom editor is `priority: "option"`, so double-clicking `data.csv` opens text. Every path into the viewer depends on the user already knowing it exists.

| Entry point | What happens | Assessment |
|---|---|---|
| **Editor title `$(table)` icon** | Shown whenever the active resource is .csv/.tsv/.tab (case-insensitive). | This is the best entry point because it shows up at the moment of need. But it's one unlabeled icon among the others in that bar (Rainbow CSV and others add icons there too), and the tooltip only appears on hover. *(Inferred)* The same `when` clause matches while the viewer itself is active, so the table icon also shows **inside the viewer**, where clicking it does nothing, while there's no "Open as Text" icon there. |
| **Explorer context menu** | "Open in CSV Viewer" in the `navigation` group | Fine for people who right-click. Most people double-click. |
| **Command Palette** | "Open in CSV Viewer", shown only when a CSV is active | You have to know the name. `CSV Viewer: Open as Text` is hidden from the palette (`when: false`), so from the palette the way back is VS Code's built-in "Reopen Editor With…". |
| **"Open With…"** | Lists "CSV Viewer". VS Code's picker also offers "Configure default editor for '*.csv'…". | This is the cleanest built-in path to "always open as a table", but almost nobody knows about it. |
| **`workbench.editorAssociations`** | Documented in the README as a JSON snippet | Correct, but it's buried in the 4th bullet of "Opening a file" and assumes the user is comfortable editing settings.json. |
| **In-viewer "Open as Text" button** | Toolbar, far right; it wraps to a second toolbar line at 1280 px (`people-first-look-light-1280.png`) | It works, but it's the least important control and sits in a primary-blue button. |

### Options considered

- **A. Make it the default editor (`priority: "default"`) with an "Open as Text" escape hatch.** `ReprEng.csv` does this. **Rejected for us:** our viewer is read-only, and a lot of CSV traffic is editing (Rainbow CSV's 24M installs are text users). Taking over every double-click for people who wanted to fix a typo is the fastest way to collect 1-star reviews. If a user also has ReprEng.csv or another default-priority CSV editor installed, VS Code has to resolve competing defaults, which is unpredictable from our side.
- **B. A walkthrough contribution.** Low value. It shows once at install time (if the fork renders walkthroughs at all, which I haven't verified for Cursor/Windsurf), long before the user opens a CSV. Users skip it.
- **C. A one-time, contextual prompt the first time a CSV opens as text.** ← **Recommended.**

### Recommendation: option C, plus two small fixes

1. **The first time** (globalState flag) a .csv/.tsv/.tab opens in a text editor after install, show one info notification: *"View data.csv as a table?"* with three buttons: **[Open as Table]** **[Always for CSV files]** **[Don't ask again]**.
   - "Always" writes `workbench.editorAssociations` for `*.csv`, `*.tsv`, `*.tab` at user scope, then tells the user how to undo it ("Open as Text is in the editor title").
   - Never show it again after any choice, and never after the user has used "Open as Text".
   - Add a setting `csvViewer.suggestOnOpen` (default true) so it can be turned off.
   - Needs `onStartupFinished` activation plus an `onDidChangeActiveTextEditor` listener, because there's no built-in `csv` language ID to activate on unless Rainbow CSV is installed.

   **Why this one:** it fires at the moment of need, costs one click, makes "default" an explicit user choice (so read-only never surprises anyone), and teaches the escape hatch at the same time.
2. **Editor title, viewer side:** when `activeCustomEditorId == csvViewer.table`, show an `$(go-to-file)` "Open as Text" icon and hide the table icon. Make `csvViewer.openAsText` visible in the Command Palette while the viewer is active.
3. **In-viewer first-run hint** (once per user, dismissible), placed in the status line: *"7 more columns are in each row's details: click a row to expand. Choose with Columns."* This is the cheapest way to make the differentiator visible in the first 10 seconds (see section 1).

---

## 4. Feature-by-feature verdict (small exports, wide long-text cells)

| Surface | Complete? | Default right for her use? | The one thing to fix |
|---|---|---|---|
| **Column picker (Columns popover)** | Yes: search, Show all/Hide all, per-column checkbox, persisted per file. | Partly | The popover is anchored to the **right edge** (`right: 8px`) while its button is on the left, so it opens ~750 px away from where you clicked (`people-columns-open-dark.png`). It doesn't close on outside click (I verified: clicking the table leaves it open; only Esc or the button closes it). There's no legend for what a checkbox means. **Fix:** anchor it under the button, close on outside click, and title the list "In table ☑ / In row details ☐". Rename the buttons "All in table" / "All in details". |
| **Row expand → detail panel** | Yes for detail-only columns | **No, for long text that lands in the table** | The detail panel only lists *detail-only* fields. In the wide fixture, `description` is column 5, so it lands in the table, gets cut to 320 px with an ellipsis, has **no tooltip** (`title` is null), and **does not appear in the expanded row** (`wide-expanded-row4-typical-dark.png`). The only way to read it is to move the column out of the table. **Fix:** the detail panel should also show any in-table cell that was truncated or contains a newline, under a dimmed "Also in table" group. Also add `title` on truncated cells. |
| **Default: first 8 columns in table** | Works as specified | **Wrong heuristic for wide exports** | Position isn't the signal; content length is. people.csv only works by luck (`notes` is column 12). **Fix:** a smart default. Keep up to 8 *short* columns in the table, chosen by sampling the first ~200 rows: median length ≤ 60 chars, no newlines, not JSON. Send long, multiline or JSON columns to details. Keep `csvViewer.defaultTableColumns` as the cap. This is a pure function in `src/core/columns.ts` plus a sample from the worker's `initResult`. |
| **Detail view: wrapping** | `pre-wrap` + `break-word`, max-width 900 px | OK for prose | Prose reads well (`wide-expanded-row4-typical-dark.png`). But an expanded field has no height limit. A 15k-char note fills the viewport, and the row it belongs to scrolls up **under the sticky header**, so you lose which row you're reading (`wide-show-all-button.png`). **Fix:** clamp each field to ~12 lines with "More"/"Less". Keep the 10k-char hard cap as the safety net behind it. |
| **Detail view: 10k truncation + Show all** | Works: "Show all (12839 characters)" expands in place | OK | Once expanded, there's **no "Show less"**: the only way back is to collapse the row. The button is primary-blue, the loudest thing on screen. **Fix:** make it a toggle with secondary/link styling. |
| **Detail view: JSON blobs** | Shown as raw wrapped text | **No** | A 12.8k-char single-line JSON becomes a wall that wraps mid-token at hyphens in dates (`wide-expanded-row0-json-dark.png`). **Fix:** if a value starts with `{`/`[` and `JSON.parse` succeeds, pretty-print it with a 2-space indent in the editor monospace font, with a "Raw" toggle. Cheap and high value for her files. |
| **Copy** | **Missing** | **No** | No copy action anywhere. Worse, **drag-selecting text in a table cell toggles the row open** (verified: selecting `charlie.brown@example.com` expanded row 3, `people-drag-select-cell.png`), and double-clicking a word toggles it twice (it flickers). Selecting inside the detail panel is fine. **Fix:** ignore the row click when `getSelection()` is non-empty. Add "Copy value", "Copy row as CSV", "Copy row as JSON" to the right-click menu, which today has only the two filter items (`people-context-menu-dark.png`). Add a copy icon per detail field. |
| **Quick search** | Works and is debounced. Searches all columns, including detail-only ones. | Yes | Matches aren't highlighted, so when a row matched on a *detail-only* column, nothing visible explains why it's there. **Fix:** highlight matches, and auto-expand or badge rows whose only match is in details. Zero results is a blank table plus tiny grey "Showing 0 of 40 rows" (`people-search-no-results-dark.png`): add an empty state with a "Clear search" button. |
| **Filters panel** | Complete set of operators, include/exclude, case, enable, helpful "rule ignored" hints | Works | **Active filters are invisible once the panel is closed.** After a right-click "exclude", the Filters button still says "Filters" and the only trace is "Showing 35 of 40 rows" in small grey text (`people-after-quick-exclude-no-badge.png`). **Fix:** "Filters (1)" badge plus a "Clear" chip. Smaller issues: the empty panel is a lone "+ Add rule" with no explanation, and "Include" is a button that toggles to "Exclude", which reads like an action rather than a state. A segmented Include/Exclude control would be clearer. |
| **Right-click → filter by value** | Works, uses the full value | Yes | Fine. Add the copy items here (see Copy). |
| **Sort** (header click, Shift+click, "Sort by…") | Complete | Yes | The "Sort by…" dropdown is the only way to sort by a detail-only column. That's correct and needed, but it takes a whole toolbar slot. **Fix:** move it into a header/column menu later. Low priority. |
| **Pagination** | Complete: First/Prev/Next/Last, jump, size 25–500, Alt+←/→ | Default 100 is low for a 5k-row export (50 pages) | **Fix:** default the page size to 500 when the file has ≤ 5k rows. "Showing 40 of 40 rows" (top) and "Rows 1–40 of 40" (bottom) say the same thing twice. Keep one. |
| **Separator** | Complete: Auto shows the detected delimiter, e.g. "Auto (;)"; presets; Custom | Yes. Auto-detected `;` correctly on a European export (`euro-semicolon-quote-banner-dark.png`) | "Separator" is plain English and fine. Its problem is placement: one of three file-format controls in prime toolbar space (see Toolbar). Related gap: decimal-comma numbers (`12,50`) are treated as text by `parseNumber`, so semicolon-separated European exports sort amounts as text *(inferred from `src/core/number.ts`)*. |
| **Quoted fields** | Works, and the banner's "Treat quotes as plain text" is a good one-click fix | Default on is right | **Jargon** for a general audience. Most users will never touch it, and when they need it the banner already explains the problem in plain words. **Fix:** move it into a Format menu labelled `Respect quotes ("…")`, with the tooltip "Turn off if a stray quote merges rows". |
| **First row is header** | Works | Yes | Same as above: belongs in the Format menu. |
| **Toolbar overall** | Has 13 controls | — | It **wraps to 2 lines at 1280 px** (Open as Text orphaned, `people-first-look-light-1280.png`), 3 lines at 640 px (`people-first-look-dark-640-split.png`), and **every button is the primary blue style**, so nothing has emphasis. The popovers use a hard-coded `top: 42px`, so on a wrapped toolbar the Filters panel **covers the second toolbar row** (`people-640-filters-open.png`). **Fix:** one row: Search · Columns · Filters (n) · Sort by · [Format: Comma · Header · Quotes ▾] · Expand/Collapse toggle · Open as Text (icon). Use the secondary button colours (`--vscode-button-secondaryBackground`) and position popovers from the button's rect. Nothing gets removed. |
| **Expand page / Collapse page** | Works | Yes | Two buttons for one toggle. Merge them into "Expand all ⇄ Collapse all" for the page. |
| **Hide all columns** | Allowed | — | It produces a table of anonymous centred ▶ glyphs (`people-hide-all.png`). Either keep the first column pinned, or treat it as a deliberate "record list" and show the first column's value as the row label. |
| **Keyboard** | Headers are focusable and sortable from the keyboard | **No** | Rows and chevrons are **not focusable** (verified: 0 focusable rows; tab order goes toolbar → headers → pager). Keyboard-only users can't open the detail panel, the product's core feature. **Fix:** make each row a focusable `button`-role element with `aria-expanded`, toggled with Enter/Space and ↑/↓ to move between rows. |
| **Live reload / Open as Text** | Works (per code and the integration suite) | Yes | — |
| **Empty and header-only files** | Renders headers | — | A header-only file says "No matching rows", which wrongly implies a filter (`header-only-dark.png`). Say "This file has no data rows." |
| **Theming** | Uses only `--vscode-*` variables. Light and Dark Modern both look right in the harness. | Yes | High contrast not checked. |

---

## 5. Gaps and roadmap

Ranked by expected week-one demand × inverse effort. Effort: S = under 1 day, M = 1–3 days, L = a week or more.

| # | Gap | Demand | Effort | Why it ranks here |
|---|---|---|---|---|
| 1 | **Copy cell / row (CSV, TSV for pasting into Sheets, JSON)**, plus fixing the drag-select toggle | High | S | It's the first thing anyone does after finding a row. ReprEng.csv and Edit CSV both have it. Without it, people will try to select the text, the row will collapse under them, and some will leave a review. |
| 2 | **Readable long in-table cells** (detail shows truncated table cells; `title` tooltip) | High (her primary use) | S | Without it, a long column that happens to be in the first 8 can't be read at all without reconfiguring columns. |
| 3 | **JSON pretty-print in details** | High for her, medium overall | S | JSON-in-CSV is common in exports and LLM eval logs, and today it's unreadable. |
| 4 | **Smart default column split** (long/multiline/JSON columns go to details) | High | S–M | Makes the differentiator work on first open with zero configuration. |
| 5 | **Header right-click: Sort asc/desc, Move to details, Filter by this column** | Medium–high | S–M | Moving a column to details straight from its header is the core idea in one gesture. The spec listed it as nice-to-have; it's the most direct way to teach the model. |
| 6 | **Column resize** (drag, double-click to fit, persisted) | High (expected from any grid) | M | Today widths are `auto` with a 320 px max and an ellipsis, so you can't widen `subject`. Users of Excel Viewer and Edit CSV will look for it in the first minute. |
| 7 | **Active-filter badge, search highlight, empty states** | Medium | S | Cheap trust fixes: users need to know why rows are missing. |
| 8 | **Export / copy filtered rows** ("Save filtered as CSV…", "Copy all filtered") | Medium | M | Natural follow-on to filter rules: the worker already has the filtered row ids, and the host needs `showSaveDialog` + `workspace.fs.writeFile`. Writes a *new* file, so the viewer stays read-only. |
| 9 | **Reveal row in text editor** ("Open as Text at this row") | Medium | M | Pairs the read-only viewer with editing. Needs source line numbers per row, which requires tracking offsets in the parse. |
| 10 | **Freeze first column(s)** | Medium | S–M | Less critical here than in other grids because the detail panel reduces horizontal scroll, but wide tables still scroll. Sticky-left on the chevron + first column is cheap. |
| 11 | **VS Code status bar item** ("40 rows · 15 cols", or "35 of 40" when filtered) | Low–medium | S | The in-view status line already covers it. Nice, but don't prioritise. |
| 12 | **Locale numbers** (decimal comma) for sort and numeric filters | Medium internationally | S | Open VSX's audience is global. Today `12,50` sorts as text. |
| 13 | **Remote-SSH / WSL / Dev Containers** | Medium | S to verify | Should already work: no `extensionKind` is set and reads go through `workspace.fs` *(inferred)*. Verify once in Remote-SSH and in Cursor's remote, then say so in the README. |
| 14 | **Web (vscode.dev / github.dev)** | Low–medium | S–M | Host code is tiny and nearly web-safe. Adding a `browser` entry point would open up GitHub browsing. |
| 15 | **Multi-file** (compare two CSVs, tabs of related files) | Low | L | Not a week-one expectation for a viewer. |
| 16 | **Git diff as table** | Low | L | Row-level diff is its own product. Later, if ever. |
| — | **Editing** | — | — | Out of scope by design. Say so in the listing and point to Edit CSV / Rainbow CSV, which turns a missing feature into a positioning statement. |

### Cut or hide for v1

No shipped feature should be removed: the owner uses all of them. What should be hidden or regrouped:

- **Regroup "First row is header", "Separator" and "Quoted fields" into one Format menu** whose button shows the current state ("Comma · Header · Quotes"). These are per-file setup controls touched once (or never, when auto-detection works), but they take ~40% of the toolbar and are why it wraps. The quote banner already surfaces the Quoted-fields fix when it matters.
- **Merge Expand page / Collapse page** into one toggle.
- **Strip the README and CHANGELOG of engineering content.** Turkish İ folding, `__proto__` headers, regex-watchdog internals and Papa quote rules are reassurance for maintainers, not buying reasons. On the listing they push the pitch below the fold and make a small tool look complicated.
- **Remove the "Installing from a .vsix" and "Development" sections from the README** (move them to CONTRIBUTING.md). Marketplace users install with one click.
- **Swap the table icon for an "Open as Text" icon while the viewer is active** (section 3).

---

## 6. Release readiness checklist: 0.4.0 → Marketplace + Open VSX

### Blockers

- [ ] **README hero screenshot/GIF.** It's a text placeholder today, and it's the top of the listing. Images must be PNG/GIF/JPG; vsce rejects SVG images other than trusted badges. Use relative paths: vsce rewrites them against the `repository` URL, so the images must be committed and pushed to GitHub before publishing.
- [ ] **Icon** (128×128 PNG, `"icon": "media/icon.png"`).
- [ ] **Rewritten `description` + README first screen** (section 2).
- [ ] **Settle the extension ID and display name.** `ronica.csv-viewer` is permanent. Pick a display name distinct from `mefisto04.csv-viewer`'s "CSV Viewer".
- [ ] **Fix drag-select toggling rows** and **add Copy value / Copy row.** Arguably a should-fix, but it's the most likely source of a bad first review for a *reading* tool, and it takes under a day.
- [ ] **Bump `version` to 0.4.0.** Turn CHANGELOG "Unreleased" into `## 0.4.0` with a user-facing summary.
- [ ] **Accounts:**
  - **Marketplace:** create publisher `ronica` at marketplace.visualstudio.com/manage. Create an Azure DevOps PAT with scope **Marketplace → Manage** and organization **"All accessible organizations"** (the usual cause of 401s), then run `npx vsce login ronica`. PATs expire (max 1 year), so put a renewal reminder in the calendar.
  - **Open VSX:** sign in to open-vsx.org with GitHub, link an Eclipse Foundation account, sign the Publisher Agreement, generate an access token, then `npx ovsx create-namespace ronica -p <token>`. The namespace is currently unclaimed (API 404). Optionally request namespace verification so the listing isn't marked unverified.
- [ ] **Package once, publish the same file to both:** `npm run compile && npx vsce package --no-dependencies` → `npx vsce publish --no-dependencies --packagePath csv-viewer-0.4.0.vsix` and `npx ovsx publish csv-viewer-0.4.0.vsix -p $OVSX_PAT`. `--no-dependencies` is correct because papaparse is bundled into `out/webview/*.js`. I confirmed with `vsce ls` that the vsix holds exactly 11 runtime files (114 KB) and no `node_modules`.
- [ ] **Smoke test the packaged vsix by hand** in VS Code, Cursor and Windsurf (install from the vsix): open people.csv, a wide file, a .tsv, an uppercase `.CSV`, and a file in a Remote-SSH workspace if you can. The Playwright harness doesn't cover the host or the forks.

### Should-fix (0.4.x, ideally before announcing anywhere)

- [ ] First-run suggestion notification + "Always for CSV files" (section 3).
- [ ] "Open as Text" icon in the editor title while the viewer is active; hide the no-op table icon there.
- [ ] Detail panel shows truncated in-table cells; `title` tooltip on truncated cells.
- [ ] JSON pretty-print; per-field line clamp with More/Less.
- [ ] Toolbar on one row: Format menu, secondary button styles, popovers anchored to their buttons and closing on outside click.
- [ ] Filters (n) badge + Clear; search empty state; fix the "No matching rows" copy for header-only files.
- [ ] Keyboard-expandable rows (`role=button`, `aria-expanded`).
- [ ] In-viewer one-time hint ("N more columns are in each row's details").
- [ ] `categories`, `keywords`, `pricing`, `qna` in package.json.
- [ ] **CI** (there's no `.github/` today). On PRs: `npm ci`, compile, `vitest`, Playwright (cache `~/.cache/ms-playwright`, `npx playwright install chromium`), integration tests under `xvfb-run`. On tag `v*`: package once, publish to both registries with `VSCE_PAT` / `OVSX_PAT` secrets (e.g. `HaaLeo/publish-vscode-extension`, which handles both), and attach the vsix to the GitHub Release like v0.1–v0.3.
- [ ] Optional: exclude `out/**/*.map` from the vsix.

### Later

- Column resize, header menu, export filtered rows, reveal-row-in-text, freeze columns, smart default page size, locale numbers, web support, status bar item.
- High-contrast theme pass.
- Collect usage signals that don't need telemetry: GitHub issue templates ("What file were you opening?") and a README link to Discussions.

---

## 7. Top 5 recommendations (in order)

1. **Make the listing sell the actual product.**
   - *Problem:* a stranger browsing either registry sees a generic name shared with another extension (`mefisto04.csv-viewer`, 41k installs), no icon, a description leading with "Read-only…", and a README whose hero is a text placeholder. Nothing mentions the table + row-details idea, which is the one thing no competitor has.
   - *Change:* icon, an 8-second hero GIF (open wide file → expand row → read notes/JSON → move a column), the display name "CSV Viewer: Table + Row Details", the description and README first screen from section 2, and a user-facing 0.4.0 changelog.
   - *Evidence:* README line 5; no `icon` in package.json; the competitor table in section 1. Open VSX is where Cursor/Windsurf users shop, and incumbents there are stale (Excel Viewer frozen at 2023) or absent (Data Wrangler, CSV to Table).

2. **Get users into the viewer at the moment of need.**
   - *Problem:* with `priority: "option"`, every first open shows plain text. The only in-context cue is an unlabeled table icon in the editor title, and "make it default" is a settings.json snippet in the README. ReprEng.csv simply takes over .csv by default.
   - *Change:* a one-time notification on the first CSV text open, "View as a table? [Open as Table] [Always for CSV files] [Don't ask again]". "Always" writes `workbench.editorAssociations`. Also an "Open as Text" icon in the editor title while the viewer is active.
   - *Evidence:* `contributes.customEditors[0].priority`; ReprEng.csv's manifest (no priority, so it's the default). Making a read-only viewer the default would break the editing workflow of Rainbow CSV's 24M users, so the default has to be the user's choice.

3. **Make long text readable without configuration.**
   - *Problem (her main use):* a long `description` column that falls within the first 8 columns is cut to 320 px with an ellipsis, has no tooltip, and is *not* in the expanded row. The only way to read it is to move the column out of the table first. JSON blobs render as an unbroken wall that wraps mid-token. A long field pushes its own row under the sticky header.
   - *Change:* (a) a smart default split: long, multiline or JSON columns go to details; (b) the detail panel also shows truncated in-table values; (c) JSON pretty-print with a Raw toggle; (d) per-field line clamp with More/Less; (e) a one-time hint "N more columns are in each row's details".
   - *Evidence:* `wide-first-look-dark-1280.png`, `wide-expanded-row4-typical-dark.png` (detail keys lack `description`), `wide-expanded-row0-json-dark.png`, `wide-show-all-button.png`.

4. **Make copying work.**
   - *Problem:* there's no copy action anywhere, and drag-selecting a cell's text toggles the row open, so even the manual workaround misbehaves.
   - *Change:* ignore the row click when a text selection exists. Add "Copy value / Copy row as CSV / Copy row as JSON" to the right-click menu, and a copy icon per detail field.
   - *Evidence:* the Playwright probe (selecting `charlie.brown@example.com` expanded row 3), `people-drag-select-cell.png`, `people-context-menu-dark.png` (only two filter items). ReprEng.csv and Edit CSV both have clipboard copy.

5. **Tame the toolbar and make state visible.**
   - *Problem:* 13 controls, all primary-blue, wrapping to 2 lines at 1280 px and 3 at 640 px. Popovers are positioned at a fixed `top: 42px`, so on narrow panes they cover the toolbar's second row. The Columns popover opens at the far right, away from its button, and doesn't close on outside click. Active filters leave no visible trace once the panel is closed.
   - *Change:* one row (Search · Columns · Filters (n) · Sort by · Format ▾ · Expand toggle · Open as Text icon), secondary button styling, popovers anchored to their button with outside-click close, a filter count badge plus Clear, and "Quoted fields" relabelled inside the Format menu. No feature is removed.
   - *Evidence:* `people-first-look-light-1280.png`, `people-640-filters-open.png`, `people-columns-open-dark.png`, `people-after-quick-exclude-no-badge.png` (5 rows hidden, button still says "Filters").
