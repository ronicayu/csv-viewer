// Static sanity checks over package.json's `contributes` and top-level
// manifest fields. These don't need a live VS Code window to be
// meaningful, but run inside the Extension Test Host anyway for a single
// consistent suite/report.

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

function readManifest(): Record<string, any> {
  const p = path.resolve(__dirname, "..", "..", "..", "..", "package.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

suite("package.json manifest sanity", () => {
  test("declares capabilities.untrustedWorkspaces and virtualWorkspaces (BUG: currently missing)", () => {
    const manifest = readManifest();
    const capabilities = manifest.capabilities;
    // BUG (low severity, correctness-of-manifest not correctness-of-code):
    // package.json has no top-level `capabilities` block at all, so VS
    // Code falls back to its defaults for both. As of VS Code 1.139, the
    // *default* for an extension with no declaration is effectively
    // "not supported" for untrusted/virtual workspaces in the Workspace
    // Trust / Virtual Workspaces UI (it's listed as unverified rather than
    // explicitly supported), which is misleading for a extension that is,
    // in fact, a pure read-only viewer with no filesystem writes, no
    // process spawning, and no arbitrary code execution — it should
    // declare both as `true` to avoid an unnecessary trust/virtual-fs
    // prompt or "not verified" badge on the Marketplace listing.
    // This assertion documents the CURRENT (missing) state; flip it to
    // `assert.deepStrictEqual(capabilities, { untrustedWorkspaces: { supported: true }, virtualWorkspaces: true })`
    // once fixed.
    assert.strictEqual(capabilities, undefined, "package.json now declares `capabilities` — update this test to check its exact shape");
  });

  test("customEditors selector is lowercase-only (.csv/.tsv/.tab) — does not itself explain menu case sensitivity, see the `when`-clause test below", () => {
    const manifest = readManifest();
    const selector: { filenamePattern: string }[] = manifest.contributes.customEditors[0].selector;
    const patterns = selector.map((s) => s.filenamePattern);
    assert.deepStrictEqual(patterns, ["*.csv", "*.tsv", "*.tab"]);
  });

  test("BUG: menu `when` clauses compare resourceExtname with lowercase literals only, so .CSV/.TSV/.TAB won't show the menu items", () => {
    const manifest = readManifest();
    const explorerWhen: string = manifest.contributes.menus["explorer/context"][0].when;
    const editorTitleWhen: string = manifest.contributes.menus["editor/title"][0].when;
    const paletteWhen: string = manifest.contributes.menus.commandPalette[0].when;

    // `resourceExtname` is VS Code's context key for the resource's
    // extension, preserving the on-disk casing (it does NOT lowercase),
    // and `when`-clause `==` is a case-sensitive string comparison. A file
    // named `DATA.CSV` therefore has `resourceExtname == ".CSV"`, which
    // none of these clauses match — so "Open in CSV Viewer" silently
    // doesn't appear in the Explorer context menu, the editor title bar,
    // or (per the identical clause) the Command Palette for an
    // uppercase-extension file, even though `csvViewer.open` itself works
    // fine when invoked directly (see opening.itest.ts's UPPER.CSV case).
    for (const when of [explorerWhen, editorTitleWhen, paletteWhen]) {
      assert.match(when, /resourceExtname == \.csv/, "expected the known lowercase-only clause");
      assert.doesNotMatch(when, /\.CSV|\.TSV|\.TAB/, "an uppercase variant would mean this was already handled");
    }
    // Fix suggestion (not applied — out of scope, tests only):
    // `resourceExtname =~ /\.(csv|tsv|tab)$/i` (regex `when` clauses
    // support an `i` flag) instead of three `==` comparisons.
  });

  test("engines.vscode and activationEvents match docs/spec.md's architecture", () => {
    const manifest = readManifest();
    assert.strictEqual(manifest.engines.vscode, "^1.80.0");
    assert.deepStrictEqual(manifest.activationEvents, []);
  });
});
