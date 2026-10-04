import { expect, test, type Locator, type Page } from "@playwright/test";
import { awaitPosted, bootAndLoadText, bootShell, clearPosted, defaultViewState, posted, pushLoadText } from "./harness";
import { toCsvText } from "./stress/stressHelpers";
import type { ViewState } from "../../core/types";

const MD_RICH = [
  "# Heading One",
  "",
  "Some **bold** text with a [link](https://example.com/a).",
  "",
  "- first",
  "- second",
  "",
  "```",
  "code here",
  "```",
  "",
  "| A | B |",
  "| --- | --- |",
  "| 1 | 2 |",
].join("\n");

const MD_SMALL = "## Second\n\n**strong** and `code`\n\n1. x\n2. y";

function field(page: Page, rowIndex: number, column: string): Locator {
  return page.locator("tr.detail-row").nth(rowIndex).locator(`dt:has(> .detail-field-label:text-is("${column}")) + dd`);
}

async function load(
  page: Page,
  headers: string[],
  rows: string[][],
  opts: { state?: Partial<ViewState>; visible?: string[]; fileKey?: string } = {},
): Promise<void> {
  const visibility: Record<string, boolean> = {};
  for (const h of headers) visibility[h] = (opts.visible ?? ["id"]).includes(h);
  await bootAndLoadText(page, {
    fileKey: opts.fileKey ?? "file:///md.csv",
    text: toCsvText(headers, rows),
    state: defaultViewState({ columnVisibility: visibility, ...opts.state }),
    defaultTableColumns: 8,
  });
}

async function expandAll(page: Page): Promise<void> {
  await page.locator("#expand-collapse-btn").click();
  await expect(page.locator("tr.detail-row:not([hidden])")).not.toHaveCount(0);
}

async function lastSavedMarkdownColumns(page: Page): Promise<Record<string, boolean>> {
  const msgs = (await posted(page)).filter((m) => m.type === "saveState");
  return (msgs[msgs.length - 1].state as ViewState).markdownColumns;
}

