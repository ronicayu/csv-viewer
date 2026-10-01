// New coverage for the "reading" pass (docs/reviews/pm-review.md §4/§5,
// docs/reviews/ux-review.md §2/§3/§6, P1-10/P1-13/P2-5/P2-6): the smart
// default column split, numeric-column right-alignment, JSON pretty-print
// with a Raw/Formatted toggle, the detail panel's 6-line height clamp and
// its interplay with the 10,000-character "Show all"/"Show less", the
// dimmed "—" for empty values, per-field Copy, Copy Row as CSV/JSON, and
// the full keyboard row model.

import * as fs from "fs";
import * as path from "path";
import { expect, test, type Page } from "@playwright/test";
import { bootAndLoad, bootAndLoadText, defaultViewState, REPO_ROOT } from "./harness";
import { smallFixture } from "./fixtures";
import { toCsvText, wideFixture } from "./stress/stressHelpers";

const TICKETS_WIDE = fs.readFileSync(path.join(REPO_ROOT, "samples", "tickets-wide.csv"), "utf8");

// ---- A. Smart default column split (src/core/columns.ts) ------------------

test.describe("smart default column split", () => {
  test("samples/tickets-wide.csv opens with its long description/notes/JSON columns in details and the short ones in the table", async ({
    page,
  }) => {
    await bootAndLoadText(page, {
      fileKey: "file:///tickets-wide.csv",
      text: TICKETS_WIDE,
      state: defaultViewState(),
      defaultTableColumns: 8,
    });

    const tableHeaders = await page.locator("#table-head th.sortable").allTextContents();
    expect(tableHeaders).toEqual(["ticket_id", "created_at", "customer", "status", "priority", "channel", "assignee", "subject"]);

    await page.locator("tr.data-row").first().click();
    const detail = page.locator("tr.detail-row").first();
    for (const field of ["description", "payload_json", "internal_notes", "tags", "sla_breached", "updated_at"]) {
      await expect(detail.locator("dt", { hasText: field })).toHaveCount(1);
    }
    // The long/multiline/JSON columns must not also be in the table.
    for (const field of ["description", "payload_json", "internal_notes"]) {
      await expect(page.locator("#table-head th", { hasText: field })).toHaveCount(0);
    }
  });

  test("a stored per-file column choice overrides the smart split", async ({ page }) => {
    // "description" looks long by its profile and would default to row
    // details — a stored choice (as a reopened file would have) wins
    // regardless, same guarantee the pure function's unit tests cover.
    await bootAndLoadText(page, {
      fileKey: "file:///tickets-wide-stored.csv",
      text: TICKETS_WIDE,
      state: defaultViewState({ columnVisibility: { description: true, ticket_id: false } }),
      defaultTableColumns: 8,
    });

    await expect(page.locator("#table-head th", { hasText: "description" })).toHaveCount(1);
    await expect(page.locator("#table-head th", { hasText: "ticket_id" })).toHaveCount(0);

    // "description" being forced into the table doesn't mean it disappears
    // from the detail panel entirely: it's long enough to be clipped (or,
    // for this row, contains a newline), so it legitimately also shows up
    // under "Also in table" — that's the pre-existing P0-1 behavior, not
    // something a stored visibility choice should suppress. The point of
    // this test is the column SPLIT (table vs. detail-only group), which
    // "ticket_id" still demonstrates correctly.
    await page.locator("tr.data-row").first().click();
    const detail = page.locator("tr.detail-row").first();
    await expect(detail.locator("dt", { hasText: "ticket_id" })).toHaveCount(1);
  });
});

// ---- B. Numeric column right-alignment -------------------------------------

