import * as fs from "fs";
import * as path from "path";
import Papa from "papaparse";
import { expect, type Page } from "@playwright/test";
import type { LoadMessage, ViewState } from "../../core/types";

export const REPO_ROOT = path.resolve(__dirname, "../../..");
const outFile = (...parts: string[]): string => path.join(REPO_ROOT, "out", ...parts);

const VSCODE_API_STUB = `
window.__posted = [];
window.acquireVsCodeApi = function () {
  return {
    postMessage: function (msg) { window.__posted.push(msg); },
    setState: function () {},
    getState: function () { return undefined; },
  };
};
`;

// Absolute fake-origin URL: page.setContent gives no base URL to resolve a relative path against.
const WORKER_SRC_URL = "https://csv-viewer.invalid/out/webview/worker.js";

// Inline the codicon font as a data: URI; there is no base URL here and icons would render as boxes.
let codiconCssCache: string | null = null;
function codiconCss(): string {
  if (codiconCssCache !== null) return codiconCssCache;
  const dist = path.join(REPO_ROOT, "node_modules", "@vscode", "codicons", "dist");
  const css = fs.readFileSync(path.join(dist, "codicon.css"), "utf8");
  const fontBase64 = fs.readFileSync(path.join(dist, "codicon.ttf")).toString("base64");
  codiconCssCache = css.replace(/url\("\.\/codicon\.ttf\?[^"]*"\)/, `url("data:font/ttf;base64,${fontBase64}")`);
  return codiconCssCache;
}

export async function posted(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(() => (window as unknown as { __posted: Array<Record<string, unknown>> }).__posted);
}

export async function clearPosted(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __posted: unknown[] }).__posted.length = 0;
  });
}

export async function awaitPosted(page: Page, type: string): Promise<Record<string, unknown>> {
  await expect
    .poll(async () => (await posted(page)).filter((m) => m.type === type).length, {
      message: `waiting for a "${type}" message`,
      timeout: 5000,
    })
    .toBeGreaterThan(0);
  const matches = (await posted(page)).filter((m) => m.type === type);
  return matches[matches.length - 1];
}

export async function bootShell(page: Page): Promise<void> {
  page.on("pageerror", (err) => {
    throw new Error(`uncaught error in webview: ${err.message}`);
  });
  await page.route(WORKER_SRC_URL, async (route) => {
    await route.fulfill({
      path: outFile("webview", "worker.js"),
      contentType: "application/javascript",
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  });
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app" data-worker-src="${WORKER_SRC_URL}"></div></body></html>`,
  );
  // Layered like VS Code's default body padding, so main.css's unlayered rule wins as in production.
  await page.addStyleTag({ content: "@layer vscode-default { body { padding: 0 20px; } }" });
  await page.addStyleTag({ content: codiconCss() });
  await page.addStyleTag({ path: outFile("webview", "main.css") });
  await page.addScriptTag({ content: VSCODE_API_STUB });
  await page.addScriptTag({ path: outFile("webview", "main.js") });
  await awaitPosted(page, "ready");
  await clearPosted(page);
}

export function defaultViewState(overrides: Partial<ViewState> = {}): ViewState {
  return {
    columnVisibility: {},
    filterRules: [],
    quickSearch: "",
    sortKeys: [],
    firstRowIsHeader: true,
    pageSize: 100,
    delimiter: "",
    quotes: true,
    markdownColumns: {},
    ...overrides,
  };
}

export interface FixtureLoad {
  fileKey: string;
  headers: string[];
  rows: string[][];
  state: ViewState;
  defaultTableColumns: number;
  defaultDelimiter?: string;
  testHooks?: boolean;
  hintsSeen?: string[];
}

export interface TextLoad {
  fileKey: string;
  text: string;
  state: ViewState;
  defaultTableColumns: number;
  defaultDelimiter?: string;
  testHooks?: boolean;
  hintsSeen?: string[];
}

function toLoadMessage(data: FixtureLoad): Omit<LoadMessage, "type"> {
  const text = Papa.unparse({ fields: data.headers, data: data.rows });
  return {
    fileKey: data.fileKey,
    text,
    state: data.state,
    defaultTableColumns: data.defaultTableColumns,
    defaultDelimiter: data.defaultDelimiter ?? "",
    testHooks: data.testHooks ?? false,
    hintsSeen: data.hintsSeen ?? [],
  };
}

function toTextLoadMessage(data: TextLoad): Omit<LoadMessage, "type"> {
  return {
    fileKey: data.fileKey,
    text: data.text,
    state: data.state,
    defaultTableColumns: data.defaultTableColumns,
    defaultDelimiter: data.defaultDelimiter ?? "",
    testHooks: data.testHooks ?? false,
    hintsSeen: data.hintsSeen ?? [],
  };
}

export async function pushLoad(page: Page, data: FixtureLoad): Promise<void> {
  const message = { type: "load" as const, ...toLoadMessage(data) };
  await page.evaluate((msg) => window.postMessage(msg, "*"), message);
}

export async function pushLoadText(page: Page, data: TextLoad): Promise<void> {
  const message = { type: "load" as const, ...toTextLoadMessage(data) };
  await page.evaluate((msg) => window.postMessage(msg, "*"), message);
}

export async function bootAndLoad(page: Page, data: FixtureLoad): Promise<void> {
  await bootShell(page);
  await pushLoad(page, data);
  await expect(page.locator("#table-head th")).not.toHaveCount(0);
}

export async function bootAndLoadText(page: Page, data: TextLoad): Promise<void> {
  await bootShell(page);
  await pushLoadText(page, data);
  await expect(page.locator("#table-head th")).not.toHaveCount(0);
}
