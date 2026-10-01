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

/** Converts one of this manifest's simple `filenamePattern` globs (a `*`
 * wildcard plus optional `[xX]` case-insensitivity character classes — no
 * other glob syntax is used here) into a RegExp, so the selector can be
 * exercised directly against sample filenames instead of just eyeballing
 * the pattern string. */
function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      out += ".*";
    } else if (c === "[") {
      const end = glob.indexOf("]", i);
      out += glob.slice(i, end + 1);
      i = end;
    } else if (/[.+^${}()|\\]/.test(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

/** Extracts the `/pattern/flags` regex literal out of a `when` clause of
 * the form `resourceExtname =~ /.../i` (optionally followed by more
 * conditions, e.g. `&& activeCustomEditorId != csvViewer.table`) and
 * compiles it, so the clause's actual matching behavior can be exercised,
 * not just its source text. Matches the first `/.../flags` after `=~`
 * rather than anchoring to the end of the string, since a combined `when`
 * clause has more text after the regex literal. */
function regexFromWhenClause(when: string): RegExp {
  const match = /=~\s*\/(.*?)\/([a-z]*)(?:\s|$)/.exec(when);
  assert.ok(match, `expected a "=~ /pattern/flags" when clause, got: ${when}`);
  return new RegExp(match![1], match![2]);
}

suite("package.json manifest sanity", () => {
  test("declares capabilities.untrustedWorkspaces and virtualWorkspaces (safe: all reads go through workspace.fs, no writes/process spawning/arbitrary code execution)", () => {
    const manifest = readManifest();
    assert.deepStrictEqual(manifest.capabilities, {
      untrustedWorkspaces: { supported: true },
      virtualWorkspaces: true,
    });
  });

  test("customEditors selector matches .csv/.tsv/.tab in any letter casing (FIXED: was lowercase-only)", () => {
    const manifest = readManifest();
    const selector: { filenamePattern: string }[] = manifest.contributes.customEditors[0].selector;
    const patterns = selector.map((s) => s.filenamePattern);
    assert.deepStrictEqual(patterns, ["*.[cC][sS][vV]", "*.[tT][sS][vV]", "*.[tT][aA][bB]"]);

    const regexes = patterns.map(globToRegExp);
    const matchesAny = (name: string) => regexes.some((r) => r.test(name));

    for (const name of ["sample.csv", "sample.tsv", "sample.tab", "UPPER.CSV", "Data.Tsv", "notes.TAB", "mIxEd.CsV"]) {
      assert.ok(matchesAny(name), `expected "${name}" to match the customEditors selector`);
    }
    for (const name of ["sample.txt", "sample.csvx", "sample"]) {
      assert.ok(!matchesAny(name), `expected "${name}" NOT to match the customEditors selector`);
    }
  });

  test("FIXED: menu `when` clauses now match resourceExtname case-insensitively, so .CSV/.TSV/.TAB show the menu items too", () => {
    const manifest = readManifest();
    const explorerWhen: string = manifest.contributes.menus["explorer/context"][0].when;
    const editorTitleOpenWhen: string = manifest.contributes.menus["editor/title"][0].when;
    const paletteOpenWhen: string = manifest.contributes.menus.commandPalette[0].when;

    for (const when of [explorerWhen, editorTitleOpenWhen, paletteOpenWhen]) {
      const re = regexFromWhenClause(when);
      for (const ext of [".csv", ".CSV", ".Csv", ".tsv", ".TSV", ".tab", ".TAB", ".Tab"]) {
        assert.ok(re.test(ext), `expected when-clause regex to match "${ext}"`);
      }
      for (const ext of [".txt", ".csvx", ""]) {
        assert.ok(!re.test(ext), `expected when-clause regex NOT to match "${ext}"`);
      }
    }
  });

  test("engines.vscode and activationEvents match docs/spec.md's architecture plus onStartupFinished for the first-run prompt", () => {
    const manifest = readManifest();
    assert.strictEqual(manifest.engines.vscode, "^1.80.0");
    assert.deepStrictEqual(manifest.activationEvents, ["onStartupFinished"]);
  });

  // ---- Editor title / Command Palette: viewer-active vs text-active state ----
  //
  // While the viewer is the active editor (activeCustomEditorId ==
  // csvViewer.table): "Open as Text" shows, the table icon command hides.
  // While a csv/tsv/tab *text* editor is active: the table icon command
  // shows, "Open as Text" hides. See pm-review.md §3 and the task brief's
  // "Editor title and palette" section.
  test("editor/title: csvViewer.open is hidden while the viewer is active; csvViewer.openAsText shows only while the viewer is active", () => {
    const manifest = readManifest();
    const entries: { command: string; when: string; group?: string }[] = manifest.contributes.menus["editor/title"];
    const openEntry = entries.find((e) => e.command === "csvViewer.open");
    const openAsTextEntry = entries.find((e) => e.command === "csvViewer.openAsText");
    assert.ok(openEntry, "expected an editor/title entry for csvViewer.open");
    assert.ok(openAsTextEntry, "expected an editor/title entry for csvViewer.openAsText");

    assert.strictEqual(openEntry!.when, "resourceExtname =~ /^\\.(csv|tsv|tab)$/i && activeCustomEditorId != csvViewer.table");
    assert.strictEqual(openAsTextEntry!.when, "activeCustomEditorId == csvViewer.table");

    // Table-icon command shows for a csv text editor (viewer NOT active)
    // and hides once the viewer IS active; openAsText is the mirror image.
    const openWhenMatches = (activeCustomEditorIsTable: boolean, ext: string): boolean => {
      const re = regexFromWhenClause(openEntry!.when);
      return re.test(ext) && !activeCustomEditorIsTable;
    };
    assert.strictEqual(openWhenMatches(false, ".csv"), true, "open should show for a .csv text editor");
    assert.strictEqual(openWhenMatches(true, ".csv"), false, "open should hide once the viewer is active");
  });

  test("commandPalette: csvViewer.openAsText is visible only while the viewer is active (no longer permanently hidden)", () => {
    const manifest = readManifest();
    const entries: { command: string; when: string }[] = manifest.contributes.menus.commandPalette;
    const openAsTextEntry = entries.find((e) => e.command === "csvViewer.openAsText");
    assert.ok(openAsTextEntry, "expected a commandPalette entry for csvViewer.openAsText");
    assert.strictEqual(openAsTextEntry!.when, "activeCustomEditorId == csvViewer.table");
    assert.notStrictEqual(openAsTextEntry!.when, "false", "openAsText must no longer be permanently hidden from the palette");
  });

  test("commands share a consistent 'CSV Viewer' category", () => {
    const manifest = readManifest();
    const commands: { command: string; category?: string }[] = manifest.contributes.commands;
    for (const cmd of commands) {
      assert.strictEqual(cmd.category, "CSV Viewer", `expected ${cmd.command} to have category "CSV Viewer"`);
    }
  });

  test("csvViewer.openAsText has a go-to-file icon, matching csvViewer.open's table icon", () => {
    const manifest = readManifest();
    const commands: { command: string; icon?: string }[] = manifest.contributes.commands;
    const open = commands.find((c) => c.command === "csvViewer.open");
    const openAsText = commands.find((c) => c.command === "csvViewer.openAsText");
    assert.strictEqual(open?.icon, "$(table)");
    assert.strictEqual(openAsText?.icon, "$(go-to-file)");
  });

  test("declares csvViewer.suggestOnOpen (default true) for the first-run suggestion prompt", () => {
    const manifest = readManifest();
    const prop = manifest.contributes.configuration.properties["csvViewer.suggestOnOpen"];
    assert.ok(prop, "expected csvViewer.suggestOnOpen to be declared");
    assert.strictEqual(prop.type, "boolean");
    assert.strictEqual(prop.default, true);
  });

  test("listing fields: displayName, description, pricing, qna, galleryBanner, icon, keywords, categories", () => {
    const manifest = readManifest();
    assert.strictEqual(manifest.displayName, "CSV Viewer: Table + Row Details");
    assert.ok(manifest.description.length <= 160, `description should fit search results (~160 chars), got ${manifest.description.length}`);
    assert.strictEqual(manifest.pricing, "Free");
    assert.strictEqual(manifest.qna, false);
    assert.deepStrictEqual(manifest.galleryBanner, { color: "#1f1f1f", theme: "dark" });
    assert.strictEqual(manifest.icon, "media/icon.png");
    assert.deepStrictEqual(manifest.categories, ["Visualization", "Data Science"]);
    for (const bad of ["excel", "xlsx"]) {
      assert.ok(!manifest.keywords.includes(bad), `keywords should not include "${bad}"`);
    }
    assert.strictEqual(manifest.version, "0.4.0");
  });
});

suite("icon file", () => {
  test("media/icon.png exists and is exactly 128x128", () => {
    const iconPath = path.resolve(__dirname, "..", "..", "..", "..", "media", "icon.png");
    assert.ok(fs.existsSync(iconPath), `expected ${iconPath} to exist`);
    const buf = fs.readFileSync(iconPath);
    // PNG signature + IHDR: width/height are the first two 4-byte big-endian
    // integers in the IHDR chunk, starting at byte 16.
    assert.strictEqual(buf.readUInt32BE(0), 0x89504e47, "not a PNG file (bad signature)");
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    assert.strictEqual(width, 128, `expected icon width 128, got ${width}`);
    assert.strictEqual(height, 128, `expected icon height 128, got ${height}`);
  });
});

suite("packaged vsix contents (vsce ls --no-dependencies)", () => {
  test("contains exactly the expected runtime files, plus whatever out/webview/codicon.* the webview build adds", async function () {
    // Generous: a directory walk via @vscode/vsce's listFiles has been
    // observed to take much longer than usual on a contended/shared
    // machine (same root cause as the perf tests' noise — see
    // src/test/stress/perfEnv.ts); don't make this test more timeout-
    // sensitive than the suite's own default.
    this.timeout(90000);
    // Uses @vscode/vsce's programmatic API (same listing `vsce ls` prints)
    // rather than spawning a CLI subprocess from inside the Extension Test
    // Host, which is slower and can double-prompt for a publisher login.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { listFiles } = require("@vscode/vsce") as { listFiles: (opts: { cwd: string; dependencies: boolean }) => Promise<string[]> };
    const cwd = path.resolve(__dirname, "..", "..", "..", "..");
    const files = (await listFiles({ cwd, dependencies: false })).sort();

    const expected = [
      "CHANGELOG.md",
      "LICENSE",
      "README.md",
      "package.json",
      "media/icon.png",
      "out/extension.js",
      "out/webview/main.css",
      "out/webview/main.js",
      "out/webview/worker.js",
    ].sort();

    // The webview team may add codicon assets (CSS + font) under
    // out/webview/ — allow those, but nothing else beyond `expected`.
    const unexpected = files.filter((f) => !expected.includes(f) && !/^out\/webview\/codicon\./.test(f));
    assert.deepStrictEqual(unexpected, [], `unexpected file(s) in the vsix: ${JSON.stringify(unexpected)}`);

    const missing = expected.filter((f) => !files.includes(f));
    assert.deepStrictEqual(missing, [], `expected file(s) missing from the vsix: ${JSON.stringify(missing)}`);
  });
});