test("a column whose values are almost all numeric is right-aligned with tabular-nums, while a text column is not", async ({ page }) => {
  const text = toCsvText(
    ["id", "amount", "label"],
    [
      ["1", "100", "a"],
      ["2", "200.50", "b"],
      ["3", "-3", "c"],
      ["4", "4e2", "d"],
    ],
  );
  await bootAndLoadText(page, {
    fileKey: "file:///numeric.csv",
    text,
    state: defaultViewState(),
    defaultTableColumns: 3,
  });

  const amountCell = page.locator("tr.data-row").first().locator("td").nth(2); // chevron, id, amount
  await expect(amountCell).toHaveClass(/numeric-cell/);
  await expect(amountCell).toHaveCSS("text-align", "right");

  // "id" ("1".."4") is itself ≥90% numeric by the same profile-based rule
  // — right-aligning it too is correct, not a bug, so it's not asserted
  // against here. "label" ("a".."d") is the genuinely non-numeric column.
  const labelCell = page.locator("tr.data-row").first().locator("td").nth(3);
  await expect(labelCell).not.toHaveClass(/numeric-cell/);
  await expect(labelCell).toHaveCSS("text-align", "left");
});

// ---- C/D. Detail panel values: JSON, height clamp, empty -------------------

async function loadSingleField(page: Page, value: string, fileKey: string): Promise<void> {
  const text = toCsvText(["id", "field"], [["1", value]]);
  await bootAndLoadText(page, {
    fileKey,
    text,
    state: defaultViewState(),
    defaultTableColumns: 1, // "field" is detail-only
  });
  await page.locator("tr.data-row").first().click();
}

test.describe("detail panel: JSON pretty-print", () => {
  test("a JSON object value is pretty-printed by default, with a Raw/Formatted toggle that round-trips", async ({ page }) => {
    const obj = { id: 7, nested: { a: 1, b: [1, 2, 3] } };
    await loadSingleField(page, JSON.stringify(obj), "file:///json-obj.csv");

    const dd = page.locator("tr.detail-row").first().locator("dd").first();
    const valueText = dd.locator(".detail-value-text");
    await expect(valueText).toHaveText(JSON.stringify(obj, null, 2));
    await expect(valueText).toHaveClass(/detail-value-json/);
    await expect(valueText).toHaveCSS("white-space", "pre-wrap");

    const toggle = dd.locator(".format-toggle-btn");
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveText("Raw");

    await toggle.click();
    await expect(valueText).toHaveText(JSON.stringify(obj));
    await expect(valueText).not.toHaveClass(/detail-value-json/);
    await expect(toggle).toHaveText("Formatted");

    await toggle.click();
    await expect(valueText).toHaveText(JSON.stringify(obj, null, 2));
    await expect(toggle).toHaveText("Raw");
  });

  test("formatted JSON shows every literal exactly as written (big integers, trailing zeros, duplicate keys)", async ({ page }) => {
    // JSON.stringify(JSON.parse(x)) would turn 9007199254740993 into
    // ...992, 1.10 into 1.1 and drop the first "a": a viewer must not.
    const raw = '{"id":9007199254740993,"price":1.10,"a":1,"a":2}';
    await loadSingleField(page, raw, "file:///json-exact.csv");
    const valueText = page.locator("tr.detail-row").first().locator("dd").first().locator(".detail-value-text");
    await expect(valueText).toHaveText('{\n  "id": 9007199254740993,\n  "price": 1.10,\n  "a": 1,\n  "a": 2\n}');
  });

  test("a JSON array value is also pretty-printed", async ({ page }) => {
    const arr = [1, "two", { three: 3 }];
    await loadSingleField(page, JSON.stringify(arr), "file:///json-arr.csv");
    const valueText = page.locator("tr.detail-row").first().locator("dd").first().locator(".detail-value-text");
    await expect(valueText).toHaveText(JSON.stringify(arr, null, 2));
  });

  test("a value that merely starts with '{' but isn't valid JSON is shown raw, with no Raw/Formatted toggle", async ({ page }) => {
    await loadSingleField(page, "{not json at all", "file:///not-json.csv");
    const dd = page.locator("tr.detail-row").first().locator("dd").first();
    await expect(dd.locator(".detail-value-text")).toHaveText("{not json at all");
    await expect(dd.locator(".format-toggle-btn")).toBeHidden();
  });

  test("a JSON *number* or *string* top-level value (not an object/array) is not pretty-printed", async ({ page }) => {
    await loadSingleField(page, "12345", "file:///json-number.csv");
    const dd = page.locator("tr.detail-row").first().locator("dd").first();
    await expect(dd.locator(".format-toggle-btn")).toBeHidden();
  });
});

