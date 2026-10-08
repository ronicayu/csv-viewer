// Allowlist sanitizer for the raw HTML that markdown-it passes through when a
// cell's Markdown contains HTML (`html: true` in markdownRender.ts). Pure
// string processing: no DOM, no dependencies, so it runs under vitest's node
// environment and makes the same decisions the webview will.
//
// It is only ever fed markdown-it's `html_block` / `html_inline` token
// contents, never the HTML markdown-it generates itself (that is trusted and
// bypasses this module). Within such a fragment:
//   - an element on the KEEP list is emitted with only its allowed
//     attributes, re-serialized (lower-cased name, decoded + re-escaped
//     values), so nothing the author wrote reaches innerHTML verbatim;
//   - <a> keeps only an http:, https: or mailto: href (checked after entity
//     decoding and whitespace stripping) and gets the same `title` and `rel`
//     as a Markdown link; any other <a> is dropped and its text stays;
//   - <img> is never emitted: like a Markdown image it becomes a link to its
//     src (same href rules) labelled with the alt text or the URL;
//   - script/style/iframe/object/svg/forms/... are dropped together with
//     their content when they occur inside one fragment; any other unknown
//     element is unwrapped (tag dropped, content kept);
//   - comments, CDATA, processing instructions and doctypes are dropped;
//   - a `<` that does not start a tag is escaped, so stray text in an HTML
//     block cannot form markup.
//
// A sanitizer holds a little state across the fragments of one render (a
// closing tag is dropped when its opening tag was), so create one per
// renderMarkdown call.

export const SAFE_HREF = /^(?:https?|mailto):/i;

const KEEP = new Set([
  // inline
  "a", "abbr", "b", "bdi", "bdo", "br", "cite", "code", "data", "del", "dfn", "em", "i", "ins", "kbd", "mark", "q", "s", "samp",
  "small", "span", "strike", "strong", "sub", "sup", "time", "u", "var", "wbr",
  // block
  "p", "div", "blockquote", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "ul", "ol", "li", "dl", "dt", "dd",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
  "details", "summary", "figure", "figcaption", "section", "article", "aside", "header", "footer", "nav", "main", "address",
]);

/** Dropped with everything up to their closing tag (within one fragment). */
const DROP_WITH_CONTENT = new Set([
  "script", "style", "template", "title", "textarea", "noscript", "xmp", "plaintext", "noembed", "noframes",
  "iframe", "frame", "frameset", "object", "embed", "applet", "head", "meta", "link", "base",
  "form", "input", "button", "select", "option", "optgroup", "datalist", "output", "fieldset", "legend",
  "svg", "math", "video", "audio", "source", "track", "canvas", "map", "area", "dialog", "slot", "portal",
]);

const VOID = new Set(["br", "hr", "wbr", "img", "col"]);

const GLOBAL_ATTRS = new Set(["title", "dir", "lang"]);

const TAG_ATTRS: Record<string, ReadonlySet<string>> = {
  td: new Set(["colspan", "rowspan", "align", "valign"]),
  th: new Set(["colspan", "rowspan", "align", "valign", "scope"]),
  ol: new Set(["start", "type", "reversed"]),
  li: new Set(["value"]),
  details: new Set(["open"]),
  time: new Set(["datetime"]),
  del: new Set(["datetime"]),
  ins: new Set(["datetime"]),
  col: new Set(["span"]),
  colgroup: new Set(["span"]),
};

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function codePoint(n: number): string {
  if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return "�";
  return String.fromCodePoint(n);
}

/** Decodes numeric and the common named character references. Unknown named
 * references are left as written. */
