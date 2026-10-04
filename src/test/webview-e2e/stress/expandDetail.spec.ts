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
    defaultTableColumns: 3,
  });

  const targetRow = page.locator('tr.data-row[data-row-id="0"]');
  await targetRow.click();
  await expect(targetRow.locator(".twisty")).toHaveAttribute("aria-expanded", "true");
  await expect(targetRow.locator("+ tr.detail-row")).toBeVisible();

  await page.locator("th", { hasText: "col_1" }).click();
  await page.locator("th", { hasText: "col_1" }).click();
  await page.locator("#pager-last-btn").click();

  const rowAfterSort = page.locator("tr.data-row").last();
  await expect(rowAfterSort).toHaveAttribute("data-row-id", "0");
  await expect(rowAfterSort.locator(".twisty")).toHaveAttribute("aria-expanded", "true");
  await expect(rowAfterSort.locator("+ tr.detail-row")).toBeVisible();

  await page.locator("#quick-search").fill("v0_3");
  await expect(page.locator("#status-bar")).toHaveText("Showing 1 of 250 rows");
  const onlyRow = page.locator("tr.data-row").first();
  await expect(onlyRow.locator(".twisty")).toHaveAttribute("aria-expanded", "true");

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

  await page.locator("#expand-collapse-btn").click();
  await expect(page.locator("tr.detail-row:visible")).toHaveCount(100);

  await page.locator("#pager-page-size-select").selectOption("50");
  await expect(page.locator("tr.data-row")).toHaveCount(50);
  await expect(page.locator("tr.detail-row:visible")).toHaveCount(50);

  await page.locator("#pager-next-btn").click();
  await expect(page.locator("tr.detail-row:visible")).toHaveCount(50);

  await page.locator("#pager-next-btn").click();
  await expect(page.locator("tr.detail-row:visible")).toHaveCount(0);
});

test("a 100 KB cell in the detail panel is truncated to 10,000 characters with a 'Show all' button, which expands it in place and gains a 'Show less' counterpart", async ({
  page,
}) => {
  const bigValue = "x".repeat(100_000);
  const text = toCsvText(["id", "big", "note"], [["1", bigValue, "n"]]);
  await bootAndLoadText(page, {
    fileKey: "file:///bigcell.csv",
    text,
    state: defaultViewState(),
    defaultTableColumns: 1,
  });

  await page.locator("tr.data-row").first().click();
  const dd = page.locator("tr.detail-row").first().locator("dd").first();
  const valueText = dd.locator(".detail-value-text");

  const initialLength = await valueText.evaluate((el) => el.textContent?.length ?? 0);
  expect(initialLength).toBe(10_001);

  const showAllBtn = dd.locator(".show-all-btn");
  await expect(showAllBtn).toHaveText("Show all (100,000 characters)");

  await showAllBtn.click();
  const fullLength = await valueText.evaluate((el) => el.textContent?.length ?? 0);
  expect(fullLength).toBe(100_000);
  await expect(showAllBtn).toHaveText("Show less");

  await showAllBtn.click();
  const collapsedAgainLength = await valueText.evaluate((el) => el.textContent?.length ?? 0);
  expect(collapsedAgainLength).toBe(10_001);
  await expect(showAllBtn).toHaveText("Show all (100,000 characters)");
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
  const raw = await dd.locator(".detail-value-text").evaluate((el) => el.textContent ?? "");
  expect(raw).toBe(multiline);

  const box = await dd.boundingBox();
  expect(box).not.toBeNull();
  const lineHeightGuess = await page.locator("tr.detail-row dd").first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize) * 1.2);
  expect(box!.height).toBeGreaterThan(lineHeightGuess * 2);
});

test("a huge table cell renders truncated to 500 characters, but right-click quick-add still uses the full value", async ({ page }) => {
  const bigValue = "y".repeat(5000);
  const text = toCsvText(["id", "big"], [["1", bigValue]]);
  await bootAndLoadText(page, {
    fileKey: "file:///bigtablecell.csv",
    text,
    // Forced into the table; the smart column split would otherwise move 'big' to row details.
    state: defaultViewState({ columnVisibility: { id: true, big: true } }),
    defaultTableColumns: 2,
  });

  const cell = page.locator("tr.data-row").first().locator("td").nth(2);
  const cellText = await cell.evaluate((el) => el.textContent ?? "");
  expect(cellText).toBe("y".repeat(500) + "…");
  expect(cellText.length).toBe(501);

  await cell.click({ button: "right" });
  await page.locator("#context-menu button", { hasText: /^Show only rows where/ }).click();
  const rule = page.locator(".rule-row").first();
  await expect(rule.locator('input[type="text"]')).toHaveValue(bigValue);
  await expect(page.locator("#status-bar")).toHaveText("Showing 1 of 1 rows");
});

test("the detail view's 'Show all' button warns in its title above 1 MB", async ({ page }) => {
  const hugeValue = "z".repeat(1024 * 1024 + 1);
  const smallValue = "s".repeat(50_000);
  const text = toCsvText(["id", "huge", "small"], [["1", hugeValue, smallValue]]);
  await bootAndLoadText(page, {
    fileKey: "file:///hugecell.csv",
    text,
    state: defaultViewState(),
    defaultTableColumns: 1,
  });

  await page.locator("tr.data-row").first().click();
  const detail = page.locator("tr.detail-row").first();

  const hugeBtn = detail.locator("dd").nth(0).locator(".show-all-btn");
  await expect(hugeBtn).toHaveAttribute("title", /may be slow/);

  const smallBtn = detail.locator("dd").nth(1).locator(".show-all-btn");
  await expect(smallBtn).toHaveCount(1);
  expect(await smallBtn.getAttribute("title")).toBeFalsy();
});
