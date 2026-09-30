import { expect, test } from "@playwright/test";
import { bootAndLoad, defaultViewState } from "./harness";
import { largeFixture } from "./fixtures";

test("a 20k-row fixture renders only the first chunk, then loads more on scroll", async ({ page }) => {
  const fixture = largeFixture(20_000);
  await bootAndLoad(page, {
    fileKey: "file:///big.csv",
    headers: fixture.headers,
    rows: fixture.rows,
    state: defaultViewState(),
    defaultTableColumns: 5,
  });

  await expect(page.locator("#status-bar")).toHaveText("Showing 20000 of 20000 rows");
  await expect(page.locator("tr.data-row")).toHaveCount(200);

  await page.locator("#table-scroll").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });

  await expect(page.locator("tr.data-row")).toHaveCount(400);

  // Scrolling again keeps appending further chunks.
  await page.locator("#table-scroll").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(page.locator("tr.data-row")).toHaveCount(600);
});