test.describe("auto-detected Markdown column", () => {
  test.beforeEach(async ({ page }) => {
    await load(page, ["id", "body", "plain"], [
      ["1", MD_RICH, "short"],
      ["2", MD_SMALL, "hello there"],
    ]);
    await expandAll(page);
  });

  test("renders real elements, shows Raw, leaves a plain column as text", async ({ page }) => {
    const md = field(page, 0, "body").locator(".detail-value-md");
    await expect(md.locator("h1")).toHaveText("Heading One");
    await expect(md.locator("strong")).toHaveText("bold");
    await expect(md.locator("li")).toHaveCount(2);
    await expect(md.locator('a[href="https://example.com/a"]')).toHaveText("link");
    await expect(md.locator('a[href="https://example.com/a"]')).toHaveAttribute("rel", "noopener noreferrer");
    await expect(md.locator('a[href="https://example.com/a"]')).toHaveAttribute("title", "https://example.com/a");
    await expect(md.locator("table")).toHaveCount(1);
    await expect(md.locator("pre")).toHaveText(/code here/);
    await expect(field(page, 0, "body").locator(".format-toggle-btn")).toHaveText("Raw");
    await expect(field(page, 0, "body").locator(".detail-value-text")).toBeHidden();

    await expect(field(page, 1, "body").locator(".detail-value-md h2")).toHaveText("Second");
    await expect(field(page, 1, "body").locator(".detail-value-md code")).toHaveText("code");

    const plain = field(page, 0, "plain");
    await expect(plain.locator(".detail-value-text")).toHaveText("short");
    await expect(plain.locator(".detail-value-md")).toBeHidden();
    await expect(plain.locator(".format-toggle-btn")).toBeHidden();
  });

  test("Raw switches that column in every expanded row, saves, keeps rows expanded and keeps focus on the toggle; Markdown switches back", async ({
    page,
  }) => {
    await clearPosted(page);
    const toggle0 = field(page, 0, "body").locator(".format-toggle-btn");
    await toggle0.click();

    for (const i of [0, 1]) {
      await expect(field(page, i, "body").locator(".detail-value-md")).toBeHidden();
      await expect(field(page, i, "body").locator(".detail-value-md")).toHaveText("");
      await expect(field(page, i, "body").locator(".detail-value-text")).toBeVisible();
    }
    await expect(field(page, 0, "body").locator(".detail-value-text")).toHaveText(MD_RICH);
    await expect(field(page, 1, "body").locator(".detail-value-text")).toHaveText(MD_SMALL);
    await expect(page.locator("tr.detail-row:not([hidden])")).toHaveCount(2);
    await expect(page.locator("tr.data-row[aria-expanded='true']")).toHaveCount(2);
    await expect(field(page, 0, "body").locator(".format-toggle-btn")).toHaveText("Markdown");
    await expect(field(page, 0, "body").locator(".format-toggle-btn")).toBeFocused();

    const saved = await awaitPosted(page, "saveState");
    expect((saved.state as ViewState).markdownColumns).toEqual({ body: false });
    await expect(field(page, 0, "plain").locator(".detail-value-text")).toHaveText("short");

    await clearPosted(page);
    await field(page, 0, "body").locator(".format-toggle-btn").click();
    for (const i of [0, 1]) await expect(field(page, i, "body").locator(".detail-value-md")).toBeVisible();
    await expect(field(page, 0, "body").locator(".detail-value-md h1")).toHaveText("Heading One");
    await expect(field(page, 0, "body").locator(".format-toggle-btn")).toHaveText("Raw");
    await expect(field(page, 0, "body").locator(".format-toggle-btn")).toBeFocused();
    expect(await lastSavedMarkdownColumns(page)).toEqual({ body: true });
    await expect(page.locator("tr.detail-row:not([hidden])")).toHaveCount(2);
  });

  test("a short plain value flipped to Raw keeps its own Markdown link so the user can flip back", async ({ page }) => {
    await load(page, ["id", "body"], [["1", "# T"], ["2", "ok"]]);
    await expandAll(page);
    await field(page, 1, "body").locator(".format-toggle-btn").click();
    await expect(field(page, 1, "body").locator(".detail-value-text")).toHaveText("ok");
    await expect(field(page, 1, "body").locator(".format-toggle-btn")).toHaveText("Markdown");
    await expect(field(page, 1, "body").locator(".format-toggle-btn")).toBeFocused();
  });

  test("switching a column does not reset More/Less on another column's field", async ({ page }) => {
    const longProse = Array.from({ length: 40 }, (_v, i) => `line ${i}`).join("\n");
    await load(page, ["id", "body", "notes"], [["1", MD_RICH, longProse]], { state: { markdownColumns: { notes: false } } });
    await expandAll(page);
    const more = field(page, 0, "notes").locator(".height-toggle-btn");
    await more.click();
    await expect(more).toHaveText("Less");
    await field(page, 0, "body").locator(".format-toggle-btn").click();
    await expect(field(page, 0, "notes").locator(".height-toggle-btn")).toHaveText("Less");
  });
});

