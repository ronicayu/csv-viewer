import { expect, test, type Locator, type Page } from "@playwright/test";
import { awaitPosted, bootAndLoad, bootAndLoadText, clearPosted, defaultViewState, posted, pushLoad } from "./harness";
import { toCsvText, XSS_IMG } from "./stress/stressHelpers";
import type { FilterRule, ViewState } from "../../core/types";

const HEADERS = ["id", "name", "status", "note"];
const ROWS: string[][] = [
  ["1", "Alice", "open", ""],
  ["2", "Bob", "closed", "n2"],
  ["3", "Cara", "open", ""],
  ["4", "Dan", "pending", "n4"],
  ["5", "Eve", "closed", ""],
  ["6", "Fay", "open", "n6"],
];

function inRule(overrides: Partial<FilterRule> = {}): FilterRule {
  return {
    id: "rule-in",
    column: "status",
    operator: "in",
    value: "",
    values: ["open"],
    mode: "include",
    caseSensitive: false,
    enabled: true,
    ...overrides,
  };
}

async function boot(page: Page, state: Partial<ViewState> = {}, rows = ROWS, headers = HEADERS): Promise<void> {
  await bootAndLoad(page, {
    fileKey: "file:///tickets.csv",
    headers,
    rows,
    state: defaultViewState(state),
    defaultTableColumns: headers.length,
    hintsSeen: ["rowDetails"],
  });
  await expect(page.locator("#status-bar")).toHaveText(/^Showing/);
}

const picker = (page: Page): Locator => page.locator("#values-popover");
const funnel = (page: Page, column: string): Locator => page.locator(`#table-head th[data-column="${column}"] .col-filter-btn`);
const rows = (page: Page): Locator => page.locator("#values-list .vp-row");

function valueRow(page: Page, text: string): Locator {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return rows(page).filter({ has: page.locator(".v").filter({ hasText: new RegExp(`^${escaped}$`) }) });
}

async function openPicker(page: Page, column: string): Promise<void> {
  await funnel(page, column).click();
  await expect(picker(page)).toBeVisible();
  await expect(page.locator("#values-list .vp-empty")).toHaveCount(0);
}

async function lastSavedRules(page: Page): Promise<FilterRule[]> {
  const saved = await awaitPosted(page, "saveState");
  return (saved.state as ViewState).filterRules;
}

const statusText = (page: Page): Locator => page.locator("#status-bar");

