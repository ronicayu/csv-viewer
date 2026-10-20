import { expect, test } from "@playwright/test";
import { bootShell, defaultViewState, pushLoadText } from "./harness";

const load = { fileKey: "file:///warm.csv", text: "id,name\n1,Alice\n2,Bob\n", state: defaultViewState(), defaultTableColumns: 4 };

test.describe("worker start-up", () => {
  test("the worker script is requested once the webview is ready, before any load, and a load reuses that worker", async ({ page }) => {
    let requests = 0;
    await bootShell(page, { onWorkerRequest: () => requests++ });
    await expect.poll(() => requests).toBe(1);

    await pushLoadText(page, load);
    await expect(page.locator("tr.data-row")).toHaveCount(2);
    expect(requests).toBe(1);
  });

  test("a failed pre-warm is not remembered: the next load fetches the worker again and renders", async ({ page }) => {
    let requests = 0;
    await bootShell(page, { onWorkerRequest: () => requests++, failWorkerRequests: 1 });
    await expect.poll(() => requests).toBe(1);

    await pushLoadText(page, load);
    await expect(page.locator("tr.data-row")).toHaveCount(2);
    expect(requests).toBe(2);
  });

  test("a load that arrives while the worker is still starting waits for it and renders", async ({ page }) => {
    await bootShell(page, { workerDelayMs: 1500 });
    await pushLoadText(page, load);
    await expect(page.locator("#status-bar")).toHaveText("Loading…");
    await expect(page.locator("tr.data-row")).toHaveCount(2);
  });
});