test.describe("stored choice and Raw-mode links", () => {
  test("a stored { body: false } overrides auto-detect on load; { plain: true } forces a plain column to render", async ({ page }) => {
    await load(page, ["id", "body", "plain"], [["1", MD_RICH, "Just some words\nacross two lines"]], {
      state: { markdownColumns: { body: false, plain: true } },
    });
    await expandAll(page);
    await expect(field(page, 0, "body").locator(".detail-value-md")).toBeHidden();
    await expect(field(page, 0, "body").locator(".detail-value-text")).toHaveText(MD_RICH);
    await expect(field(page, 0, "body").locator(".format-toggle-btn")).toHaveText("Markdown");

    await expect(field(page, 0, "plain").locator(".detail-value-md p")).toHaveCount(1);
    await expect(field(page, 0, "plain").locator(".detail-value-md br")).toHaveCount(1);
    await expect(field(page, 0, "plain").locator(".format-toggle-btn")).toHaveText("Raw");
  });

  test("state saved by an older version (no markdownColumns) loads and auto-detects", async ({ page }) => {
    await bootShell(page);
    await page.evaluate(
      (text) => {
        const state = { columnVisibility: { id: true, body: false }, filterRules: [], quickSearch: "", sortKeys: [], firstRowIsHeader: true, pageSize: 100, delimiter: "", quotes: true };
        window.postMessage({ type: "load", fileKey: "file:///old.csv", text, state, defaultTableColumns: 8, defaultDelimiter: "", hintsSeen: [] }, "*");
      },
      toCsvText(["id", "body"], [["1", MD_RICH]]),
    );
    await expect(page.locator("#table-head th")).not.toHaveCount(0);
    await expandAll(page);
    await expect(field(page, 0, "body").locator(".detail-value-md h1")).toHaveText("Heading One");
    await clearPosted(page);
    await field(page, 0, "body").locator(".format-toggle-btn").click();
    expect(await lastSavedMarkdownColumns(page)).toEqual({ body: false });
  });

  test("in a Raw column the Markdown link appears only on capable values that are multi-line, long, or look like Markdown", async ({ page }) => {
    const headers = ["id", "short", "multiline", "long", "looksmd", "huge", "json"];
    const huge = "x".repeat(100_001);
    const state: Record<string, boolean> = {};
    for (const h of headers.slice(1)) state[h] = false;
    await load(page, headers, [["1", "ok", "one\ntwo", "w".repeat(61), "# hi", huge, '{"a":1}']], { state: { markdownColumns: state } });
    await expandAll(page);
    const link = (c: string): Locator => field(page, 0, c).locator(".format-toggle-btn");

    await expect(link("short")).toBeHidden();
    await expect(link("multiline")).toHaveText("Markdown");
    await expect(link("long")).toHaveText("Markdown");
    await expect(link("looksmd")).toHaveText("Markdown");
    await expect(link("huge")).toBeHidden();
    await expect(link("json")).toHaveText("Raw");
  });

  test("exactly 60 characters does not earn a link, and a value over 100,000 characters stays raw even in a Markdown column", async ({ page }) => {
    const huge = "# Title\n" + "x".repeat(100_000);
    await load(page, ["id", "sixty", "huge"], [["1", "y".repeat(60), huge]], { state: { markdownColumns: { sixty: false, huge: true } } });
    await expandAll(page);
    await expect(field(page, 0, "sixty").locator(".format-toggle-btn")).toBeHidden();
    const hugeDd = field(page, 0, "huge");
    await expect(hugeDd.locator(".detail-value-md")).toBeHidden();
    await expect(hugeDd.locator(".detail-value-text")).toBeVisible();
    await expect(hugeDd.locator(".format-toggle-btn")).toBeHidden();
    await expect(hugeDd.locator(".show-all-btn")).toContainText("Show all (100,008 characters)");
  });
});

test.describe("JSON is never Markdown", () => {
  test("a JSON field in an auto-Markdown column keeps Raw/Formatted and does not change the column choice", async ({ page }) => {
    await load(page, ["id", "mixed"], [
      ["1", '{"title":"# not a heading","items":[1,2]}'],
      ["2", "# A heading"],
    ]);
    await expandAll(page);
    const json = field(page, 0, "mixed");
    await expect(json.locator(".detail-value-md")).toBeHidden();
    await expect(json.locator(".detail-value-text")).toHaveClass(/detail-value-json/);
    await expect(json.locator(".format-toggle-btn")).toHaveText("Raw");
    await expect(field(page, 1, "mixed").locator(".detail-value-md h1")).toHaveText("A heading");

    await clearPosted(page);
    await json.locator(".format-toggle-btn").click();
    await expect(json.locator(".detail-value-text")).toHaveText('{"title":"# not a heading","items":[1,2]}');
    await expect(json.locator(".format-toggle-btn")).toHaveText("Formatted");
    await expect(field(page, 1, "mixed").locator(".detail-value-md h1")).toHaveText("A heading");
    expect((await posted(page)).filter((m) => m.type === "saveState")).toHaveLength(0);
  });
});

