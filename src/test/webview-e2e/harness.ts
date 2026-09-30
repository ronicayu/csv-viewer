// Boot helpers for the webview e2e suite. These specs load the *shipped*
// webview bundle (out/webview/main.js) into real Chromium with
// `acquireVsCodeApi` stubbed, push a `load` message the same way the
// extension host would, and then drive the rendered UI.

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

/** Every message the client has posted to the host, oldest first. */
export async function posted(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(() => (window as unknown as { __posted: Array<Record<string, unknown>> }).__posted);
}

/** Drop the recorded messages — call after boot so a spec asserts only its own action. */
export async function clearPosted(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __posted: unknown[] }).__posted.length = 0;
  });
}

/** Wait until at least one message of `type` has been posted and return the last one. */
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

/** Boot the webview shell (loads the bundle, waits for the initial `ready`). */
export async function bootShell(page: Page): Promise<void> {
  page.on("pageerror", (err) => {
    throw new Error(`uncaught error in webview: ${err.message}`);
  });
  await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div></body></html>');
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
    ...overrides,
  };
}

/**
 * Fixture data for a `load` message, in the convenient `headers`/`rows`
 * shape specs have always used. The real host now sends `text` (the whole
 * document), not parsed `headers`/`rows` — parsing moved into the webview
 * for performance — so this is serialized to CSV text (quoting handled by
 * Papa.unparse, the same library the webview parses with) before posting.
 */
export interface FixtureLoad {
  fileKey: string;
  headers: string[];
  rows: string[][];
  state: ViewState;
  defaultTableColumns: number;
  /** Defaults to "" (auto), same as the host would send for a .csv file. */
  defaultDelimiter?: string;
}

/** A `load` message built from raw CSV/TSV text instead of headers/rows —
 * for specs that need to exercise parsing itself (delimiter detection,
 * quoting edge cases) rather than starting from already-tabular data. */
export interface TextLoad {
  fileKey: string;
  text: string;
  state: ViewState;
  defaultTableColumns: number;
  defaultDelimiter?: string;
}

function toLoadMessage(data: FixtureLoad): Omit<LoadMessage, "type"> {
  const text = Papa.unparse({ fields: data.headers, data: data.rows });
  return {
    fileKey: data.fileKey,
    text,
    state: data.state,
    defaultTableColumns: data.defaultTableColumns,
    defaultDelimiter: data.defaultDelimiter ?? "",
  };
}

function toTextLoadMessage(data: TextLoad): Omit<LoadMessage, "type"> {
  return {
    fileKey: data.fileKey,
    text: data.text,
    state: data.state,
    defaultTableColumns: data.defaultTableColumns,
    defaultDelimiter: data.defaultDelimiter ?? "",
  };
}

/** Push a `load` message built from headers/rows into an already-booted page. */
export async function pushLoad(page: Page, data: FixtureLoad): Promise<void> {
  const message = { type: "load" as const, ...toLoadMessage(data) };
  await page.evaluate((msg) => window.postMessage(msg, "*"), message);
}

/** Push a `load` message built from raw text into an already-booted page. */
export async function pushLoadText(page: Page, data: TextLoad): Promise<void> {
  const message = { type: "load" as const, ...toTextLoadMessage(data) };
  await page.evaluate((msg) => window.postMessage(msg, "*"), message);
}

/** Boot the shell and push a `load` message built from headers/rows, exactly
 * as specs have always specified fixtures — just serialized to CSV text
 * under the hood, matching what the real host now sends. */
export async function bootAndLoad(page: Page, data: FixtureLoad): Promise<void> {
  await bootShell(page);
  await pushLoad(page, data);
  // Wait for the table to actually render this file's headers before the
  // spec starts interacting with it.
  await expect(page.locator("#table-head th")).not.toHaveCount(0);
}

/** Boot the shell and push a `load` message built from raw text. */
export async function bootAndLoadText(page: Page, data: TextLoad): Promise<void> {
  await bootShell(page);
  await pushLoadText(page, data);
  await expect(page.locator("#table-head th")).not.toHaveCount(0);
}
