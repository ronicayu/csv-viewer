import { expect, test } from "@playwright/test";
import { bootAndLoad, bootAndLoadText, defaultViewState } from "./harness";
import { smallFixture } from "./fixtures";
import { toCsvText, wideFixture } from "./stress/stressHelpers";

test.describe("toolbar is a single row and its height never changes", () => {
  for (const width of [1280, 900, 700]) {
    test(`single row at ${width}px, and height doesn't change when a sort, a filter, or a separator error is set`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await bootAndLoad(page, {
        fileKey: "file:///chrome.csv",
        headers: smallFixture.headers,
        rows: smallFixture.rows,
        state: defaultViewState(),
        defaultTableColumns: 4,
      });

      const toolbar = page.locator(".toolbar");
      const baseline = (await toolbar.boundingBox())!;
      // Group children by vertical overlap, not exact top: controls of different heights share a row.
      const lineCount = async (): Promise<number> => {
        const rects = await toolbar.evaluate((el) =>
          Array.from(el.children)
            .filter((c) => (c as HTMLElement).offsetParent !== null)
            .map((c) => {
              const r = c.getBoundingClientRect();
              return { top: r.top, bottom: r.bottom };
            }),
        );
        rects.sort((a, b) => a.top - b.top);
        let lines = 0;
        let lineBottom = -Infinity;
        for (const r of rects) {
          if (r.top >= lineBottom - 1) lines++;
          lineBottom = Math.max(lineBottom, r.bottom);
        }
        return lines;
      };
      expect(await lineCount()).toBe(1);

      await page.locator("th", { hasText: "age" }).click();
      expect((await toolbar.boundingBox())!.height).toBe(baseline.height);
      expect(await lineCount()).toBe(1);

      await page.locator("#filters-btn").click();
      await page.locator("#add-rule-btn").click();
      const rule = page.locator(".rule-row").first();
      await rule.locator('select[aria-label="Column"]').selectOption("city");
      await rule.locator('select[aria-label="Condition"]').selectOption("equals");
      await rule.locator('input[type="text"]').fill("LA");
      await page.keyboard.press("Escape");
      expect((await toolbar.boundingBox())!.height).toBe(baseline.height);
      expect(await lineCount()).toBe(1);

      await page.locator("#format-btn").click();
      await page.locator("#separator-select").selectOption("custom");
      await page.locator("#separator-custom").fill('"');
      await expect(page.locator("#separator-custom-error")).toBeVisible();
      await page.keyboard.press("Escape");
      expect((await toolbar.boundingBox())!.height).toBe(baseline.height);
      expect(await lineCount()).toBe(1);
    });
  }
});

test("Columns button shows 'in table / total' and updates live", async ({ page }) => {
  await bootAndLoad(page, {
    fileKey: "file:///badges.csv",
    headers: smallFixture.headers,
    rows: smallFixture.rows,
    state: defaultViewState(),
    defaultTableColumns: 4,
  });
  await expect(page.locator("#columns-btn")).toHaveText("Columns 4/4");

  await page.locator("#columns-btn").click();
  await page.locator(".column-row", { hasText: "age" }).locator('input[type="checkbox"]').uncheck();
  await expect(page.locator("#columns-btn")).toHaveText("Columns 3/4");
});

