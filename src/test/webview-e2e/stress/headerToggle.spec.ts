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

test("a column-visibility customization survives toggling 'first row is header' off and back on, since the header names end up unchanged", async ({
  page,
}) => {
  // FIXED: reconcileVisibility (src/core/columns.ts) now merges rather
  // than replaces — every entry from the previous visibility map is
  // carried forward, including ones for header names not in the
  // *current* header list. So "b: false" survives being carried through
  // the intermediate reconciliation against the synthetic column_1..N
  // headers (while "first row is header" is off), and reappears once the
  // real a/b/c/d names come back.
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

  await expect(page.locator("th", { hasText: "b" })).toHaveCount(0);
});
