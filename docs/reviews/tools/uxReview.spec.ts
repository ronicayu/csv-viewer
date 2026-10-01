// THROWAWAY (UX review, not for commit): renders the real built webview in
// three real VS Code palettes at two widths and screenshots every
// meaningful state into test-results/ux-review/<theme>/<width>/.
// Run:  npx playwright test src/test/webview-e2e/review --output=/tmp/cvux-pw

import * as fs from "fs";
import * as path from "path";
import { expect, test, type Page } from "@playwright/test";
import { bootShell, defaultViewState, pushLoadText, REPO_ROOT } from "../harness";
import { toCsvText } from "../stress/stressHelpers";
import type { ViewState } from "../../../core/types";
import { THEMES, themeCss, type ThemeDef } from "./themes";
import { wideCsv } from "./fixtures";

const OUT = path.join(REPO_ROOT, "docs", "reviews", "ux-screens");
const VIEWPORTS = [
  { name: "1280", width: 1280, height: 800 },
  { name: "700", width: 700, height: 800 },
];
const PEOPLE = fs.readFileSync(path.join(REPO_ROOT, "samples", "people.csv"), "utf8");

async function boot(
  page: Page,
  theme: ThemeDef,
  vp: { width: number; height: number },
  text: string,
  state: Partial<ViewState> = {},
  defaultTableColumns = 8,
  fileKey = "file:///review.csv",
): Promise<void> {
  await page.setViewportSize({ width: vp.width, height: vp.height });
  await bootShell(page);
  await page.addStyleTag({ content: themeCss(theme) });
  await page.evaluate((kind) => {
    document.body.classList.add(kind);
    document.body.dataset.vscodeThemeKind = kind;
  }, theme.kind);
  await pushLoadText(page, { fileKey, text, state: defaultViewState(state), defaultTableColumns });
  await expect(page.locator("#table-head th")).not.toHaveCount(0);
  await expect(page.locator("#status-bar")).toHaveText(/^Showing/);
  await page.waitForTimeout(100);
}

