import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/test/**/*.test.ts"],
    exclude: ["src/test/webview-e2e/**", "src/test/integration/**", "node_modules/**"],
    environment: "node",
  },
});