test.describe("clamp and character cap on rendered Markdown", () => {
  test("rendered Markdown is clamped to about six lines with More / Less", async ({ page }) => {
    const long = Array.from({ length: 30 }, (_v, i) => `Paragraph number ${i}`).join("\n\n");
    await load(page, ["id", "body"], [["1", `# Title\n\n${long}`]]);
    await expandAll(page);
    const dd = field(page, 0, "body");
    const md = dd.locator(".detail-value-md");
    await expect(md).toHaveClass(/detail-value-md-clamped/);
    const more = dd.locator(".height-toggle-btn");
    await expect(more).toHaveText("More");

    const lineHeight = await md.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
    const clampedHeight = (await md.boundingBox())!.height;
    expect(clampedHeight).toBeLessThanOrEqual(lineHeight * 6 + 1);

    await more.click();
    await expect(md).not.toHaveClass(/detail-value-md-clamped/);
    await expect(more).toHaveText("Less");
    expect((await md.boundingBox())!.height).toBeGreaterThan(clampedHeight * 2);

    await more.click();
    await expect(md).toHaveClass(/detail-value-md-clamped/);
  });

  test("a short Markdown value gets no More link", async ({ page }) => {
    await load(page, ["id", "body"], [["1", "# Title\n\nOne paragraph."]]);
    await expandAll(page);
    await expect(field(page, 0, "body").locator(".height-toggle-btn")).toBeHidden();
  });

  test("Markdown renders from the capped text; Show all renders the full value, Show less goes back", async ({ page }) => {
    const words = Array.from({ length: 3000 }, () => "word");
    words[words.length - 1] = "ENDMARK";
    const value = `# Title\n\n${words.join(" ")}`;
    await load(page, ["id", "body"], [["1", value]]);
    await expandAll(page);
    const dd = field(page, 0, "body");
    const md = dd.locator(".detail-value-md");
    await expect(md.locator("h1")).toHaveText("Title");
    const initial = (await md.textContent()) ?? "";
    expect(initial).toContain("…");
    expect(initial).not.toContain("ENDMARK");
    expect(initial.length).toBeLessThan(10_100);

    const showAll = dd.locator(".show-all-btn");
    await expect(showAll).toContainText("Show all");
    await showAll.click();
    await expect(md).toContainText("ENDMARK");
    await expect(md).not.toContainText("…");
    await expect(showAll).toHaveText("Show less");
    await showAll.click();
    await expect(md).not.toContainText("ENDMARK");
  });
});

test.describe("raw value is what gets copied or filtered", () => {
  test("the per-field copy button and the context menu's Copy Value copy the raw source", async ({ page }) => {
    await load(page, ["id", "body"], [["1", MD_RICH]]);
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: (text: string) => {
            (window as unknown as { __copied?: string }).__copied = text;
            return Promise.resolve();
          },
        },
        configurable: true,
      });
    });
    await expandAll(page);
    const copied = (): Promise<string | undefined> => page.evaluate(() => (window as unknown as { __copied?: string }).__copied);

    await page.locator("tr.detail-row dt:has(> .detail-field-label:text-is('body')) .field-copy-btn").click();
    expect(await copied()).toBe(MD_RICH);

    await page.evaluate(() => {
      (window as unknown as { __copied?: string }).__copied = undefined;
    });
    await field(page, 0, "body").locator(".detail-value-md strong").click({ button: "right" });
    await page.locator("#context-menu button", { hasText: "Copy Value" }).click();
    await expect.poll(copied).toBe(MD_RICH);

    await field(page, 0, "body").locator(".detail-value-md strong").click({ button: "right" });
    await page.locator("#context-menu button", { hasText: /^Show only rows where/ }).click();
    // The rule's text input strips newlines, so read the saved rule instead.
    const rule = ((await awaitPosted(page, "saveState")).state as ViewState).filterRules[0];
    expect(rule).toMatchObject({ column: "body", operator: "equals", value: MD_RICH });
  });
});

