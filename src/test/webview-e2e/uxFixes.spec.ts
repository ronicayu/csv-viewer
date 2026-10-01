// New coverage for the UX/accessibility fixes in docs/reviews/ux-review.md
// and docs/reviews/pm-review.md §4: the "Also in table" detail group,
// clipped-cell tooltips, the sticky detail panel width, the text-selection
// click guard, the richer context menu (Copy value + relabeled filter
// items), codicon-based focusable controls (chevron, pager, headers),
// popover anchoring/focus/outside-click behavior, the three empty states,
// the missing-column filter option, and Cmd/Ctrl+F.

import { expect, test } from "@playwright/test";
import { bootAndLoad, bootAndLoadText, defaultViewState } from "./harness";
import { smallFixture } from "./fixtures";
import { toCsvText, wideFixture } from "./stress/stressHelpers";

// ---- A. Reading long text --------------------------------------------------

test.describe("detail panel: Also in table", () => {
  test("a clipped visible column appears under 'Also in table'; an unclipped one does not", async ({ page }) => {
    const longValue = "A long value that is definitely wider than the 320px table cell cap. ".repeat(3);
    const text = toCsvText(["id", "short", "long"], [["1", "ok", longValue]]);
    await bootAndLoadText(page, {
      fileKey: "file:///clip.csv",
      text,
      // "long"'s median value length puts it over the smart default
      // column split's "short" threshold (see src/core/columns.ts), so it
      // would default to row details on its own — force all three
      // columns into the table explicitly (a stored choice always wins),
      // since this test is specifically about a long value that's
      // visually clipped WHILE still in the table.
      state: defaultViewState({ columnVisibility: { id: true, short: true, long: true } }),
      defaultTableColumns: 3,
    });

    await page.locator("tr.data-row").first().click();
    const detail = page.locator("tr.detail-row").first();
    await expect(detail).toBeVisible();
    await expect(detail.locator(".detail-group-heading", { hasText: "Also in table" })).toBeVisible();
    await expect(detail.locator("dt", { hasText: "long" })).toHaveCount(1);
    // "short" isn't clipped, so it must not be duplicated into the panel.
    await expect(detail.locator("dt", { hasText: "short" })).toHaveCount(0);
    // "id" is short too — detailOnly is empty and "long" is the only
    // clipped column, so only the "Also in table" group renders.
    await expect(detail.locator("dt", { hasText: "id" })).toHaveCount(0);
  });

  test("falls back to showing every column when nothing is hidden and nothing is clipped", async ({ page }) => {
    await bootAndLoad(page, {
      fileKey: "file:///noclip.csv",
      headers: smallFixture.headers,
      rows: smallFixture.rows,
      state: defaultViewState(),
      defaultTableColumns: 4, // everything visible; no value is long enough to clip
    });

    await page.locator("tr.data-row").first().click();
    const detail = page.locator("tr.detail-row").first();
    await expect(detail.locator(".detail-group-heading")).toHaveCount(0);
    for (const h of smallFixture.headers) {
      await expect(detail.locator("dt", { hasText: h })).toHaveCount(1);
    }
  });

  test("a clipped table cell gets a title tooltip lazily, on hover", async ({ page }) => {
    const longValue = "A long value that is definitely wider than the 320px table cell cap. ".repeat(3);
    const text = toCsvText(["id", "long"], [["1", longValue]]);
    await bootAndLoadText(page, {
      fileKey: "file:///tooltip.csv",
      text,
      // Force "long" into the table explicitly — see the identical note
      // in the "Also in table" test above.
      state: defaultViewState({ columnVisibility: { id: true, long: true } }),
      defaultTableColumns: 2,
    });

    const cell = page.locator("tr.data-row").first().locator("td").nth(2); // chevron, id, long
    await expect(cell).not.toHaveAttribute("title"); // not set yet — rendering stays cheap
    await cell.hover();
    await expect(cell).toHaveAttribute("title", longValue.slice(0, 500));
  });

  test("the detail panel's width matches the scroll viewport, not the table's full scrolled width, at 700px", async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 800 });
    const fixture = wideFixture(5, 30); // 30 columns — wide enough to scroll horizontally
    await bootAndLoad(page, {
      fileKey: "file:///wide700.csv",
      headers: fixture.headers,
      rows: fixture.rows,
      state: defaultViewState(),
      defaultTableColumns: 30,
    });

    const scrollWidth = await page.locator("#table-scroll").evaluate((el) => el.clientWidth);
    await page.locator("tr.data-row").first().click();
    const wrap = page.locator("tr.detail-row").first().locator(".detail-wrap");
    const wrapWidth = await wrap.evaluate((el) => el.getBoundingClientRect().width);
    expect(Math.abs(wrapWidth - scrollWidth)).toBeLessThan(2);

    // Pinned to the viewport: scrolling the table 200px horizontally
    // must not drag the detail block along with it — a small (<10px)
    // settling delta between "not yet stuck" and "stuck" is fine; the
    // 200px scroll itself must not show up as drift.
    const leftBefore = await wrap.evaluate((el) => el.getBoundingClientRect().left);
    await page.locator("#table-scroll").evaluate((el) => {
      el.scrollLeft = 200;
    });
    const leftAfter = await wrap.evaluate((el) => el.getBoundingClientRect().left);
    expect(Math.abs(leftAfter - leftBefore)).toBeLessThan(10);
  });
});

