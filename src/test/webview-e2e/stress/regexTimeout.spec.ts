import { expect, test, type Page } from "@playwright/test";
import { bootAndLoadText, bootShell, defaultViewState } from "../harness";
import { toCsvText, trackConsoleErrors } from "./stressHelpers";
import type { ViewState } from "../../../core/types";

test("a catastrophic regex rule is marked 'too slow' within ~3s while the UI stays responsive — clicking Next page during the wait still works", async ({
  page,
}) => {
  test.setTimeout(20_000);
  const consoleErrors = trackConsoleErrors(page);

  // Row 0 is pathological for (a+)+$; 250 rows give the pager a second page to navigate to.
  const pathological = "a".repeat(40) + "b";
  const rows: string[][] = [["0", pathological]];
  for (let i = 1; i < 250; i++) rows.push([String(i), `normal-${i}`]);
  const text = toCsvText(["id", "val"], rows);

  await bootAndLoadText(page, {
    fileKey: "file:///regex-timeout.csv",
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

  // Wait past the 150ms debounce so the query is sent and the watchdog is armed.
  await page.waitForTimeout(300);
  const clickStart = Date.now();
  await page.locator("#pager-next-btn").click();
  const clickMs = Date.now() - clickStart;
  expect(clickMs).toBeLessThan(1_000);

  await expect(rule.locator(".rule-error-text")).toHaveText("Skipped: pattern took over 2 s. Edit it to retry.", { timeout: 3_000 });
  await expect(rule).toHaveClass(/rule-error/);

  await expect(page.locator("#status-bar")).toHaveText("Showing 250 of 250 rows");
  await expect(page.locator("#pager-page-input")).toHaveValue("2");

  expect(consoleErrors).toEqual([]);
});

test("editing a timed-out rule's value clears the 'too slow' mark and re-queries", async ({ page }) => {
  test.setTimeout(20_000);
  const pathological = "a".repeat(40) + "b";
  const rows: string[][] = [["0", pathological]];
  for (let i = 1; i < 50; i++) rows.push([String(i), `normal-${i}`]);
  const text = toCsvText(["id", "val"], rows);

  await bootAndLoadText(page, {
    fileKey: "file:///regex-timeout-edit.csv",
    text,
    state: defaultViewState(),
    defaultTableColumns: 2,
  });

  await page.locator("#filters-btn").click();
  await page.locator("#add-rule-btn").click();
  const rule = page.locator(".rule-row").first();
  await rule.locator('select[aria-label="Column"]').selectOption("val");
  await rule.locator('select[aria-label="Condition"]').selectOption("regex");
  const valueInput = rule.locator('input[type="text"]');
  await valueInput.fill("(a+)+$");

  await expect(rule.locator(".rule-error-text")).toHaveText("Skipped: pattern took over 2 s. Edit it to retry.", { timeout: 3_000 });

  await valueInput.fill("normal");
  await expect(rule.locator(".rule-error-text")).toBeHidden();
  await expect(page.locator("#status-bar")).toHaveText("Showing 49 of 50 rows");
});

// Big enough that the quick search is still running, small enough to stay clear of the 2s watchdog.
const RACE_ROWS = 150_000;
const RACE_COLS = 20;
// Only in each row's last column, so a quick search scans every other column before matching.
const MARKER = "zzzsearchmarker";
// Slow to reject with (a+)+$ but far under 2s; in a single row to bound the total cost.
const SLOW_BUT_FINITE = "a".repeat(18) + "b";
const PATHOLOGICAL_ROW_IDS = [0];

// Generated in the page: tens of MB through Playwright's arguments would skew the timing.
async function loadRaceFixture(page: Page, state: ViewState): Promise<void> {
  await page.evaluate(
    ({ rows, cols, marker, slowButFinite, pathologicalRowIds, state }) => {
      const headers: string[] = [];
      for (let i = 0; i < cols; i++) headers.push(`col_${i + 1}`);
      const pathological = new Set<number>(pathologicalRowIds);
      const lines: string[] = [headers.join(",")];
      for (let r = 0; r < rows; r++) {
        const cells: string[] = [];
        for (let c = 0; c < cols; c++) {
          if (c === 0) cells.push(String(r));
          else if (c === 2) cells.push(pathological.has(r) ? slowButFinite : `v${r}_3`);
          else if (c === cols - 1) cells.push(`v${r}_${cols}${marker}`);
          else cells.push(`v${r}_${c + 1}`);
        }
        lines.push(cells.join(","));
      }
      const text = lines.join("\n");
      window.postMessage(
        { type: "load", fileKey: "file:///regex-race.csv", text, state, defaultTableColumns: 8, defaultDelimiter: "" },
        "*",
      );
    },
    { rows: RACE_ROWS, cols: RACE_COLS, marker: MARKER, slowButFinite: SLOW_BUT_FINITE, pathologicalRowIds: PATHOLOGICAL_ROW_IDS, state },
  );
  await expect(page.locator("tr.data-row").first()).toBeVisible();
}

test("a slow-but-finite legitimate regex, queued right behind another in-flight query, is NOT marked too slow", async ({
  page,
}) => {
  test.setTimeout(30_000);
  const consoleErrors = trackConsoleErrors(page);
  await bootShell(page);
  await loadRaceFixture(page, defaultViewState());

  await page.locator("th", { hasText: "col_2" }).click();
  await expect(page.locator("th", { hasText: "col_2" })).toHaveAttribute("aria-sort", "ascending");

  await page.locator("#filters-btn").click();
  await page.locator("#add-rule-btn").click();
  const rule = page.locator(".rule-row").first();
  await rule.locator('select[aria-label="Column"]').selectOption("col_3");
  await rule.locator('select[aria-label="Condition"]').selectOption("regex");

  await page.locator("#quick-search").fill(MARKER);

  // No wait: both debounce timers share 150ms, so this queues right behind the quick search query.
  await rule.locator('input[type="text"]').fill("(a+)+$");

  // The regex matches no row, so 'Showing 0' proves it ran; 'too slow' would show every row.
  await expect(page.locator("#status-bar")).toHaveText(`Showing 0 of ${RACE_ROWS.toLocaleString()} rows`, { timeout: 10_000 });

  await expect(rule.locator(".rule-error-text")).toBeHidden();
  await expect(rule).not.toHaveClass(/rule-error/);

  expect(consoleErrors).toEqual([]);
});
