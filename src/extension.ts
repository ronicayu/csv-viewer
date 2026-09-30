import * as vscode from "vscode";
import { normalizePageSize } from "./core/paging";
import {
  createDefaultViewState,
  type HostToWebviewMessage,
  type ViewState,
  type WebviewToHostMessage,
} from "./core/types";

const VIEW_TYPE = "csvViewer.table";
const STATE_PREFIX = "csvViewer.state:";
const LARGE_FILE_BYTES = 50 * 1024 * 1024;
/** Hard ceiling: above this we refuse to load at all (see docs/spec.md). */
const HARD_LIMIT_BYTES = 512 * 1024 * 1024;
/** Debounce for re-reading and re-sending the file after it changes on
 * disk, so a burst of rapid writes (or a save that touches the file
 * multiple times) coalesces into one reload instead of one per write. */
const RELOAD_DEBOUNCE_MS = 300;

// ---- BEGIN TEST HOOK (CSV_VIEWER_TEST_HOOKS) ------------------------------
// Test-only instrumentation for src/test/integration. Completely inert
// (zero extra state, zero extra work, activate() returns undefined as
// normal) unless the extension host process has CSV_VIEWER_TEST_HOOKS=1 set
// — which only the integration test runner does. Nothing here changes
// production behavior for real users.
const TEST_HOOKS_ENABLED = process.env.CSV_VIEWER_TEST_HOOKS === "1";
/** fileKey (document.uri.toString()) -> live panel, for postToWebview(). */
const testHookPanels = new Map<string, vscode.WebviewPanel>();
/** fileKey -> every WebviewToHostMessage received so far, in order. */
const testHookMessages = new Map<string, WebviewToHostMessage[]>();
/** Every warning/error notification the extension has shown, in order. */
const testHookNotifications: { level: "warning" | "error"; message: string }[] = [];

export interface CsvViewerTestApi {
  /** Messages received from the webview for a given document, in order. */
  getMessages(fileKey: string): WebviewToHostMessage[];
  /** Post a message directly into a given document's live webview,
   * bypassing the UI. Returns false if no panel is open for that fileKey. */
  postToWebview(fileKey: string, message: HostToWebviewMessage): boolean;
  /** Warning/error messages shown via vscode.window.show*Message so far. */
  getNotifications(): { level: "warning" | "error"; message: string }[];
  /** Number of currently-live CSV Viewer panels (for disposal/leak checks). */
  panelCount(): number;
  /** Every `csvViewer.state:*` key currently in workspaceState, for
   * verifying the rename-migration behavior (see onDidRenameFiles below)
   * directly rather than only inferring it from webview messages. */
  getWorkspaceStateKeys(): string[];
}
// ---- END TEST HOOK setup ---------------------------------------------------

export function activate(context: vscode.ExtensionContext): CsvViewerTestApi | undefined {
  const provider = new CsvEditorProvider(context);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("csvViewer.open", async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        const msg = "CSV Viewer: no file to open.";
        if (TEST_HOOKS_ENABLED) testHookNotifications.push({ level: "error", message: msg });
        void vscode.window.showErrorMessage(msg);
        return;
      }
      await vscode.commands.executeCommand("vscode.openWith", target, VIEW_TYPE);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("csvViewer.openAsText", async () => {
      const uri = CsvEditorProvider.activeUri;
      if (!uri) return;
      await vscode.commands.executeCommand("vscode.openWith", uri, "default");
    }),
  );

  // Renaming a file (or a folder containing one) moves it to a new URI, but
  // per-file view state (column visibility, filters, sort, ...) is keyed by
  // the URI string in workspaceState. Without this, that state is silently
  // orphaned forever under the old key. Fires for both a single-file rename
  // and a folder rename (VS Code reports one {oldUri,newUri} pair for the
  // renamed folder itself, not one per descendant) — migrateWorkspaceState
  // handles both by also moving every key nested under the old prefix.
  context.subscriptions.push(
    vscode.workspace.onDidRenameFiles((e) => {
      for (const { oldUri, newUri } of e.files) {
        migrateWorkspaceState(context, oldUri, newUri);
      }
    }),
  );

  if (TEST_HOOKS_ENABLED) {
    return {
      getMessages: (fileKey) => (testHookMessages.get(fileKey) ?? []).slice(),
      postToWebview: (fileKey, message) => {
        const panel = testHookPanels.get(fileKey);
        if (!panel) return false;
        void panel.webview.postMessage(message);
        return true;
      },
      getNotifications: () => testHookNotifications.slice(),
      panelCount: () => testHookPanels.size,
      getWorkspaceStateKeys: () => context.workspaceState.keys().filter((k) => k.startsWith(STATE_PREFIX)),
    };
  }
  return undefined;
}

