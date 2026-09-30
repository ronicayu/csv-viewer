import * as vscode from "vscode";
import { parseCsv } from "./core/csvParse";
import { defaultVisibility, reconcileVisibility } from "./core/columns";
import { normalizePageSize } from "./core/paging";
import { createDefaultViewState, type HostToWebviewMessage, type ViewState, type WebviewToHostMessage } from "./core/types";

const VIEW_TYPE = "csvViewer.table";
const STATE_PREFIX = "csvViewer.state:";
const LARGE_FILE_BYTES = 50 * 1024 * 1024;

export function activate(context: vscode.ExtensionContext): void {
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
        void vscode.window.showErrorMessage("CSV Viewer: no file to open.");
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

    if (Buffer.byteLength(document.getText(), "utf8") > LARGE_FILE_BYTES) {
      void vscode.window.showWarningMessage(
        `CSV Viewer: "${basename(document.uri)}" is larger than 50 MB. Loading it may be slow.`,
      );
    }

    const postLoad = (): void => {
      const state = this.loadOrCreateState(fileKey, document);
      const parsed = parseCsv(document.getText(), {
        delimiter: this.delimiterFor(document.uri),
        firstRowIsHeader: state.firstRowIsHeader,
      });
      state.columnVisibility = reconcileVisibility(parsed.headers, state.columnVisibility, this.defaultTableColumns());
      this.saveState(fileKey, state);

      const message: HostToWebviewMessage = {
        type: "load",
        fileKey,
        headers: parsed.headers,
        rows: parsed.rows,
        state,
        defaultTableColumns: this.defaultTableColumns(),
      };
      void webview.postMessage(message);
    };

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === document.uri.toString()) postLoad();
    });

    const viewStateSub = webviewPanel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) CsvEditorProvider.activeUri = document.uri;
    });

    const messageSub = webview.onDidReceiveMessage((message: WebviewToHostMessage) => {
      switch (message.type) {
        case "ready":
          postLoad();
          break;
        case "saveState": {
          const previous = this.context.workspaceState.get<ViewState>(STATE_PREFIX + fileKey);
          this.saveState(fileKey, message.state);
          // Toggling "first row is header" changes how the document must be
          // re-parsed; parsing lives in the host, so re-send on that change.
          if (!previous || previous.firstRowIsHeader !== message.state.firstRowIsHeader) postLoad();
          break;
        }
        case "openAsText":
          void vscode.commands.executeCommand("vscode.openWith", document.uri, "default");
          break;
      }
    });

    webviewPanel.onDidDispose(() => {
      changeSub.dispose();
      viewStateSub.dispose();
      messageSub.dispose();
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

  private loadOrCreateState(fileKey: string, document: vscode.TextDocument): ViewState {
    const stored = this.context.workspaceState.get<ViewState>(STATE_PREFIX + fileKey);
    if (stored) {
      // Backward compatibility: state saved before pagination existed has no
      // pageSize (or, in principle, a corrupted one) — normalize it rather
      // than shipping `undefined` down to the webview.
      stored.pageSize = normalizePageSize(stored.pageSize);
      return stored;
    }

    const parsed = parseCsv(document.getText(), { delimiter: this.delimiterFor(document.uri), firstRowIsHeader: true });
    const state = createDefaultViewState();
    state.columnVisibility = defaultVisibility(parsed.headers, this.defaultTableColumns());
    return state;
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