// ---- B. Copy and selection --------------------------------------------------

test.describe("row click vs. text selection", () => {
  test.beforeEach(async ({ page }) => {
    await bootAndLoad(page, {
      fileKey: "file:///select.csv",
      headers: smallFixture.headers,
      rows: smallFixture.rows,
      state: defaultViewState(),
      defaultTableColumns: 4,
    });
  });

  test("drag-selecting text in a cell does not toggle the row", async ({ page }) => {
    const row = page.locator("tr.data-row").first();
    const detail = page.locator("tr.detail-row").first();
    await expect(detail).toBeHidden();

    const cell = row.locator("td").nth(1);
    const box = (await cell.boundingBox())!;
    await page.mouse.move(box.x + 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();

    const selection = await page.evaluate(() => String(window.getSelection()));
    expect(selection.length).toBeGreaterThan(0);
    await expect(detail).toBeHidden();
  });

  test("a click is ignored when a text selection already exists — the guard behind 'double-click doesn't flicker the row'", async ({ page }) => {
    // This is what makes double-clicking a word not flicker the row: the
    // browser selects the word as part of handling the double-click's
    // second mousedown, before that second click event fires — so by the
    // time the row's click handler runs, getSelection() is already
    // non-empty and the guard skips the toggle. Chromium's CDP-driven
    // `locator.dblclick()` doesn't reproduce that native OS text
    // selection, so it can't exercise this path end-to-end here; this
    // creates the selection directly (exactly the state a real second
    // click would see) and fires the same click the row's own listener
    // receives, to test the actual guard condition deterministically.
    const row = page.locator("tr.data-row").first();
    const detail = page.locator("tr.detail-row").first();
    await expect(detail).toBeHidden();

    const cell = row.locator("td").nth(1);
    await cell.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    });
    // Click the SAME cell the selection is in — clicking elsewhere would
    // itself collapse the selection as an ordinary side effect of the
    // mousedown, before the guard even gets a chance to see it.
    await cell.click({ force: true });
    await expect(detail).toBeHidden(); // the click was ignored — a selection existed
  });
});