test.describe("header funnel and values picker", () => {
  test.beforeEach(async ({ page }) => {
    await boot(page);
  });

  test("every sortable header gets a dim funnel button after its sort button, with the documented attributes", async ({ page }) => {
    const ths = page.locator("#table-head th.sortable");
    await expect(ths).toHaveCount(4);
    for (const column of HEADERS) {
      const th = page.locator(`#table-head th[data-column="${column}"]`);
      const buttons = th.locator("button");
      await expect(buttons).toHaveCount(2);
      await expect(buttons.nth(0)).toHaveClass(/col-header-btn/);
      const f = buttons.nth(1);
      await expect(f).toHaveClass(/col-filter-btn/);
      await expect(f).toHaveAttribute("aria-label", `Filter ${column} by values`);
      await expect(f).toHaveAttribute("title", `Filter ${column} by values`);
      await expect(f).toHaveAttribute("aria-haspopup", "dialog");
      await expect(f).toHaveAttribute("aria-expanded", "false");
      await expect(f.locator(".codicon")).toHaveClass(/codicon-filter(?!-)/);
      await expect(f).not.toHaveClass(/active/);
    }
    await expect(page.locator("#table-head th.chevron-col button")).toHaveCount(0);
  });

  test("the funnel is dim at rest, fully opaque on hover, and always opaque in a high-contrast theme", async ({ page }) => {
    const f = funnel(page, "status");
    const opacity = (): Promise<string> => f.evaluate((el) => getComputedStyle(el).opacity);
    expect(Number(await opacity())).toBeCloseTo(0.55, 2);
    await f.hover();
    expect(Number(await opacity())).toBe(1);
    await page.mouse.move(1, 1);
    expect(Number(await opacity())).toBeCloseTo(0.55, 2);
    await page.evaluate(() => document.body.classList.add("vscode-high-contrast"));
    expect(Number(await opacity())).toBe(1);
  });

  test("the funnel does not change the header row's height", async ({ page }) => {
    const height = (): Promise<number> => page.locator("#table-head tr").evaluate((el) => el.getBoundingClientRect().height);
    const withFunnels = await height();
    await page.addStyleTag({ content: ".col-filter-btn { display: none !important; }" });
    expect(await height()).toBe(withFunnels);
  });

  test("a long column name ellipsizes inside the sort button and the funnel is neither shrunk nor clipped", async ({ page }) => {
    const longName = "a_really_long_column_name_that_cannot_possibly_fit_in_this_cell_at_all_ok";
    await boot(page, {}, [["1", "x"]], ["id", longName]);
    // Force a constrained column; an auto-layout table never shrinks below its content.
    await page.addStyleTag({ content: "#table { table-layout: fixed; width: 240px; } th.sortable { width: 100px; }" });
    const th = page.locator(`#table-head th[data-column="${longName}"]`);
    const f = th.locator(".col-filter-btn");
    const [thBox, fBox] = await Promise.all([th.boundingBox(), f.boundingBox()]);
    expect(fBox!.width).toBeGreaterThan(8);
    expect(fBox!.x + fBox!.width).toBeLessThanOrEqual(thBox!.x + thBox!.width + 0.5);
    const label = th.locator(".col-header-label");
    expect(await label.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    expect(await label.evaluate((el) => getComputedStyle(el).textOverflow)).toBe("ellipsis");
  });

  test("clicking the funnel opens the picker for that column, lists its values with counts, and does not sort", async ({ page }) => {
    await clearPosted(page);
    await funnel(page, "status").click();
    const p = picker(page);
    await expect(p).toBeVisible();
    await expect(p).toHaveAttribute("role", "dialog");
    await expect(p).toHaveAttribute("aria-label", "Filter “status” by values");
    await expect(page.locator("#values-title")).toHaveText("Filter “status” by values");
    await expect(page.locator("#values-search")).toBeFocused();
    await expect(page.locator("#values-search")).toHaveAttribute("placeholder", "Search values…");
    await expect(page.locator("#values-search")).toHaveAttribute("type", "search");
    await expect(funnel(page, "status")).toHaveAttribute("aria-expanded", "true");

    await expect(rows(page).locator(".v")).toHaveText(["closed", "open", "pending"]);
    await expect(rows(page).locator(".n")).toHaveText(["2", "3", "1"]);
    await expect(rows(page).locator("input")).toHaveCount(3);
    for (const box of await rows(page).locator("input").all()) await expect(box).toBeChecked();
    await expect(page.locator("#values-select-all")).toHaveText("Select all 3");
    await expect(page.locator("#values-clear")).toHaveText("Clear");
    await expect(page.locator("#values-selected-count")).toHaveText("3 of 3 selected");
    await expect(page.locator("#values-ok")).toBeEnabled();

    const [fBox, pBox] = await Promise.all([funnel(page, "status").boundingBox(), p.boundingBox()]);
    expect(pBox!.y).toBeGreaterThanOrEqual(fBox!.y + fBox!.height);
    expect(pBox!.y).toBeLessThan(fBox!.y + fBox!.height + 20);

    await expect(page.locator('#table-head th[data-column="status"]')).toHaveAttribute("aria-sort", "none");
    expect((await posted(page)).filter((m) => m.type === "saveState")).toEqual([]);
  });

  test("clicking the open funnel again closes the picker; clicking another funnel switches to that column", async ({ page }) => {
    await openPicker(page, "status");
    await funnel(page, "status").click();
    await expect(picker(page)).toBeHidden();
    await expect(funnel(page, "status")).toHaveAttribute("aria-expanded", "false");

    await openPicker(page, "status");
    await funnel(page, "name").click();
    await expect(page.locator("#values-title")).toHaveText("Filter “name” by values");
    await expect(funnel(page, "status")).toHaveAttribute("aria-expanded", "false");
    await expect(funnel(page, "name")).toHaveAttribute("aria-expanded", "true");
  });

  test("opening another popover closes the picker", async ({ page }) => {
    await openPicker(page, "status");
    await page.locator("#columns-btn").click();
    await expect(picker(page)).toBeHidden();
    await expect(page.locator("#columns-popover")).toBeVisible();
  });

  test("unticking a value and pressing OK filters the rows, activates the funnel, and updates the toolbar, panel, and saved state", async ({
    page,
  }) => {
    await openPicker(page, "status");
    await valueRow(page, "pending").locator("input").uncheck();
    await expect(page.locator("#values-selected-count")).toHaveText("2 of 3 selected");
    await expect(statusText(page)).toHaveText("Showing 6 of 6 rows");
    await expect(funnel(page, "status")).not.toHaveClass(/active/);

    await clearPosted(page);
    await page.locator("#values-ok").click();
    await expect(picker(page)).toBeHidden();
    await expect(statusText(page)).toHaveText("Showing 5 of 6 rows");
    await expect(funnel(page, "status")).toHaveClass(/active/);
    await expect(funnel(page, "status").locator(".codicon")).toHaveClass(/codicon-filter-filled/);
    await expect(funnel(page, "name")).not.toHaveClass(/active/);
    await expect(page.locator("#filters-btn")).toHaveText("Filters • 1");
    await expect(funnel(page, "status")).toHaveAttribute("aria-expanded", "false");

    const rules = await lastSavedRules(page);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      column: "status",
      operator: "in",
      values: ["closed", "open"],
      value: "",
      mode: "include",
      caseSensitive: false,
      enabled: true,
    });

    await page.locator("#filters-btn").click();
    const rule = page.locator(".rule-row").first();
    await expect(rule.locator('select[aria-label="Column"]')).toHaveValue("status");
    await expect(rule.locator('select[aria-label="Condition"]')).toHaveValue("in");
    await expect(rule.locator('select[aria-label="Condition"] option:checked')).toHaveText("is any of");
    await expect(rule.locator(".values-btn")).toHaveText("closed, open (2)");
    await expect(rule.locator('input[type="text"]')).toBeHidden();
    await expect(rule.locator(".inline-checkbox-label")).toBeHidden();
    await expect(rule).not.toHaveClass(/rule-hint|rule-error/);
  });

  test("Cancel, Escape, and an outside click each discard the edits and leave the table alone", async ({ page }) => {
    await openPicker(page, "status");
    await valueRow(page, "open").locator("input").uncheck();
    await page.locator("#values-cancel").click();
    await expect(picker(page)).toBeHidden();
    await expect(funnel(page, "status")).toBeFocused();
    await expect(statusText(page)).toHaveText("Showing 6 of 6 rows");

    await openPicker(page, "status");
    await expect(valueRow(page, "open").locator("input")).toBeChecked();
    await valueRow(page, "open").locator("input").uncheck();
    await page.keyboard.press("Escape");
    await expect(picker(page)).toBeHidden();
    await expect(funnel(page, "status")).toBeFocused();

    await openPicker(page, "status");
    await valueRow(page, "open").locator("input").uncheck();
    await page.locator("#quick-search").click();
    await expect(picker(page)).toBeHidden();
    await expect(page.locator("#quick-search")).toBeFocused();

    await expect(statusText(page)).toHaveText("Showing 6 of 6 rows");
    await expect(page.locator("#filters-btn")).toHaveText("Filters");
    await expect(funnel(page, "status")).not.toHaveClass(/active/);
    await openPicker(page, "status");
    await expect(page.locator("#values-selected-count")).toHaveText("3 of 3 selected");
  });

  test("an outside click on a data row closes the picker without toggling the row", async ({ page }) => {
    await openPicker(page, "status");
    await page.locator("tr.data-row").nth(3).locator("td").nth(1).click();
    await expect(picker(page)).toBeHidden();
    await expect(page.locator("tr.data-row").nth(3)).toHaveAttribute("aria-expanded", "false");
  });

  test("search narrows the list case-insensitively; Select all and Clear act only on the values shown", async ({ page }) => {
    await openPicker(page, "name");
    await page.locator("#values-search").fill("A");
    await expect(rows(page).locator(".v")).toHaveText(["Alice", "Cara", "Dan", "Fay"]);
    await expect(page.locator("#values-select-all")).toHaveText("Select all 4");
    await expect(page.locator("#values-selected-count")).toHaveText("6 of 6 selected");

    await page.locator("#values-clear").click();
    await expect(page.locator("#values-selected-count")).toHaveText("2 of 6 selected");
    for (const box of await rows(page).locator("input").all()) await expect(box).not.toBeChecked();

    await page.locator("#values-search").fill("");
    await expect(rows(page)).toHaveCount(6);
    await expect(valueRow(page, "Bob").locator("input")).toBeChecked();
    await expect(valueRow(page, "Eve").locator("input")).toBeChecked();
    await expect(valueRow(page, "Alice").locator("input")).not.toBeChecked();

    await page.locator("#values-search").fill("ali");
    await expect(page.locator("#values-select-all")).toHaveText("Select all 1");
    await page.locator("#values-select-all").click();
    await page.locator("#values-search").fill("");
    await expect(page.locator("#values-selected-count")).toHaveText("3 of 6 selected");
    await expect(valueRow(page, "Alice").locator("input")).toBeChecked();
    await expect(valueRow(page, "Cara").locator("input")).not.toBeChecked();

    await page.locator("#values-ok").click();
    await expect(statusText(page)).toHaveText("Showing 3 of 6 rows");
    await expect(page.locator("tr.data-row td:nth-child(3)")).toHaveText(["Alice", "Bob", "Eve"]);
  });

  test("a search that matches nothing says so", async ({ page }) => {
    await openPicker(page, "name");
    await page.locator("#values-search").fill("zzz");
    await expect(page.locator("#values-list")).toHaveText("No values match");
    await expect(page.locator("#values-select-all")).toHaveText("Select all 0");
  });

  test("(Blanks) lists empty cells in italics, matches the search 'blank', and filters to the empty rows", async ({ page }) => {
    await openPicker(page, "note");
    await expect(rows(page).locator(".v")).toHaveText(["(Blanks)", "n2", "n4", "n6"]);
    await expect(rows(page).first()).toHaveClass(/blank/);
    await expect(rows(page).first().locator(".n")).toHaveText("3");
    expect(await rows(page).first().locator(".v").evaluate((el) => getComputedStyle(el).fontStyle)).toBe("italic");

    await page.locator("#values-clear").click();
    await page.locator("#values-search").fill("blank");
    await expect(rows(page).locator(".v")).toHaveText(["(Blanks)"]);
    await page.locator("#values-select-all").click();
    await page.locator("#values-search").fill("");
    await expect(page.locator("#values-selected-count")).toHaveText("1 of 4 selected");
    await clearPosted(page);
    await page.locator("#values-ok").click();
    await expect(statusText(page)).toHaveText("Showing 3 of 6 rows");
    expect((await lastSavedRules(page))[0].values).toEqual([""]);
    await page.locator("#filters-btn").click();
    await expect(page.locator(".rule-row .values-btn")).toHaveText("(Blanks) (1)");
  });

  test("OK is disabled while nothing is ticked, and Enter then does nothing", async ({ page }) => {
    await openPicker(page, "status");
    await page.locator("#values-clear").click();
    await expect(page.locator("#values-selected-count")).toHaveText("0 of 3 selected");
    await expect(page.locator("#values-ok")).toBeDisabled();
    await page.locator("#values-search").press("Enter");
    await expect(picker(page)).toBeVisible();
    await valueRow(page, "open").locator("input").check();
    await expect(page.locator("#values-ok")).toBeEnabled();
  });

  test("Enter in the search box and on a checkbox both act as OK", async ({ page }) => {
    await openPicker(page, "status");
    await valueRow(page, "pending").locator("input").uncheck();
    await page.locator("#values-search").press("Enter");
    await expect(picker(page)).toBeHidden();
    await expect(statusText(page)).toHaveText("Showing 5 of 6 rows");

    await openPicker(page, "status");
    await valueRow(page, "closed").locator("input").uncheck();
    await valueRow(page, "closed").locator("input").press("Enter");
    await expect(picker(page)).toBeHidden();
    await expect(statusText(page)).toHaveText("Showing 3 of 6 rows");
  });

  test("Enter on a footer button keeps its own meaning (Cancel cancels)", async ({ page }) => {
    await openPicker(page, "status");
    await valueRow(page, "open").locator("input").uncheck();
    await page.locator("#values-cancel").focus();
    await page.keyboard.press("Enter");
    await expect(picker(page)).toBeHidden();
    await expect(statusText(page)).toHaveText("Showing 6 of 6 rows");
  });

  test("ticking everything again removes the rule (and never creates one)", async ({ page }) => {
    await clearPosted(page);
    await openPicker(page, "status");
    await page.locator("#values-ok").click();
    await expect(picker(page)).toBeHidden();
    await expect(page.locator("#filters-btn")).toHaveText("Filters");
    expect(await lastSavedRules(page)).toEqual([]);

    await openPicker(page, "status");
    await valueRow(page, "pending").locator("input").uncheck();
    await page.locator("#values-ok").click();
    await expect(page.locator("#filters-btn")).toHaveText("Filters • 1");

    await openPicker(page, "status");
    await expect(page.locator("#values-selected-count")).toHaveText("2 of 3 selected");
    await valueRow(page, "pending").locator("input").check();
    await clearPosted(page);
    await page.locator("#values-ok").click();
    await expect(page.locator("#filters-btn")).toHaveText("Filters");
    await expect(funnel(page, "status")).not.toHaveClass(/active/);
    await expect(statusText(page)).toHaveText("Showing 6 of 6 rows");
    expect(await lastSavedRules(page)).toEqual([]);
    await page.locator("#filters-btn").click();
    await expect(page.locator(".rule-row")).toHaveCount(0);
  });

  test("re-opening after OK pre-ticks the rule's values; a second OK with a different set re-queries", async ({ page }) => {
    await openPicker(page, "status");
    await page.locator("#values-clear").click();
    await valueRow(page, "open").locator("input").check();
    await page.locator("#values-ok").click();
    await expect(statusText(page)).toHaveText("Showing 3 of 6 rows");

    await openPicker(page, "status");
    await expect(page.locator("#values-selected-count")).toHaveText("1 of 3 selected");
    await valueRow(page, "pending").locator("input").check();
    await page.locator("#values-ok").click();
    await expect(statusText(page)).toHaveText("Showing 4 of 6 rows");
    await expect(page.locator("#filters-btn")).toHaveText("Filters • 1");
  });

  test("counts cover the whole file, not the currently filtered view", async ({ page }) => {
    await page.locator("#quick-search").fill("Alice");
    await expect(statusText(page)).toHaveText("Showing 1 of 6 rows");
    await openPicker(page, "status");
    await expect(rows(page).locator(".v")).toHaveText(["closed", "open", "pending"]);
    await expect(rows(page).locator(".n")).toHaveText(["2", "3", "1"]);
  });

  test("keyboard: Tab goes from a column's sort button to its funnel to the next column's sort button; Enter on the funnel opens the picker", async ({
    page,
  }) => {
    await page.locator('#table-head th[data-column="status"] .col-header-btn').focus();
    await page.keyboard.press("Tab");
    await expect(funnel(page, "status")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator('#table-head th[data-column="note"] .col-header-btn')).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(funnel(page, "status")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(picker(page)).toBeVisible();
    await expect(page.locator("#values-search")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(funnel(page, "status")).toBeFocused();
  });

  test("focus returns to the same funnel (not the sort button) after OK re-renders the header", async ({ page }) => {
    await funnel(page, "status").focus();
    await page.keyboard.press("Enter");
    await expect(picker(page)).toBeVisible();
    await valueRow(page, "pending").locator("input").uncheck();
    await page.locator("#values-search").press("Enter");
    await expect(statusText(page)).toHaveText("Showing 5 of 6 rows");
    await expect(funnel(page, "status")).toBeFocused();
    expect(await page.evaluate(() => document.activeElement?.classList.contains("col-filter-btn"))).toBe(true);
  });

  test("the sort button still sorts and keeps focus on itself across re-renders", async ({ page }) => {
    const sortBtn = page.locator('#table-head th[data-column="name"] .col-header-btn');
    await sortBtn.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator('#table-head th[data-column="name"]')).toHaveAttribute("aria-sort", "ascending");
    await expect(sortBtn).toBeFocused();
  });

  test("a click on the header label area still sorts", async ({ page }) => {
    await page.locator('#table-head th[data-column="name"] .col-header-label').click();
    await expect(page.locator('#table-head th[data-column="name"]')).toHaveAttribute("aria-sort", "ascending");
  });

  test("a new load while the picker is open closes it and discards the edits", async ({ page }) => {
    await openPicker(page, "status");
    await valueRow(page, "open").locator("input").uncheck();
    await pushLoad(page, {
      fileKey: "file:///tickets.csv",
      headers: HEADERS,
      rows: ROWS,
      state: defaultViewState(),
      defaultTableColumns: 4,
      hintsSeen: ["rowDetails"],
    });
    await expect(picker(page)).toBeHidden();
    await expect(statusText(page)).toHaveText("Showing 6 of 6 rows");
  });

  test("re-clamps inside the viewport when the window is resized", async ({ page }) => {
    await openPicker(page, "note");
    await page.setViewportSize({ width: 420, height: 500 });
    const box = await picker(page).boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(8 - 0.5);
    expect(box!.x + box!.width).toBeLessThanOrEqual(420 - 8 + 0.5);
  });

  test("a value containing HTML is rendered as text everywhere", async ({ page }) => {
    const evil = [
      ["1", XSS_IMG],
      ["2", "plain"],
    ];
    await bootAndLoadText(page, {
      fileKey: "file:///evil.csv",
      text: toCsvText(["id", "tag"], evil),
      state: defaultViewState(),
      defaultTableColumns: 2,
    });
    await openPicker(page, "tag");
    await expect(valueRow(page, XSS_IMG).locator(".v")).toHaveText(XSS_IMG);
    await expect(picker(page).locator("img")).toHaveCount(0);
    await valueRow(page, "plain").locator("input").uncheck();
    await page.locator("#values-ok").click();
    await expect(statusText(page)).toHaveText("Showing 1 of 2 rows");
    await page.locator("#filters-btn").click();
    await expect(page.locator(".values-btn")).toContainText("<img src=x");
    await expect(page.locator("#filter-panel img")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __xssFired?: number }).__xssFired)).toBeUndefined();
  });

  test("a value longer than 80 characters is cut with an ellipsis for display only, and still filters by its full text", async ({ page }) => {
    const long = "L".repeat(100);
    await bootAndLoadText(page, {
      fileKey: "file:///long.csv",
      text: toCsvText(["id", "tag"], [["1", long], ["2", "short"]]),
      state: defaultViewState(),
      defaultTableColumns: 2,
    });
    await openPicker(page, "tag");
    await expect(rows(page).locator(".v").first()).toHaveText(`${"L".repeat(80)}…`);
    await valueRow(page, `${"L".repeat(80)}…`).locator("input").uncheck();
    await page.locator("#values-ok").click();
    await expect(statusText(page)).toHaveText("Showing 1 of 2 rows");
    await expect(page.locator("tr.data-row td:nth-child(3)")).toHaveText(["short"]);
  });

  test("clicking a funnel inside an open Filters panel closes the panel and opens the picker", async ({ page }) => {
    await page.locator("#filters-btn").click();
    await expect(page.locator("#filter-panel")).toBeVisible();
    await funnel(page, "id").click(); // the panel covers the right-hand headers, not the first one
    await expect(picker(page)).toBeVisible();
    await expect(page.locator("#values-title")).toHaveText("Filter “id” by values");
    await expect(page.locator("#filter-panel")).toBeHidden();
  });
});

