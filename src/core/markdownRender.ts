// Cell text -> HTML for the row-details "Markdown" view. Pure (no DOM, no
// vscode) but depends on markdown-it, so ONLY src/webview/main.ts may import
// it: pulling it into the worker or extension-host bundles would bloat them
// for nothing (see docs/spec.md, Architecture). Detection lives separately,
// dependency-free, in markdownDetect.ts for exactly that reason.
//
// The string returned by renderMarkdown is the one and only thing in the
// webview that may be assigned to innerHTML from cell content, so the
// guarantees live here:
//   - raw HTML in a cell is escaped and shown as text (`html: false`);
//   - only http:, https: and mailto: hrefs become <a>; any other link
//     (relative, #anchor, javascript:, data:, file:, ...) is its plain text;
//   - images are never loaded: `![alt](src)` becomes a link to src (same
//     href rules) labelled with the alt text or the URL, never an <img>.

import MarkdownIt from "markdown-it";
import type { StateCore, Token } from "markdown-it";

const SAFE_HREF = /^(?:https?|mailto):/i;

const md = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: true });

function attr(token: Token, name: string): string {
  return String(token.attrGet(name) ?? "");
}

function textToken(state: StateCore, content: string): Token {
  const token = new state.Token("text", "", 0);
  token.content = content;
  return token;
}

function linkOpenToken(state: StateCore, href: string): Token {
  const token = new state.Token("link_open", "a", 1);
  token.attrs = [
    ["href", href],
    ["title", href],
    ["rel", "noopener noreferrer"],
  ];
  return token;
}

/** Restricts every link to safe schemes and turns every image into a link.
 * Runs after inline parsing, over each inline token's children. */
function restrictLinksAndImages(state: StateCore): void {
  for (const block of state.tokens) {
    if (block.type !== "inline" || !block.children) continue;
    const out: Token[] = [];
    // One entry per open link, in nesting order: whether it survived.
    const keptLinks: boolean[] = [];
    for (const child of block.children) {
      if (child.type === "link_open") {
        const href = attr(child, "href");
        const keep = SAFE_HREF.test(href);
        keptLinks.push(keep);
        if (keep) {
          child.attrs = [
            ["href", href],
            ["title", href],
            ["rel", "noopener noreferrer"],
          ];
          out.push(child);
        }
      } else if (child.type === "link_close") {
        if (keptLinks.pop()) out.push(child);
      } else if (child.type === "image") {
        const src = attr(child, "src");
        const label = child.content !== "" ? child.content : src;
        if (SAFE_HREF.test(src)) {
          out.push(linkOpenToken(state, src), textToken(state, label), new state.Token("link_close", "a", -1));
        } else {
          out.push(textToken(state, label));
        }
      } else {
        out.push(child);
      }
    }
    block.children = out;
  }
}

md.core.ruler.push("csv_viewer_restrict_links", restrictLinksAndImages);

// A wide table scrolls inside its own wrapper instead of stretching the page.
md.renderer.rules.table_open = () => '<div class="md-table-wrap"><table>\n';
md.renderer.rules.table_close = () => "</table></div>\n";

export function renderMarkdown(source: string): string {
  return md.render(source);
}
