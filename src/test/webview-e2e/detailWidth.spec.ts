import { expect, test, type Page } from "@playwright/test";
import { bootAndLoad, defaultViewState } from "./harness";
import { largeFixture } from "./fixtures";

// renderTableBody no longer measures the scroll container itself; the ResizeObserver keeps the detail rows' width in step with it.
const widths = (page: Page) =>
  page.locator("#table-scroll").evaluate((el) => ({ variable: el.style.getPropertyValue("--detail-viewport-w"), client: `${el.clientWidth}px` }));

test("the detail rows' viewport width follows the scroll container through renders and resizes", async ({ page }) => {
  const fixture = largeFixture(300);
  await bootAndLoad(page, { fileKey: "file:///wide.csv", headers: fixture.headers, rows: fixture.rows, state: defaultViewState(), defaultTableColumns: 3 });
  await expect(page.locator("tr.data-row")).toHaveCount(100);
  await expect.poll(async () => (await widths(page)).variable).toBe((await widths(page)).client);

  await page.locator("th.sortable").first().click();
  await expect(page.locator("th.sortable").first()).toHaveAttribute("aria-sort", "ascending");
  await expect.poll(async () => (await widths(page)).variable).toBe((await widths(page)).client);

  await page.setViewportSize({ width: 700, height: 500 });
  await expect.poll(async () => (await widths(page)).variable).toBe((await widths(page)).client);
  const narrow = (await widths(page)).client;
  await page.setViewportSize({ width: 1100, height: 500 });
  await expect.poll(async () => (await widths(page)).variable).not.toBe(narrow);
  await expect.poll(async () => (await widths(page)).variable).toBe((await widths(page)).client);
});

test("an expanded row's detail pane is as wide as the scroll container's viewport on first render", async ({ page }) => {
  const fixture = largeFixture(5);
  await bootAndLoad(page, { fileKey: "file:///wide.csv", headers: fixture.headers, rows: fixture.rows, state: defaultViewState(), defaultTableColumns: 3 });
  await page.locator("tr.data-row").first().click();
  const wrap = page.locator("tr.detail-row:not([hidden]) .detail-wrap");
  await expect(wrap).toHaveCount(1);
  await expect
    .poll(async () => {
      const [wrapWidth, containerWidth] = await Promise.all([wrap.evaluate((el) => el.getBoundingClientRect().width), page.locator("#table-scroll").evaluate((el) => el.clientWidth)]);
      return Math.abs(wrapWidth - containerWidth) <= 1;
    })
    .toBe(true);
});
