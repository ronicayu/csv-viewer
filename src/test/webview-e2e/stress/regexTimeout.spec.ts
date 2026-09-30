// Regex-timeout watchdog: a catastrophically backtracking regex filter
// rule (e.g. `(a+)+$` against a pathological "aaaa...b" value) would
// otherwise hang the worker's single JS thread forever on `RegExp.test`.
// The main thread arms a 2000ms timer per query that contains an enabled,
// syntactically-valid regex rule; if it fires, the stuck worker is
// terminated and replaced, the offending rule(s) are marked "too slow" and
// excluded from the next query (ignored the same way an invalid regex is
// ignored), and the filter panel shows "Regex too slow — rule disabled".
// Because parsing/filtering/sorting live in a worker (not the main
// thread), the page itself never freezes while this plays out — proven
// here by clicking "Next page" *during* the stuck window and getting a
// working result once the watchdog recovers.

import { expect, test } from "@playwright/test";
import { bootAndLoadText, defaultViewState } from "../harness";
import { toCsvText, trackConsoleErrors } from "./stressHelpers";

test("a catastrophic regex rule is marked 'too slow' within ~3s while the UI stays responsive — clicking Next page during the wait still works", async ({
  page,
}) => {
  test.setTimeout(20_000);
  const consoleErrors = trackConsoleErrors(page);

  // Row 0's value is the classic (a+)+$ pathological input (30 a's + a
  // trailing non-matching "b" is already enough to blow up well past our
  // 2s watchdog — see src/test/stress/filter.stress.test.ts, which
  // confirms this exact pattern doesn't resolve within 2s via a
  // subprocess timeout). 250 rows total (2 pager pages at the default
  // page size of 100) so there's somewhere to navigate to.
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
  await rule.locator("select").nth(0).selectOption("val");
  await rule.locator("select").nth(1).selectOption("regex");
  await rule.locator('input[type="text"]').fill("(a+)+$");

  // Give the debounced value-change a moment to actually send the query
  // (150ms) so the regex watchdog is armed, then immediately try to
  // navigate — the worker is (or is about to be) stuck running the regex
  // against row 0, but the main thread must still respond to this click
  // quickly, proving it was never blocked.
  await page.waitForTimeout(300);
  const clickStart = Date.now();
  await page.locator("#pager-next-btn").click();
  const clickMs = Date.now() - clickStart;
  expect(clickMs).toBeLessThan(1_000); // the click itself must never hang

  // Within ~3s the watchdog fires (2000ms timeout), terminates the stuck
  // worker, and the rule is marked disabled.
  await expect(rule.locator(".rule-error-text")).toHaveText("Regex too slow — rule disabled", { timeout: 3_000 });
  await expect(rule).toHaveClass(/rule-error/);

  // The disabled rule is ignored (like an invalid regex), so every row is
  // shown again — and the page navigation requested *during* the stuck
  // window is honored once the worker recovers.
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
  await rule.locator("select").nth(0).selectOption("val");
  await rule.locator("select").nth(1).selectOption("regex");
  const valueInput = rule.locator('input[type="text"]');
  await valueInput.fill("(a+)+$");

  await expect(rule.locator(".rule-error-text")).toHaveText("Regex too slow — rule disabled", { timeout: 3_000 });

  // Editing the value clears the mark immediately (before any requery
  // even answers) and the rule gets a fresh chance with a safe pattern.
  await valueInput.fill("normal");
  await expect(rule.locator(".rule-error-text")).toBeHidden();
  await expect(page.locator("#status-bar")).toHaveText("Showing 49 of 50 rows");
});
