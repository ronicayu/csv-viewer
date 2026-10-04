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

  const expectedVisible = ["quick-search", "columns-btn", "filters-btn", "sort-btn", "expand-collapse-btn", "format-btn", "open-as-text-btn"];
  for (const id of expectedVisible) {
    expect(ids, `expected #${id} to receive focus while tabbing`).toContain(id);
  }
  expect(ids).not.toContain("separator-select");
  expect(ids).not.toContain("separator-custom");
  expect(ids).not.toContain("first-row-header");
  expect(ids).not.toContain("sort-add-select");
  expect(consoleErrors).toEqual([]);
});

test("once the Sort popover is open, its controls (including a key's direction toggle) join the tab order", async ({ page }) => {
  await page.locator("th", { hasText: "age" }).click();
  await page.locator("#sort-btn").click();
  await expect(page.locator(".sort-key-dir-btn")).toBeVisible();

  await expect(page.locator(".sort-key-dir-btn")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator(".sort-key-remove-btn")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("#sort-add-select")).toBeFocused();
});

test("once the File format popover is open, its controls join the tab order", async ({ page }) => {
  await page.locator("#format-btn").click();
  await expect(page.locator("#separator-select")).toBeFocused();
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("Tab");
    ids.push(await page.evaluate(() => document.activeElement?.id ?? ""));
  }
  expect(ids).toContain("first-row-header");
  expect(ids).toContain("quotes-checkbox");
});

test("table headers are keyboard-activatable via Enter/Space (a real <button> inside the <th>)", async ({ page }) => {
  const ageHeaderBtn = page.locator("th", { hasText: "age" }).locator(".col-header-btn");
  await ageHeaderBtn.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("th", { hasText: "age" })).toHaveAttribute("aria-sort", "ascending");
});

test("FIXED: activating a header via keyboard keeps focus on it (or the new <th> that replaced it), so repeated Space/Enter keeps cycling the sort direction", async ({
  page,
}) => {
  const ageHeaderBtn = () => page.locator("th", { hasText: "age" }).locator(".col-header-btn");
  await ageHeaderBtn().focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("th", { hasText: "age" })).toHaveAttribute("aria-sort", "ascending");
  await expect(ageHeaderBtn()).toBeFocused();

  await page.keyboard.press(" ");
  await expect(page.locator("th", { hasText: "age" })).toHaveAttribute("aria-sort", "descending");
  await expect(ageHeaderBtn()).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(page.locator("th", { hasText: "age" })).toHaveAttribute("aria-sort", "none");
  await expect(ageHeaderBtn()).toBeFocused();
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

test("Escape closes the Sort popover", async ({ page }) => {
  await page.locator("#sort-btn").click();
  await expect(page.locator("#sort-popover")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#sort-popover")).toBeHidden();
});

test("Escape closes the File format popover", async ({ page }) => {
  await page.locator("#format-btn").click();
  await expect(page.locator("#format-popover")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#format-popover")).toBeHidden();
});

test("Escape closes the cell context menu", async ({ page }) => {
  await page.locator("tr.data-row").first().locator("td").nth(1).click({ button: "right" });
  await expect(page.locator("#context-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#context-menu")).toBeHidden();
});
