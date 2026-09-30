// Expand/detail edge cases: does the right row stay expanded (and its
// chevron stay in sync) across sort/filter/page changes; does "Expand page"
// survive a page-size change; and does the detail panel handle a 100 KB
// cell and multi-line cells without truncation or mangling.

import { expect, test } from "@playwright/test";
import { bootAndLoad, bootAndLoadText, defaultViewState } from "../harness";
import { toCsvText, trackConsoleErrors, wideFixture } from "./stressHelpers";

test("an expanded row stays expanded (and its chevron stays ▼) after sorting, filtering, and paging away and back", async ({
  page,
}) => {
  const consoleErrors = trackConsoleErrors(page);
  const fixture = wideFixture(250, 5);
  await bootAndLoad(page, {
    fileKey: "file:///expand-sort.csv",
    headers: fixture.headers,
    rows: fixture.rows,
    state: defaultViewState(),
    defaultTableColumns: 3, // col_4/col_5 detail-only
  });

  // Expand the row for id=0 (col_1 value "0"), currently first on page 1.
  // Rows carry their stable row id as a data attribute, which is a much
  // more robust selector than matching rendered text.
  const targetRow = page.locator('tr.data-row[data-row-id="0"]');
  await targetRow.click();
  await expect(targetRow.locator(".chevron")).toHaveText("▼");
  await expect(targetRow.locator("+ tr.detail-row")).toBeVisible();

  // Sort descending by col_1 (a header click cycles asc then desc) — the
  // id=0 row moves from first to last-in-dataset, likely a different page.
  await page.locator("th", { hasText: "col_1" }).click();
  await page.locator("th", { hasText: "col_1" }).click();
  await page.locator("#pager-last-btn").click();

  const rowAfterSort = page.locator("tr.data-row").last();
  await expect(rowAfterSort).toHaveAttribute("data-row-id", "0"); // the id=0 row, now last
  await expect(rowAfterSort.locator(".chevron")).toHaveText("▼");
  await expect(rowAfterSort.locator("+ tr.detail-row")).toBeVisible();

  // Filter down to just that row, then back out to everything — still
  // expanded either way.
  await page.locator("#quick-search").fill("v0_3"); // col_4 value unique to row 0
  await expect(page.locator("#status-bar")).toHaveText("Showing 1 of 250 rows");
  const onlyRow = page.locator("tr.data-row").first();
  await expect(onlyRow.locator(".chevron")).toHaveText("▼");

  await page.locator("#quick-search").fill("");
  await expect(page.locator("#status-bar")).toHaveText("Showing 250 of 250 rows");
  expect(consoleErrors).toEqual([]);
});

test("Expand page followed by a page-size change keeps the previously-expanded rows expanded on their new pages", async ({
  page,
}) => {
  const fixture = wideFixture(150, 4);
  await bootAndLoad(page, {
    fileKey: "file:///expand-pagesize.csv",
    headers: fixture.headers,
    rows: fixture.rows,
    state: defaultViewState({ pageSize: 100 }),
    defaultTableColumns: 4,
  });

  await page.locator("#expand-all-btn").click(); // "Expand page" — rows 0-99 (ids 0-99)
  await expect(page.locator("tr.detail-row:visible")).toHaveCount(100);

  // Shrink the page size to 50: page 1 now covers ids 0-49 (still expanded,
  // since expansion is keyed by row id, not position).
  await page.locator("#pager-page-size-select").selectOption("50");
  await expect(page.locator("tr.data-row")).toHaveCount(50);
  await expect(page.locator("tr.detail-row:visible")).toHaveCount(50);

  // Page 2 (ids 50-99) was also expanded by the original "Expand page" —
  // confirm it's still expanded even though it was never the active page
  // when that button was clicked.
  await page.locator("#pager-next-btn").click();
  await expect(page.locator("tr.detail-row:visible")).toHaveCount(50);

  // Page 3 (ids 100-149) was never touched by "Expand page" and must stay
  // collapsed.
  await page.locator("#pager-next-btn").click();
  await expect(page.locator("tr.detail-row:visible")).toHaveCount(0);
});

