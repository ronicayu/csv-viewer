import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../core/markdownRender";

describe("renderMarkdown: structure", () => {
  it("headings, emphasis, lists", () => {
    const html = renderMarkdown("# One\n\n## Two\n\nsome **bold** and *it*\n\n- a\n- b\n\n1. x\n2. y");
    expect(html).toContain("<h1>One</h1>");
    expect(html).toContain("<h2>Two</h2>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>it</em>");
    expect(html).toMatch(/<ul>\s*<li>a<\/li>\s*<li>b<\/li>\s*<\/ul>/);
    expect(html).toMatch(/<ol>\s*<li>x<\/li>\s*<li>y<\/li>\s*<\/ol>/);
  });

  it("GFM tables (in a scroll wrapper) and strikethrough", () => {
    const html = renderMarkdown("| A | B |\n| --- | --- |\n| 1 | 2 |\n\n~~gone~~");
    expect(html).toContain('<div class="md-table-wrap"><table>');
    expect(html).toContain("<th>A</th>");
    expect(html).toContain("<td>2</td>");
    expect(html).toContain("</table></div>");
    expect(html).toContain("<s>gone</s>");
  });

  it("inline code and fenced code blocks", () => {
    const html = renderMarkdown("use `x` here\n\n```\nlet a = 1 < 2;\n```");
    expect(html).toContain("<code>x</code>");
    expect(html).toContain("<pre><code>let a = 1 &lt; 2;\n</code></pre>");
  });

  it("single newlines become line breaks", () => {
    expect(renderMarkdown("line one\nline two")).toContain("line one<br>\nline two");
  });

  it("does not linkify bare URLs or apply typographer replacements", () => {
    const html = renderMarkdown('see https://example.com and "quotes" (c)');
    expect(html).not.toContain("<a");
    expect(html).toContain("&quot;quotes&quot;");
    expect(html).toContain("(c)");
  });
});

describe("renderMarkdown: raw HTML is text", () => {
  it("escapes <script>", () => {
    const html = renderMarkdown("<script>alert(1)</script>");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes <img onerror> inline and as a block", () => {
    for (const src of ["<img src=x onerror=alert(1)>", "text <img src=x onerror=alert(1)> text"]) {
      const html = renderMarkdown(src);
      expect(html).not.toContain("<img");
      expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    }
  });

  it("escapes other tags and attribute-style payloads", () => {
    const html = renderMarkdown('<a href="javascript:alert(1)" onclick="x()">hi</a> <iframe src="//e"></iframe>');
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<iframe");
  });
});

describe("renderMarkdown: links", () => {
  it("http, https and mailto links become anchors with rel and title", () => {
    for (const url of ["https://example.com/a?b=1", "http://example.com", "mailto:a@b.co"]) {
      const html = renderMarkdown(`[go](${url})`);
      expect(html).toContain(`<a href="${url}" title="${url}" rel="noopener noreferrer">go</a>`);
    }
  });

  it("an autolink in angle brackets is a link too", () => {
    expect(renderMarkdown("<https://example.com>")).toContain('<a href="https://example.com"');
  });

  it("any other scheme or a relative/anchor link is its plain text", () => {
    for (const url of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "file:///etc/passwd", "vbscript:x", "relative/path", "./x", "#anchor", "//evil.example/x", "ftp://example.com/x"]) {
      const html = renderMarkdown(`[label](${url})`);
      expect(html, url).not.toContain("<a");
      expect(html, url).not.toContain("href");
      expect(html, url).toContain("label");
    }
  });

  it("nested emphasis inside a dropped link keeps its text, and a kept link next to a dropped one still closes correctly", () => {
    const html = renderMarkdown("[**bold**](javascript:x) and [ok](https://a.io)");
    expect(html).toContain("<strong>bold</strong>");
    expect((html.match(/<a /g) ?? []).length).toBe(1);
    expect((html.match(/<\/a>/g) ?? []).length).toBe(1);
  });
});

describe("renderMarkdown: images are never loaded", () => {
  it("an image becomes a link labelled with its alt text", () => {
    const html = renderMarkdown("![a cat](https://example.com/cat.png)");
    expect(html).not.toContain("<img");
    expect(html).toContain('<a href="https://example.com/cat.png" title="https://example.com/cat.png" rel="noopener noreferrer">a cat</a>');
  });

  it("with no alt text the label is the URL", () => {
    const html = renderMarkdown("![](https://example.com/cat.png)");
    expect(html).not.toContain("<img");
    expect(html).toContain(">https://example.com/cat.png</a>");
  });

  it("an image with an unsafe source is plain text only", () => {
    for (const src of ["javascript:alert(1)", "data:image/png;base64,AAAA", "relative.png", "file:///x.png"]) {
      const html = renderMarkdown(`![alt text](${src})`);
      expect(html, src).not.toContain("<img");
      expect(html, src).not.toContain("<a");
      expect(html, src).toContain("alt text");
    }
  });

  it("an image inside a link keeps the outer link", () => {
    const html = renderMarkdown("[![pic](https://a.io/p.png)](https://a.io)");
    expect(html).not.toContain("<img");
    expect(html).toContain('href="https://a.io"');
  });
});
