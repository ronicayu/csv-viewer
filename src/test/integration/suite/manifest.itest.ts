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
 * the form `resourceExtname =~ /.../i` and compiles it, so the clause's
 * actual matching behavior can be exercised, not just its source text. */
function regexFromWhenClause(when: string): RegExp {
  const match = /=~\s*\/(.*)\/([a-z]*)\s*$/.exec(when);
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
    const editorTitleWhen: string = manifest.contributes.menus["editor/title"][0].when;
    const paletteWhen: string = manifest.contributes.menus.commandPalette[0].when;

    for (const when of [explorerWhen, editorTitleWhen, paletteWhen]) {
      assert.strictEqual(when, "resourceExtname =~ /^\\.(csv|tsv|tab)$/i");
      const re = regexFromWhenClause(when);
      for (const ext of [".csv", ".CSV", ".Csv", ".tsv", ".TSV", ".tab", ".TAB", ".Tab"]) {
        assert.ok(re.test(ext), `expected when-clause regex to match "${ext}"`);
      }
      for (const ext of [".txt", ".csvx", ""]) {
        assert.ok(!re.test(ext), `expected when-clause regex NOT to match "${ext}"`);
      }
    }
  });

  test("engines.vscode and activationEvents match docs/spec.md's architecture", () => {
    const manifest = readManifest();
    assert.strictEqual(manifest.engines.vscode, "^1.80.0");
    assert.deepStrictEqual(manifest.activationEvents, []);
  });
});
