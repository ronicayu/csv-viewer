import * as fs from "fs";
import * as path from "path";
import Papa from "papaparse";
import { expect, type Page } from "@playwright/test";
import type { ParseTuning } from "../../webview/workerProtocol";
import type { HostToWebviewMessage, LoadMessage, PendingRecordEdit, ReadOnlyReason, RecordFloor, ViewState } from "../../core/types";

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

export interface BootOptions {
  // Holds the worker script back, as a slow disk or a busy machine would.
  workerDelayMs?: number;
  onWorkerRequest?: () => void;
  // Fails this many worker-script requests before letting one through.
  failWorkerRequests?: number;
  // Cuts the worker's parse into slices of this many records and waits this long between them (with testHooks on), so a test can act mid-parse.
  parseTuning?: ParseTuning;
}

export async function bootShell(page: Page, options: BootOptions = {}): Promise<void> {
  let failuresLeft = options.failWorkerRequests ?? 0;
  page.on("pageerror", (err) => {
    throw new Error(`uncaught error in webview: ${err.message}`);
  });
  await page.route(WORKER_SRC_URL, async (route) => {
    options.onWorkerRequest?.();
    if (failuresLeft > 0) {
      failuresLeft--;
      await route.abort();
      return;
    }
    if (options.workerDelayMs) await new Promise((resolve) => setTimeout(resolve, options.workerDelayMs));
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
  if (options.parseTuning) await page.addScriptTag({ content: `window.__csvParseTuning = ${JSON.stringify(options.parseTuning)};` });
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
  baseVersion?: number;
  editable?: boolean;
  readOnlyReason?: ReadOnlyReason;
  pendingEdits?: PendingRecordEdit[];
}

export interface TextLoad {
  fileKey: string;
  text: string;
  state: ViewState;
  defaultTableColumns: number;
  defaultDelimiter?: string;
  testHooks?: boolean;
  hintsSeen?: string[];
  baseVersion?: number;
  editable?: boolean;
  readOnlyReason?: ReadOnlyReason;
  pendingEdits?: PendingRecordEdit[];
  recordFloors?: RecordFloor[];
}

function editingFields(data: FixtureLoad | Omit<TextLoad, "text">): Pick<LoadMessage, "baseVersion" | "editable" | "readOnlyReason" | "pendingEdits" | "recordFloors"> {
  const editable = data.editable ?? true;
  return {
    baseVersion: data.baseVersion ?? 1,
    editable,
    readOnlyReason: editable ? undefined : (data.readOnlyReason ?? "setting"),
    pendingEdits: data.pendingEdits ?? [],
    recordFloors: "recordFloors" in data ? data.recordFloors : undefined,
  };
}

// A load message without its file: the page encodes the text itself, so the encoding happens before any clock a spec might have started.
type LoadEnvelope = Omit<LoadMessage, "type" | "bytes">;

function toLoadMessage(data: FixtureLoad): LoadEnvelope {
  return {
    fileKey: data.fileKey,
    state: data.state,
    defaultTableColumns: data.defaultTableColumns,
    defaultDelimiter: data.defaultDelimiter ?? "",
    testHooks: data.testHooks ?? false,
    hintsSeen: data.hintsSeen ?? [],
    ...editingFields(data),
  };
}

function toTextLoadMessage(data: Omit<TextLoad, "text">): LoadEnvelope {
  return {
    fileKey: data.fileKey,
    state: data.state,
    defaultTableColumns: data.defaultTableColumns,
    defaultDelimiter: data.defaultDelimiter ?? "",
    testHooks: data.testHooks ?? false,
    hintsSeen: data.hintsSeen ?? [],
    ...editingFields(data),
  };
}

// Plays the host: delivers any host-to-webview message exactly as the extension's postMessage would.
export async function postFromHost(page: Page, message: HostToWebviewMessage): Promise<void> {
  await page.evaluate((msg) => window.postMessage(msg, "*"), message);
}

// Plays the host as it really is: the file crosses as bytes, a view that sits inside a larger buffer (readFile's result is not at offset 0).
async function postLoad(page: Page, envelope: LoadEnvelope, file: { text: string } | { values: number[] }): Promise<void> {
  await page.evaluate(
    ({ msg, source }) => {
      const encoded = "text" in source ? new TextEncoder().encode(source.text) : Uint8Array.from(source.values);
      const backing = new Uint8Array(encoded.length + 9);
      backing.set(encoded, 9);
      window.postMessage({ type: "load", ...msg, bytes: backing.subarray(9) }, "*");
    },
    { msg: envelope, source: file },
  );
}

// The two halves of a chunked load as the host sends them (a header, then chunks of exact-size arrays), for specs that interleave other messages.
export async function postLoadHeader(page: Page, data: Omit<TextLoad, "text">, loadId: number, byteLength: number): Promise<void> {
  const message = { type: "load" as const, ...toTextLoadMessage(data), chunked: true as const, loadId, byteLength };
  await page.evaluate((msg) => window.postMessage(msg, "*"), message);
}

export async function postLoadChunk(page: Page, loadId: number, offset: number, bytes: Uint8Array): Promise<void> {
  await page.evaluate(
    ({ id, at, values }) => window.postMessage({ type: "loadChunk", loadId: id, offset: at, bytes: Uint8Array.from(values) }, "*"),
    { id: loadId, at: offset, values: Array.from(bytes) },
  );
}

export async function pushLoadChunked(page: Page, data: Omit<TextLoad, "text"> & { bytes: Uint8Array }, chunkBytes: number, loadId = 1): Promise<void> {
  const { bytes, ...rest } = data;
  await postLoadHeader(page, rest, loadId, bytes.length);
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) await postLoadChunk(page, loadId, offset, bytes.subarray(offset, offset + chunkBytes));
}

export async function pushLoad(page: Page, data: FixtureLoad): Promise<void> {
  await postLoad(page, toLoadMessage(data), { text: Papa.unparse({ fields: data.headers, data: data.rows }) });
}

export async function pushLoadText(page: Page, data: TextLoad): Promise<void> {
  await postLoad(page, toTextLoadMessage(data), { text: data.text });
}

export async function pushLoadBytes(page: Page, data: Omit<TextLoad, "text"> & { bytes: Uint8Array }): Promise<void> {
  const { bytes, ...rest } = data;
  await postLoad(page, toTextLoadMessage(rest), { values: Array.from(bytes) });
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
