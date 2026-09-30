// Boots a real, cached VS Code (Electron) instance with this extension
// loaded against a temp workspace, then hands control to the mocha suite
// in `./suite/index.js`. Mirrors the layout used by
// ~/projects/markdown-collab-plugin's src/test/integration.

import * as path from "path";
import { runTests } from "@vscode/test-electron";
import { prepareWorkspaceFixtures, WORKSPACE_ROOT } from "./fixtures";

async function main(): Promise<void> {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, "..", "..", "..");
    const extensionTestsPath = path.resolve(__dirname, "suite", "index.js");

    await prepareWorkspaceFixtures();

    const vscodeExecutablePath =
      "/Users/ronica/projects/markdown-collab-plugin/.vscode-test/vscode-darwin-arm64-1.139.1/Visual Studio Code.app/Contents/MacOS/Code";

    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath,
      // CSV_VIEWER_TEST_HOOKS=1 turns on the extension's test-only
      // instrumentation (see extension.ts's "BEGIN TEST HOOK" block) —
      // never set outside this runner.
      extensionTestsEnv: { CSV_VIEWER_TEST_HOOKS: "1", ITEST_GREP: process.env.ITEST_GREP },
      launchArgs: [
        // Workspace folder containing the generated small fixtures.
        WORKSPACE_ROOT,
        "--disable-extensions",
        // Short path: the default .vscode-test/user-data lives under this
        // worktree's (long) path and blows past the ~103-char Unix domain
        // socket path limit used for the IPC handle.
        "--user-data-dir=/tmp/cvst-ud",
      ],
    });
  } catch (err) {
    console.error("Integration tests failed:", err);
    process.exit(1);
  }
}

void main();
