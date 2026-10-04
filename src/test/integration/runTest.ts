import * as fs from "fs";
import * as path from "path";
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";
import { prepareWorkspaceFixtures, WORKSPACE_ROOT } from "./fixtures";

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
      extensionTestsEnv: { CSV_VIEWER_TEST_HOOKS: "1", ITEST_GREP: process.env.ITEST_GREP },
      launchArgs: [
        WORKSPACE_ROOT,
        "--disable-extensions",
        // Short path: a long user-data dir path exceeds the ~103-char Unix socket limit for the IPC handle.
        "--user-data-dir=/tmp/cvst-ud",
      ],
    });
  } catch (err) {
    console.error("Integration tests failed:", err);
    process.exit(1);
  }
}

void main();