test.describe("context menu: Copy Value and relabeled filter items", () => {
  test.beforeEach(async ({ page }) => {
    await bootAndLoad(page, {
      fileKey: "file:///menu.csv",
      headers: smallFixture.headers,
      rows: smallFixture.rows,
      state: defaultViewState(),
      defaultTableColumns: 4,
    });
  });

  test("Copy Value puts the full value on the clipboard", async ({ page }) => {
    // The harness's page (via page.setContent, with no real https origin)
    // isn't a secure context, so the real navigator.clipboard API is
    // undefined here altogether — unlike a real VS Code webview, which
    // is backed by a secure vscode-webview: origin. Stand in a fake
    // implementation that main.ts's copyToClipboard calls exactly like
    // the real API (feature-detected the same way: `navigator.clipboard
    // ?.writeText`), so the right value reaching it is still verified
    // precisely, instead of depending on this harness's clipboard
    // permissions (which grantPermissions can't make real here either).
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: (text: string) => {
            (window as unknown as { __copied?: string }).__copied = text;
            return Promise.resolve();
          },
        },
        configurable: true,
      });
    });
    const cell = page.locator("tr.data-row").first().locator("td").nth(2); // chevron, id, name
    await cell.click({ button: "right" });
    await page.locator("#context-menu button", { hasText: "Copy Value" }).click();
    await expect(page.locator("#context-menu")).toBeHidden();
    const copied = await page.evaluate(() => (window as unknown as { __copied?: string }).__copied);
    expect(copied).toBe("Alice");
  });

  test("'Show only rows where' creates an include/equals rule; 'Hide rows where' creates an exclude/equals rule", async ({ page }) => {
    const cell = page.locator("tr.data-row").nth(1).locator("td").nth(3); // row Bob, age=25
    await cell.click({ button: "right" });
    await expect(page.locator("#context-menu button", { hasText: /^Show only rows where age = "25"/ })).toBeVisible();
    await expect(page.locator("#context-menu button", { hasText: /^Hide rows where age = "25"/ })).toBeVisible();

    await page.locator("#context-menu button", { hasText: /^Show only rows where/ }).click();
    await expect(page.locator("#status-bar")).toHaveText("Showing 1 of 5 rows");
    const rule = page.locator(".rule-row").first();
    await expect(rule.locator("select").nth(0)).toHaveValue("age");
    await expect(rule.locator('input[type="text"]')).toHaveValue("25");
    await expect(rule.locator(".mode-toggle")).toHaveText("Include");

    await rule.locator(".remove-rule-btn").click();
    await expect(page.locator("#status-bar")).toHaveText("Showing 5 of 5 rows");

    await cell.click({ button: "right" });
    await page.locator("#context-menu button", { hasText: /^Hide rows where/ }).click();
    const rule2 = page.locator(".rule-row").first();
    await expect(rule2.locator(".mode-toggle")).toHaveText("Exclude");
    await expect(page.locator("#status-bar")).toHaveText("Showing 4 of 5 rows");
  });
});

// ---- C. Keyboard and screen readers -----------------------------------------

test.describe("chevron twisty button", () => {
  test.beforeEach(async ({ page }) => {
    await bootAndLoad(page, {
      fileKey: "file:///twisty.csv",
      headers: smallFixture.headers,
      rows: smallFixture.rows,
      state: defaultViewState(),
      defaultTableColumns: 4,
    });
  });

  test("is a focusable <button> with correct aria-expanded/aria-label, and Enter/Space toggle it", async ({ page }) => {
    const twisty = page.locator("tr.data-row").first().locator(".twisty");
    await expect(twisty).toHaveAttribute("aria-expanded", "false");
    await expect(twisty).toHaveAttribute("aria-label", "Show details for row 1");

    await twisty.focus();
    await page.keyboard.press("Enter");
    await expect(twisty).toHaveAttribute("aria-expanded", "true");
    await expect(twisty).toHaveAttribute("aria-label", "Hide details for row 1");
    await expect(page.locator("tr.detail-row").first()).toBeVisible();

    await page.keyboard.press(" ");
    await expect(twisty).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("tr.detail-row").first()).toBeHidden();
  });

  test("clicking the chevron does not double-toggle via the row's own click handler", async ({ page }) => {
    const twisty = page.locator("tr.data-row").first().locator(".twisty");
    await twisty.click();
    await expect(twisty).toHaveAttribute("aria-expanded", "true");
  });
});

test("pager buttons have First/Previous/Next/Last page aria-labels", async ({ page }) => {
  const fixture = wideFixture(250, 4);
  await bootAndLoad(page, {
    fileKey: "file:///pageraria.csv",
    headers: fixture.headers,
    rows: fixture.rows,
    state: defaultViewState(),
    defaultTableColumns: 4,
  });
  await expect(page.locator("#pager-first-btn")).toHaveAttribute("aria-label", "First page");
  await expect(page.locator("#pager-prev-btn")).toHaveAttribute("aria-label", "Previous page");
  await expect(page.locator("#pager-next-btn")).toHaveAttribute("aria-label", "Next page");
  await expect(page.locator("#pager-last-btn")).toHaveAttribute("aria-label", "Last page");
});