test.describe("safety", () => {
  const EVIL = [
    "<script>window.__xssFired = 1</script>",
    '<img src=x onerror="window.__xssFired = 2">',
    "[bad](javascript:window.__xssFired=3)",
    "[rel](relative/path) and [anchor](#top)",
    "![pic](https://example.com/pic.png)",
    "![](javascript:window.__xssFired=4)",
    "[ok](https://example.com/ok) <https://example.com/auto>",
  ].join("\n\n");

  test("no script runs, no <img> exists, no javascript: href, nothing is fetched, HTML shows as text", async ({ page }) => {
    const requests: string[] = [];
    page.on("request", (r) => requests.push(r.url()));
    await load(page, ["id", "body"], [["1", EVIL]], { state: { markdownColumns: { body: true } } });
    await expandAll(page);
    const md = field(page, 0, "body").locator(".detail-value-md");
    await expect(md).toBeVisible();

    expect(await page.evaluate(() => (window as unknown as { __xssFired?: number }).__xssFired)).toBeUndefined();
    await expect(page.locator("img")).toHaveCount(0);
    await expect(page.locator("script", { hasText: "__xssFired" })).toHaveCount(0);
    await expect(page.locator('a[href^="javascript" i]')).toHaveCount(0);
    await expect(md.locator("a:not([href^='http'])")).toHaveCount(0);

    await expect(md).toContainText("<script>window.__xssFired = 1</script>");
    await expect(md).toContainText('<img src=x onerror="window.__xssFired = 2">');
    await expect(md).toContainText("bad");
    await expect(md).toContainText("rel and anchor");
    await expect(md.locator('a[href="https://example.com/pic.png"]')).toHaveText("pic");
    await expect(md.locator('a[href="https://example.com/ok"]')).toHaveText("ok");
    expect(requests.filter((u) => u.includes("example.com"))).toEqual([]);
  });
});

test.describe("column names and persistence", () => {
  test("a __proto__-named column can be toggled and the choice persists across a same-file reload", async ({ page }) => {
    const text = toCsvText(["id", "__proto__"], [["1", MD_RICH]]);
    await load(page, ["id", "__proto__"], [["1", MD_RICH]]);
    await expandAll(page);
    const dd = field(page, 0, "__proto__");
    await expect(dd.locator(".detail-value-md h1")).toHaveText("Heading One");

    await clearPosted(page);
    await dd.locator(".format-toggle-btn").click();
    await expect(dd.locator(".detail-value-text")).toHaveText(MD_RICH);
    const savedJson = await page.evaluate(() => {
      const msgs = (window as unknown as { __posted: Array<{ type: string; state: { markdownColumns: object } }> }).__posted.filter((m) => m.type === "saveState");
      return JSON.stringify(msgs[msgs.length - 1].state.markdownColumns);
    });
    expect(savedJson).toBe('{"__proto__":false}');

    await page.evaluate(
      ({ text, savedJson }) => {
        const state = {
          columnVisibility: JSON.parse('{"id":true,"__proto__":false}'),
          filterRules: [],
          quickSearch: "",
          sortKeys: [],
          firstRowIsHeader: true,
          pageSize: 100,
          delimiter: "",
          quotes: true,
          markdownColumns: JSON.parse(savedJson),
        };
        window.postMessage({ type: "load", fileKey: "file:///md.csv", text, state, defaultTableColumns: 8, defaultDelimiter: "", hintsSeen: [] }, "*");
      },
      { text, savedJson },
    );
    await expect(page.locator("tr.data-row")).toHaveCount(1);
    await expandAll(page);
    const again = field(page, 0, "__proto__");
    await expect(again.locator(".detail-value-text")).toHaveText(MD_RICH);
    await expect(again.locator(".detail-value-md")).toBeHidden();
    await expect(again.locator(".format-toggle-btn")).toHaveText("Markdown");
  });

  test("a same-fileKey reload with the saved state keeps the Raw choice", async ({ page }) => {
    const headers = ["id", "body"];
    const rows = [["1", MD_RICH]];
    await load(page, headers, rows);
    await expandAll(page);
    await clearPosted(page);
    await field(page, 0, "body").locator(".format-toggle-btn").click();
    const saved = (await awaitPosted(page, "saveState")).state as ViewState;

    await pushLoadText(page, { fileKey: "file:///md.csv", text: toCsvText(headers, rows), state: saved, defaultTableColumns: 8 });
    await expect(page.locator("tr.data-row")).toHaveCount(1);
    await expandAll(page);
    await expect(field(page, 0, "body").locator(".detail-value-md")).toBeHidden();
    await expect(field(page, 0, "body").locator(".detail-value-text")).toHaveText(MD_RICH);
  });
});