test.describe("detail panel: height clamp (More/Less)", () => {
  test("a long prose value clamps to 6 lines with a 'More' link, which expands to 'Less' and composes with 'Show all'/'Show less'", async ({
    page,
  }) => {
    // Comfortably more than 6 lines AND more than 10,000 characters, so
    // both the height clamp and the character cap are exercised together.
    const line = "This is one line of prose that is reasonably long for a detail field value.\n";
    const bigProse = line.repeat(400); // ~30,800 chars, 400 lines
    await loadSingleField(page, bigProse, "file:///long-prose.csv");

    const dd = page.locator("tr.detail-row").first().locator("dd").first();
    const valueText = dd.locator(".detail-value-text");
    await expect(valueText).toHaveClass(/detail-value-clamped/);

    const moreBtn = dd.locator(".height-toggle-btn");
    await expect(moreBtn).toHaveText("More");
    const showAllBtn = dd.locator(".show-all-btn");
    await expect(showAllBtn).toContainText("Show all");

    // Expand height first — the char cap still applies underneath it.
    await moreBtn.click();
    await expect(valueText).not.toHaveClass(/detail-value-clamped/);
    await expect(moreBtn).toHaveText("Less");
    const clampedLength = await valueText.evaluate((el) => el.textContent?.length ?? 0);
    expect(clampedLength).toBe(10_001); // still truncated at 10,000 chars + "…"

    // Now expand the character cap too.
    await showAllBtn.click();
    const fullLength = await valueText.evaluate((el) => el.textContent?.length ?? 0);
    expect(fullLength).toBe(bigProse.length);
    await expect(showAllBtn).toHaveText("Show less");

    // Collapse height back down — the full (uncapped) text is still what's
    // clamped, just visually limited to 6 lines again.
    await moreBtn.click();
    await expect(valueText).toHaveClass(/detail-value-clamped/);
    await expect(moreBtn).toHaveText("More");
  });

  test("a short value (well under 6 lines) gets no 'More' link at all", async ({ page }) => {
    await loadSingleField(page, "just one short line", "file:///short-prose.csv");
    const dd = page.locator("tr.detail-row").first().locator("dd").first();
    await expect(dd.locator(".height-toggle-btn")).toBeHidden();
  });

  test("the line clamp also applies to pretty-printed JSON", async ({ page }) => {
    const obj: Record<string, number> = {};
    for (let i = 0; i < 60; i++) obj[`field_${i}`] = i; // 60 keys -> way over 6 lines once pretty-printed
    await loadSingleField(page, JSON.stringify(obj), "file:///json-long.csv");

    const dd = page.locator("tr.detail-row").first().locator("dd").first();
    const valueText = dd.locator(".detail-value-text");
    await expect(valueText).toHaveClass(/detail-value-clamped/);
    await expect(dd.locator(".height-toggle-btn")).toHaveText("More");
  });
});

test("an empty detail value shows a dimmed em dash instead of nothing", async ({ page }) => {
  await loadSingleField(page, "", "file:///empty-field.csv");
  const dd = page.locator("tr.detail-row").first().locator("dd").first();
  await expect(dd.locator(".detail-empty-value")).toHaveText("—");
});

// ---- F. Per-field copy icon -------------------------------------------------

