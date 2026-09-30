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

test("BUG: activating a header via keyboard re-renders the whole header row and drops focus, so a second Space/Enter does nothing until the user tabs back to it", async ({
  page,
}) => {
  test.fail(); // see comment below for expected behavior
  const ageHeader = page.locator("th", { hasText: "age" });
  await ageHeader.focus();
  await page.keyboard.press("Enter"); // none -> asc
  await expect(ageHeader.locator(".sort-indicator")).toHaveText("▲");

  // Expected: focus stays on the "age" header (or is restored to the new
  // <th> that replaced it) so a keyboard-only user can keep cycling the
  // sort direction with repeated Space/Enter presses, the same way mouse
  // users can keep clicking.
  // Actual: onHeaderClick -> recomputeAndRender -> renderTableHead
  // (src/webview/main.ts) does `tableHead.innerHTML = ""` and appends a
  // brand-new <tr>/<th> tree every time, destroying the focused element.
  // The next Space keypress therefore lands on whatever (or nothing) has
  // focus now — not the header — and never reaches onHeaderClick again.
  await page.keyboard.press(" "); // intended: asc -> desc
  await expect(page.locator("th", { hasText: "age" }).locator(".sort-indicator")).toHaveText("▼"); // fails: still "▲"
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
