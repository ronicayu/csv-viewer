import * as path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The host tests run extension.ts against an in-memory stand-in for the editor's API.
    alias: { vscode: path.resolve(__dirname, "src/test/host/fakeVscode.ts") },
  },
  test: {
    include: ["src/test/**/*.test.ts"],
    exclude: ["src/test/webview-e2e/**", "src/test/integration/**", "node_modules/**"],
    environment: "node",
  },
});
