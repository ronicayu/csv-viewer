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

describe("renderMarkdown: HTML is rendered through the sanitizer", () => {
  it("keeps formatting and structure elements, inline and as a block", () => {
    const html = renderMarkdown("some <b>bold</b>, <u>under</u>, x<sup>2</sup> and <kbd>Ctrl</kbd>\n\n<p>para</p>\n<ul><li>one</li><li>two</li></ul>\n<details><summary>more</summary>hidden</details>");
    expect(html).toContain("<b>bold</b>");
    expect(html).toContain("<u>under</u>");
    expect(html).toContain("x<sup>2</sup>");
    expect(html).toContain("<kbd>Ctrl</kbd>");
    expect(html).toContain("<p>para</p>");
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(html).toContain("<details><summary>more</summary>hidden</details>");
  });

  it("keeps only harmless attributes, re-serialized", () => {
    const html = renderMarkdown('<td colspan="2" rowspan=3 style="color:red" class="x" id="y" onclick="z()" title="t &amp; &lt;u&gt;">c</td>');
    expect(html).toContain('<td colspan="2" rowspan="3" title="t &amp; &lt;u&gt;">c</td>');
    expect(html).not.toMatch(/style|class|id=|onclick/);
    expect(renderMarkdown('<details open><summary>s</summary>b</details>')).toContain('<details open="">');
    expect(renderMarkdown('<ol start="3" reversed><li value="7">x</li></ol>')).toContain('<ol start="3" reversed=""><li value="7">x</li></ol>');
  });

  it("drops <script> and <style> with their content, as a block and inline", () => {
    for (const src of ["<script>alert(1)</script>", "<style>body{display:none}</style>", "<div><script>alert(1)</script>kept</div>"]) {
      const html = renderMarkdown(src);
      expect(html, src).not.toContain("<script");
      expect(html, src).not.toContain("<style");
      expect(html, src).not.toContain("alert(1)");
      expect(html, src).not.toContain("display:none");
    }
    const inline = renderMarkdown("text <script>alert(1)</script> text");
    expect(inline).not.toContain("<script");
    expect(inline).not.toContain("</script");
    expect(inline).toContain("text");
  });

  it("drops embeds, forms, svg and unknown elements but keeps their text where it is not scripting", () => {
    const html = renderMarkdown('<iframe src="//e">fb</iframe> <object data="x">o</object> <svg onload="a()"><circle/></svg> <form><input value="v"><button>go</button></form> <font color="red">red</font> <blink>b</blink>');
    for (const tag of ["iframe", "object", "svg", "circle", "form", "input", "button", "font", "blink"]) {
      expect(html, tag).not.toContain(`<${tag}`);
      expect(html, tag).not.toContain(`</${tag}`);
    }
    expect(html).toContain("red");
    expect(html).toContain("b");
  });

  it("never emits an <img>: it becomes a link to a safe src labelled with the alt text, or plain text", () => {
    expect(renderMarkdown('<img src="https://example.com/c.png" alt="a cat" onerror="x()">')).toContain(
      '<a href="https://example.com/c.png" title="https://example.com/c.png" rel="noopener noreferrer">a cat</a>',
    );
    expect(renderMarkdown('<img src="https://example.com/c.png">')).toContain(">https://example.com/c.png</a>");
    for (const src of ["<img src=x onerror=alert(1)>", "text <img src=x onerror=alert(1)> text", '<img src="javascript:alert(1)" alt="alt text">', '<img src="data:image/png;base64,AAAA" alt="alt text">']) {
      const html = renderMarkdown(src);
      expect(html, src).not.toContain("<img");
      expect(html, src).not.toContain("onerror");
      expect(html, src).not.toContain("<a");
    }
    expect(renderMarkdown('<img src="javascript:alert(1)" alt="alt text">')).toContain("alt text");
  });

  it("an HTML <a> follows the same href rules as a Markdown link", () => {
    expect(renderMarkdown('<a href="https://a.io/x" target="_blank" onclick="x()">go</a>')).toContain(
      '<a href="https://a.io/x" title="https://a.io/x" rel="noopener noreferrer">go</a>',
    );
    expect(renderMarkdown("<a href='mailto:a@b.co'>m</a>")).toContain('<a href="mailto:a@b.co"');
    for (const href of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", " \t javascript:alert(1)", "java&#115;cript:alert(1)", "java&#x73;cript:alert(1)", "j&#97;vascript:alert(1)", "data:text/html,x", "relative/path", "#anchor", "//evil.example/x", "vbscript:x", ""]) {
      const html = renderMarkdown(`<a href="${href}" onclick="x()">hi</a> after`);
      expect(html, href).not.toContain("<a");
      expect(html, href).not.toContain("</a");
      expect(html, href).not.toContain("href");
      expect(html, href).toContain("hi");
      expect(html, href).toContain("after");
    }
    const noHref = renderMarkdown("<a name='top'>hi</a>");
    expect(noHref).not.toContain("<a");
    expect(noHref).toContain("hi");
  });

  it("decodes entities in an href before checking the scheme and re-escapes what it emits", () => {
    const html = renderMarkdown('<a href="https://a.io/?q=1&amp;r=&lt;2&gt;">q</a>');
    expect(html).toContain('<a href="https://a.io/?q=1&amp;r=&lt;2&gt;" title="https://a.io/?q=1&amp;r=&lt;2&gt;"');
    // Leading/trailing whitespace is stripped and a tab inside removed, as a browser would.
    expect(renderMarkdown("<a href=' \t https://a.io/x\ty '>n</a>")).toContain('href="https://a.io/xy"');
  });

  it("drops comments, CDATA, doctypes and processing instructions, including payloads inside them", () => {
    const html = renderMarkdown("<!-- <script>alert(1)</script> --><p>a</p><![CDATA[<b>x]]><!DOCTYPE html><?php echo 1 ?>");
    expect(html).toContain("<p>a</p>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain("<!--");
    expect(html).not.toContain("CDATA");
    expect(html).not.toContain("DOCTYPE");
    expect(html).not.toContain("php");
  });

  it("escapes a stray < in an HTML block and closes nothing it did not open", () => {
    const html = renderMarkdown("<div>\na < b and 1 <2\n</div>");
    expect(html).toContain("a &lt; b and 1 &lt;2");
    expect(renderMarkdown("<div>a</span></div>")).toContain("<div>a</span></div>");
    expect(renderMarkdown("<div>a</font></div>")).toContain("<div>a</div>");
    expect(renderMarkdown("<br></br><hr/>")).toContain("<br><hr>");
  });

  it("Markdown and HTML mix on one line", () => {
    const html = renderMarkdown("**bold** then <u>under *em*</u> and [l](https://a.io)");
    expect(html).toContain("<strong>bold</strong> then <u>under <em>em</em></u> and <a href=\"https://a.io\"");
  });

  it("a markup-looking value that is not HTML stays text", () => {
    const html = renderMarkdown("<not a tag and <1> and <-3>");
    expect(html).toContain("&lt;not a tag and &lt;1&gt; and &lt;-3&gt;");
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