test.describe("stored rules", () => {
  test("a stored `in` rule is applied on load, lights its funnel, and pre-ticks the picker", async ({ page }) => {
    await boot(page, { filterRules: [inRule({ values: ["open"] })] });
    await expect(statusText(page)).toHaveText("Showing 3 of 6 rows");
    await expect(funnel(page, "status")).toHaveClass(/active/);
    await expect(page.locator("#filters-btn")).toHaveText("Filters • 1");

    await openPicker(page, "status");
    await expect(page.locator("#values-selected-count")).toHaveText("1 of 3 selected");
    await expect(valueRow(page, "open").locator("input")).toBeChecked();
    await expect(valueRow(page, "closed").locator("input")).not.toBeChecked();
    await expect(valueRow(page, "pending").locator("input")).not.toBeChecked();
  });

  test("a rule value the file doesn't contain is listed first, ticked, with count 0, and can be unticked", async ({ page }) => {
    await boot(page, { filterRules: [inRule({ values: ["open", "gone"] })] });
    await openPicker(page, "status");
    await expect(rows(page).locator(".v")).toHaveText(["gone", "closed", "open", "pending"]);
    await expect(rows(page).first().locator(".n")).toHaveText("0");
    await expect(rows(page).first().locator("input")).toBeChecked();
    await expect(page.locator("#values-selected-count")).toHaveText("2 of 4 selected");
    await rows(page).first().locator("input").uncheck();
    await page.locator("#values-ok").click();
    expect((await lastSavedRules(page))[0].values).toEqual(["open"]);
  });

  test("a stored `in` rule written by an older version (no `values`) is inactive and harmless", async ({ page }) => {
    const legacy = inRule();
    delete (legacy as { values?: string[] }).values;
    await boot(page, { filterRules: [legacy] });
    await expect(statusText(page)).toHaveText("Showing 6 of 6 rows");
    await expect(funnel(page, "status")).not.toHaveClass(/active/);
    await expect(page.locator("#filters-btn")).toHaveText("Filters");
    await page.locator("#filters-btn").click();
    const rule = page.locator(".rule-row").first();
    await expect(rule.locator(".values-btn")).toHaveText("Choose values…");
    await expect(rule.locator(".rule-error-text")).toHaveText("Choose values");
    await expect(rule).toHaveClass(/rule-hint/);
  });

  test("Hide mode: the picker is titled for hiding, keeps the mode on OK, and an all-ticked Hide rule is not removed", async ({ page }) => {
    await boot(page, { filterRules: [inRule({ mode: "exclude", values: ["closed"] })] });
    await expect(statusText(page)).toHaveText("Showing 4 of 6 rows");
    await expect(funnel(page, "status")).toHaveClass(/active/);

    await openPicker(page, "status");
    await expect(page.locator("#values-title")).toHaveText("Hide rows where “status” is any of");
    await expect(picker(page)).toHaveAttribute("aria-label", "Hide rows where “status” is any of");
    await expect(page.locator("#values-selected-count")).toHaveText("1 of 3 selected");
    await valueRow(page, "pending").locator("input").check();
    await page.locator("#values-ok").click();
    await expect(statusText(page)).toHaveText("Showing 3 of 6 rows");
    const rules = await lastSavedRules(page);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ mode: "exclude", values: ["closed", "pending"] });

    await openPicker(page, "status");
    await page.locator("#values-select-all").click();
    await page.locator("#values-ok").click();
    await expect(statusText(page)).toHaveText("Showing 0 of 6 rows");
    await expect(page.locator("#filters-btn")).toHaveText("Filters • 1");
  });

  test("a disabled rule is not 'active': the funnel stays plain, and OK re-enables the rule", async ({ page }) => {
    await boot(page, { filterRules: [inRule({ enabled: false, values: ["open"] })] });
    await expect(statusText(page)).toHaveText("Showing 6 of 6 rows");
    await expect(funnel(page, "status")).not.toHaveClass(/active/);
    await openPicker(page, "status");
    await expect(page.locator("#values-selected-count")).toHaveText("1 of 3 selected");
    await page.locator("#values-ok").click();
    await expect(statusText(page)).toHaveText("Showing 3 of 6 rows");
    await expect(funnel(page, "status")).toHaveClass(/active/);
  });

  test("the funnel's active state follows every way a rule can change: enable checkbox, remove, Turn Off Filters", async ({ page }) => {
    await boot(page, { filterRules: [inRule({ values: ["open"] })] });
    await expect(funnel(page, "status")).toHaveClass(/active/);

    await page.locator("#filters-btn").click();
    const enabled = page.locator('.rule-row input[aria-label="Rule enabled"]');
    await enabled.uncheck();
    await expect(funnel(page, "status")).not.toHaveClass(/active/);
    await enabled.check();
    await expect(funnel(page, "status")).toHaveClass(/active/);
    await page.locator(".remove-rule-btn").click();
    await expect(funnel(page, "status")).not.toHaveClass(/active/);
    await expect(funnel(page, "status").locator(".codicon")).toHaveClass(/codicon-filter(?!-)/);
  });

  test("Turn Off Filters clears the funnel's active state", async ({ page }) => {
    await boot(page, { filterRules: [inRule({ values: ["open"] })] });
    await expect(funnel(page, "status")).toHaveClass(/active/);
    await page.locator("#filtered-turn-off-filters-btn").click();
    await expect(funnel(page, "status")).not.toHaveClass(/active/);
    await expect(statusText(page)).toHaveText("Showing 6 of 6 rows");
  });

  test("a stored in-rule on a column missing from the file is ignored and shows the usual 'column isn't in this file' error", async ({
    page,
  }) => {
    await boot(page, { filterRules: [inRule({ column: "ghost", values: ["x"] })] });
    await expect(statusText(page)).toHaveText("Showing 6 of 6 rows");
    await page.locator("#filters-btn").click();
    const rule = page.locator(".rule-row").first();
    await expect(rule).toHaveClass(/rule-error/);
    await expect(rule.locator(".rule-error-text")).toHaveText(`Skipped: column "ghost" isn't in this file`);
  });
});

