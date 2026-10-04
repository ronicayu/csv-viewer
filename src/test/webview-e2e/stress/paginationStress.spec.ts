import { expect, test } from "@playwright/test";
import { bootAndLoad, defaultViewState, pushLoad } from "../harness";
import { trackConsoleErrors, wideFixture } from "./stressHelpers";

const fixture = wideFixture(250, 4);

test.beforeEach(async ({ page }) => {
  await bootAndLoad(page, {
    fileKey: "file:///pagestress.csv",
    headers: fixture.headers,
    rows: fixture.rows,
    state: defaultViewState(),
    defaultTableColumns: 4,
  });
});

async function commit(page: import("@playwright/test").Page, value: string): Promise<void> {
  const input = page.locator("#pager-page-input");
  await input.fill(value);
  await input.press("Enter");
}

test("page input '0' clamps up to page 1", async ({ page }) => {
  await page.locator("#pager-next-btn").click();
  await commit(page, "0");
  await expect(page.locator("#pager-page-input")).toHaveValue("1");
});

test("page input '-1' clamps up to page 1", async ({ page }) => {
  await page.locator("#pager-next-btn").click();
  await commit(page, "-1");
  await expect(page.locator("#pager-page-input")).toHaveValue("1");
});

test("page input '1e9' clamps down to the last page without hanging or erroring", async ({ page }) => {
  const consoleErrors = trackConsoleErrors(page);
  await commit(page, "1e9");
  await expect(page.locator("#pager-page-input")).toHaveValue("3");
  expect(consoleErrors).toEqual([]);
});

test("page input 'abc' can't actually be typed (native type=number input rejects it outright), and forcing it in normalizes to empty and is rejected the same way as a blank input", async ({
  page,
}) => {
  await page.locator("#pager-next-btn").click();
  await expect(page.locator("#pager-page-input")).toHaveValue("2");

  await expect(async () => {
    await page.locator("#pager-page-input").fill("abc");
  }).rejects.toThrow();

  const input = page.locator("#pager-page-input");
  const normalized = await input.evaluate((el: HTMLInputElement) => {
    el.value = "abc";
    return el.value;
  });
  expect(normalized).toBe("");
  await input.press("Enter");
  await expect(input).toHaveValue("2");
});

test("page input '2.7' truncates (not rounds) to page 2", async ({ page }) => {
  await commit(page, "2.7");
  await expect(page.locator("#pager-page-input")).toHaveValue("2");
  await expect(page.locator("#pager-row-range")).toHaveText("101–200 of 250 rows");
});

test("page input left empty then blurred restores the current page", async ({ page }) => {
  await page.locator("#pager-last-btn").click();
  await expect(page.locator("#pager-page-input")).toHaveValue("3");

  const input = page.locator("#pager-page-input");
  await input.fill("");
  await input.blur();
  await expect(input).toHaveValue("3");
});

test("Alt+ArrowRight changes pages when focus is on a button (only form controls are exempted)", async ({ page }) => {
  await page.locator("#pager-next-btn").focus();
  await page.keyboard.press("Alt+ArrowRight");
  await expect(page.locator("#pager-page-input")).toHaveValue("2");
});

test("Alt+ArrowRight is ignored when focus is on the page-number input itself", async ({ page }) => {
  await page.locator("#pager-page-input").focus();
  await page.keyboard.press("Alt+ArrowRight");
  await expect(page.locator("#pager-page-input")).toHaveValue("1");
});

test("changing the page size while on the last page keeps the first-visible row in view", async ({ page }) => {
  await page.locator("#pager-last-btn").click();
  await expect(page.locator("#pager-page-input")).toHaveValue("3");
  await page.locator("#pager-page-size-select").selectOption("50");

  await expect(page.locator("#pager-page-input")).toHaveValue("5");
  await expect(page.locator("#pager-page-count")).toHaveText("5");
  await expect(page.locator("tr.data-row")).toHaveCount(50);
});

test("filtering down to 0 rows disables every nav control, and clearing the filter recovers to page 1 with everything re-enabled", async ({
  page,
}) => {
  await page.locator("#pager-next-btn").click();
  await expect(page.locator("#pager-page-input")).toHaveValue("2");

  await page.locator("#quick-search").fill("zzz-nothing-matches-zzz");
  await expect(page.locator("#pager-row-range")).toHaveText("0 rows (filtered from 250)");
  for (const id of ["#pager-first-btn", "#pager-prev-btn", "#pager-next-btn", "#pager-last-btn", "#pager-page-input"]) {
    await expect(page.locator(id)).toBeDisabled();
  }

  await page.locator("#quick-search").fill("");
  await expect(page.locator("#pager-page-input")).toHaveValue("1");
  for (const id of ["#pager-next-btn", "#pager-last-btn"]) {
    await expect(page.locator(id)).toBeEnabled();
  }
  await expect(page.locator("tr.data-row")).toHaveCount(100);
});

test("a render landing while the user is typing a page number doesn't overwrite what they typed", async ({ page }) => {
  // Re-render between fill and Enter to reproduce the race deterministically.
  const input = page.locator("#pager-page-input");
  await input.fill("3");
  await pushLoad(page, {
    fileKey: "file:///pagestress.csv",
    headers: fixture.headers,
    rows: fixture.rows,
    state: defaultViewState(),
    defaultTableColumns: 4,
  });
  await expect(page.locator("#status-bar")).toHaveText("Showing 250 of 250 rows");
  await expect(input).toHaveValue("3");
  await input.press("Enter");
  await expect(page.locator("#pager-row-range")).toHaveText("201–250 of 250 rows");
});