export function deactivate(): void {
  // No teardown needed: everything is disposed via context.subscriptions
  // and per-panel listeners registered in resolveCustomEditor.
}

/** Moves every workspaceState entry keyed under `oldUri` (exactly, or
 * nested under it as a folder prefix) to the equivalent key under
 * `newUri`, deleting the old key(s). A plain file rename only ever matches
 * the exact-key branch; a folder rename matches the nested-prefix branch
 * for every file that lived under it. */
function migrateWorkspaceState(context: vscode.ExtensionContext, oldUri: vscode.Uri, newUri: vscode.Uri): void {
  const oldKey = STATE_PREFIX + oldUri.toString();
  const oldFolderPrefix = oldKey + "/";
  const newKey = STATE_PREFIX + newUri.toString();

  for (const key of context.workspaceState.keys()) {
    let migratedKey: string | undefined;
    if (key === oldKey) migratedKey = newKey;
    else if (key.startsWith(oldFolderPrefix)) migratedKey = newKey + "/" + key.slice(oldFolderPrefix.length);
    if (migratedKey === undefined) continue;

    const value = context.workspaceState.get(key);
    void context.workspaceState.update(migratedKey, value);
    void context.workspaceState.update(key, undefined);
  }
}

/** Minimal CustomDocument for the readonly provider: just carries the uri.
 * All the real per-panel state (watcher, debounce timer, message/view-state
 * listeners) lives in resolveCustomEditor, scoped to the webviewPanel,
 * exactly as it did when this was a CustomTextEditorProvider. */
class CsvDocument implements vscode.CustomDocument {
  constructor(readonly uri: vscode.Uri) {}
  dispose(): void {}
}