export function decodeEntities(s: string): string {
  if (s.indexOf("&") < 0) return s;
  return s.replace(/&(?:#[xX]([0-9a-fA-F]{1,8})|#([0-9]{1,8})|([a-zA-Z]+));?/g, (whole, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
    if (hex !== undefined) return codePoint(parseInt(hex, 16));
    if (dec !== undefined) return codePoint(parseInt(dec, 10));
    return NAMED_ENTITIES[(name ?? "").toLowerCase()] ?? whole;
  });
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Text inside an HTML fragment was written as HTML, so its entities stand;
 * only a `<` can start markup. */
function escapeText(s: string): string {
  return s.replace(/</g, "&lt;");
}

/** What a browser does to a URL attribute before reading its scheme: strip
 * leading/trailing C0 controls and spaces, and remove tab/newline anywhere. */
export function cleanHref(raw: string): string {
  return decodeEntities(raw)
    .replace(/^[\u0000- ]+|[\u0000- ]+$/g, "")
    .replace(/[\t\n\r]/g, "");
}

function linkOpen(href: string): string {
  const h = escapeAttr(href);
  return `<a href="${h}" title="${h}" rel="noopener noreferrer">`;
}

// One attribute: name, then optionally = and a double-quoted, single-quoted
// or unquoted value. Sticky so the scan can walk a tag's attribute list.
const ATTR_RE = /\s+([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/y;
const TAG_START_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/y;
const TAG_END_RE = /\s*\/?>/y;

interface ParsedTag {
  closing: boolean;
  name: string;
  attrs: Array<[string, string]>;
  /** Index just past the closing `>`. */
  end: number;
}

function parseTag(s: string, at: number): ParsedTag | null {
  TAG_START_RE.lastIndex = at;
  const start = TAG_START_RE.exec(s);
  if (!start) return null;
  const closing = start[1] === "/";
  const name = start[2].toLowerCase();
  let pos = TAG_START_RE.lastIndex;
  const attrs: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (;;) {
    ATTR_RE.lastIndex = pos;
    const m = ATTR_RE.exec(s);
    if (!m) break;
    pos = ATTR_RE.lastIndex;
    const attrName = m[1].toLowerCase();
    if (seen.has(attrName)) continue; // the first occurrence wins, as in HTML
    seen.add(attrName);
    attrs.push([attrName, m[2] ?? m[3] ?? m[4] ?? ""]);
  }
  TAG_END_RE.lastIndex = pos;
  if (!TAG_END_RE.exec(s)) return null;
  return { closing, name, attrs, end: TAG_END_RE.lastIndex };
}

export interface HtmlSanitizer {
  /** Sanitizes one markdown-it html_block / html_inline token's content. */
  sanitize(fragment: string): string;
}

export function createHtmlSanitizer(): HtmlSanitizer {
  // Opening tags dropped so far whose closing tag must be dropped too, by
  // name. Survives across the fragments of one render: inline HTML arrives
  // as one token per tag.
  const dropped = new Map<string, number>();

  function noteDropped(name: string): void {
    dropped.set(name, (dropped.get(name) ?? 0) + 1);
  }

  function takeDropped(name: string): boolean {
    const n = dropped.get(name) ?? 0;
    if (n === 0) return false;
    dropped.set(name, n - 1);
    return true;
  }

  function openTag(tag: ParsedTag): string {
    const { name, attrs } = tag;
    if (name === "img") {
      let src = "";
      let alt = "";
      for (const [k, v] of attrs) {
        if (k === "src") src = cleanHref(v);
        else if (k === "alt") alt = decodeEntities(v);
      }
      const label = alt !== "" ? alt : src;
      if (SAFE_HREF.test(src)) return `${linkOpen(src)}${escapeAttr(label)}</a>`;
      return escapeAttr(label);
    }
    if (name === "a") {
      const hrefAttr = attrs.find(([k]) => k === "href");
      const href = hrefAttr ? cleanHref(hrefAttr[1]) : "";
      if (!SAFE_HREF.test(href)) {
        noteDropped("a");
        return "";
      }
      return linkOpen(href);
    }
    const allowed = TAG_ATTRS[name];
    let out = `<${name}`;
    for (const [k, v] of attrs) {
      if (GLOBAL_ATTRS.has(k) || (allowed !== undefined && allowed.has(k))) {
        out += ` ${k}="${escapeAttr(decodeEntities(v))}"`;
      }
    }
    return out + ">";
  }

  function sanitize(fragment: string): string {
    let out = "";
    let i = 0;
    const len = fragment.length;
    // Inside a DROP_WITH_CONTENT element: skip everything until its closing tag.
    let skipUntil: string | null = null;

    while (i < len) {
      const lt = fragment.indexOf("<", i);
      if (lt < 0) {
        if (skipUntil === null) out += escapeText(fragment.slice(i));
        break;
      }
      if (skipUntil === null) out += escapeText(fragment.slice(i, lt));

      // Comments, CDATA, doctypes and processing instructions: dropped whole.
      if (fragment.startsWith("<!--", lt)) {
        const end = fragment.indexOf("-->", lt + 4);
        i = end < 0 ? len : end + 3;
        continue;
      }
      if (fragment.startsWith("<![CDATA[", lt)) {
        const end = fragment.indexOf("]]>", lt + 9);
        i = end < 0 ? len : end + 3;
        continue;
      }
      const next = fragment.charAt(lt + 1);
      if (next === "!" || next === "?") {
        const end = fragment.indexOf(">", lt + 2);
        i = end < 0 ? len : end + 1;
        continue;
      }

      const tag = parseTag(fragment, lt);
      if (!tag) {
        // Not markup: a literal `<`.
        if (skipUntil === null) out += "&lt;";
        i = lt + 1;
        continue;
      }
      i = tag.end;

      if (skipUntil !== null) {
        if (tag.closing && tag.name === skipUntil) skipUntil = null;
        continue;
      }

      if (tag.closing) {
        if (VOID.has(tag.name)) continue;
        if (takeDropped(tag.name)) continue;
        if (KEEP.has(tag.name)) out += `</${tag.name}>`;
        // Unknown closing tag: dropped (its opening tag was unwrapped).
        continue;
      }

      if (DROP_WITH_CONTENT.has(tag.name)) {
        if (!VOID.has(tag.name)) skipUntil = tag.name;
        continue;
      }
      if (tag.name === "img" || KEEP.has(tag.name)) {
        out += openTag(tag);
        continue;
      }
      // Unknown element: unwrapped. Its closing tag is dropped too.
      noteDropped(tag.name);
    }
    return out;
  }

  return { sanitize };
}