test.describe("File format popover", () => {
  test.beforeEach(async ({ page }) => {
    await bootAndLoad(page, {
      fileKey: "file:///format.csv",
      headers: smallFixture.headers,
      rows: smallFixture.rows,
      state: defaultViewState(),
      defaultTableColumns: 4,
    });
  });

  test("opens anchored under its button (clamped inside the viewport, same as every other popover) and shows the kept element ids", async ({
    page,
  }) => {
    await page.locator("#format-btn").click();
    const popoverBox = (await page.locator("#format-popover").boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(popoverBox.x).toBeGreaterThanOrEqual(0);
    expect(popoverBox.x + popoverBox.width).toBeLessThanOrEqual(viewport.width);
    await expect(page.locator("#separator-select")).toBeVisible();
    await expect(page.locator("#first-row-header")).toBeVisible();
    await expect(page.locator("#quotes-checkbox")).toBeVisible();
    await expect(page.locator(".quotes-explain")).toHaveText('Treat "…" as quoting. Turn off if quotes in your data are literal text.');
  });

  test("separator option labels match the spec exactly", async ({ page }) => {
    await page.locator("#format-btn").click();
    const options = await page.locator("#separator-select option").allTextContents();
    expect(options.slice(1)).toEqual(["Comma (,)", "Semicolon (;)", "Tab", "Pipe (|)", "Custom…"]);
  });
});

test.describe("the slim 'Filtered' row under the toolbar", () => {
  test.beforeEach(async ({ page }) => {
    await bootAndLoad(page, {
      fileKey: "file:///filteredrow.csv",
      headers: smallFixture.headers,
      rows: smallFixture.rows,
      state: defaultViewState(),
      defaultTableColumns: 4,
    });
  });

  test("hidden by default; shows with 'Clear Search' once search is non-empty", async ({ page }) => {
    await expect(page.locator("#filtered-row")).toBeHidden();

    await page.locator("#quick-search").fill("la");
    await expect(page.locator("#filtered-row")).toBeVisible();
    await expect(page.locator("#filtered-row-text")).toHaveText("Filtered: 2 of 5 rows");
    await expect(page.locator("#filtered-clear-search-btn")).toBeVisible();
    await expect(page.locator("#filtered-turn-off-filters-btn")).toBeHidden();

    await page.locator("#filtered-clear-search-btn").click();
    await expect(page.locator("#quick-search")).toHaveValue("");
    await expect(page.locator("#filtered-row")).toBeHidden();
  });

  test("shows 'Turn Off Filters' once a filter rule is active, and turning them off hides the row again", async ({ page }) => {
    await page.locator("#filters-btn").click();
    await page.locator("#add-rule-btn").click();
    const rule = page.locator(".rule-row").first();
    await rule.locator('select[aria-label="Column"]').selectOption("city");
    await rule.locator('select[aria-label="Condition"]').selectOption("equals");
    await rule.locator('input[type="text"]').fill("LA");

    await expect(page.locator("#filtered-row")).toBeVisible();
    await expect(page.locator("#filtered-row-text")).toHaveText("Filtered: 2 of 5 rows");
    await expect(page.locator("#filtered-turn-off-filters-btn")).toBeVisible();
    await expect(page.locator("#filtered-clear-search-btn")).toBeHidden();

    await page.locator("#filtered-turn-off-filters-btn").click();
    await expect(page.locator("#filtered-row")).toBeHidden();
    await expect(page.locator("#status-bar")).toHaveText("Showing 5 of 5 rows");
  });

  test("does not appear when a filter rule is enabled but inactive (no column/value yet)", async ({ page }) => {
    await page.locator("#filters-btn").click();
    await page.locator("#add-rule-btn").click();
    await expect(page.locator("#filtered-row")).toBeHidden();
  });
});

test("the progress bar shows after ~150ms on a slow query, sets aria-busy on the table, and clears both when it answers", async ({
  page,
}) => {
  // A catastrophic regex forces a slow filter phase without needing a huge fixture.
  const pathological = "a".repeat(30) + "b";
  const rows: string[][] = [["0", pathological]];
  for (let i = 1; i < 50; i++) rows.push([String(i), `normal-${i}`]);
  const text = toCsvText(["id", "val"], rows);
  await bootAndLoadText(page, {
    fileKey: "file:///working.csv",
    text,
    state: defaultViewState(),
    defaultTableColumns: 2,
  });

  await page.locator("#filters-btn").click();
  await page.locator("#add-rule-btn").click();
  const rule = page.locator(".rule-row").first();
  await rule.locator('select[aria-label="Column"]').selectOption("val");
  await rule.locator('select[aria-label="Condition"]').selectOption("regex");
  await rule.locator('input[type="text"]').fill("(a+)+$");

  await expect(page.locator("#working-indicator")).toBeVisible({ timeout: 2_500 });
  await expect(page.locator("#table")).toHaveAttribute("aria-busy", "true");

  await expect(page.locator("#working-indicator")).toBeHidden({ timeout: 5_000 });
  await expect(page.locator("#table")).not.toHaveAttribute("aria-busy", "true");
});

test("the progress bar is static (no animation) under body.vscode-reduce-motion", async ({ page }) => {
  await bootAndLoad(page, {
    fileKey: "file:///reducemotion.csv",
    headers: smallFixture.headers,
    rows: smallFixture.rows,
    state: defaultViewState(),
    defaultTableColumns: 4,
  });
  await page.evaluate(() => document.body.classList.add("vscode-reduce-motion"));
  const animationName = await page.locator("#working-indicator").evaluate((el) => getComputedStyle(el, "::before").animationName);
  expect(animationName).toBe("none");
});

test.describe("deleted-file banner", () => {
  test.beforeEach(async ({ page }) => {
    await bootAndLoad(page, {
      fileKey: "file:///deleted.csv",
      headers: smallFixture.headers,
      rows: smallFixture.rows,
      state: defaultViewState(),
      defaultTableColumns: 4,
    });
  });

  test("shows on fileDeleted, naming the file, and disappears on fileRestored", async ({ page }) => {
    await expect(page.locator("#file-deleted-banner")).toBeHidden();
    await page.evaluate(() => window.postMessage({ type: "fileDeleted", name: "deleted.csv" }, "*"));
    await expect(page.locator("#file-deleted-banner")).toBeVisible();
    await expect(page.locator("#file-deleted-banner")).toHaveAttribute("role", "alert");
    await expect(page.locator("#file-deleted-text")).toHaveText('"deleted.csv" was deleted from disk. Showing the last loaded copy.');

    await page.evaluate(() => window.postMessage({ type: "fileRestored" }, "*"));
    await expect(page.locator("#file-deleted-banner")).toBeHidden();
  });

  test("disappears on the next load even without an explicit fileRestored", async ({ page }) => {
    await page.evaluate(() => window.postMessage({ type: "fileDeleted", name: "deleted.csv" }, "*"));
    await expect(page.locator("#file-deleted-banner")).toBeVisible();

    await bootAndLoad(page, {
      fileKey: "file:///deleted.csv",
      headers: smallFixture.headers,
      rows: smallFixture.rows,
      state: defaultViewState(),
      defaultTableColumns: 4,
    });
    await expect(page.locator("#file-deleted-banner")).toBeHidden();
  });
});

test.describe("the one-time 'rowDetails' hint", () => {
  test("shows once at least one column is detail-only, hides on dismiss, and posts hintSeen", async ({ page }) => {
    await bootAndLoad(page, {
      fileKey: "file:///hint.csv",
      headers: smallFixture.headers,
      rows: smallFixture.rows,
      state: defaultViewState(),
      defaultTableColumns: 2,
    });
    await expect(page.locator("#hint-rowdetails-banner")).toBeVisible();
    await expect(page.locator("#hint-rowdetails-text")).toHaveText(
      "2 more columns are in each row's details. Click a row's arrow to expand it, or change which with Columns.",
    );

    await page.locator("#hint-rowdetails-dismiss-btn").click();
    await expect(page.locator("#hint-rowdetails-banner")).toBeHidden();

    const seenMessages = await page.evaluate(() => (window as unknown as { __posted: Array<Record<string, unknown>> }).__posted);
    expect(seenMessages.some((m) => m.type === "hintSeen" && m.id === "rowDetails")).toBe(true);
  });

  test("hides on the first row expansion too, and posts hintSeen exactly once", async ({ page }) => {
    await bootAndLoad(page, {
      fileKey: "file:///hint2.csv",
      headers: smallFixture.headers,
      rows: smallFixture.rows,
      state: defaultViewState(),
      defaultTableColumns: 2,
    });
    await expect(page.locator("#hint-rowdetails-banner")).toBeVisible();

    await page.locator("tr.data-row").first().click();
    await expect(page.locator("#hint-rowdetails-banner")).toBeHidden();

    await page.locator("tr.data-row").nth(1).click();
    const seenMessages = await page.evaluate(() => (window as unknown as { __posted: Array<Record<string, unknown>> }).__posted);
    expect(seenMessages.filter((m) => m.type === "hintSeen").length).toBe(1);
  });

  test("stays hidden on load when hintsSeen already includes 'rowDetails'", async ({ page }) => {
    await bootAndLoad(page, {
      fileKey: "file:///hint3.csv",
      headers: smallFixture.headers,
      rows: smallFixture.rows,
      state: defaultViewState(),
      defaultTableColumns: 2,
      hintsSeen: ["rowDetails"],
    });
    await expect(page.locator("#hint-rowdetails-banner")).toBeHidden();
  });

  test("never shows when every column is already visible in the table", async ({ page }) => {
    await bootAndLoad(page, {
      fileKey: "file:///hint4.csv",
      headers: smallFixture.headers,
      rows: smallFixture.rows,
      state: defaultViewState(),
      defaultTableColumns: 4,
    });
    await expect(page.locator("#hint-rowdetails-banner")).toBeHidden();
  });
});

test("the quote banner uses the updated copy and action label", async ({ page }) => {
  const text = ["id,name,comment", "1,Alice,fine", '2,Bob,"starts quoted but never closes', "3,Cara,ok"].join("\n");
  await bootAndLoadText(page, {
    fileKey: "file:///badquotes.csv",
    text,
    state: defaultViewState(),
    defaultTableColumns: 3,
  });
  await expect(page.locator("#quote-warning-banner")).toBeVisible();
  await expect(page.locator("#quote-warning-text")).toHaveText(/^Quotes look malformed near row \d+\. Rows after it may be merged into one\.$/);
  await expect(page.locator("#quote-warning-fix-btn")).toHaveText("Read Quotes as Plain Text");
});

test("the pager range shows '(filtered from N)' only once search/filters actually reduce the set", async ({ page }) => {
  const fixture = wideFixture(240, 4);
  await bootAndLoad(page, {
    fileKey: "file:///filteredcount.csv",
    headers: fixture.headers,
    rows: fixture.rows,
    state: defaultViewState(),
    defaultTableColumns: 4,
  });
  await expect(page.locator("#pager-row-range")).toHaveText("1–100 of 240 rows");

  await page.locator("#quick-search").fill("v1_2");
  await expect(page.locator("#pager-row-range")).toHaveText("1–1 of 1 rows (filtered from 240)");

  await page.locator("#quick-search").fill("zzz-nothing-zzz");
  await expect(page.locator("#pager-row-range")).toHaveText("0 rows (filtered from 240)");
});