test("the per-field copy icon copies the full raw value and briefly confirms with a check icon", async ({ page }) => {
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: (text: string) => {
          (window as unknown as { __copied?: string }).__copied = text;
          return Promise.resolve();
        },
      },
      configurable: true,
    });
  });
  const rawValue = "x".repeat(50_000); // longer than the 10k detail cap — copy must use the full value
  await loadSingleField(page, rawValue, "file:///copy-field.csv");

  const dt = page.locator("tr.detail-row").first().locator("dt").first();
  const copyBtn = dt.locator(".field-copy-btn");
  await expect(copyBtn).toHaveAttribute("aria-label", "Copy field value");
  await expect(copyBtn.locator(".codicon")).toHaveClass(/codicon-copy/);

  await copyBtn.click();
  const copied = await page.evaluate(() => (window as unknown as { __copied?: string }).__copied);
  expect(copied).toBe(rawValue);
  await expect(copyBtn.locator(".codicon")).toHaveClass(/codicon-check/);
  await expect(copyBtn.locator(".codicon")).toHaveClass(/codicon-copy/, { timeout: 2000 });
});

// ---- G. Copy Row as CSV / JSON ----------------------------------------------

test.describe("Copy Row as CSV / Copy Row as JSON", () => {
  async function stubClipboard(page: Page): Promise<void> {
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: (text: string) => {
            (window as unknown as { __copied?: string }).__copied = text;
            return Promise.resolve();
          },
        },
        configurable: true,
      });
    });
  }

  test("Copy Row as CSV produces one properly-quoted RFC 4180 line, all columns, file order", async ({ page }) => {
    await stubClipboard(page);
    const headers = ["id", "note", "tags"];
    const rows = [["1", 'has, comma and "quote" and\nnewline', "a;b"]];
    const text = toCsvText(headers, rows);
    await bootAndLoadText(page, { fileKey: "file:///csvrow.csv", text, state: defaultViewState(), defaultTableColumns: 3 });

    await page.locator("tr.data-row").first().locator("td").nth(1).click({ button: "right" });
    await page.locator("#context-menu button", { hasText: "Copy Row as CSV" }).click();
    const copied = await page.evaluate(() => (window as unknown as { __copied?: string }).__copied);
    expect(copied).toBe('1,"has, comma and ""quote"" and\nnewline",a;b');
  });

  test("Copy Row as JSON produces an object keyed by header, all columns, 2-space indent", async ({ page }) => {
    await stubClipboard(page);
    const headers = ["id", "note"];
    const rows = [["1", 'has "quotes" and, commas']];
    const text = toCsvText(headers, rows);
    await bootAndLoadText(page, { fileKey: "file:///jsonrow.csv", text, state: defaultViewState(), defaultTableColumns: 2 });

    await page.locator("tr.data-row").first().locator("td").nth(1).click({ button: "right" });
    await page.locator("#context-menu button", { hasText: "Copy Row as JSON" }).click();
    const copied = await page.evaluate(() => (window as unknown as { __copied?: string }).__copied);
    expect(copied).toBe(JSON.stringify({ id: "1", note: 'has "quotes" and, commas' }, null, 2));
  });

  test("Copy Row as JSON keeps a column literally named __proto__", async ({ page }) => {
    await stubClipboard(page);
    const text = toCsvText(["id", "__proto__"], [["1", "kept"]]);
    await bootAndLoadText(page, { fileKey: "file:///protorow.csv", text, state: defaultViewState(), defaultTableColumns: 2 });

    await page.locator("tr.data-row").first().locator("td").nth(1).click({ button: "right" });
    await page.locator("#context-menu button", { hasText: "Copy Row as JSON" }).click();
    const copied = await page.evaluate(() => (window as unknown as { __copied?: string }).__copied);
    expect(copied).toBe('{\n  "id": "1",\n  "__proto__": "kept"\n}');
  });

  test("Copy Row as CSV/JSON cover every column, including ones hidden in the table", async ({ page }) => {
    await stubClipboard(page);
    await bootAndLoad(page, {
      fileKey: "file:///hiddencols.csv",
      headers: smallFixture.headers,
      rows: smallFixture.rows,
      state: defaultViewState(),
      defaultTableColumns: 2, // age/city detail-only
    });
    await page.locator("tr.data-row").first().locator("td").nth(1).click({ button: "right" });
    await page.locator("#context-menu button", { hasText: "Copy Row as CSV" }).click();
    expect(await page.evaluate(() => (window as unknown as { __copied?: string }).__copied)).toBe("1,Alice,30,NYC");

    await page.locator("tr.data-row").first().locator("td").nth(1).click({ button: "right" });
    await page.locator("#context-menu button", { hasText: "Copy Row as JSON" }).click();
    expect(await page.evaluate(() => (window as unknown as { __copied?: string }).__copied)).toBe(
      JSON.stringify({ id: "1", name: "Alice", age: "30", city: "NYC" }, null, 2),
    );
  });
});

