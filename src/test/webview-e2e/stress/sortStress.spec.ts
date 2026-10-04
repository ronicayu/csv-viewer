import { expect, test } from "@playwright/test";
import { bootAndLoad, bootAndLoadText, defaultViewState } from "../harness";
import { trackConsoleErrors, wideFixture } from "./stressHelpers";

test("rapid repeated clicks on the same header cycle asc/desc/none without desync or console errors", async ({ page }) => {
  const consoleErrors = trackConsoleErrors(page);
  const fixture = wideFixture(30, 4);
  await bootAndLoad(page, {
    fileKey: "file:///rapidsort.csv",
    headers: fixture.headers,
    rows: fixture.rows,
    state: defaultViewState(),
    defaultTableColumns: 4,
  });

  const header = page.locator("th", { hasText: "col_2" });
  // No `force`: headers are rebuilt on each render, and a forced click can hit the detached old <th>.
  for (let i = 0; i < 9; i++) await header.click({ delay: 0 });

  await expect(header).toHaveAttribute("aria-sort", "none");
  await expect(header.locator(".sort-indicator")).toHaveCount(0);
  await expect(page.locator("#sort-btn")).toHaveText("Sort");
  expect(consoleErrors).toEqual([]);
});

test("shift-clicking 5 different headers builds a 5-key multi-sort with priority indicators 1-5", async ({ page }) => {
  const fixture = wideFixture(40, 6);
  await bootAndLoad(page, {
    fileKey: "file:///5key.csv",
    headers: fixture.headers,
    rows: fixture.rows,
    state: defaultViewState(),
    defaultTableColumns: 6,
  });

  const columns = ["col_1", "col_2", "col_3", "col_4", "col_5"];
  await page.locator("th", { hasText: columns[0] }).click();
  for (const col of columns.slice(1)) {
    await page.locator("th", { hasText: col }).click({ modifiers: ["Shift"] });
  }

  for (let i = 0; i < columns.length; i++) {
    const header = page.locator("th", { hasText: columns[i] });
    await expect(header).toHaveAttribute("aria-sort", "ascending");
    await expect(header.locator(".sort-priority")).toHaveText(String(i + 1));
  }
  await expect(page.locator("#sort-btn")).toHaveText("Sort • 5");
  await page.locator("#sort-btn").click();
  await expect(page.locator(".sort-key-row")).toHaveCount(5);
});

test("the Sort popover's 'Add sort column' replaces an existing header-driven multi-sort is NOT how it works — it ADDS a key, and the direction toggle flips just that key", async ({
  page,
}) => {
  const fixture = wideFixture(30, 4);
  await bootAndLoad(page, {
    fileKey: "file:///dropdown-vs-headers.csv",
    headers: fixture.headers,
    rows: fixture.rows,
    state: defaultViewState(),
    defaultTableColumns: 4,
  });

  await page.locator("th", { hasText: "col_1" }).click();
  await page.locator("th", { hasText: "col_2" }).click({ modifiers: ["Shift"] });
  await expect(page.locator("th", { hasText: "col_1" })).toHaveAttribute("aria-sort", "ascending");
  await expect(page.locator("th", { hasText: "col_1" }).locator(".sort-priority")).toHaveText("1");
  await expect(page.locator("th", { hasText: "col_2" })).toHaveAttribute("aria-sort", "ascending");
  await expect(page.locator("th", { hasText: "col_2" }).locator(".sort-priority")).toHaveText("2");

  await page.locator("#sort-btn").click();
  await page.locator("#sort-add-select").selectOption("col_3");
  await expect(page.locator("th", { hasText: "col_1" })).toHaveAttribute("aria-sort", "ascending");
  await expect(page.locator("th", { hasText: "col_2" })).toHaveAttribute("aria-sort", "ascending");
  await expect(page.locator("th", { hasText: "col_3" })).toHaveAttribute("aria-sort", "ascending");
  await expect(page.locator("th", { hasText: "col_3" }).locator(".sort-priority")).toHaveText("3");

  const col3Row = page.locator(".sort-key-row").nth(2);
  await expect(col3Row.locator(".sort-key-column")).toHaveText("col_3");
  await col3Row.locator(".sort-key-dir-btn").click();
  await expect(page.locator("th", { hasText: "col_3" })).toHaveAttribute("aria-sort", "descending");
  await expect(page.locator("th", { hasText: "col_1" })).toHaveAttribute("aria-sort", "ascending");
});

test("Clear sort removes every key at once, including ones built via header Shift+click", async ({ page }) => {
  const fixture = wideFixture(30, 4);
  await bootAndLoad(page, {
    fileKey: "file:///clearsort.csv",
    headers: fixture.headers,
    rows: fixture.rows,
    state: defaultViewState(),
    defaultTableColumns: 4,
  });

  await page.locator("th", { hasText: "col_1" }).click();
  await page.locator("th", { hasText: "col_2" }).click({ modifiers: ["Shift"] });
  await page.locator("#sort-btn").click();
  await page.locator("#sort-clear-btn").click();

  await expect(page.locator("th", { hasText: "col_1" })).toHaveAttribute("aria-sort", "none");
  await expect(page.locator("th", { hasText: "col_2" })).toHaveAttribute("aria-sort", "none");
  await expect(page.locator("#sort-btn")).toHaveText("Sort");
});

test("a sort key pointing at a column removed by a separator change is inert (documented behavior), not a crash", async ({
  page,
}) => {
  const consoleErrors = trackConsoleErrors(page);
  const text = "id,age,city\n1,30,NYC\n2,20,LA\n3,40,SF";
  await bootAndLoadText(page, {
    fileKey: "file:///sort-then-sep.csv",
    text,
    state: defaultViewState(),
    defaultTableColumns: 3,
  });

  await page.locator("th", { hasText: "age" }).click();
  await expect(page.locator("th", { hasText: "age" })).toHaveAttribute("aria-sort", "ascending");

  await page.locator("#format-btn").click();
  await page.locator("#separator-select").selectOption("|");
  await expect(page.locator("th.sortable")).toHaveCount(1);
  await expect(page.locator(".sort-indicator")).toHaveCount(0);
  const firstCellText = await page.locator("tr.data-row").first().locator("td").nth(1).textContent();
  expect(firstCellText).toContain("1,30,NYC");
  expect(consoleErrors).toEqual([]);
});