test.describe("Filters panel: is any of", () => {
  test.beforeEach(async ({ page }) => {
    await boot(page, { filterRules: [inRule({ values: ["open", "pending"] })] });
    await page.locator("#filters-btn").click();
    await expect(page.locator("#filter-panel")).toBeVisible();
  });

  test("`is any of` follows `equals` in the condition list", async ({ page }) => {
    const options = await page.locator('.rule-row select[aria-label="Condition"] option').allTextContents();
    expect(options.slice(0, 4)).toEqual(["contains", "equals", "is any of", "starts with"]);
  });

  test("the values button shows the summary and count, with a chevron, and carries dialog semantics", async ({ page }) => {
    const btn = page.locator(".rule-row .values-btn");
    await expect(btn).toHaveText("open, pending (2)");
    await expect(btn).toHaveAttribute("aria-haspopup", "dialog");
    await expect(btn).toHaveAttribute("aria-expanded", "false");
    await expect(btn.locator(".codicon-chevron-down")).toBeVisible();
    await expect(btn.locator(".muted")).toHaveText("(2)");
  });

  test("clicking the values button opens the picker under it while the Filters panel stays open", async ({ page }) => {
    const btn = page.locator(".rule-row .values-btn");
    await btn.click();
    await expect(picker(page)).toBeVisible();
    await expect(page.locator("#filter-panel")).toBeVisible();
    await expect(btn).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#values-selected-count")).toHaveText("2 of 3 selected");
    const [bBox, pBox] = await Promise.all([btn.boundingBox(), picker(page).boundingBox()]);
    expect(pBox!.y).toBeGreaterThanOrEqual(bBox!.y + bBox!.height);

    await valueRow(page, "closed").locator("input").check();
    await page.locator("#values-search").fill("o");
    await expect(picker(page)).toBeVisible();
    await expect(page.locator("#filter-panel")).toBeVisible();

    await btn.click();
    await expect(picker(page)).toBeHidden();
    await expect(page.locator("#filter-panel")).toBeVisible();
    await expect(btn).toHaveAttribute("aria-expanded", "false");
  });

  test("Escape closes only the picker and returns focus to the values button", async ({ page }) => {
    await page.locator(".rule-row .values-btn").click();
    await expect(picker(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(picker(page)).toBeHidden();
    await expect(page.locator("#filter-panel")).toBeVisible();
    await expect(page.locator(".rule-row .values-btn")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator("#filter-panel")).toBeHidden();
  });

  test("a click elsewhere in the panel just cancels the picker; a click outside both closes everything", async ({ page }) => {
    await page.locator(".rule-row .values-btn").click();
    await valueRow(page, "closed").locator("input").check();
    await page.locator("#filter-panel .filter-panel-hint").first().click();
    await expect(picker(page)).toBeHidden();
    await expect(page.locator("#filter-panel")).toBeVisible();
    await expect(page.locator(".rule-row .values-btn")).toHaveText("open, pending (2)");
    await expect(statusText(page)).toHaveText("Showing 4 of 6 rows");

    await page.locator(".rule-row .values-btn").click();
    await expect(picker(page)).toBeVisible();
    await page.locator("#quick-search").click();
    await expect(picker(page)).toBeHidden();
    await expect(page.locator("#filter-panel")).toBeHidden();
  });

  test("Cancel returns focus to the values button; OK leaves the panel open with the rule row updated", async ({ page }) => {
    const btn = page.locator(".rule-row .values-btn");
    await btn.click();
    await page.locator("#values-cancel").click();
    await expect(page.locator("#filter-panel")).toBeVisible();
    await expect(btn).toBeFocused();

    await btn.click();
    await valueRow(page, "pending").locator("input").uncheck();
    await valueRow(page, "closed").locator("input").check();
    await clearPosted(page);
    await page.locator("#values-ok").click();
    await expect(picker(page)).toBeHidden();
    await expect(page.locator("#filter-panel")).toBeVisible();
    await expect(page.locator(".rule-row .values-btn")).toHaveText("closed, open (2)");
    await expect(page.locator(".rule-row .values-btn")).toBeFocused();
    await expect(statusText(page)).toHaveText("Showing 5 of 6 rows");
    expect((await lastSavedRules(page))[0].values).toEqual(["closed", "open"]);
  });

  test("OK with everything ticked on a Keep rule removes the rule from the open panel", async ({ page }) => {
    await page.locator(".rule-row .values-btn").click();
    await page.locator("#values-select-all").click();
    await page.locator("#values-ok").click();
    await expect(page.locator(".rule-row")).toHaveCount(0);
    await expect(page.locator("#filter-panel")).toBeVisible();
    await expect(statusText(page)).toHaveText("Showing 6 of 6 rows");
    await expect(page.locator("#filter-panel-tip")).toBeVisible();
  });

  test("a long selection is summarised to about 30 characters", async ({ page }) => {
    const btn = page.locator(".rule-row .values-btn");
    const load = (values: string[]): Promise<void> =>
      pushLoad(page, {
        fileKey: "file:///tickets.csv",
        headers: HEADERS,
        rows: ROWS,
        state: defaultViewState({ filterRules: [inRule({ column: "name", values })] }),
        defaultTableColumns: 4,
        hintsSeen: ["rowDetails"],
      });
    await load(["Alice", "Bob", "Cara", "Dan", "Eve"]);
    await expect(btn).toHaveText("Alice, Bob, Cara, Dan, Eve (5)");
    await load(["Alexandria", "Bartholomew", "Christopher", "Dominic"]);
    await expect(btn).toHaveText("Alexandria, Bartholomew, Chris… (4)");
    await load(["", "x"]);
    await expect(btn).toHaveText("(Blanks), x (2)");
  });

  test("switching the condition away and back keeps `value` and `values` and toggles the controls", async ({ page }) => {
    const rule = page.locator(".rule-row").first();
    const condition = rule.locator('select[aria-label="Condition"]');
    await condition.selectOption("contains");
    await expect(rule.locator(".values-btn")).toBeHidden();
    await expect(rule.locator('input[type="text"]')).toBeVisible();
    await expect(rule.locator(".inline-checkbox-label")).toBeVisible();
    await rule.locator('input[type="text"]').fill("clo");
    await expect(statusText(page)).toHaveText("Showing 2 of 6 rows");
    await condition.selectOption("in");
    await expect(rule.locator(".values-btn")).toHaveText("open, pending (2)");
    await expect(rule.locator('input[type="text"]')).toBeHidden();
    await expect(rule.locator('input[type="text"]')).toHaveValue("clo");
    await expect(statusText(page)).toHaveText("Showing 4 of 6 rows");
  });

  test("changing the column of an `in` rule clears its values and shows 'Choose values'", async ({ page }) => {
    const rule = page.locator(".rule-row").first();
    await clearPosted(page);
    await rule.locator('select[aria-label="Column"]').selectOption("name");
    await expect(rule.locator(".values-btn")).toHaveText("Choose values…");
    await expect(rule.locator(".rule-error-text")).toHaveText("Choose values");
    await expect(rule).toHaveClass(/rule-hint/);
    await expect(rule).not.toHaveClass(/rule-error/);
    await expect(statusText(page)).toHaveText("Showing 6 of 6 rows");
    await expect(funnel(page, "status")).not.toHaveClass(/active/);
    await expect(page.locator("#filters-btn")).toHaveText("Filters");
    await expect.poll(async () => (await lastSavedRules(page))[0]?.values).toEqual([]);
  });

  test("'Any column' with `is any of` says 'Choose a column' and disables the values button", async ({ page }) => {
    const rule = page.locator(".rule-row").first();
    await rule.locator('select[aria-label="Column"]').selectOption({ label: "Any column" });
    await expect(rule.locator(".rule-error-text")).toHaveText("Choose a column");
    await expect(rule).toHaveClass(/rule-hint/);
    await expect(rule.locator(".values-btn")).toBeDisabled();
    await expect(statusText(page)).toHaveText("Showing 6 of 6 rows");
  });
});

test.describe("adding `is any of` from the panel", () => {
  test("works on a detail-only column (which has no header funnel)", async ({ page }) => {
    await boot(page, { columnVisibility: { note: false } });
    await expect(funnel(page, "note")).toHaveCount(0);

    await page.locator("#filters-btn").click();
    await page.locator("#add-rule-btn").click();
    const rule = page.locator(".rule-row").first();
    await rule.locator('select[aria-label="Column"]').selectOption("note");
    await rule.locator('select[aria-label="Condition"]').selectOption("in");
    await expect(rule.locator(".values-btn")).toHaveText("Choose values…");
    await expect(rule.locator(".rule-error-text")).toHaveText("Choose values");

    await rule.locator(".values-btn").click();
    await expect(picker(page)).toBeVisible();
    await expect(rows(page).locator(".v")).toHaveText(["(Blanks)", "n2", "n4", "n6"]);
    await expect(page.locator("#values-selected-count")).toHaveText("0 of 4 selected");
    await expect(page.locator("#values-ok")).toBeDisabled();
    await valueRow(page, "n2").locator("input").check();
    await valueRow(page, "n6").locator("input").check();
    await page.locator("#values-ok").click();

    await expect(statusText(page)).toHaveText("Showing 2 of 6 rows");
    await expect(rule.locator(".values-btn")).toHaveText("n2, n6 (2)");
    await expect(rule).not.toHaveClass(/rule-hint/);
    await expect(page.locator("#filters-btn")).toHaveText("Filters • 1");
    await expect(page.locator("#filter-panel")).toBeVisible();
  });

  test("a rule added on a visible column lights that column's funnel", async ({ page }) => {
    await boot(page);
    await page.locator("#filters-btn").click();
    await page.locator("#add-rule-btn").click();
    const rule = page.locator(".rule-row").first();
    await rule.locator('select[aria-label="Column"]').selectOption("name");
    await rule.locator('select[aria-label="Condition"]').selectOption("in");
    await expect(funnel(page, "name")).not.toHaveClass(/active/);
    await rule.locator(".values-btn").click();
    await page.locator("#values-select-all").click();
    await valueRow(page, "Bob").locator("input").uncheck();
    await page.locator("#values-ok").click();
    await expect(funnel(page, "name")).toHaveClass(/active/);
    await expect(statusText(page)).toHaveText("Showing 5 of 6 rows");
  });

  test("a funnel edits the first `in` rule on its column, in either mode, rather than adding a second", async ({ page }) => {
    await boot(page, {
      filterRules: [
        inRule({ id: "a", column: "name", values: ["Alice"], mode: "exclude" }),
        inRule({ id: "b", column: "name", values: ["Bob"] }),
      ],
    });
    await openPicker(page, "name");
    await expect(page.locator("#values-title")).toHaveText("Hide rows where “name” is any of");
    await expect(page.locator("#values-selected-count")).toHaveText("1 of 6 selected");
    await valueRow(page, "Cara").locator("input").check();
    await page.locator("#values-ok").click();
    const rules = await lastSavedRules(page);
    expect(rules.map((r) => [r.id, r.values])).toEqual([
      ["a", ["Alice", "Cara"]],
      ["b", ["Bob"]],
    ]);
  });
});

test.describe("context menu", () => {
  test.beforeEach(async ({ page }) => {
    await boot(page);
  });

  test("a cell's menu has `Filter ‹column› by Values…` after the two quick filters, before the row-copy items", async ({ page }) => {
    await page.locator("tr.data-row").first().locator("td").nth(3).click({ button: "right" });
    await expect(page.locator("#context-menu button")).toHaveText([
      "Copy Value",
      'Show only rows where status = "open"',
      'Hide rows where status = "open"',
      "Filter status by Values…",
      "Copy Row as CSV",
      "Copy Row as JSON",
    ]);
    const kinds = await page.locator("#context-menu > *").evaluateAll((els) => els.map((e) => e.tagName));
    expect(kinds).toEqual(["BUTTON", "HR", "BUTTON", "BUTTON", "BUTTON", "HR", "BUTTON", "BUTTON"]);
  });

  test("the item closes the menu and opens the picker under that column's funnel", async ({ page }) => {
    await page.locator("tr.data-row").first().locator("td").nth(3).click({ button: "right" });
    await page.locator("#context-menu button", { hasText: "Filter status by Values…" }).click();
    await expect(page.locator("#context-menu")).toBeHidden();
    await expect(picker(page)).toBeVisible();
    await expect(page.locator("#values-title")).toHaveText("Filter “status” by values");
    await expect(funnel(page, "status")).toHaveAttribute("aria-expanded", "true");
    const [fBox, pBox] = await Promise.all([funnel(page, "status").boundingBox(), picker(page).boundingBox()]);
    expect(pBox!.y).toBeGreaterThanOrEqual(fBox!.y + fBox!.height);
    expect(Math.abs(pBox!.x - fBox!.x)).toBeLessThan(30);
    await expect(page.locator("#values-search")).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(picker(page)).toBeHidden();
    await expect(funnel(page, "status")).toBeFocused();
  });

  test("Arrow Up/Down rove through the extra item too", async ({ page }) => {
    await page.locator("tr.data-row").first().locator("td").nth(3).click({ button: "right" });
    const items = page.locator("#context-menu button");
    await items.first().focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(items.nth(3)).toBeFocused();
    await expect(items.nth(3)).toHaveText("Filter status by Values…");
    await page.keyboard.press("ArrowDown");
    await expect(items.nth(4)).toHaveText("Copy Row as CSV");
    await expect(items.nth(4)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await expect(picker(page)).toBeVisible();
  });

  test("the row-level keyboard menu (Shift+F10) is unchanged", async ({ page }) => {
    await page.locator("tr.data-row").first().focus();
    await page.keyboard.press("Shift+F10");
    await expect(page.locator("#context-menu button")).toHaveText(["Copy Row as CSV", "Copy Row as JSON"]);
  });

  test("choosing it on a column that already has a rule pre-ticks from that rule; on another column everything is ticked", async ({ page }) => {
    await boot(page, { filterRules: [inRule({ values: ["pending"] })] });
    await page.locator("tr.data-row").first().locator("td").nth(2).click({ button: "right" });
    await page.locator("#context-menu button", { hasText: "Filter name by Values…" }).click();
    await expect(page.locator("#values-title")).toHaveText("Filter “name” by values");
    await expect(page.locator("#values-selected-count")).toHaveText("6 of 6 selected");

    await page.keyboard.press("Escape");
    await page.locator("tr.data-row").first().locator("td").nth(3).click({ button: "right" });
    await page.locator("#context-menu button", { hasText: "Filter status by Values…" }).click();
    await expect(page.locator("#values-selected-count")).toHaveText("1 of 3 selected");
    await expect(valueRow(page, "pending").locator("input")).toBeChecked();
  });

  test("from a detail field of a column that isn't in the table, the picker opens at the click position", async ({ page }) => {
    await boot(page, { columnVisibility: { note: false } });
    await page.locator("tr.data-row").nth(1).click();
    const dd = page.locator("tr.detail-row:not([hidden]) dd").first();
    await expect(dd).toBeVisible();
    const box = (await dd.boundingBox())!;
    const x = Math.round(box.x + 6);
    const y = Math.round(box.y + 4);
    await page.mouse.click(x, y, { button: "right" });
    await page.locator("#context-menu button", { hasText: "Filter note by Values…" }).click();
    await expect(picker(page)).toBeVisible();
    await expect(page.locator("#values-title")).toHaveText("Filter “note” by values");
    await expect(rows(page).locator(".v")).toHaveText(["(Blanks)", "n2", "n4", "n6"]);
    const pBox = (await picker(page).boundingBox())!;
    expect(Math.abs(pBox.x - x)).toBeLessThan(2);
    const vp = page.viewportSize()!;
    expect(pBox.y + pBox.height).toBeLessThanOrEqual(vp.height);
    expect(pBox.x + pBox.width).toBeLessThanOrEqual(vp.width);
    await page.keyboard.press("Escape");
    await expect(picker(page)).toBeHidden();
  });

  test("at a viewport edge the point-anchored picker is clamped inside the viewport", async ({ page }) => {
    await boot(page, { columnVisibility: { note: false } });
    await page.locator("tr.data-row").nth(1).click();
    const vp = page.viewportSize()!;
    const dd = page.locator("tr.detail-row:not([hidden]) dd").first();
    const box = (await dd.boundingBox())!;
    await page.mouse.click(Math.min(vp.width - 4, box.x + box.width - 2), box.y + 4, { button: "right" });
    await page.locator("#context-menu button", { hasText: "Filter note by Values…" }).click();
    const pBox = (await picker(page).boundingBox())!;
    expect(pBox.x + pBox.width).toBeLessThanOrEqual(vp.width);
    expect(pBox.x).toBeGreaterThanOrEqual(0);
  });
});

test.describe("limits and recovery", () => {
  test("more than 500 matching values: renders 500, says so, and 'Select all' still means every match", async ({ page }) => {
    const data = Array.from({ length: 600 }, (_, i) => [String(i), `val${String(i).padStart(3, "0")}`]);
    await bootAndLoadText(page, {
      fileKey: "file:///many.csv",
      text: toCsvText(["id", "tag"], data),
      state: defaultViewState(),
      defaultTableColumns: 2,
    });
    await openPicker(page, "tag");
    await expect(rows(page)).toHaveCount(500);
    await expect(page.locator("#values-note-shown")).toHaveText("Showing the first 500 of 600. Search to narrow.");
    await expect(page.locator("#values-note-truncated")).toBeHidden();
    await expect(page.locator("#values-select-all")).toHaveText("Select all 600");
    await expect(page.locator("#values-selected-count")).toHaveText("600 of 600 selected");

    await page.locator("#values-clear").click();
    await expect(page.locator("#values-selected-count")).toHaveText("0 of 600 selected");
    await page.locator("#values-search").fill("val59");
    await expect(rows(page)).toHaveCount(10);
    await expect(page.locator("#values-note-shown")).toBeHidden();
    await page.locator("#values-select-all").click();
    await page.locator("#values-ok").click();
    await expect(statusText(page)).toHaveText("Showing 10 of 600 rows");
  });

  test("a column with more than 10,000 distinct values lists the first 10,000 with a note, and OK on 'all ticked' still keeps a rule", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const total = 10_020;
    const lines = ["id,tag"];
    for (let i = 0; i < total; i++) lines.push(`${i},t${String(i).padStart(5, "0")}`);
    await bootAndLoadText(page, {
      fileKey: "file:///huge.csv",
      text: lines.join("\n"),
      state: defaultViewState(),
      defaultTableColumns: 2,
    });
    await openPicker(page, "tag");
    await expect(page.locator("#values-note-truncated")).toHaveText(
      "This column has more than 10,000 distinct values; only the first 10,000 are listed.",
    );
    await expect(page.locator("#values-selected-count")).toHaveText("10000 of 10000 selected");
    await page.locator("#values-ok").click();
    await expect(statusText(page)).toHaveText("Showing 10,000 of 10,020 rows");
    await expect(page.locator("#filters-btn")).toHaveText("Filters • 1");
  });

  test("a picker waiting on a stuck worker gets its values after regex-timeout recovery instead of hanging on 'Loading values…'", async ({
    page,
  }) => {
    test.setTimeout(30_000);
    const pathological = "a".repeat(40) + "b";
    const data: string[][] = [["0", pathological]];
    for (let i = 1; i < 30; i++) data.push([String(i), `normal-${i % 3}`]);
    await bootAndLoadText(page, {
      fileKey: "file:///regex-and-values.csv",
      text: toCsvText(["id", "val"], data),
      state: defaultViewState(),
      defaultTableColumns: 2,
    });

    await page.locator("#filters-btn").click();
    await page.locator("#add-rule-btn").click();
    const rule = page.locator(".rule-row").first();
    await rule.locator('select[aria-label="Column"]').selectOption("val");
    await rule.locator('select[aria-label="Condition"]').selectOption("regex");
    await rule.locator('input[type="text"]').fill("(a+)+$");
    await page.waitForTimeout(400); // debounce -> the worker is now stuck in the regex
    await page.keyboard.press("Escape"); // the open panel covers the right-hand funnel

    await funnel(page, "val").click();
    await expect(page.locator("#values-list .vp-empty")).toHaveText("Loading values…");
    await expect(rows(page).locator(".v")).toHaveText([pathological, "normal-0", "normal-1", "normal-2"], { timeout: 8_000 });
    await expect(page.locator("#values-ok")).toBeEnabled();
  });
});
