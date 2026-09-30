// Boot helpers for the webview e2e suite. These specs load the *shipped*
// webview bundle (out/webview/main.js) into real Chromium with
// `acquireVsCodeApi` stubbed, push a `load` message the same way the
// extension host would, and then drive the rendered UI.

import * as path from "path";
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
    ...overrides,
  };
}

/** Boot the shell and push a `load` message, exactly as the host would. */
export async function bootAndLoad(page: Page, data: Omit<LoadMessage, "type">): Promise<void> {
  await bootShell(page);
  await page.evaluate((msg) => window.postMessage(msg, "*"), { type: "load", ...data });
  // Wait for the table to actually render this file's headers before the
  // spec starts interacting with it.
  await expect(page.locator("#table-head th")).not.toHaveCount(0);
}
