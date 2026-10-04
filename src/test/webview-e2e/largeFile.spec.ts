import { expect, test } from "@playwright/test";
import { bootAndLoad, defaultViewState } from "./harness";
import { largeFixture } from "./fixtures";

test.describe("pagination with a 20k-row fixture", () => {
  test.beforeEach(async ({ page }) => {
    const fixture = largeFixture(20_000);
    await bootAndLoad(page, {
      fileKey: "file:///big.csv",
      headers: fixture.headers,
      rows: fixture.rows,
      state: defaultViewState(),
      defaultTableColumns: 5,
    });
  });

  test("shows the first page of 100 rows at the default page size", async ({ page }) => {
    await expect(page.locator("#status-bar")).toHaveText("Showing 20,000 of 20,000 rows");
    await expect(page.locator("tr.data-row")).toHaveCount(100);
    await expect(page.locator("#pager-page-input")).toHaveValue("1");
    await expect(page.locator("#pager-page-count")).toHaveText("200");
    await expect(page.locator("#pager-row-range")).toHaveText("1–100 of 20,000 rows");
  });

  test("Next shows rows 101-200", async ({ page }) => {
    await page.locator("#pager-next-btn").click();
    await expect(page.locator("#pager-page-input")).toHaveValue("2");
    await expect(page.locator("#pager-row-range")).toHaveText("101–200 of 20,000 rows");
    await expect(page.locator("tr.data-row")).toHaveCount(100);
    await expect(page.locator("tr.data-row").first()).toContainText("Person 100");
  });

  test("Last jumps to page 200, the final page", async ({ page }) => {
    await page.locator("#pager-last-btn").click();
    await expect(page.locator("#pager-page-input")).toHaveValue("200");
    await expect(page.locator("#pager-row-range")).toHaveText("19,901–20,000 of 20,000 rows");
    await expect(page.locator("#pager-next-btn")).toBeDisabled();
    await expect(page.locator("#pager-last-btn")).toBeDisabled();
  });

  test("typing a page number into the jump input navigates there", async ({ page }) => {
    const input = page.locator("#pager-page-input");
    await input.fill("57");
    await input.press("Enter");
    await expect(page.locator("#pager-row-range")).toHaveText("5,601–5,700 of 20,000 rows");
  });

  test("changing the page size to 500 keeps the first visible row on screen and shows 'of 40'", async ({ page }) => {
    await page.locator("#pager-next-btn").click();
    await page.locator("#pager-page-size-select").selectOption("500");

    await expect(page.locator("#pager-page-count")).toHaveText("40");
    await expect(page.locator("tr.data-row")).toHaveCount(500);
    const names = await page.locator("tr.data-row").evaluateAll((rows) => rows.map((r) => r.textContent ?? ""));
    expect(names.some((t) => t.includes("Person 100"))).toBe(true);
  });

  test("scrolling to the bottom of the table area does not append more rows", async ({ page }) => {
    await expect(page.locator("tr.data-row")).toHaveCount(100);
    await page.locator("#table-scroll").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(200);
    await expect(page.locator("tr.data-row")).toHaveCount(100);
    await expect(page.locator("#pager-page-input")).toHaveValue("1");
  });
});
