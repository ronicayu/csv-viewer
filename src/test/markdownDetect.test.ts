import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { looksLikeJsonObjectOrArray } from "../core/json";
import { MARKDOWN_MAX_CHARS, looksLikeMarkdown } from "../core/markdownDetect";

describe("looksLikeMarkdown: strong signals (any one suffices)", () => {
  it("an ATX heading line, at the start or later in the value", () => {
    expect(looksLikeMarkdown("# Title")).toBe(true);
    expect(looksLikeMarkdown("intro\n\n### Steps\nmore")).toBe(true);
    expect(looksLikeMarkdown("###### six")).toBe(true);
  });

  it("a fenced code block, with backticks or tildes", () => {
    expect(looksLikeMarkdown("run:\n```\nnpm test\n```")).toBe(true);
    expect(looksLikeMarkdown("```sh\nls\n```")).toBe(true);
    expect(looksLikeMarkdown("~~~\ncode\n~~~")).toBe(true);
  });

  it("a Markdown link to http, https or mailto", () => {
    expect(looksLikeMarkdown("see [docs](https://example.com/a)")).toBe(true);
    expect(looksLikeMarkdown("see [docs](http://example.com)")).toBe(true);
    expect(looksLikeMarkdown("write [us](mailto:a@b.co)")).toBe(true);
  });

  it("a table delimiter row", () => {
    expect(looksLikeMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |")).toBe(true);
    expect(looksLikeMarkdown("a | b\n:--- | ---:\n1 | 2")).toBe(true);
  });
});

describe("looksLikeMarkdown: weak signals (two different kinds needed)", () => {
  const bold = "this is **bold** text";
  const bullets = "- one\n- two";
  const ordered = "1. one\n2. two";
  const quote = "> quoted";
  const code = "use `npm test` here";
  const kinds: [string, string][] = [
    ["bold", bold],
    ["bullets", bullets],
    ["ordered", ordered],
    ["blockquote", quote],
    ["inline code", code],
  ];

  for (let i = 0; i < kinds.length; i++) {
    for (let j = i + 1; j < kinds.length; j++) {
      it(`${kinds[i][0]} + ${kinds[j][0]}`, () => {
        expect(looksLikeMarkdown(`${kinds[i][1]}\n${kinds[j][1]}`)).toBe(true);
      });
    }
  }

  for (const [name, text] of kinds) {
    it(`a single weak signal alone is not enough: ${name}`, () => {
      expect(looksLikeMarkdown(text)).toBe(false);
    });
  }

  it("both bold syntaxes are the same kind", () => {
    expect(looksLikeMarkdown("**a** and __b__")).toBe(false);
  });

  it("one bullet line (or one ordered line) is not a list", () => {
    expect(looksLikeMarkdown("- one\nand `code`")).toBe(false);
    expect(looksLikeMarkdown("1. one\nand `code`")).toBe(false);
  });

  it("star and plus bullets count", () => {
    expect(looksLikeMarkdown("* a\n* b\n**c**")).toBe(true);
    expect(looksLikeMarkdown("+ a\n+ b\n> q")).toBe(true);
  });
});

describe("looksLikeMarkdown: things that must stay plain", () => {
  it("empty", () => {
    expect(looksLikeMarkdown("")).toBe(false);
  });

  it("JSON objects and arrays, even with Markdown-looking content inside", () => {
    expect(looksLikeMarkdown('{"title":"# Heading","body":"**bold** and `code`"}')).toBe(false);
    expect(looksLikeMarkdown('["[a](https://x.io)", "b"]')).toBe(false);
    expect(looksLikeMarkdown('{\n  "a": "```x```"\n}')).toBe(false);
  });

  it("prose with stray *, # and 1.", () => {
    expect(looksLikeMarkdown("Ticket #1 is 5 * 3 wide")).toBe(false);
    expect(looksLikeMarkdown("Step 1. Do the thing")).toBe(false);
    expect(looksLikeMarkdown("price: 2 ** 3 ** 4")).toBe(false);
    expect(looksLikeMarkdown("#hashtag and #1")).toBe(false);
    expect(looksLikeMarkdown("a - b - c")).toBe(false);
  });

  it("a link that is not http, https or mailto is not a signal", () => {
    expect(looksLikeMarkdown("[x](relative/path)")).toBe(false);
    expect(looksLikeMarkdown("[x](#anchor)")).toBe(false);
  });

  it("a value over the size cap is only scanned up to the cap", () => {
    const head = "x".repeat(MARKDOWN_MAX_CHARS + 10);
    expect(looksLikeMarkdown(`${head}\n# late heading`)).toBe(false);
    expect(looksLikeMarkdown(`# early heading\n${head}`)).toBe(true);
  });
});

// The detector without the cheap pre-test, as it was.
function looksLikeMarkdownOld(value: string): boolean {
  if (value === "") return false;
  const text = value.length > MARKDOWN_MAX_CHARS ? value.slice(0, MARKDOWN_MAX_CHARS) : value;
  if (looksLikeJsonObjectOrArray(value)) return false;
  const count = (re: RegExp) => text.match(re)?.length ?? 0;
  if (/^#{1,6} \S/m.test(text) || /^ {0,3}(?:```|~~~)/m.test(text) || /\[[^\]\n]+\]\((?:https?:\/\/|mailto:)[^)\s]+\)/i.test(text)) return true;
  if (/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/m.test(text)) return true;
  let weak = 0;
  if (/\*\*\S(?:[^*\n]*\S)?\*\*|__\S(?:[^_\n]*\S)?__/.test(text)) weak++;
  if (count(/^[ \t]*[-*+] \S/gm) >= 2) weak++;
  if (count(/^[ \t]*\d+\. \S/gm) >= 2) weak++;
  if (/^ {0,3}> \S/m.test(text)) weak++;
  if (/`[^`\n]+`/.test(text)) weak++;
  return weak >= 2;
}

describe("looksLikeMarkdown: the signal-character pre-test changes no answer", () => {
  const piece = fc.constantFrom("#", "##", " ", "\n", "a", "1", "1.", ". ", "-", "---", "|", ":", "*", "**", "_", "__", "+", ">", "`", "```", "~~~", "[", "](", "x", "https://a.b", ")", "{", "}", "\t", "é");

  it("agrees with the plain detector on arbitrary strings built from Markdown's own characters (property)", () => {
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 24 }).map((p) => p.join("")), (value) => {
        expect(looksLikeMarkdown(value)).toBe(looksLikeMarkdownOld(value));
      }),
      { numRuns: 20000 },
    );
  });

  it("agrees on arbitrary Unicode strings and on plain short cells", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ maxLength: 20 }), fc.string({ unit: "binary", maxLength: 20 }), fc.constantFrom("xxxxxxxxx", "123", "2024-01-02", "a b c", "")), (value) => {
        expect(looksLikeMarkdown(value)).toBe(looksLikeMarkdownOld(value));
      }),
      { numRuns: 5000 },
    );
  });
});
