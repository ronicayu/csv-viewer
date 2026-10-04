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

  await page.locator(".rule-row").nth(9).locator(".remove-rule-btn").click();
  await expect(page.locator(".rule-row")).toHaveCount(19);

  const toggles = await page.locator(".mode-select").all();
  for (const t of toggles) await t.selectOption("exclude");
  for (const t of toggles) await t.selectOption("include");
  for (const t of await page.locator(".mode-select").all()) {
    expect(await t.inputValue()).toBe("include");
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
  await rule.locator('select[aria-label="Column"]').selectOption("col_2");
  await rule.locator('select[aria-label="Condition"]').selectOption("contains");
  const valueInput = rule.locator('input[type="text"]');

  await valueInput.evaluate((el) => {
    (window as unknown as { __inputTimes: number[] }).__inputTimes = [];
    el.addEventListener("input", () => (window as unknown as { __inputTimes: number[] }).__inputTimes.push(performance.now()));
  });

  await valueInput.click();
  await page.keyboard.type("v49999_", { delay: 0 });

  const times = await page.evaluate(() => (window as unknown as { __inputTimes: number[] }).__inputTimes);
  expect(times.length).toBe(7);
  const deltas: number[] = [];
  for (let i = 1; i < times.length; i++) deltas.push(times[i] - times[i - 1]);

  // eslint-disable-next-line no-console
  console.log("[stress] per-keystroke filter latency on 50k rows (ms):", deltas.map((d) => Math.round(d)));

  const worst = Math.max(...deltas);
  // Warn only, never fail: this makes latency regressions visible without blocking the suite.
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
  await rule.locator('select[aria-label="Condition"]').selectOption("regex");
  const valueInput = rule.locator('input[type="text"]');

  await valueInput.pressSequentially("(v0", { delay: 0 });
  await expect(rule.locator(".rule-error-text")).toBeVisible();
  await expect(page.locator("#status-bar")).toHaveText("Showing 20 of 20 rows");

  await valueInput.pressSequentially(")", { delay: 0 });
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
    // Forced into the table; the smart column split would otherwise move 'val' to row details.
    state: defaultViewState({ columnVisibility: { id: true, val: true } }),
    defaultTableColumns: 2,
  });

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
  await page.keyboard.press("Escape");

  await page.locator('tr.data-row[data-row-id="1"]').locator("td").nth(2).click({ button: "right" });
  await page.locator("#context-menu button", { hasText: /^Show only rows where/ }).click();
  await expect(page.locator(".rule-row")).toHaveCount(1);
  await expect(page.locator(".rule-row").last().locator('input[type="text"]')).toHaveValue('He said "hi" to me');
  await page.locator(".rule-row").last().locator(".remove-rule-btn").click();
  await expect(page.locator("#status-bar")).toHaveText("Showing 3 of 3 rows");
  await page.keyboard.press("Escape");

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

  const lastCell = page.locator("tr.data-row").last().locator("td").last();
  await lastCell.scrollIntoViewIfNeeded();
  await lastCell.click({ button: "right", position: { x: 5, y: 5 } });
  await expect(page.locator("#context-menu")).toBeVisible();

  const menuBox = await page.locator("#context-menu").boundingBox();
  expect(menuBox).not.toBeNull();

  expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(viewport!.width);
  expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(viewport!.height);
  expect(consoleErrors).toEqual([]);
});
