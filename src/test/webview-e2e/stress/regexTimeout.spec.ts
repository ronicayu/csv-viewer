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
//
// The watchdog's 2s window only starts once the worker actually begins
// running a request (`queryStarted`) and is disarmed the moment filtering
// finishes (`filterDone`, before sorting even starts) — never from when
// the request was merely sent. Otherwise a perfectly fine (if slow)
// regex, queued behind an earlier still-processing query (or paired with
// a slow sort), could be falsely marked "too slow" for time it spent
// waiting its turn in the worker's single-threaded mailbox, not running.

import { expect, test, type Page } from "@playwright/test";
import { bootAndLoadText, bootShell, defaultViewState } from "../harness";
import { toCsvText, trackConsoleErrors } from "./stressHelpers";
import type { ViewState } from "../../../core/types";

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

// Large enough that the "ahead" quick search is genuinely still running
// (not already answered) a moment later when the regex query is queued
// behind it, but small enough that the combined cost of both phases
// keeps a comfortable margin under the 2000ms watchdog even under real
// concurrent load on a shared machine — 200k rows' worth of full-row
// quick-search scanning plus regex overhead did not leave that margin.
const RACE_ROWS = 150_000;
const RACE_COLS = 20;
/** Present in every row's LAST column only, so a quick search for it
 * forces `applyFilters`'s per-row `.some()` to check every *other*
 * column first (all failing) before finally matching — i.e. a genuine
 * full-row scan, not an early exit on the first cell. */
const MARKER = "zzzsearchmarker";
/** (a+)+$ against this doesn't resolve instantly, but nowhere near 2s
 * either — see src/test/stress/filter.stress.test.ts's timing table
 * ("18": "~73ms"). Placed in just one row, not all of them, so the
 * *total* filter-phase cost stays comfortably bounded. */
const SLOW_BUT_FINITE = "a".repeat(18) + "b";
const PATHOLOGICAL_ROW_IDS = [0];

/** Generates the fixture text INSIDE the page and posts `load` directly,
 * rather than passing the (tens-of-MB) text through Playwright's own
 * Node -> browser argument serialization, which would itself cost real
 * time and confound this test's timing — see scale.spec.ts's
 * pushGeneratedLoad for the same reasoning. */
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

  // A sort is already active (and, by clicking it once here, its
  // column's sort-key cache is already warmed — see core/sort.ts /
  // worker.ts) by the time the race below happens, matching the
  // documented scenario ("with a sort active").
  await page.locator("th", { hasText: "col_2" }).click();
  await expect(page.locator("th", { hasText: "col_2" }).locator(".sort-indicator")).toHaveText("▲");

  // Set up the regex rule's column/operator now, with no value yet —
  // per the no-op query skip (see noopQuery.spec.ts), this sends no
  // query on its own.
  await page.locator("#filters-btn").click();
  await page.locator("#add-rule-btn").click();
  const rule = page.locator(".rule-row").first();
  await rule.locator("select").nth(0).selectOption("col_3");
  await rule.locator("select").nth(1).selectOption("regex");

  // The "ahead" operation: a quick search over every column of 150k rows
  // — genuinely slow (the marker is only in the last column, forcing a
  // near-full-row scan each time), sent first (both this and the regex
  // rule's value below share the same 150ms debounce delay, so this
  // one's underlying query message reaches the worker a few ms before
  // the regex one, regardless of how fast or slow the machine otherwise
  // is — no fixed wall-clock wait to tune here). Since the worker
  // processes messages strictly in the order it receives them, the
  // regex query is genuinely queued behind this one for however long
  // *this* one takes to filter+sort — deliberately not fast (the point
  // of this test).
  await page.locator("#quick-search").fill(MARKER);

  // Immediately queue the regex query right behind it — no wait: both
  // debounce timers (quick search's and this rule-value's) start within
  // a couple of DOM-event dispatches of each other and share the same
  // 150ms delay, so this reliably lands just behind the quick search
  // query without depending on absolute machine speed the way waiting
  // for a "still in flight" signal (e.g. the Working… indicator) would —
  // that signal itself only appears/persists reliably within a specific
  // speed *range* (too fast a machine never shows it; too contended a
  // machine risks the *combined* work exceeding the 2000ms this test
  // means to stay well clear of).
  await rule.locator('input[type="text"]').fill("(a+)+$");

  // `(a+)+$` — anchored only at the end, not the start — never actually
  // matches anything here: every value, pathological or not, ends in a
  // digit or "b", never a bare run of "a"s (that's exactly what makes it
  // slow to reject, not what makes it match). So the regex rule, once
  // correctly evaluated, excludes every row — "Showing 0", not the
  // "Showing 150000" that quick search alone would give. That gap is
  // exactly the proof this test wants: 150000 would mean the regex rule
  // got excluded (marked "too slow"); 0 means it was genuinely
  // evaluated, took its slow-but-finite time, and correctly excluded
  // everything itself. Generous timeout — this is deliberately a
  // multi-hundred-ms operation on 150k rows, and this environment can be
  // under real concurrent load.
  await expect(page.locator("#status-bar")).toHaveText(`Showing 0 of ${RACE_ROWS} rows`, { timeout: 10_000 });

  // The direct check, and the whole point of this test: despite being
  // queued behind another still-running query, the regex rule is never
  // marked "too slow" — it answered (correctly, if slowly) well within
  // its own fresh 2000ms budget, rather than being excluded.
  await expect(rule.locator(".rule-error-text")).toBeHidden();
  await expect(rule).not.toHaveClass(/rule-error/);

  expect(consoleErrors).toEqual([]);
});
