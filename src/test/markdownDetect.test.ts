import { describe, expect, it } from "vitest";
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

describe("looksLikeMarkdown: HTML is a strong signal", () => {
  it("a formatting or structure element with its closing tag, or a <br>", () => {
    expect(looksLikeMarkdown("some <b>bold</b> text")).toBe(true);
    expect(looksLikeMarkdown("<p>para</p>")).toBe(true);
    expect(looksLikeMarkdown('<a href="https://a.io">x</a>')).toBe(true);
    expect(looksLikeMarkdown("<ul>\n<li>a</li>\n</ul>")).toBe(true);
    expect(looksLikeMarkdown("line<br>line")).toBe(true);
    expect(looksLikeMarkdown("line<br/>line")).toBe(true);
    expect(looksLikeMarkdown("<H2>Title</H2>")).toBe(true);
  });

  it("an unclosed tag, a comparison, or an element outside the list is not", () => {
    expect(looksLikeMarkdown("a <b and c> d")).toBe(false);
    expect(looksLikeMarkdown("<b>unclosed")).toBe(false);
    expect(looksLikeMarkdown("<script>alert(1)</script>")).toBe(false);
    expect(looksLikeMarkdown("<foo>bar</foo>")).toBe(false);
    expect(looksLikeMarkdown("1 < 2 and 3 > 2")).toBe(false);
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
