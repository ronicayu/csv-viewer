import { expect, test } from "@playwright/test";
import { bootAndLoad, defaultViewState } from "../harness";
import { smallFixture } from "../fixtures";
import { trackConsoleErrors, wideFixture } from "./stressHelpers";

test.describe("Hide all", () => {
  test.beforeEach(async ({ page }) => {
    await bootAndLoad(page, {
      fileKey: "file:///people.csv",
      headers: smallFixture.headers,
      rows: smallFixture.rows,
      state: defaultViewState(),
      defaultTableColumns: 4,
    });
  });

  test("the table keeps only the chevron column, rows are still clickable, and the detail panel shows every column", async ({
    page,
  }) => {
    const consoleErrors = trackConsoleErrors(page);
    await page.locator("#columns-btn").click();
    await page.locator("#columns-hide-all").click();

    await expect(page.locator("th.sortable")).toHaveCount(0);
    await expect(page.locator("th.chevron-col")).toHaveCount(1);
    await expect(page.locator("tr.data-row")).toHaveCount(smallFixture.rows.length);

    // Close the popover first: a row click while one is open only dismisses it.
    await page.keyboard.press("Escape");
    await expect(page.locator("#columns-popover")).toBeHidden();

    const firstRow = page.locator("tr.data-row").first();
    await firstRow.click();
    const detail = page.locator("tr.detail-row").first();
    await expect(detail).toBeVisible();
    for (const h of smallFixture.headers) {
      await expect(detail.locator("dt", { hasText: h })).toHaveCount(1);
    }

    await page.locator("#columns-btn").click();
    await expect(page.locator("#columns-popover")).toBeVisible();
    await page.locator("#columns-show-all").click();
    await expect(page.locator("th.sortable")).toHaveCount(smallFixture.headers.length);
    expect(consoleErrors).toEqual([]);
  });

  test("with every column hidden, sorting via the Sort popover's 'Add sort column' still works even though there's no header to click", async ({
    page,
  }) => {
    await page.locator("#columns-btn").click();
    await page.locator("#columns-hide-all").click();
    await page.keyboard.press("Escape");

    await page.locator("#sort-btn").click();
    await page.locator("#sort-add-select").selectOption("age");
    await expect(page.locator(".sort-key-row")).toHaveCount(1);
    await expect(page.locator(".sort-key-row").first().locator(".sort-key-column")).toHaveText("age");
    await expect(page.locator("#sort-btn")).toHaveText("Sort • 1");
  });
});

test.describe("300 columns, Show all", () => {
  test("every column renders as a <th>, the table scrolls horizontally, and the header stays aligned with the body", async ({
    page,
  }) => {
    const fixture = wideFixture(20, 300);
    await bootAndLoad(page, {
      fileKey: "file:///wide.csv",
      headers: fixture.headers,
      rows: fixture.rows,
      state: defaultViewState(),
      defaultTableColumns: 8,
    });

    await page.locator("#columns-btn").click();
    await page.locator("#columns-show-all").click();
    await expect(page.locator("th.sortable")).toHaveCount(300);

    const { scrollWidth, clientWidth } = await page.locator("#table-scroll").evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(scrollWidth).toBeGreaterThan(clientWidth);

    await page.locator("#table-scroll").evaluate((el) => {
      el.scrollLeft = 500;
    });
    const lastHeaderCell = page.locator("th.sortable").last();
    const lastBodyCell = page.locator("tr.data-row").first().locator("td").last();
    const [headerBox, bodyBox] = await Promise.all([lastHeaderCell.boundingBox(), lastBodyCell.boundingBox()]);
    expect(headerBox).not.toBeNull();
    expect(bodyBox).not.toBeNull();
    expect(Math.abs((headerBox!.x + headerBox!.width) - (bodyBox!.x + bodyBox!.width))).toBeLessThan(2);
  });

  test("the columns popover itself scrolls internally for a 300-row checkbox list instead of growing off-screen", async ({
    page,
  }) => {
    const fixture = wideFixture(5, 300);
    await bootAndLoad(page, {
      fileKey: "file:///wide2.csv",
      headers: fixture.headers,
      rows: fixture.rows,
      state: defaultViewState(),
      defaultTableColumns: 8,
    });

    await page.locator("#columns-btn").click();
    const popoverBox = await page.locator("#columns-popover").boundingBox();
    const viewport = page.viewportSize();
    expect(popoverBox).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(popoverBox!.height).toBeLessThanOrEqual(viewport!.height);
    expect(popoverBox!.y + popoverBox!.height).toBeLessThanOrEqual(viewport!.height + 1);
  });
});

test("a columns search that matches nothing leaves an empty list without errors, and Show all/Hide all still act on the full column set", async ({
  page,
}) => {
  const consoleErrors = trackConsoleErrors(page);
  await bootAndLoad(page, {
    fileKey: "file:///people.csv",
    headers: smallFixture.headers,
    rows: smallFixture.rows,
    state: defaultViewState(),
    defaultTableColumns: 4,
  });

  await page.locator("#columns-btn").click();
  await page.locator("#columns-search").fill("zzz-no-such-column-zzz");
  await expect(page.locator("#columns-list .column-row")).toHaveCount(0);

  await page.locator("#columns-hide-all").click();
  await expect(page.locator("th.sortable")).toHaveCount(0);

  await page.locator("#columns-search").fill("");
  await expect(page.locator("#columns-list .column-row")).toHaveCount(smallFixture.headers.length);
  for (const row of await page.locator("#columns-list .column-row input").all()) await expect(row).not.toBeChecked();

  await page.locator("#columns-show-all").click();
  await expect(page.locator("th.sortable")).toHaveCount(smallFixture.headers.length);
  expect(consoleErrors).toEqual([]);
});
