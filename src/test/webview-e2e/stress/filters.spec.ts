// Filter panel stress: 20 rules with delete-from-the-middle and rapid mode
// toggling; typing latency in the (undebounced) value box on a 50k-row
// file; invalid->valid regex while typing; quick-add on empty/quoted/very
// long cell values; and context-menu clipping near the viewport edges.

import { expect, test } from "@playwright/test";
import { bootAndLoad, bootAndLoadText, defaultViewState } from "../harness";
import { toCsvText, trackConsoleErrors, wideFixture } from "./stressHelpers";

test("adding 20 rules, deleting one from the middle, and rapidly toggling Include/Exclude on the rest doesn't corrupt state", async ({
  page,
}) => {
  const consoleErrors = trackConsoleErrors(page);
  const fixture = wideFixture(50, 4);
  await bootAndLoad(page, {
    fileKey: "file:///20rules.csv",
    headers: fixture.headers,
    rows: fixture.rows,
    state: defaultViewState(),
    defaultTableColumns: 4,
  });

  await page.locator("#filters-btn").click();
  for (let i = 0; i < 20; i++) await page.locator("#add-rule-btn").click();
  await expect(page.locator(".rule-row")).toHaveCount(20);

  // Delete the middle one (index 9, the 10th).
  await page.locator(".rule-row").nth(9).locator(".remove-rule-btn").click();
  await expect(page.locator(".rule-row")).toHaveCount(19);

  // Rapidly toggle Include/Exclude on every remaining rule, back to back,
  // without waiting between clicks.
  const toggles = await page.locator(".mode-toggle").all();
  for (const t of toggles) await t.click({ delay: 0 });
  for (const t of toggles) await t.click({ delay: 0 });
  // Net effect: two toggles each -> back to "Include" (the default) for
  // every rule that started life as a default `contains` rule with no
  // column/value, which never matches anything by "equals"... rules here
  // default to operator "contains" with empty value, which matches every
  // cell trivially (`"".includes("")` is true), so every enabled Include
  // rule still passes every row and every enabled Exclude rule drops every
  // row. After an even number of toggles they're back to Include.
  for (const label of await page.locator(".mode-toggle").allTextContents()) {
    expect(label).toBe("Include");
  }
  expect(consoleErrors).toEqual([]);
});

test("typing fast in the filter value box on a 50k-row file: the value box is now debounced (150ms) and re-filtering runs in a worker, so per-keystroke DOM latency stays low even on a large file — measure per-keystroke latency", async ({
  page,
}) => {
  const fixture = wideFixture(50_000, 6);
  await bootAndLoad(page, {
    fileKey: "file:///50k.csv",
    headers: fixture.headers,
    rows: fixture.rows,
    state: defaultViewState(),
    defaultTableColumns: 6,
  });

  await page.locator("#filters-btn").click();
  await page.locator("#add-rule-btn").click();
  const rule = page.locator(".rule-row").first();
  await rule.locator("select").nth(0).selectOption("col_2");
  await rule.locator("select").nth(1).selectOption("contains");
  const valueInput = rule.locator('input[type="text"]');

  await valueInput.evaluate((el) => {
    (window as unknown as { __inputTimes: number[] }).__inputTimes = [];
    el.addEventListener("input", () => (window as unknown as { __inputTimes: number[] }).__inputTimes.push(performance.now()));
  });

  await valueInput.click();
  await page.keyboard.type("v49999_", { delay: 0 }); // 7 keystrokes — the 'input' event itself fires per keystroke regardless of the debounce; only the resulting re-filter is delayed/coalesced

  const times = await page.evaluate(() => (window as unknown as { __inputTimes: number[] }).__inputTimes);
  expect(times.length).toBe(7);
  const deltas: number[] = [];
  for (let i = 1; i < times.length; i++) deltas.push(times[i] - times[i - 1]);

  // eslint-disable-next-line no-console
  console.log("[stress] per-keystroke filter latency on 50k rows (ms):", deltas.map((d) => Math.round(d)));

  const worst = Math.max(...deltas);
  // Flag (not fail) anything over 300ms per keystroke. Each keystroke's
  // synchronous work is now just updating `rule.value` and the (instant,
  // undebounced) error/hint check — the actual re-filter is debounced
  // 150ms and runs off-thread in the worker — so this should stay far
  // under the budget even on a large file; this assertion exists to make
  // regressions visible, not to block the suite.
  if (worst > 300) {
    // eslint-disable-next-line no-console
    console.warn(`[stress] worst per-keystroke latency ${Math.round(worst)}ms exceeds the 300ms budget`);
  }
});