test("the row count is a polite status region and the quote banner is an alert", async ({ page }) => {
  await bootAndLoad(page, {
    fileKey: "file:///rolestatus.csv",
    headers: smallFixture.headers,
    rows: smallFixture.rows,
    state: defaultViewState(),
    defaultTableColumns: 4,
  });
  await expect(page.locator("#status-bar")).toHaveAttribute("role", "status");
  await expect(page.locator("#quote-warning-banner")).toHaveAttribute("role", "alert");
});

// ---- E. Popovers -------------------------------------------------------------

test.describe("popovers", () => {
  test.beforeEach(async ({ page }) => {
    await bootAndLoad(page, {
      fileKey: "file:///popover.csv",
      headers: smallFixture.headers,
      rows: smallFixture.rows,
      state: defaultViewState(),
      defaultTableColumns: 4,
    });
  });

  test("the Columns popover opens within 8px of its trigger's left edge and gets focus", async ({ page }) => {
    const btnBox = (await page.locator("#columns-btn").boundingBox())!;
    await page.locator("#columns-btn").click();
    const popoverBox = (await page.locator("#columns-popover").boundingBox())!;
    expect(Math.abs(popoverBox.x - btnBox.x)).toBeLessThanOrEqual(8);
    await expect(page.locator("#columns-search")).toBeFocused();
    await expect(page.locator("#columns-btn")).toHaveAttribute("aria-expanded", "true");
  });

  test("a click outside closes the popover and does not also toggle a row underneath it", async ({ page }) => {
    await page.locator("#columns-btn").click();
    await expect(page.locator("#columns-popover")).toBeVisible();

    const row = page.locator("tr.data-row").first();
    const detail = page.locator("tr.detail-row").first();
    await row.click();

    await expect(page.locator("#columns-popover")).toBeHidden();
    await expect(detail).toBeHidden(); // the click closed the popover, not the row
    await expect(page.locator("#columns-btn")).toHaveAttribute("aria-expanded", "false");
  });

  test("Escape closes the popover and returns focus to its trigger", async ({ page }) => {
    await page.locator("#columns-btn").focus();
    await page.locator("#columns-btn").click();
    await expect(page.locator("#columns-popover")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#columns-popover")).toBeHidden();
    await expect(page.locator("#columns-btn")).toBeFocused();
  });

  test("opening Filters closes an already-open Columns popover, anchored under the Filters button", async ({ page }) => {
    await page.locator("#columns-btn").click();
    await expect(page.locator("#columns-popover")).toBeVisible();

    const filtersBox = (await page.locator("#filters-btn").boundingBox())!;
    await page.locator("#filters-btn").click();
    await expect(page.locator("#columns-popover")).toBeHidden();
    await expect(page.locator("#filter-panel")).toBeVisible();
    const panelBox = (await page.locator("#filter-panel").boundingBox())!;
    expect(Math.abs(panelBox.x - filtersBox.x)).toBeLessThanOrEqual(8);
  });
});

// ---- F. States and copy -------------------------------------------------------

test("empty state: a file with zero data rows", async ({ page }) => {
  const text = toCsvText(["id", "name"], []);
  await bootAndLoadText(page, {
    fileKey: "file:///empty.csv",
    text,
    state: defaultViewState(),
    defaultTableColumns: 2,
  });
  await expect(page.locator("tr.empty-state-row")).toHaveText("This file has no data rows.");
});

test("empty state: search matches nothing offers Clear search", async ({ page }) => {
  await bootAndLoad(page, {
    fileKey: "file:///zero.csv",
    headers: smallFixture.headers,
    rows: smallFixture.rows,
    state: defaultViewState(),
    defaultTableColumns: 4,
  });
  await page.locator("#quick-search").fill("zzqx-no-such-thing");
  await expect(page.locator("tr.empty-state-row")).toContainText("No rows match.");
  const clearBtn = page.locator("tr.empty-state-row button", { hasText: "Clear search" });
  await expect(clearBtn).toBeVisible();
  await clearBtn.click();
  await expect(page.locator("#quick-search")).toHaveValue("");
  await expect(page.locator("#status-bar")).toHaveText("Showing 5 of 5 rows");
});

test("empty state: filters matching nothing offers Turn off filters (disables, doesn't delete)", async ({ page }) => {
  const rule = {
    id: "r1",
    column: "city",
    operator: "equals" as const,
    value: "zzqx-no-such-city",
    mode: "include" as const,
    caseSensitive: false,
    enabled: true,
  };
  await bootAndLoad(page, {
    fileKey: "file:///zerofilter.csv",
    headers: smallFixture.headers,
    rows: smallFixture.rows,
    state: defaultViewState({ filterRules: [rule] }),
    defaultTableColumns: 4,
  });
  await expect(page.locator("tr.empty-state-row")).toContainText("No rows match.");
  const turnOffBtn = page.locator("tr.empty-state-row button", { hasText: "Turn off filters" });
  await expect(turnOffBtn).toBeVisible();
  await turnOffBtn.click();
  await expect(page.locator("#status-bar")).toHaveText("Showing 5 of 5 rows");

  // Disabled, not deleted.
  await page.locator("#filters-btn").click();
  await expect(page.locator(".rule-row")).toHaveCount(1);
  await expect(page.locator(".rule-row input[type=\"checkbox\"]").first()).not.toBeChecked();
});

test("empty state: hiding every column shows a banner above the still-clickable rows, with a Choose columns button", async ({ page }) => {
  await bootAndLoad(page, {
    fileKey: "file:///hideall-banner.csv",
    headers: smallFixture.headers,
    rows: smallFixture.rows,
    state: defaultViewState(),
    defaultTableColumns: 4,
  });
  await page.locator("#columns-btn").click();
  await page.locator("#columns-hide-all").click();
  await page.keyboard.press("Escape");

  await expect(page.locator("tr.empty-state-row")).toContainText("All columns are in the row details.");
  const chooseBtn = page.locator("tr.empty-state-row button", { hasText: "Choose columns" });
  await expect(chooseBtn).toBeVisible();
  await chooseBtn.click();
  await expect(page.locator("#columns-popover")).toBeVisible();
});

test("a filter rule whose column no longer exists shows a disabled '<name> (missing)' option and a named hint", async ({ page }) => {
  const rule = {
    id: "r1",
    column: "legacy_owner",
    operator: "contains" as const,
    value: "x",
    mode: "include" as const,
    caseSensitive: false,
    enabled: true,
  };
  await bootAndLoad(page, {
    fileKey: "file:///missingcol.csv",
    headers: smallFixture.headers,
    rows: smallFixture.rows,
    state: defaultViewState({ filterRules: [rule] }),
    defaultTableColumns: 4,
  });
  await page.locator("#filters-btn").click();
  const select = page.locator(".rule-row").first().locator("select").nth(0);
  await expect(select).toHaveValue("legacy_owner");
  const missingOption = select.locator("option", { hasText: "legacy_owner (missing)" });
  await expect(missingOption).toHaveCount(1);
  await expect(missingOption).toBeDisabled();
  await expect(page.locator(".rule-row").first().locator(".rule-error-text")).toHaveText('Skipped: column "legacy_owner" isn\'t in this file');
});

test("Cmd/Ctrl+F focuses and selects the quick search box", async ({ page }) => {
  await bootAndLoad(page, {
    fileKey: "file:///ctrlf.csv",
    headers: smallFixture.headers,
    rows: smallFixture.rows,
    state: defaultViewState({ quickSearch: "Alice" }),
    defaultTableColumns: 4,
  });
  await page.locator("#columns-btn").focus();
  await page.keyboard.press("Control+f");
  await expect(page.locator("#quick-search")).toBeFocused();
  const selected = await page.locator("#quick-search").evaluate((el: HTMLInputElement) => el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0));
  expect(selected).toBe("Alice");
});

test("numbers in the status bar and pager are locale-formatted", async ({ page }) => {
  const fixture = wideFixture(20_000, 4);
  await bootAndLoad(page, {
    fileKey: "file:///numbers.csv",
    headers: fixture.headers,
    rows: fixture.rows,
    state: defaultViewState(),
    defaultTableColumns: 4,
  });
  await expect(page.locator("#status-bar")).toHaveText("Showing 20,000 of 20,000 rows");
  await expect(page.locator("#pager-row-range")).toHaveText("Rows 1–100 of 20,000");
});
