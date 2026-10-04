// Output goes to innerHTML: raw HTML stays escaped, only http/https/mailto links, images never load.

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

function restrictLinksAndImages(state: StateCore): void {
  for (const block of state.tokens) {
    if (block.type !== "inline" || !block.children) continue;
    const out: Token[] = [];
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

md.renderer.rules.table_open = () => '<div class="md-table-wrap"><table>\n';
md.renderer.rules.table_close = () => "</table></div>\n";

export function renderMarkdown(source: string): string {
  return md.render(source);
}