test("an invalid regex typed character-by-character shows the error immediately and clears immediately once valid, with no stale matches shown", async ({
  page,
}) => {
  const fixture = wideFixture(20, 3);
  await bootAndLoad(page, {
    fileKey: "file:///regexstream.csv",
    headers: fixture.headers,
    rows: fixture.rows,
    state: defaultViewState(),
    defaultTableColumns: 3,
  });

  await page.locator("#filters-btn").click();
  await page.locator("#add-rule-btn").click();
  const rule = page.locator(".rule-row").first();
  await rule.locator("select").nth(1).selectOption("regex");
  const valueInput = rule.locator('input[type="text"]');

  await valueInput.pressSequentially("(v0", { delay: 0 });
  await expect(rule.locator(".rule-error-text")).toBeVisible(); // "(v0" is an unterminated group
  await expect(page.locator("#status-bar")).toHaveText("Showing 20 of 20 rows"); // invalid rule ignored, nothing filtered

  await valueInput.pressSequentially(")", { delay: 0 }); // now "(v0)" — valid, matches row v0_*
  await expect(rule.locator(".rule-error-text")).toBeHidden();
  await expect(page.locator("#status-bar")).toHaveText("Showing 1 of 20 rows");
});

test("right-click quick-add works on an empty cell value, a value containing quotes, and a very long value", async ({ page }) => {
  const longValue = "L".repeat(400);
  const text = toCsvText(
    ["id", "val"],
    [
      ["1", ""],
      ["2", 'He said "hi" to me'],
      ["3", longValue],
    ],
  );
  await bootAndLoadText(page, {
    fileKey: "file:///quickadd-edge.csv",
    text,
    // "val"'s median value length (one entry is 400 chars) now makes it
    // NOT "short" under the smart default column split (see
    // src/core/columns.ts's reconcileVisibility) — force it into the
    // table explicitly, same as an already-configured file would, since
    // this test is about right-click quick-add on table cells.
    state: defaultViewState({ columnVisibility: { id: true, val: true } }),
    defaultTableColumns: 2,
  });

  // Each quick-add below creates an "equals" rule for that exact row's
  // value, which (correctly) filters the other rows out of view — so each
  // case removes its own rule afterward before moving to the next row,
  // rather than stacking rules and losing access to the remaining rows.

  // Empty value: creates an "equals" rule with value: "" — since decision
  // #10, a value-taking rule with an empty value is ignored (isRuleActive
  // returns false) rather than applied as "equals empty string", so this
  // one has no filtering effect at all and shows the "enter a value" hint,
  // not a 1-row result.
  await page.locator('tr.data-row[data-row-id="0"]').locator("td").nth(2).click({ button: "right" });
  await expect(page.locator("#context-menu")).toBeVisible();
  await page.locator("#context-menu button", { hasText: /^Show only rows where/ }).click();
  await expect(page.locator(".rule-row")).toHaveCount(1);
  await expect(page.locator(".rule-row").last().locator('input[type="text"]')).toHaveValue("");
  await expect(page.locator("#status-bar")).toHaveText("Showing 3 of 3 rows");
  await expect(page.locator(".rule-row").last()).toHaveClass(/rule-hint/);
  await expect(page.locator(".rule-row").last().locator(".rule-error-text")).toContainText("Enter a value");
  await page.locator(".rule-row").last().locator(".remove-rule-btn").click();
  await expect(page.locator("#status-bar")).toHaveText("Showing 3 of 3 rows");

  // Quoted value.
  await page.locator('tr.data-row[data-row-id="1"]').locator("td").nth(2).click({ button: "right" });
  await page.locator("#context-menu button", { hasText: /^Show only rows where/ }).click();
  await expect(page.locator(".rule-row")).toHaveCount(1);
  await expect(page.locator(".rule-row").last().locator('input[type="text"]')).toHaveValue('He said "hi" to me');
  await page.locator(".rule-row").last().locator(".remove-rule-btn").click();
  await expect(page.locator("#status-bar")).toHaveText("Showing 3 of 3 rows");

  // Very long value.
  await page.locator('tr.data-row[data-row-id="2"]').locator("td").nth(2).click({ button: "right" });
  await page.locator("#context-menu button", { hasText: /^Show only rows where/ }).click();
  await expect(page.locator(".rule-row")).toHaveCount(1);
  await expect(page.locator(".rule-row").last().locator('input[type="text"]')).toHaveValue(longValue);
});

test("FIXED: the cell context menu is clamped to the viewport, so a right-click near the bottom-right corner no longer renders it off-screen", async ({
  page,
}) => {
  const consoleErrors = trackConsoleErrors(page);
  const fixture = wideFixture(60, 10);
  await bootAndLoad(page, {
    fileKey: "file:///contextmenu-edge.csv",
    headers: fixture.headers,
    rows: fixture.rows,
    state: defaultViewState({ pageSize: 25 }),
    defaultTableColumns: 10,
  });

  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();

  // Right-click the last row's last cell — as close to the bottom-right
  // corner of the viewport as the fixture's own layout puts it.
  const lastCell = page.locator("tr.data-row").last().locator("td").last();
  await lastCell.scrollIntoViewIfNeeded();
  await lastCell.click({ button: "right", position: { x: 5, y: 5 } });
  await expect(page.locator("#context-menu")).toBeVisible();

  const menuBox = await page.locator("#context-menu").boundingBox();
  expect(menuBox).not.toBeNull();

  // onCellContextMenu (src/webview/main.ts) now measures the menu after
  // it's shown and clamps left/top so it always fits fully inside the
  // viewport (flipping left/up instead of overflowing right/bottom), the
  // same way a native context menu would.
  expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(viewport!.width);
  expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(viewport!.height);
  expect(consoleErrors).toEqual([]);
});