function shotPath(theme: ThemeDef, vpName: string, name: string): string {
  const dir = path.join(OUT, theme.name, vpName);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${name}.png`);
}

async function shot(page: Page, theme: ThemeDef, vpName: string, name: string): Promise<void> {
  await page.mouse.move(1, 1); // park the pointer so hover doesn't leak into shots
  await page.screenshot({ path: shotPath(theme, vpName, name) });
}

const BAD_QUOTES = ['id,name,comment', '1,Alice,fine', '2,Bob,"starts quoted but never closes', '3,Cara,ok', '4,Dan,ok', '5,Eve,ok'].join("\n");

for (const theme of THEMES) {
  for (const vp of VIEWPORTS) {
    test.describe(`${theme.name} @ ${vp.name}`, () => {
      test("people default", async ({ page }) => {
        await boot(page, theme, vp, PEOPLE);
        await shot(page, theme, vp.name, "01-people-default");
        await page.locator("tr.data-row").nth(4).hover();
        await page.screenshot({ path: shotPath(theme, vp.name, "01b-people-hover") });
      });

      test("people expanded", async ({ page }) => {
        await boot(page, theme, vp, PEOPLE);
        await page.locator("tr.data-row").nth(4).click(); // Eve: multi-line note
        await shot(page, theme, vp.name, "02-people-expanded");
      });

      test("wide default + expanded + JSON", async ({ page }) => {
        await boot(page, theme, vp, wideCsv(240));
        await shot(page, theme, vp.name, "03-wide-default");
        await page.locator("tr.data-row").first().click();
        await shot(page, theme, vp.name, "04-wide-expanded-top");
        await page.locator("dt", { hasText: "metadata_json" }).first().scrollIntoViewIfNeeded();
        await shot(page, theme, vp.name, "05-wide-expanded-json");
      });

      test("wide show all", async ({ page }) => {
        await boot(page, theme, vp, wideCsv(240, { hugeTranscriptRow: 1 }));
        await page.locator("tr.data-row").nth(1).click();
        const btn = page.locator(".show-all-btn").first();
        await btn.scrollIntoViewIfNeeded();
        await page.locator("#table-scroll").evaluate((el) => (el.scrollTop += 200));
        await shot(page, theme, vp.name, "06-wide-show-all");
      });

      test("wide expand page", async ({ page }) => {
        await boot(page, theme, vp, wideCsv(240));
        await page.locator("#expand-all-btn").click();
        await shot(page, theme, vp.name, "07-wide-expand-page");
      });

      test("columns popover", async ({ page }) => {
        await boot(page, theme, vp, wideCsv(240));
        await page.locator("#columns-btn").click();
        await shot(page, theme, vp.name, "08-columns-popover");
      });

      test("filters panel with problem rules", async ({ page }) => {
        test.setTimeout(20_000);
        const rules = [
          { id: "r1", column: "status", operator: "equals" as const, value: "", mode: "include" as const, caseSensitive: false, enabled: true },
          { id: "r2", column: "legacy_owner", operator: "contains" as const, value: "Priya", mode: "include" as const, caseSensitive: false, enabled: true },
          { id: "r3", column: "external_ref", operator: "regex" as const, value: "(a+)+$", mode: "include" as const, caseSensitive: false, enabled: true },
          { id: "r4", column: "region", operator: "equals" as const, value: "EMEA", mode: "exclude" as const, caseSensitive: false, enabled: true },
        ];
        await boot(page, theme, vp, wideCsv(240, { pathologicalRef: true }), { filterRules: rules });
        await page.locator("#filters-btn").click();
        await expect(page.locator(".rule-error-text", { hasText: "Regex too slow" })).toBeVisible({ timeout: 6000 });
        await page.waitForTimeout(300);
        await shot(page, theme, vp.name, "09-filters-panel");
      });

      test("quote banner", async ({ page }) => {
        await boot(page, theme, vp, BAD_QUOTES);
        await expect(page.locator("#quote-warning-banner")).toBeVisible();
        await shot(page, theme, vp.name, "10-quote-banner");
      });

      test("zero results", async ({ page }) => {
        await boot(page, theme, vp, wideCsv(240));
        await page.locator("#quick-search").fill("zzqx-no-such-thing");
        await expect(page.locator("#status-bar")).toHaveText(/^Showing 0 of/);
        await shot(page, theme, vp.name, "11-zero-results");
      });

      test("last page", async ({ page }) => {
        await boot(page, theme, vp, wideCsv(240));
        await page.locator("#pager-last-btn").click();
        await expect(page.locator("#pager-page-input")).toHaveValue("3");
        await shot(page, theme, vp.name, "12-last-page");
      });

      test("custom separator error", async ({ page }) => {
        await boot(page, theme, vp, PEOPLE);
        await page.locator("#separator-select").selectOption("custom");
        await page.locator("#separator-custom").fill('"');
        await expect(page.locator("#separator-custom-error")).toBeVisible();
        await shot(page, theme, vp.name, "13-separator-error");
      });

      test("context menu quick-add", async ({ page }) => {
        await boot(page, theme, vp, PEOPLE);
        await page.locator("tr.data-row").nth(2).locator("td").nth(5).click({ button: "right" });
        await page.screenshot({ path: shotPath(theme, vp.name, "14-context-menu") });
      });

      test("sorted multi + hidden-column sort", async ({ page }) => {
        await boot(page, theme, vp, PEOPLE);
        await page.locator("th.sortable", { hasText: "department" }).click();
        await page.locator("th.sortable", { hasText: "salary" }).click({ modifiers: ["Shift"] });
        await page.locator("th.sortable", { hasText: "salary" }).click({ modifiers: ["Shift"] });
        await page.waitForTimeout(300);
        await shot(page, theme, vp.name, "15-multi-sort");
      });

      test("hide all columns", async ({ page }) => {
        await boot(page, theme, vp, PEOPLE);
        await page.locator("#columns-btn").click();
        await page.locator("#columns-hide-all").click();
        await page.keyboard.press("Escape");
        await page.waitForTimeout(200);
        await shot(page, theme, vp.name, "16-hide-all");
      });

      test("focus rings", async ({ page }) => {
        await boot(page, theme, vp, PEOPLE);
        await page.locator("body").click({ position: { x: 5, y: 790 } });
        // Walk Tab and capture specific stops.
        const want: Record<string, string> = {
          "quick-search": "17a-focus-search",
          "columns-btn": "17b-focus-columns-btn",
          "sort-by-select": "17c-focus-sortby",
          "first-row-header": "17d-focus-checkbox",
          "open-as-text-btn": "17e-focus-open-as-text",
          "pager-page-input": "17g-focus-page-input",
        };
        let gotTh = false;
        for (let i = 0; i < 40; i++) {
          await page.keyboard.press("Tab");
          const info = await page.evaluate(() => {
            const a = document.activeElement as HTMLElement | null;
            return { id: a?.id ?? "", tag: a?.tagName ?? "" };
          });
          const name = want[info.id];
          if (name) await page.screenshot({ path: shotPath(theme, vp.name, name) });
          if (info.tag === "TH" && !gotTh) {
            gotTh = true;
            await page.screenshot({ path: shotPath(theme, vp.name, "17f-focus-header") });
          }
        }
      });
    });
  }

  test(`${theme.name} working indicator (200k rows)`, async ({ page }) => {
    test.setTimeout(90_000);
    const headers = ["id", "name", "city", "amount", "note"];
    const rows: string[][] = [];
    for (let i = 0; i < 200_000; i++) rows.push([String(i), `name ${i % 977}`, `city ${i % 113}`, String((i * 37) % 10007), `note ${i}`]);
    await boot(page, theme, VIEWPORTS[0], toCsvText(headers, rows), {}, 8, "file:///big.csv");
    let caught = false;
    for (let attempt = 0; attempt < 6 && !caught; attempt++) {
      const col = ["amount", "name", "city", "note", "id"][attempt % 5];
      await page.locator("th.sortable", { hasText: col }).first().click();
      try {
        await expect(page.locator("#working-indicator")).toBeVisible({ timeout: 1500 });
        await page.screenshot({ path: shotPath(theme, "1280", "18-working-indicator") });
        caught = true;
      } catch {
        /* too fast this time */
      }
      await expect(page.locator("#working-indicator")).toBeHidden({ timeout: 30_000 });
    }
    fs.writeFileSync(path.join(OUT, theme.name, `working-caught.txt`), String(caught));
  });

  test(`${theme.name} contrast audit`, async ({ page }) => {
    test.setTimeout(30_000);
    const rules = [
      { id: "r1", column: "status", operator: "equals" as const, value: "", mode: "include" as const, caseSensitive: false, enabled: true },
      { id: "r2", column: "legacy_owner", operator: "contains" as const, value: "x", mode: "include" as const, caseSensitive: false, enabled: true },
    ];
    await boot(page, theme, VIEWPORTS[0], BAD_QUOTES, { filterRules: rules, sortKeys: [{ column: "name", direction: "asc" }] }, 8);
    await page.locator("#filters-btn").click();
    await page.locator("tr.data-row").first().click();
    await page.locator("#separator-select").selectOption("custom");
    await page.locator("#separator-custom").fill('"');
    await expect(page.locator("#separator-custom-error")).toBeVisible();
    await page.mouse.move(1, 1);
    const results = await page.evaluate(() => {
      type RGBA = [number, number, number, number];
      const parse = (s: string): RGBA | null => {
        const m = s.match(/rgba?\(([^)]+)\)/);
        if (!m) return null;
        const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
        return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
      };
      const over = (top: RGBA, bottom: RGBA): RGBA => {
        const a = top[3] + bottom[3] * (1 - top[3]);
        if (a === 0) return [0, 0, 0, 0];
        return [0, 1, 2].map((i) => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a).concat(a) as RGBA;
      };
      const bgOf = (el: Element | null): RGBA => {
        const layers: RGBA[] = [];
        let e: Element | null = el;
        while (e) {
          const c = parse(getComputedStyle(e).backgroundColor);
          if (c && c[3] > 0) layers.push(c);
          if (c && c[3] >= 1) break;
          e = e.parentElement;
        }
        let acc: RGBA = [255, 255, 255, 1];
        for (const l of layers.reverse()) acc = over(l, acc);
        return acc;
      };
      const opacityOf = (el: Element | null): number => {
        let o = 1;
        for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
        return o;
      };
      const lum = (c: RGBA): number => {
        const f = (v: number) => {
          v /= 255;
          return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
      };
      const ratio = (a: RGBA, b: RGBA): number => {
        const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
        return Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100;
      };
      const hex = (c: RGBA) => "#" + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
      const out: Record<string, unknown>[] = [];
      const text = (label: string, sel: string, pseudo?: string) => {
        const el = document.querySelector(sel);
        if (!el) return out.push({ label, sel, missing: true });
        const bg = bgOf(el);
        let fg = parse(getComputedStyle(el, pseudo).color)!;
        fg = over([fg[0], fg[1], fg[2], fg[3] * opacityOf(el)], bg);
        out.push({ label, kind: "text", fg: hex(fg), bg: hex(bg), ratio: ratio(fg, bg) });
      };
      const nonText = (label: string, sel: string, prop: "borderTopColor" | "outlineColor", against?: string) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) return out.push({ label, sel, missing: true });
        const bg = against ? bgOf(document.querySelector(against)) : bgOf(el.parentElement);
        const c = parse(getComputedStyle(el)[prop]);
        if (!c) return out.push({ label, sel, none: getComputedStyle(el)[prop] });
        const fg = over(c, bg);
        out.push({ label, kind: "non-text", fg: hex(fg), bg: hex(bg), ratio: ratio(fg, bg) });
      };
      text("table cell text", "tr.data-row td:nth-child(2)");
      text("chevron ▶", "tr.data-row .chevron");
      text("sort indicator ▲", ".sort-indicator");
      text("status line", "#status-bar");
      text("toolbar label (Sort by…)", ".sort-by-label");
      text("detail key (dt)", "tr.detail-row:not([hidden]) dt");
      text("detail value (dd)", "tr.detail-row:not([hidden]) dd");
      text("primary button label", "#columns-btn");
      text("pager text", ".pager-page-label");
      text("disabled pager button «", "#pager-first-btn");
      text("rule error text (Column not found)", ".rule-row.rule-error .rule-error-text");
      text("rule hint text (Enter a value)", ".rule-row.rule-hint .rule-error-text");
      text("separator error", "#separator-custom-error");
      text("quote banner text", "#quote-warning-text");
      text("quote banner button", "#quote-warning-fix-btn");
      text("search placeholder", "#quick-search", "::placeholder");
      text("working indicator", "#working-indicator");
      nonText("input border vs bg", "#quick-search", "borderTopColor", ".toolbar");
      nonText("row separator (td border)", "tr.data-row td", "borderTopColor");
      nonText("quote banner border", "#quote-warning-banner", "borderTopColor", "#app");
      // focus outline: focus a header first
      (document.querySelector("th.sortable") as HTMLElement).focus();
      nonText("focus outline on header", "th.sortable", "outlineColor", "#table-head");
      (document.querySelector("#columns-btn") as HTMLElement).focus();
      nonText("focus outline on primary button (vs toolbar)", "#columns-btn", "outlineColor", ".toolbar");
      const btn = document.querySelector("#columns-btn") as HTMLElement;
      const btnBg = bgOf(btn);
      const ring = parse(getComputedStyle(btn).outlineColor)!;
      out.push({ label: "focus outline vs primary button fill (offset 1px)", kind: "non-text", fg: hex(ring), bg: hex(btnBg), ratio: ratio(over(ring, btnBg), btnBg) });
      (document.querySelector('.rule-row input[type="checkbox"]') as HTMLElement).focus();
      out.push({ label: "native checkbox accent", accent: getComputedStyle(document.querySelector('.rule-row input[type="checkbox"]')!).accentColor, colorScheme: getComputedStyle(document.documentElement).colorScheme });
      return out;
    });
    fs.mkdirSync(path.join(OUT, theme.name), { recursive: true });
    fs.writeFileSync(path.join(OUT, theme.name, "contrast.json"), JSON.stringify(results, null, 2));
    await page.screenshot({ path: shotPath(theme, "1280", "19-contrast-audit-state") });
  });
}

// ---- Behavior audit (one theme is enough) ------------------------------------
test("behavior audit (dark-modern 1280)", async ({ page }) => {
  test.setTimeout(30_000);
  const theme = THEMES[1];
  const log: Record<string, unknown> = {};
  await boot(page, theme, VIEWPORTS[0], PEOPLE);

  // 1. Tab order from a fresh document.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const order: string[] = [];
  for (let i = 0; i < 45; i++) {
    await page.keyboard.press("Tab");
    order.push(
      await page.evaluate(() => {
        const a = document.activeElement as HTMLElement | null;
        if (!a || a === document.body) return "BODY";
        const name = a.getAttribute("aria-label") ?? a.getAttribute("title") ?? (a.textContent ?? "").trim().slice(0, 30);
        return `${a.tagName.toLowerCase()}${a.id ? "#" + a.id : ""}${a.getAttribute("role") ? "[role=" + a.getAttribute("role") + "]" : ""} "${name}"`;
      }),
    );
  }
  log.tabOrder = order;
  log.rowsFocusable = await page.evaluate(() => Array.from(document.querySelectorAll("tr.data-row, .chevron")).some((e) => (e as HTMLElement).tabIndex >= 0));

  // 2. Enter on a header: does focus stay, is sort state exposed?
  await page.locator("th.sortable").first().focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  log.headerAfterEnter = await page.evaluate(() => {
    const a = document.activeElement as HTMLElement;
    return { focusedTag: a.tagName, text: a.textContent, ariaSort: a.getAttribute("aria-sort"), role: a.getAttribute("role") };
  });

  // 3. Columns popover: focus moves in? Escape returns focus?
  await page.locator("#columns-btn").focus();
  await page.keyboard.press("Enter");
  log.columnsOpenFocus = await page.evaluate(() => document.activeElement?.id);
  log.columnsBtnAria = await page.evaluate(() => ({
    expanded: document.querySelector("#columns-btn")!.getAttribute("aria-expanded"),
    haspopup: document.querySelector("#columns-btn")!.getAttribute("aria-haspopup"),
    popoverRole: document.querySelector("#columns-popover")!.getAttribute("role"),
  }));
  await page.locator("#columns-search").focus();
  await page.keyboard.press("Escape");
  log.afterEscapeFocus = await page.evaluate(() => (document.activeElement === document.body ? "BODY" : document.activeElement?.id));
  log.escapeOnSearchClearsSearch = await page.evaluate(() => (document.querySelector("#columns-search") as HTMLInputElement).value);

  // 4. Click outside popover closes it?
  await page.locator("#columns-btn").click();
  await page.locator("#status-bar").click();
  log.columnsStillOpenAfterOutsideClick = await page.locator("#columns-popover").isVisible();
  // Clicking a row while popover open expands the row (click-through)?
  await page.locator("tr.data-row").nth(1).click();
  log.rowExpandedByClickWhilePopoverOpen = await page.locator("tr.detail-row").nth(1).isVisible();
  await page.keyboard.press("Escape");
  await page.locator("tr.data-row").nth(1).click(); // collapse again

  // 5. Drag-select text inside a cell: does the row toggle?
  const cell = page.locator("tr.data-row").nth(3).locator("td").nth(4);
  const box = (await cell.boundingBox())!;
  await page.mouse.move(box.x + 3, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 5, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  log.selectionText = await page.evaluate(() => String(window.getSelection()));
  log.rowExpandedAfterDragSelect = await page.locator("tr.detail-row").nth(3).isVisible();
  // Double-click to select a word
  await page.locator("tr.data-row").nth(5).locator("td").nth(4).dblclick();
  log.rowExpandedAfterDoubleClick = await page.locator("tr.detail-row").nth(5).isVisible();

  // 6. Escape inside quick search: clears it AND closes popovers?
  await page.locator("#quick-search").fill("Alice");
  await page.waitForTimeout(400);
  await page.locator("#quick-search").press("Escape");
  await page.waitForTimeout(400);
  log.quickSearchAfterEscape = await page.locator("#quick-search").inputValue();
  log.statusAfterEscape = await page.locator("#status-bar").textContent();

  // 7. Accessibility tree
  log.ariaSnapshot = await page.locator("#app").ariaSnapshot();
  await page.locator("#filters-btn").click();
  await page.locator("#add-rule-btn").click();
  log.ruleRowAria = await page.locator(".rule-row").first().ariaSnapshot();
  // live regions?
  log.liveRegions = await page.evaluate(() => Array.from(document.querySelectorAll("[aria-live],[role=status],[role=alert]")).map((e) => e.id || e.className));
  log.reducedMotionRules = await page.evaluate(() => Array.from(document.styleSheets).some((s) => { try { return Array.from(s.cssRules).some((r) => r.cssText.includes("prefers-reduced-motion")); } catch { return false; } }));
  log.transitionsOrAnimations = await page.evaluate(() => Array.from(document.querySelectorAll("*")).some((e) => { const cs = getComputedStyle(e); return cs.transitionDuration !== "0s" || cs.animationName !== "none"; }));

  // 8. Alt+Arrow with focus on a header
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "behavior-audit.json"), JSON.stringify(log, null, 2));
});

// ---- Narrow toolbar geometry ----------------------------------------------------
test("toolbar geometry at several widths", async ({ page }) => {
  const theme = THEMES[0];
  const res: Record<string, unknown> = {};
  for (const w of [1280, 1000, 900, 700, 500]) {
    await boot(page, theme, { width: w, height: 800 }, PEOPLE);
    res[w] = await page.evaluate(() => {
      const tb = document.querySelector(".toolbar")!.getBoundingClientRect();
      const kids = Array.from(document.querySelector(".toolbar")!.children).filter((c) => !(c as HTMLElement).hidden);
      const lines = new Set(kids.map((k) => Math.round(k.getBoundingClientRect().top))).size;
      const tableTop = document.querySelector("#table-scroll")!.getBoundingClientRect().top;
      const pager = document.querySelector("#pager-bar")!.getBoundingClientRect();
      return { toolbarHeight: Math.round(tb.height), toolbarLines: lines, tableTop: Math.round(tableTop), pagerHeight: Math.round(pager.height), visibleTableHeight: Math.round(pager.top - tableTop) };
    });
    // where would the popover be?
    await page.locator("#columns-btn").click();
    (res[w] as Record<string, unknown>).popoverTop = await page.evaluate(() => Math.round(document.querySelector("#columns-popover")!.getBoundingClientRect().top));
    (res[w] as Record<string, unknown>).columnsBtnBottom = await page.evaluate(() => Math.round(document.querySelector("#columns-btn")!.getBoundingClientRect().bottom));
  }
  fs.writeFileSync(path.join(OUT, "toolbar-geometry.json"), JSON.stringify(res, null, 2));
});