test("a 100 KB cell in the detail panel is truncated to 10,000 characters with a 'Show all' button, which expands it in place", async ({
  page,
}) => {
  // Decision: the detail view renders at most 10,000 characters plus a
  // "Show all (N characters)" button (see docs/spec.md, "Huge cells") —
  // a 15 MB single-line cell used to be rendered in full and trip VS
  // Code's unresponsive-webview watchdog. Table cells truncate to 500
  // characters; the detail view's higher cap is exercised here.
  const bigValue = "x".repeat(100_000);
  const text = toCsvText(["id", "big", "note"], [["1", bigValue, "n"]]);
  await bootAndLoadText(page, {
    fileKey: "file:///bigcell.csv",
    text,
    state: defaultViewState(),
    defaultTableColumns: 1, // "big" and "note" are detail-only
  });

  await page.locator("tr.data-row").first().click();
  const dd = page.locator("tr.detail-row").first().locator("dd").first();

  const initialLength = await dd.evaluate((el) => (el.childNodes[0]?.textContent ?? "").length);
  expect(initialLength).toBe(10_001); // 10,000 chars + the "…" marker

  const showAllBtn = dd.locator(".show-all-btn");
  await expect(showAllBtn).toHaveText("Show all (100000 characters)");

  await showAllBtn.click();
  const fullLength = await dd.evaluate((el) => el.textContent?.length ?? 0);
  expect(fullLength).toBe(100_000);
  await expect(showAllBtn).toHaveCount(0); // expands in place, button removed
});

test("multi-line cell values preserve their newlines in the detail panel (CSS pre-wrap, not literal collapsing)", async ({
  page,
}) => {
  const multiline = "line one\nline two\nline three";
  const text = toCsvText(["id", "notes"], [["1", multiline]]);
  await bootAndLoadText(page, {
    fileKey: "file:///multiline.csv",
    text,
    state: defaultViewState(),
    defaultTableColumns: 1,
  });

  await page.locator("tr.data-row").first().click();
  const dd = page.locator("tr.detail-row").first().locator("dd").first();
  const raw = await dd.evaluate((el) => el.textContent ?? "");
  expect(raw).toBe(multiline);

  // The CSS actually renders it on 3 visual lines (white-space: pre-wrap),
  // not a single collapsed line — sanity check via client rect height
  // vs. a single-line sibling.
  const box = await dd.boundingBox();
  expect(box).not.toBeNull();
  const lineHeightGuess = await page.locator("tr.detail-row dd").first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize) * 1.2);
  expect(box!.height).toBeGreaterThan(lineHeightGuess * 2); // at least ~3 lines tall
});

test("a huge table cell renders truncated to 500 characters, but right-click quick-add still uses the full value", async ({ page }) => {
  // Table cells render at most 500 characters (+ "…") — a 15 MB
  // single-line cell used to freeze rendering entirely. The worker
  // always returns the FULL cell value; only rendering into the <td>
  // truncates, so quick-add (which needs the real value to build an
  // "equals" rule) is unaffected.
  const bigValue = "y".repeat(5000);
  const text = toCsvText(["id", "big"], [["1", bigValue]]);
  await bootAndLoadText(page, {
    fileKey: "file:///bigtablecell.csv",
    text,
    state: defaultViewState(),
    defaultTableColumns: 2, // "big" visible in the table
  });

  const cell = page.locator("tr.data-row").first().locator("td").nth(2); // chevron, id, big
  const cellText = await cell.evaluate((el) => el.textContent ?? "");
  expect(cellText).toBe("y".repeat(500) + "…");
  expect(cellText.length).toBe(501);

  await cell.click({ button: "right" });
  await page.locator("#context-menu button", { hasText: "include this value" }).click();
  const rule = page.locator(".rule-row").first();
  await expect(rule.locator('input[type="text"]')).toHaveValue(bigValue); // full value, not the truncated display text
  await expect(page.locator("#status-bar")).toHaveText("Showing 1 of 1 rows");
});

test("the detail view's 'Show all' button warns in its title above 1 MB", async ({ page }) => {
  const hugeValue = "z".repeat(1024 * 1024 + 1);
  const smallValue = "s".repeat(50_000); // truncated (> 10,000) but well under the 1 MB warn threshold
  const text = toCsvText(["id", "huge", "small"], [["1", hugeValue, smallValue]]);
  await bootAndLoadText(page, {
    fileKey: "file:///hugecell.csv",
    text,
    state: defaultViewState(),
    defaultTableColumns: 1, // "huge"/"small" detail-only
  });

  await page.locator("tr.data-row").first().click();
  const detail = page.locator("tr.detail-row").first();

  const hugeBtn = detail.locator("dd").nth(0).locator(".show-all-btn");
  await expect(hugeBtn).toHaveAttribute("title", /may be slow/);

  const smallBtn = detail.locator("dd").nth(1).locator(".show-all-btn");
  await expect(smallBtn).toHaveCount(1);
  expect(await smallBtn.getAttribute("title")).toBeFalsy();
});