test.describe("where Markdown applies", () => {
  test("table cells stay raw and single-line; the same column under 'Also in table' renders", async ({ page }) => {
    await load(page, ["id", "body"], [["1", MD_RICH]], { visible: ["id", "body"] });
    const cell = page.locator("tr.data-row").first().locator("td").nth(2);
    await expect(cell.locator("h1, strong, a, li, table, pre")).toHaveCount(0);
    expect(await cell.textContent()).toContain("# Heading One");
    expect(await cell.textContent()).toContain("**bold**");

    await page.locator("tr.data-row").first().click();
    const detail = page.locator("tr.detail-row").first();
    await expect(detail.locator(".detail-group-heading")).toHaveText("Also in table");
    await expect(detail.locator(".detail-value-md h1")).toHaveText("Heading One");
    await expect(page.locator("tr.data-row").first().locator("td").nth(2).locator("h1")).toHaveCount(0);
  });

  test("clicking a rendered link neither collapses nor toggles the row", async ({ page }) => {
    await load(page, ["id", "body"], [["1", MD_RICH], ["2", MD_SMALL]]);
    await page.locator("tr.data-row").first().click();
    await page.evaluate(() => {
      document.addEventListener("click", (e) => {
        if (e.target instanceof Element && e.target.closest("a")) e.preventDefault();
      });
    });
    await clearPosted(page);
    await field(page, 0, "body").locator('a[href="https://example.com/a"]').click();
    await expect(page.locator("tr.detail-row").first()).toBeVisible();
    await expect(page.locator("tr.data-row").first()).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("tr.data-row").nth(1)).toHaveAttribute("aria-expanded", "false");
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("");
    expect((await posted(page)).filter((m) => m.type === "saveState")).toHaveLength(0);
  });
});

test.describe("styles", () => {
  test("a Markdown table does not inherit the page table's header, cell or detail-row rules", async ({ page }) => {
    await load(page, ["id", "body"], [["1", MD_RICH]]);
    // The harness has no host theme; define the two variables these rules use.
    await page.addStyleTag({ content: ":root { --vscode-panel-border: rgb(60, 60, 60); --vscode-focusBorder: rgb(0, 127, 212); }" });
    await expandAll(page);
    const md = field(page, 0, "body").locator(".detail-value-md");
    const th = md.locator("th").first();
    const td = md.locator("td").first();

    expect(await md.locator("thead").evaluate((el) => getComputedStyle(el).position)).toBe("static");
    for (const cell of [th, td]) {
      const css = await cell.evaluate((el) => {
        const s = getComputedStyle(el);
        return {
          whiteSpace: s.whiteSpace,
          overflow: s.overflow,
          textOverflow: s.textOverflow,
          maxWidth: s.maxWidth,
          boxShadow: s.boxShadow,
          left: s.borderLeftWidth,
          right: s.borderRightWidth,
          top: s.borderTopWidth,
          bottom: s.borderBottomWidth,
        };
      });
      expect(css).toMatchObject({ whiteSpace: "normal", overflow: "visible", textOverflow: "clip", maxWidth: "none", boxShadow: "none", left: "1px", right: "1px", top: "1px", bottom: "1px" });
    }
    const accent = await page.locator("tr.detail-row > td").first().evaluate((el) => getComputedStyle(el).borderLeftColor);
    const nested = await td.evaluate((el) => getComputedStyle(el).borderLeftColor);
    expect(nested).not.toBe(accent);
    expect(await md.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe("normal");
  });

  test("a wide code block scrolls inside itself and the page never scrolls sideways", async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 600 });
    const wide = "```\n" + "0123456789".repeat(60) + "\n```\n\n| " + Array.from({ length: 25 }, (_v, i) => `column ${i}`).join(" | ") + " |\n| " + Array.from({ length: 25 }, () => "---").join(" | ") + " |";
    await load(page, ["id", "body"], [["1", wide]]);
    await expandAll(page);
    const md = field(page, 0, "body").locator(".detail-value-md");
    await expect(md.locator("pre")).toHaveCount(1);
    const pre = await md.locator("pre").evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(pre.scroll).toBeGreaterThan(pre.client);
    const wrap = await md.locator(".md-table-wrap").evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(wrap.scroll).toBeGreaterThan(wrap.client);
    const page_ = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: document.documentElement.clientWidth }));
    expect(page_.doc).toBeLessThanOrEqual(page_.win);
    const detailWrap = await page.locator(".detail-wrap").first().evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(detailWrap.scroll).toBeLessThanOrEqual(detailWrap.client + 1);
  });
});
