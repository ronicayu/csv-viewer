// Sort stress: rapid header clicks, shift-click with 5 keys, the Sort-by
// dropdown/direction button interacting with header-driven multi-sort, and
// sort keys surviving (as documented, inert-if-stale) a separator change.

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
  // 9 rapid clicks, no waiting in between -> 9 mod 3 == 0 -> back to "none".
  for (let i = 0; i < 9; i++) await header.click({ delay: 0, force: true });

  await expect(header.locator(".sort-indicator")).toHaveCount(0);
  await expect(page.locator("#sort-by-select")).toHaveValue("");
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
  await page.locator("th", { hasText: columns[0] }).click(); // primary, no shift
  for (const col of columns.slice(1)) {
    await page.locator("th", { hasText: col }).click({ modifiers: ["Shift"] });
  }

  for (let i = 0; i < columns.length; i++) {
    const indicator = page.locator("th", { hasText: columns[i] }).locator(".sort-indicator");
    await expect(indicator).toHaveText(`▲${i + 1}`);
  }
});

test("the Sort by… dropdown replaces an existing header-driven multi-sort with a single key, and the direction button flips it", async ({
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
  await expect(page.locator("th", { hasText: "col_1" }).locator(".sort-indicator")).toHaveText("▲1");
  await expect(page.locator("th", { hasText: "col_2" }).locator(".sort-indicator")).toHaveText("▲2");

  await page.locator("#sort-by-select").selectOption("col_3");
  // Replaces the whole multi-sort with a single key on col_3 — the
  // priority indicators on col_1/col_2 disappear entirely.
  await expect(page.locator("th", { hasText: "col_1" }).locator(".sort-indicator")).toHaveCount(0);
  await expect(page.locator("th", { hasText: "col_2" }).locator(".sort-indicator")).toHaveCount(0);
  await expect(page.locator("th", { hasText: "col_3" }).locator(".sort-indicator")).toHaveText("▲");

  await page.locator("#sort-dir-btn").click();
  await expect(page.locator("th", { hasText: "col_3" }).locator(".sort-indicator")).toHaveText("▼");
  await expect(page.locator("#sort-by-select")).toHaveValue("col_3");
});

test("a sort key pointing at a column removed by a separator change is inert (documented behavior), not a crash", async ({
  page,
}) => {
  const consoleErrors = trackConsoleErrors(page);
  // Comma-delimited, 3 columns; sort by "age" first.
  const text = "id,age,city\n1,30,NYC\n2,20,LA\n3,40,SF";
  await bootAndLoadText(page, {
    fileKey: "file:///sort-then-sep.csv",
    text,
    state: defaultViewState(),
    defaultTableColumns: 3,
  });

  await page.locator("th", { hasText: "age" }).click();
  await expect(page.locator("th", { hasText: "age" }).locator(".sort-indicator")).toHaveText("▲");

  // Force the separator to "|" — nothing in the text contains "|", so the
  // whole line becomes a single column, collapsing "id,age,city" into one
  // header. The stale sort key {column:"age"} now matches no header.
  await page.locator("#separator-select").selectOption("|");
  await expect(page.locator("th.sortable")).toHaveCount(1);
  // No crash, no indicator anywhere (nothing named "age" exists anymore),
  // rows kept in their original relative order (sort silently no-ops).
  await expect(page.locator(".sort-indicator")).toHaveCount(0);
  const firstCellText = await page.locator("tr.data-row").first().locator("td").nth(1).textContent();
  expect(firstCellText).toContain("1,30,NYC");
  expect(consoleErrors).toEqual([]);
});
