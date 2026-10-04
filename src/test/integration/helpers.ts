import * as vscode from "vscode";
import type { HostToWebviewMessage, SaveStateMessage, WebviewToHostMessage } from "../../core/types";

export const EXTENSION_ID = "ronica.csv-row-details";

// Declared locally so tsconfig.integration.json does not pull src/extension.ts into its program.
export interface CsvViewerTestApi {
  getMessages(fileKey: string): WebviewToHostMessage[];
  getOutgoing(fileKey: string): HostToWebviewMessage[];
  postToWebview(fileKey: string, message: HostToWebviewMessage): boolean;
  simulateWebviewMessage(fileKey: string, message: WebviewToHostMessage): boolean;
  getNotifications(): { level: "warning" | "error"; message: string }[];
  panelCount(): number;
  getWorkspaceStateKeys(): string[];
  getPendingPrompt(): { message: string; buttons: string[] } | undefined;
  choosePromptButton(button: string | undefined): void;
  getHintsSeen(): string[];
  resetSuggestPromptState(): void;
}

export async function getTestApi(): Promise<CsvViewerTestApi> {
  const ext = vscode.extensions.getExtension<CsvViewerTestApi>(EXTENSION_ID);
  if (!ext) throw new Error(`Extension ${EXTENSION_ID} not found — is it loaded via --extensionDevelopmentPath?`);
  const api = ext.isActive ? ext.exports : await ext.activate();
  if (!api) {
    throw new Error(
      "Extension activated but returned no test API. CSV_VIEWER_TEST_HOOKS=1 must be set in the Extension Host's environment (see runTest.ts's extensionTestsEnv).",
    );
  }
  return api;
}

export function fileKeyFor(uri: vscode.Uri): string {
  return uri.toString();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(predicate: () => boolean, opts: { timeoutMs?: number; intervalMs?: number; message?: string } = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const intervalMs = opts.intervalMs ?? 40;
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(opts.message ?? `waitFor timed out after ${timeoutMs}ms`);
    await sleep(intervalMs);
  }
}

export async function waitForRender(
  api: CsvViewerTestApi,
  fileKey: string,
  minCount = 1,
  opts: { timeoutMs?: number } = {},
): Promise<{ type: "rendered"; rowCount: number; headers: string[] }> {
  await waitFor(() => api.getMessages(fileKey).filter((m) => m.type === "rendered").length >= minCount, {
    timeoutMs: opts.timeoutMs,
    message: `never saw ${minCount} "rendered" message(s) for ${fileKey}. Messages so far: ${JSON.stringify(api.getMessages(fileKey))}`,
  });
  const renders = api.getMessages(fileKey).filter((m): m is { type: "rendered"; rowCount: number; headers: string[] } => m.type === "rendered");
  return renders[renders.length - 1];
}

export function renderCount(api: CsvViewerTestApi, fileKey: string): number {
  return api.getMessages(fileKey).filter((m) => m.type === "rendered").length;
}

export function loadCount(api: CsvViewerTestApi, fileKey: string): number {
  // Each host `load` yields exactly one "rendered" reply, so the render count stands in for the load count.
  return renderCount(api, fileKey);
}

export async function closeAllEditors(): Promise<void> {
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
}

export async function openInViewer(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand("csvViewer.open", uri);
}

export async function waitForSaveState(
  api: CsvViewerTestApi,
  fileKey: string,
  opts: { timeoutMs?: number } = {},
): Promise<SaveStateMessage> {
  await waitFor(() => api.getMessages(fileKey).some((m) => m.type === "saveState"), {
    timeoutMs: opts.timeoutMs,
    message: `never saw a "saveState" message for ${fileKey}`,
  });
  const msgs = api.getMessages(fileKey).filter((m): m is SaveStateMessage => m.type === "saveState");
  return msgs[msgs.length - 1];
}

export async function waitForPrompt(api: CsvViewerTestApi, opts: { timeoutMs?: number } = {}): Promise<{ message: string; buttons: string[] }> {
  await waitFor(() => api.getPendingPrompt() !== undefined, {
    timeoutMs: opts.timeoutMs,
    message: "the first-run suggestion prompt never appeared",
  });
  return api.getPendingPrompt()!;
}

export async function assertNoPromptAppears(api: CsvViewerTestApi, windowMs = 1000): Promise<void> {
  await sleep(windowMs);
  const pending = api.getPendingPrompt();
  if (pending) throw new Error(`expected no prompt, but one is pending: ${JSON.stringify(pending)}`);
}

export async function waitForReady(api: CsvViewerTestApi, fileKey: string, opts: { timeoutMs?: number } = {}): Promise<void> {
  await waitFor(() => api.getMessages(fileKey).some((m) => m.type === "ready"), {
    timeoutMs: opts.timeoutMs,
    message: `never saw a "ready" message for ${fileKey}`,
  });
}
