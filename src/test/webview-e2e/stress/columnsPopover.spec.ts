// Columns popover edge cases: hiding every column, showing 300 columns at
// once, and a search that matches nothing.

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
    // Rows still render (as chevron-only rows) and are still clickable.
    await expect(page.locator("tr.data-row")).toHaveCount(smallFixture.rows.length);

    // Close the popover before interacting with a row — a click while a
    // popover is open closes the popover instead of also toggling the
    // row underneath it (see docs/reviews/ux-review.md §3, "click-through").
    await page.keyboard.press("Escape");
    await expect(page.locator("#columns-popover")).toBeHidden();

    const firstRow = page.locator("tr.data-row").first();
    await firstRow.click();
    const detail = page.locator("tr.detail-row").first();
    await expect(detail).toBeVisible();
    // detailFieldsFor falls back to "every column" when nothing is
    // hidden... wait, here everything IS hidden, so detail-only columns
    // ARE all columns; every header should appear as a dt.
    for (const h of smallFixture.headers) {
      await expect(detail.locator("dt", { hasText: h })).toHaveCount(1);
    }

    // Recovery: Show all brings the table back.
    await page.locator("#columns-btn").click();
    await expect(page.locator("#columns-popover")).toBeVisible();
    await page.locator("#columns-show-all").click();
    await expect(page.locator("th.sortable")).toHaveCount(smallFixture.headers.length);
    expect(consoleErrors).toEqual([]);
  });

  test("with every column hidden, sorting via the Sort by… dropdown still works even though there's no header to click", async ({
    page,
  }) => {
    await page.locator("#columns-btn").click();
    await page.locator("#columns-hide-all").click();

    await page.locator("#sort-by-select").selectOption("age");
    // No visible <th> to read the sort indicator from, but the dropdown
    // and direction button should reflect the active sort.
    await expect(page.locator("#sort-by-select")).toHaveValue("age");
    await expect(page.locator("#sort-dir-btn")).toBeVisible();
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
      defaultTableColumns: 8, // most columns start detail-only
    });

    await page.locator("#columns-btn").click();
    await page.locator("#columns-show-all").click();
    await expect(page.locator("th.sortable")).toHaveCount(300);

    // Horizontal scroll exists (content wider than the viewport).
    const { scrollWidth, clientWidth } = await page.locator("#table-scroll").evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(scrollWidth).toBeGreaterThan(clientWidth);

    // Scroll partway and confirm the sticky header tracks the same
    // horizontal offset as the body (thead is `position: sticky; top: 0`,
    // which only pins the vertical axis — it scrolls horizontally with its
    // parent, so header/body columns should stay visually aligned).
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
    // The popover's own CSS caps it at max-height: 60vh with overflow:
    // auto, so it must never grow taller than the viewport.
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

  // Hide all is not scoped to the filtered (empty) list — it still hides
  // every real column, per the spec's "Show all"/"Hide all" being
  // unconditional bulk actions.
  await page.locator("#columns-hide-all").click();
  await expect(page.locator("th.sortable")).toHaveCount(0);

  await page.locator("#columns-search").fill(""); // clear the filter to see the (still-empty-looking) list again
  await expect(page.locator("#columns-list .column-row")).toHaveCount(smallFixture.headers.length);
  for (const row of await page.locator("#columns-list .column-row input").all()) await expect(row).not.toBeChecked();

  await page.locator("#columns-show-all").click();
  await expect(page.locator("th.sortable")).toHaveCount(smallFixture.headers.length);
  expect(consoleErrors).toEqual([]);
});