class CsvEditorProvider implements vscode.CustomReadonlyEditorProvider<CsvDocument> {
  /** Tracks the most recently focused CSV Viewer panel's document, so the
   * "Open as Text" command (invokable outside the webview too) knows what
   * to act on. */
  static activeUri: vscode.Uri | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken,
  ): CsvDocument {
    // No I/O here: VS Code no longer hands us a synced TextDocument (that's
    // exactly the bug this fixes — it never sent files >= its own text-sync
    // ceiling), so *we* read the bytes ourselves, in resolveCustomEditor,
    // where size checks and read failures can all go through the same
    // notification/test-hook pipeline.
    return new CsvDocument(uri);
  }

  async resolveCustomEditor(
    document: CsvDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const webview = webviewPanel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "out", "webview"),
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
      ],
    };
    webview.html = this.buildHtml(webview);

    const uri = document.uri;
    const fileKey = uri.toString();
    CsvEditorProvider.activeUri = uri;
    if (TEST_HOOKS_ENABLED) testHookPanels.set(fileKey, webviewPanel);

    // Reads the file fresh from disk via workspace.fs (works for files of
    // any size VS Code will let us stat/read, and outside the workspace,
    // and in untrusted/virtual workspaces — see docs/spec.md), decodes it,
    // and posts the same `load` message shape the webview has always
    // expected. Parsing still happens in the webview (unchanged).
    const postLoad = async (): Promise<void> => {
      let stat: vscode.FileStat;
      try {
        stat = await vscode.workspace.fs.stat(uri);
      } catch {
        // Transient (e.g. mid-write, or raced with a delete): the
        // FileSystemWatcher will either fire onDidChange again or
        // onDidDelete, which is handled separately below.
        return;
      }

      if (stat.size > HARD_LIMIT_BYTES) {
        const msg = `CSV Viewer: "${basename(uri)}" is larger than 512 MB and was not loaded.`;
        if (TEST_HOOKS_ENABLED) testHookNotifications.push({ level: "error", message: msg });
        void vscode.window.showErrorMessage(msg);
        return;
      }
      if (stat.size > LARGE_FILE_BYTES) {
        const msg = `CSV Viewer: "${basename(uri)}" is larger than 50 MB. Loading it may be slow.`;
        if (TEST_HOOKS_ENABLED) testHookNotifications.push({ level: "warning", message: msg });
        void vscode.window.showWarningMessage(msg);
      }

      let bytes: Uint8Array;
      try {
        bytes = await vscode.workspace.fs.readFile(uri);
      } catch {
        return;
      }
      // BOM handling stays in parseCsv (src/core/csvParse.ts) — the decoder
      // here just turns bytes into a string.
      const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);

      const state = this.loadOrCreateState(fileKey);
      const message: HostToWebviewMessage = {
        type: "load",
        fileKey,
        text,
        state,
        defaultTableColumns: this.defaultTableColumns(),
        defaultDelimiter: this.delimiterFor(uri) ?? "",
        testHooks: TEST_HOOKS_ENABLED,
      };
      void webview.postMessage(message);
    };

    // Live reload: watch exactly this file on disk (not the whole
    // workspace) — a non-recursive single-filename RelativePattern works
    // even for a file outside any open workspace folder. Deliberately NOT
    // wired to any "unsaved edit" signal: since resolveCustomEditor no
    // longer gets a synced TextDocument, an edit in a text editor that
    // hasn't been saved yet has no effect on the file on disk and so isn't
    // reflected here — see docs/spec.md / README ("Unsaved edits").
    const dirUri = vscode.Uri.joinPath(uri, "..");
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dirUri, basename(uri)));

    let reloadDebounceHandle: ReturnType<typeof setTimeout> | undefined;
    const scheduleReload = (): void => {
      if (reloadDebounceHandle) clearTimeout(reloadDebounceHandle);
      reloadDebounceHandle = setTimeout(() => {
        reloadDebounceHandle = undefined;
        void postLoad();
      }, RELOAD_DEBOUNCE_MS);
    };

    const changeSub = watcher.onDidChange(scheduleReload);
    const createSub = watcher.onDidCreate(scheduleReload);
    const deleteSub = watcher.onDidDelete(() => {
      // Don't try to reload — there's nothing to read. Keep whatever was
      // last rendered in the webview (it already holds the parsed data in
      // memory) and just tell the user, non-modally.
      if (reloadDebounceHandle) {
        clearTimeout(reloadDebounceHandle);
        reloadDebounceHandle = undefined;
      }
      const msg = "CSV Viewer: File was deleted — showing last loaded contents.";
      if (TEST_HOOKS_ENABLED) testHookNotifications.push({ level: "warning", message: msg });
      void vscode.window.showWarningMessage(msg);
    });

    const viewStateSub = webviewPanel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) CsvEditorProvider.activeUri = uri;
    });

    const messageSub = webview.onDidReceiveMessage((message: WebviewToHostMessage) => {
      if (TEST_HOOKS_ENABLED) {
        const arr = testHookMessages.get(fileKey) ?? [];
        arr.push(message);
        testHookMessages.set(fileKey, arr);
      }
      switch (message.type) {
        case "ready":
          void postLoad();
          break;
        case "saveState":
          this.saveState(fileKey, message.state);
          break;
        case "openAsText":
          void vscode.commands.executeCommand("vscode.openWith", uri, "default");
          break;
      }
    });

    webviewPanel.onDidDispose(() => {
      if (reloadDebounceHandle) clearTimeout(reloadDebounceHandle);
      changeSub.dispose();
      createSub.dispose();
      deleteSub.dispose();
      watcher.dispose();
      viewStateSub.dispose();
      messageSub.dispose();
      if (TEST_HOOKS_ENABLED) testHookPanels.delete(fileKey);
    });
  }

  private defaultTableColumns(): number {
    return vscode.workspace.getConfiguration("csvViewer").get<number>("defaultTableColumns", 8);
  }

  private delimiterFor(uri: vscode.Uri): string | undefined {
    const path = uri.path.toLowerCase();
    if (path.endsWith(".tsv") || path.endsWith(".tab")) return "\t";
    return undefined;
  }

  private loadOrCreateState(fileKey: string): ViewState {
    const stored = this.context.workspaceState.get<ViewState>(STATE_PREFIX + fileKey);
    if (stored) {
      // Backward compatibility: state saved before pagination/separator
      // support existed may have no pageSize/delimiter (or, in principle, a
      // corrupted pageSize) — normalize rather than shipping `undefined`
      // down to the webview. Column visibility defaults are reconciled in
      // the webview once it knows the parsed headers.
      stored.pageSize = normalizePageSize(stored.pageSize);
      stored.delimiter = typeof stored.delimiter === "string" ? stored.delimiter : "";
      return stored;
    }

    return createDefaultViewState();
  }

  private saveState(fileKey: string, state: ViewState): void {
    void this.context.workspaceState.update(STATE_PREFIX + fileKey, state);
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "out", "webview", "main.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "out", "webview", "main.css"));
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${styleUri}" />
<title>CSV Viewer</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function basename(uri: vscode.Uri): string {
  const parts = uri.path.split("/");
  return parts[parts.length - 1] ?? uri.path;
}

function getNonce(): string {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}
