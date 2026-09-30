// Keyboard-only use: every toolbar/pager control must be reachable by Tab
// (respecting that hidden/disabled controls are legitimately skipped), and
// Escape must close every open popover/panel/context-menu.

import { expect, test } from "@playwright/test";
import { bootAndLoad, defaultViewState } from "../harness";
import { smallFixture } from "../fixtures";
import { trackConsoleErrors } from "./stressHelpers";

test.beforeEach(async ({ page }) => {
  await bootAndLoad(page, {
    fileKey: "file:///kbd.csv",
    headers: smallFixture.headers,
    rows: smallFixture.rows,
    state: defaultViewState(),
    defaultTableColumns: 4,
  });
});

async function tabSequence(page: import("@playwright/test").Page, presses: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press("Tab");
    const id = await page.evaluate(() => document.activeElement?.id ?? "");
    ids.push(id);
  }
  return ids;
}

test("every visible, enabled toolbar control is reachable via Tab, in DOM order", async ({ page }) => {
  const consoleErrors = trackConsoleErrors(page);
  const ids = await tabSequence(page, 20);

  // sort-dir-btn is `hidden` (no active sort) and pager-first/prev-btn are
  // `disabled` (already on page 1) — all three are correctly absent from
  // the tab order, not a bug.
  const expectedVisible = [
    "quick-search",
    "columns-btn",
    "filters-btn",
    "expand-all-btn",
    "collapse-all-btn",
    "sort-by-select",
    "first-row-header",
    "separator-select",
    "open-as-text-btn",
  ];
  for (const id of expectedVisible) {
    expect(ids, `expected #${id} to receive focus while tabbing`).toContain(id);
  }
  expect(ids).not.toContain("sort-dir-btn");
  expect(ids).not.toContain("separator-custom");
  expect(consoleErrors).toEqual([]);
});

test("once a sort is active, sort-dir-btn joins the tab order", async ({ page }) => {
  await page.locator("th", { hasText: "age" }).click();
  await expect(page.locator("#sort-dir-btn")).toBeVisible();
  const ids = await tabSequence(page, 20);
  expect(ids).toContain("sort-dir-btn");
});

test("table headers are keyboard-activatable via Enter/Space (role=button, tabindex=0)", async ({ page }) => {
  const ageHeader = page.locator("th", { hasText: "age" });
  await ageHeader.focus();
  await page.keyboard.press("Enter");
  await expect(ageHeader.locator(".sort-indicator")).toHaveText("▲");
});

test("FIXED: activating a header via keyboard keeps focus on it (or the new <th> that replaced it), so repeated Space/Enter keeps cycling the sort direction", async ({
  page,
}) => {
  // renderTableHead (src/webview/main.ts) still does `tableHead.innerHTML
  // = ""` and appends a brand-new <tr>/<th> tree on every render (now
  // after an async worker round-trip too), which used to destroy the
  // focused element outright. It now remembers which column's header had
  // focus (matched by label text, not DOM position, since a render can
  // also reorder/remove columns) and restores focus to the new <th> for
  // that same column once the tree is rebuilt.
  const ageHeader = page.locator("th", { hasText: "age" });
  await ageHeader.focus();
  await page.keyboard.press("Enter"); // none -> asc
  await expect(ageHeader.locator(".sort-indicator")).toHaveText("▲");
  await expect(page.locator("th", { hasText: "age" })).toBeFocused();

  await page.keyboard.press(" "); // asc -> desc
  await expect(page.locator("th", { hasText: "age" }).locator(".sort-indicator")).toHaveText("▼");
  await expect(page.locator("th", { hasText: "age" })).toBeFocused();

  await page.keyboard.press("Enter"); // desc -> none
  await expect(page.locator("th", { hasText: "age" }).locator(".sort-indicator")).toHaveCount(0);
  await expect(page.locator("th", { hasText: "age" })).toBeFocused();
});

test("Escape closes the columns popover", async ({ page }) => {
  await page.locator("#columns-btn").click();
  await expect(page.locator("#columns-popover")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#columns-popover")).toBeHidden();
});

test("Escape closes the filter panel", async ({ page }) => {
  await page.locator("#filters-btn").click();
  await expect(page.locator("#filter-panel")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#filter-panel")).toBeHidden();
});

test("Escape closes the cell context menu", async ({ page }) => {
  await page.locator("tr.data-row").first().locator("td").nth(1).click({ button: "right" });
  await expect(page.locator("#context-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#context-menu")).toBeHidden();
});
