// Stale-response guard: every query sent to the worker carries a
// monotonically increasing request id, echoed back unchanged; the main
// thread only ever acts on a queryResult/pageResult whose id matches the
// *latest* request it sent, so an older, slower-to-answer query can never
// clobber a newer one's already-in-flight (or already-rendered) result —
// see requery()/onQueryResult in src/webview/main.ts. The worker processes
// messages strictly in the order it receives them, so the only way to
// observe this from outside is to make the FIRST query slow enough that
// it's still being computed when the SECOND one is sent, then prove the
// first query's answer never reaches the DOM once it does arrive.

import { expect, test } from "@playwright/test";
import { bootShell, defaultViewState } from "../harness";
import { trackConsoleErrors } from "./stressHelpers";
import type { ViewState } from "../../../core/types";

// Quick search over every column of a large, wide fixture is genuinely
// slow (measured ~300-500ms at this shape — see scale.spec.ts and
// src/test/stress/performance.stress.test.ts's "quick search alone over
// 500k rows" benchmark), which is what gives the first search term a
// real window to still be in flight when the second one is sent 200ms
// later. Generated inside the page (not passed as a Playwright `evaluate`
// argument) so building/transmitting the ~57MB fixture text itself never
// dominates the timing — see scale.spec.ts's pushGeneratedLoad for why.
const ROWS = 200_000;
const COLS = 30;

async function loadWideFixtureInBrowser(
  page: import("@playwright/test").Page,
  state: ViewState,
): Promise<void> {
  await page.evaluate(
    ({ rows, cols, state }) => {
      const headers: string[] = [];
      for (let i = 0; i < cols; i++) headers.push(`col_${i + 1}`);
      const lines: string[] = [headers.join(",")];
      for (let r = 0; r < rows; r++) {
        const cells: string[] = [];
        for (let c = 0; c < cols; c++) cells.push(c === 0 ? String(r) : `v${r}_${c}`);
        lines.push(cells.join(","));
      }
      const text = lines.join("\n");
      window.postMessage(
        { type: "load", fileKey: "file:///stale-search.csv", text, state, defaultTableColumns: 8, defaultDelimiter: "" },
        "*",
      );
    },
    { rows: ROWS, cols: COLS, state },
  );
  await expect(page.locator("tr.data-row").first()).toBeVisible();
}

test("a slow-to-answer quick search never overwrites a newer one's result, even once its (stale) answer arrives", async ({
  page,
}) => {
  test.setTimeout(30_000);
  const consoleErrors = trackConsoleErrors(page);
  await bootShell(page);
  await loadWideFixtureInBrowser(page, defaultViewState());

  // Baseline: no search yet, every row matches.
  await expect(page.locator("#status-bar")).toHaveText(`Showing ${ROWS.toLocaleString()} of ${ROWS.toLocaleString()} rows`);

  // Record every distinct value #status-bar's text ever takes on, from
  // just before the first search term is typed onward, so we can inspect
  // the *entire* history afterward rather than only the final value.
  await page.evaluate(() => {
    const el = document.getElementById("status-bar")!;
    (window as unknown as { __statusHistory: string[] }).__statusHistory = [el.textContent ?? ""];
    new MutationObserver(() => {
      (window as unknown as { __statusHistory: string[] }).__statusHistory.push(el.textContent ?? "");
    }).observe(el, { characterData: true, childList: true, subtree: true });
  });

  const searchA = "v0_1"; // unique to exactly one row (row 0's col_2) — a distinctly different count from B
  const searchAText = `Showing 1 of ${ROWS.toLocaleString()} rows`;
  const searchB = ""; // cleared — matches every row again
  const searchBText = `Showing ${ROWS.toLocaleString()} of ${ROWS.toLocaleString()} rows`;

  await page.locator("#quick-search").fill(searchA);
  // Long enough for A's debounce (150ms) to fire and its query to reach
  // the worker, nowhere near long enough for that query to finish
  // (quick search across every column of 200k x 30 rows is the ~300-500ms
  // operation this test relies on being slow).
  await page.waitForTimeout(200);
  await page.locator("#quick-search").fill(searchB);

  // Once everything settles, the *only* thing that should ever have
  // rendered is B's result — A's answer, however late it arrives from the
  // worker, must never reach the DOM.
  await expect(page.locator("#status-bar")).toHaveText(searchBText);
  await expect(page.locator("tr.data-row")).toHaveCount(100); // page 1 of the full, unfiltered set

  const history = await page.evaluate(() => (window as unknown as { __statusHistory: string[] }).__statusHistory);
  // The full status-bar history recorded from just before A was typed:
  // it may show the baseline and B's final text, but A's text (which
  // would only appear if A's stale, late-arriving answer were rendered)
  // must never appear.
  expect(history).not.toContain(searchAText);
  expect(history[history.length - 1]).toBe(searchBText);

  expect(consoleErrors).toEqual([]);
});
