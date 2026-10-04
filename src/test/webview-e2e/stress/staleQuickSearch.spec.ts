import { expect, test } from "@playwright/test";
import { bootShell, defaultViewState } from "../harness";
import { trackConsoleErrors } from "./stressHelpers";
import type { ViewState } from "../../../core/types";

// Generated in the page so shipping ~57MB through Playwright arguments doesn't dominate the timing.
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
        { type: "load", fileKey: "file:///stale-search.csv", text, state, defaultTableColumns: 8, defaultDelimiter: "", testHooks: true, hintsSeen: [] },
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

  await expect(page.locator("#status-bar")).toHaveText(`Showing ${ROWS.toLocaleString()} of ${ROWS.toLocaleString()} rows`);

  await page.evaluate(() => {
    const el = document.getElementById("status-bar")!;
    (window as unknown as { __statusHistory: string[] }).__statusHistory = [el.textContent ?? ""];
    new MutationObserver(() => {
      (window as unknown as { __statusHistory: string[] }).__statusHistory.push(el.textContent ?? "");
    }).observe(el, { characterData: true, childList: true, subtree: true });
  });

  const searchA = "v0_1";
  const searchAText = `Showing 1 of ${ROWS.toLocaleString()} rows`;
  const searchB = "";
  const searchBText = `Showing ${ROWS.toLocaleString()} of ${ROWS.toLocaleString()} rows`;

  // Both inputs are driven in-page: two Playwright calls can be seconds apart on a busy machine.
  await page.evaluate(
    ({ a, b }) =>
      new Promise<void>((resolve) => {
        const w = window as unknown as { __workerQueryCount?: number };
        const input = document.getElementById("quick-search") as HTMLInputElement;
        const sentBefore = w.__workerQueryCount ?? 0;
        input.value = a;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        const poll = (): void => {
          if ((w.__workerQueryCount ?? 0) > sentBefore) {
            input.value = b;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            resolve();
          } else {
            setTimeout(poll, 5);
          }
        };
        poll();
      }),
    { a: searchA, b: searchB },
  );

  await expect(page.locator("#status-bar")).toHaveText(searchBText);
  await expect(page.locator("tr.data-row")).toHaveCount(100);

  const history = await page.evaluate(() => (window as unknown as { __statusHistory: string[] }).__statusHistory);
  expect(history).not.toContain(searchAText);
  expect(history[history.length - 1]).toBe(searchBText);

  expect(consoleErrors).toEqual([]);
});
