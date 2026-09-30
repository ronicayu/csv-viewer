// "First row is header" toggled on/off repeatedly: does it survive without
// errors, and do column visibility customizations survive a full round
// trip (off, then back on)?

import { expect, test } from "@playwright/test";
import { bootAndLoadText, defaultViewState } from "../harness";
import { trackConsoleErrors } from "./stressHelpers";

test("toggling 'first row is header' off and on 10 times in a row never throws and always leaves a consistent table", async ({
  page,
}) => {
  const consoleErrors = trackConsoleErrors(page);
  const text = "a,b,c\n1,2,3\n4,5,6\n7,8,9";
  await bootAndLoadText(page, {
    fileKey: "file:///toggle-stress.csv",
    text,
    state: defaultViewState(),
    defaultTableColumns: 3,
  });

  const checkbox = page.locator("#first-row-header");
  for (let i = 0; i < 10; i++) {
    await checkbox.uncheck();
    await expect(page.locator("th", { hasText: "column_1" })).toHaveCount(1);
    await checkbox.check();
    await expect(page.locator("th.sortable")).toHaveCount(3);
    await expect(page.locator("th", { hasText: "column_1" })).toHaveCount(0); // back to real header names
  }
  expect(consoleErrors).toEqual([]);
});

test("BUG: a column-visibility customization is lost after toggling 'first row is header' off and back on, even though the header names end up unchanged", async ({
  page,
}) => {
  test.fail(); // see comment below for expected behavior
  const text = "a,b,c,d\n1,2,3,4\n5,6,7,8";
  await bootAndLoadText(page, {
    fileKey: "file:///toggle-visibility.csv",
    text,
    state: defaultViewState(),
    defaultTableColumns: 4, // all visible to start
  });

  // Hide "b".
  await page.locator("#columns-btn").click();
  await page.locator(".column-row", { hasText: "b" }).locator('input[type="checkbox"]').uncheck();
  await expect(page.locator("th", { hasText: "b" })).toHaveCount(0);

  // Toggle "first row is header" off, then immediately back on. The text
  // hasn't changed and firstRowIsHeader ends up back at its original
  // value (true) — from the user's perspective this round trip should be
  // a no-op.
  await page.locator("#first-row-header").uncheck();
  await page.locator("#first-row-header").check();

  // Expected: "b" is still hidden — reparseFromText (src/webview/main.ts)
  // should reconcile visibility by header *name* across the whole round
  // trip, and "b" is exactly the name it started and ended with.
  // Actual: turning the checkbox off re-parses with synthetic headers
  // (column_1..column_4), and reconcileVisibility (src/core/columns.ts)
  // only compares against the *immediately previous* map — which is now
  // keyed by column_1..column_4, not a/b/c/d. Turning it back on treats
  // "b" as a brand-new column name (no matching key in that intermediate
  // map) and reapplies the default-N rule, silently un-hiding it.
  await expect(page.locator("th", { hasText: "b" })).toHaveCount(0); // fails: "b" is visible again
});
