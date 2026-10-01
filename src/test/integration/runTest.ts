// Boots a real VS Code (Electron) instance with this extension loaded
// against a temp workspace, then hands control to the mocha suite in
// `./suite/index.js`. Mirrors the layout used by
// ~/projects/markdown-collab-plugin's src/test/integration.

import * as fs from "fs";
import * as path from "path";
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";
import { prepareWorkspaceFixtures, WORKSPACE_ROOT } from "./fixtures";

/** A locally-cached VS Code build from a sibling project, reused here only
 * when it happens to exist (e.g. this machine's dev setup) — CI and any
 * other machine fall back to @vscode/test-electron's own download/cache
 * instead (a version it pins and keeps under its own cache dir), rather
 * than failing outright on this hard-coded path not existing. */
const LOCAL_CACHED_VSCODE =
  "/Users/ronica/projects/markdown-collab-plugin/.vscode-test/vscode-darwin-arm64-1.139.1/Visual Studio Code.app/Contents/MacOS/Code";

async function resolveVscodeExecutablePath(): Promise<string> {
  if (fs.existsSync(LOCAL_CACHED_VSCODE)) return LOCAL_CACHED_VSCODE;
  return downloadAndUnzipVSCode("stable");
}

async function main(): Promise<void> {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, "..", "..", "..");
    const extensionTestsPath = path.resolve(__dirname, "suite", "index.js");

    await prepareWorkspaceFixtures();

    const vscodeExecutablePath = await resolveVscodeExecutablePath();

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