// ---- H. Full keyboard walkthrough ------------------------------------------

test.describe("row keyboard model", () => {
  test.beforeEach(async ({ page }) => {
    await bootAndLoad(page, {
      fileKey: "file:///kbdrows.csv",
      headers: smallFixture.headers,
      rows: smallFixture.rows,
      state: defaultViewState(),
      defaultTableColumns: 4,
    });
  });

  test("Tab reaches exactly one row (tabindex 0), arrows move between rows, Home/End jump, →/← expand/collapse, Enter toggles", async ({
    page,
  }) => {
    const rows = page.locator("tr.data-row");
    await expect(rows).toHaveCount(5);

    // The twisty is out of the Tab order — clicking it still works (see
    // uxFixes.spec.ts), but sequential Tab must land on the row itself.
    await expect(rows.first()).toHaveAttribute("tabindex", "0");
    for (const i of [1, 2, 3, 4]) await expect(rows.nth(i)).toHaveAttribute("tabindex", "-1");

    // Tab from the last toolbar control: it passes through the (sortable)
    // column header buttons — owned by a parallel agent, so this doesn't
    // assume how many there are — and should land on a row once it gets
    // there, never skip past every row.
    await page.locator("#open-as-text-btn").focus();
    let reachedRow = false;
    for (let i = 0; i < 20 && !reachedRow; i++) {
      await page.keyboard.press("Tab");
      reachedRow = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.classList.contains("data-row") ?? false);
    }
    expect(reachedRow).toBe(true);
    await expect(rows.first()).toBeFocused();

    await page.keyboard.press("ArrowDown");
    await expect(rows.nth(1)).toBeFocused();
    await expect(rows.nth(1)).toHaveAttribute("tabindex", "0");
    await expect(rows.first()).toHaveAttribute("tabindex", "-1");

    await page.keyboard.press("ArrowDown");
    await expect(rows.nth(2)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(rows.nth(1)).toBeFocused();

    await page.keyboard.press("End");
    await expect(rows.last()).toBeFocused();
    await page.keyboard.press("Home");
    await expect(rows.first()).toBeFocused();

    // →/← expand/collapse; Enter toggles too.
    const detail = page.locator("tr.detail-row").first();
    await expect(detail).toBeHidden();
    await expect(rows.first()).toHaveAttribute("aria-expanded", "false");

    await page.keyboard.press("ArrowRight");
    await expect(detail).toBeVisible();
    await expect(rows.first()).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("ArrowRight"); // already expanded — no-op, stays expanded
    await expect(detail).toBeVisible();

    await page.keyboard.press("ArrowLeft");
    await expect(detail).toBeHidden();
    await expect(rows.first()).toHaveAttribute("aria-expanded", "false");

    await page.keyboard.press("Enter");
    await expect(detail).toBeVisible();
    await page.keyboard.press(" ");
    await expect(detail).toBeHidden();
  });

  test("Shift+F10 opens the row context menu with only the two Copy Row items; arrow keys and Enter work inside it; Escape returns focus to the row", async ({
    page,
  }) => {
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: (text: string) => {
            (window as unknown as { __copied?: string }).__copied = text;
            return Promise.resolve();
          },
        },
        configurable: true,
      });
    });

    const row = page.locator("tr.data-row").first();
    await row.focus();
    await page.keyboard.press("Shift+F10");

    const menu = page.locator("#context-menu");
    await expect(menu).toBeVisible();
    const items = menu.locator("button");
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toHaveText("Copy Row as CSV");
    await expect(items.nth(1)).toHaveText("Copy Row as JSON");
    await expect(items.nth(0)).toBeFocused();

    await page.keyboard.press("ArrowDown");
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press("ArrowDown"); // wraps back to the first item
    await expect(items.nth(0)).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(row).toBeFocused();

    // The ContextMenu key does the same thing.
    await page.keyboard.press("ContextMenu");
    await expect(menu).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press("Enter");
    const copied = await page.evaluate(() => (window as unknown as { __copied?: string }).__copied);
    expect(copied).toBe(JSON.stringify({ id: "1", name: "Alice", age: "30", city: "NYC" }, null, 2));
  });

  test("focus moves to the first row after a re-render only if a row had focus before; typing in an input never steals focus", async ({
    page,
  }) => {
    // A dedicated load with pageSize: 25 (the smallest valid preset — see
    // core/paging.ts's PAGE_SIZES) and 30 rows, so there are two pages —
    // instead of the shared beforeEach's defaults. Alt+→/← is a
    // document-level keydown shortcut (see main.ts), not a click, so
    // it's the one re-render trigger that doesn't focus some OTHER
    // control first the way clicking a header or the pager legitimately
    // does.
    const fixture = wideFixture(30, 4);
    await bootAndLoad(page, {
      fileKey: "file:///kbdrows-paged.csv",
      headers: fixture.headers,
      rows: fixture.rows,
      state: defaultViewState({ pageSize: 25 }),
      defaultTableColumns: 4,
    });
    const rows = page.locator("tr.data-row");
    await rows.nth(1).focus();
    await expect(rows.nth(1)).toBeFocused();

    await page.keyboard.press("Alt+ArrowRight");
    await expect(page.locator("#pager-page-input")).toHaveValue("2");
    await expect(page.locator("tr.data-row").first()).toBeFocused();
    await expect(page.locator("tr.data-row").first()).toHaveAttribute("tabindex", "0");

    // Now focus an input (quick search) and trigger another re-render —
    // focus must stay in the input, never get pulled to a row.
    await page.locator("#quick-search").fill("v25"); // matches exactly row 25's cells
    await expect(page.locator("#quick-search")).toBeFocused();
    await expect(page.locator("#status-bar")).toHaveText("Showing 1 of 30 rows");
    await expect(page.locator("#quick-search")).toBeFocused(); // still, after the re-render
  });
});

test("a 250-row file's roving tabindex and focus survive paging via the pager button (which itself takes focus, same as any other clicked control)", async ({
  page,
}) => {
  const fixture = wideFixture(250, 4);
  await bootAndLoad(page, {
    fileKey: "file:///kbdpaging.csv",
    headers: fixture.headers,
    rows: fixture.rows,
    state: defaultViewState(),
    defaultTableColumns: 4,
  });
  const rows = page.locator("tr.data-row");
  await rows.nth(3).focus();
  // Clicking the pager button focuses the BUTTON (ordinary browser
  // behavior for any clicked focusable control) — the roving tabindex
  // still moves to the new page's first row even though focus itself
  // isn't pulled there, so Tab/Shift+Tab from the button reaches it.
  await page.locator("#pager-next-btn").click();
  await expect(page.locator("tr.data-row").first()).toHaveAttribute("tabindex", "0");
  await expect(page.locator("tr.data-row").nth(1)).toHaveAttribute("tabindex", "-1");

  // Alt+→ instead (no intervening click) DOES keep focus on a row.
  await rows.nth(2).focus();
  await page.keyboard.press("Alt+ArrowRight");
  await expect(page.locator("tr.data-row").first()).toBeFocused();
});
