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
/** Debounce for re-sending the document text on `onDidChangeTextDocument`,
 * so typing in a side-by-side text editor doesn't re-send a large file on
 * every keystroke. */
const CHANGE_DEBOUNCE_MS = 300;

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
    };
  }
  return undefined;
}

export function deactivate(): void {
  // No teardown needed: everything is disposed via context.subscriptions
  // and per-panel listeners registered in resolveCustomTextEditor.
}

class CsvEditorProvider implements vscode.CustomTextEditorProvider {
  /** Tracks the most recently focused CSV Viewer panel's document, so the
   * "Open as Text" command (invokable outside the webview too) knows what
   * to act on. */
  static activeUri: vscode.Uri | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
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

    const fileKey = document.uri.toString();
    CsvEditorProvider.activeUri = document.uri;
    if (TEST_HOOKS_ENABLED) testHookPanels.set(fileKey, webviewPanel);

    // `document.getText().length` (UTF-16 code units) is a cheaper stand-in
    // for the file's byte size than `Buffer.byteLength(..., "utf8")` — good
    // enough for a "this might be slow" warning.
    if (document.getText().length > LARGE_FILE_BYTES) {
      const msg = `CSV Viewer: "${basename(document.uri)}" is larger than 50 MB. Loading it may be slow.`;
      if (TEST_HOOKS_ENABLED) testHookNotifications.push({ level: "warning", message: msg });
      void vscode.window.showWarningMessage(msg);
    }

    // Parsing now happens in the webview (see docs/spec.md): the host just
    // ships the whole document text once per load/reload, plus enough
    // context (defaultDelimiter, defaultTableColumns) for the webview to
    // parse and reconcile column visibility itself.
    const postLoad = (): void => {
      const state = this.loadOrCreateState(fileKey);
      const message: HostToWebviewMessage = {
        type: "load",
        fileKey,
        text: document.getText(),
        state,
        defaultTableColumns: this.defaultTableColumns(),
        defaultDelimiter: this.delimiterFor(document.uri) ?? "",
        testHooks: TEST_HOOKS_ENABLED,
      };
      void webview.postMessage(message);
    };

    let changeDebounceHandle: ReturnType<typeof setTimeout> | undefined;
    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      if (changeDebounceHandle) clearTimeout(changeDebounceHandle);
      changeDebounceHandle = setTimeout(() => {
        changeDebounceHandle = undefined;
        postLoad();
      }, CHANGE_DEBOUNCE_MS);
    });

    const viewStateSub = webviewPanel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) CsvEditorProvider.activeUri = document.uri;
    });

    const messageSub = webview.onDidReceiveMessage((message: WebviewToHostMessage) => {
      if (TEST_HOOKS_ENABLED) {
        const arr = testHookMessages.get(fileKey) ?? [];
        arr.push(message);
        testHookMessages.set(fileKey, arr);
      }
      switch (message.type) {
        case "ready":
          postLoad();
          break;
        case "saveState":
          // Separator changes and the "first row is header" toggle now
          // re-parse locally in the webview from the text it already
          // holds, so saving state here never needs to trigger a re-send.
          this.saveState(fileKey, message.state);
          break;
        case "openAsText":
          void vscode.commands.executeCommand("vscode.openWith", document.uri, "default");
          break;
      }
    });

    webviewPanel.onDidDispose(() => {
      if (changeDebounceHandle) clearTimeout(changeDebounceHandle);
      changeSub.dispose();
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
