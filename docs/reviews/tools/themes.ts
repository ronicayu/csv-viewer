// THROWAWAY (UX review): resolved --vscode-* palettes for three built-in
// themes, taken from microsoft/vscode main (2026-10-01):
//   extensions/theme-defaults/themes/{light_modern,dark_modern,hc_black}.json
//   + registry defaults in src/vs/platform/theme/common/colors/*.ts and
//     src/vs/workbench/common/theme.ts (panel.border).
// A color whose registry default is `null` for that theme is NOT emitted
// by VS Code as a CSS variable at all, so it is deliberately left out here
// (e.g. inputValidation.warningForeground in Dark Modern, widget.shadow in
// HC) — that is what lets main.css's var() fallbacks behave as they would
// in the real product. Transparent registry values are given as rgba().

export interface ThemeDef {
  name: string;
  kind: "vscode-light" | "vscode-dark" | "vscode-high-contrast";
  vars: Record<string, string>;
}

const common = {
  "font-family": '-apple-system, BlinkMacSystemFont, sans-serif',
  "font-size": "13px",
  "font-weight": "normal",
  "editor-font-family": 'Menlo, Monaco, "Courier New", monospace',
  "editor-font-size": "12px",
};

export const THEMES: ThemeDef[] = [
  {
    name: "light-modern",
    kind: "vscode-light",
    vars: {
      ...common,
      "foreground": "#3B3B3B",
      "editor-foreground": "#3B3B3B",
      "editor-background": "#FFFFFF",
      "descriptionForeground": "#3B3B3B",
      "errorForeground": "#F85149",
      "focusBorder": "#005FB8",
      "button-background": "#005FB8",
      "button-foreground": "#FFFFFF",
      "button-hoverBackground": "#0258A8",
      "button-border": "rgba(0,0,0,0.1)",
      "button-secondaryBackground": "#E5E5E5",
      "button-secondaryForeground": "#3B3B3B",
      "button-secondaryHoverBackground": "#CCCCCC",
      "checkbox-background": "#F8F8F8",
      "checkbox-border": "#CECECE",
      "input-background": "#FFFFFF",
      "input-foreground": "#3B3B3B",
      "input-border": "#CECECE",
      "input-placeholderForeground": "#767676",
      "dropdown-background": "#FFFFFF",
      "dropdown-foreground": "#3B3B3B",
      "dropdown-border": "#CECECE",
      "panel-border": "#E5E5E5",
      "widget-border": "#E5E5E5",
      "widget-shadow": "rgba(0,0,0,0.16)",
      "editorWidget-background": "#F8F8F8",
      "list-hoverBackground": "#F2F2F2",
      "inputValidation-warningBackground": "#F6F5D2",
      "inputValidation-warningBorder": "#B89500",
      "editorWarning-foreground": "#BF8803",
      "scrollbarSlider-background": "rgba(100,100,100,0.4)",
      "textLink-foreground": "#005FB8",
    },
  },
  {
    name: "dark-modern",
    kind: "vscode-dark",
    vars: {
      ...common,
      "foreground": "#CCCCCC",
      "editor-foreground": "#CCCCCC",
      "editor-background": "#1F1F1F",
      "descriptionForeground": "#9D9D9D",
      "errorForeground": "#F85149",
      "focusBorder": "#0078D4",
      "button-background": "#0078D4",
      "button-foreground": "#FFFFFF",
      "button-hoverBackground": "#026EC1",
      "button-border": "rgba(255,255,255,0.1)",
      "button-secondaryBackground": "rgba(0,0,0,0)",
      "button-secondaryForeground": "#CCCCCC",
      "button-secondaryHoverBackground": "#2B2B2B",
      "checkbox-background": "#313131",
      "checkbox-border": "#3C3C3C",
      "input-background": "#313131",
      "input-foreground": "#CCCCCC",
      "input-border": "#3C3C3C",
      "input-placeholderForeground": "#989898",
      "dropdown-background": "#313131",
      "dropdown-foreground": "#CCCCCC",
      "dropdown-border": "#3C3C3C",
      "panel-border": "#2B2B2B",
      "widget-border": "#313131",
      "widget-shadow": "rgba(0,0,0,0.36)",
      "editorWidget-background": "#202020",
      "list-hoverBackground": "#2A2D2E",
      "inputValidation-warningBackground": "#352A05",
      "inputValidation-warningBorder": "#B89500",
      "editorWarning-foreground": "#CCA700",
      "scrollbarSlider-background": "rgba(121,121,121,0.4)",
      "textLink-foreground": "#4daafc",
    },
  },
  {
    name: "hc-dark",
    kind: "vscode-high-contrast",
    vars: {
      ...common,
      "foreground": "#FFFFFF",
      "editor-foreground": "#FFFFFF",
      "editor-background": "#000000",
      "descriptionForeground": "rgba(255,255,255,0.7)",
      "errorForeground": "#F48771",
      "focusBorder": "#F38518",
      "contrastBorder": "#6FC3DF",
      "contrastActiveBorder": "#F38518",
      "button-background": "#000000",
      "button-foreground": "#FFFFFF",
      "button-hoverBackground": "#000000",
      "button-border": "#6FC3DF",
      "button-secondaryForeground": "#FFFFFF",
      "checkbox-background": "#000000",
      "checkbox-border": "#6FC3DF",
      "input-background": "#000000",
      "input-foreground": "#FFFFFF",
      "input-border": "#6FC3DF",
      "dropdown-background": "#000000",
      "dropdown-foreground": "#FFFFFF",
      "dropdown-border": "#6FC3DF",
      "panel-border": "#6FC3DF",
      "widget-border": "#6FC3DF",
      "editorWidget-background": "#0C141F",
      "list-hoverBackground": "rgba(255,255,255,0.1)",
      "inputValidation-warningBackground": "#000000",
      "inputValidation-warningBorder": "#6FC3DF",
      "editorWarning-foreground": "#FFD370",
      "editorWarning-border": "rgba(255,204,0,0.8)",
      "scrollbarSlider-background": "rgba(111,195,223,0.6)",
      "textLink-foreground": "#21A6FF",
    },
  },
];

/** VS Code's own webview default stylesheet (pre/index.html, `@layer
 * vscode-default`), trimmed to the rules that affect this page. Layered,
 * so main.css's unlayered rules win where they set the same property —
 * but main.css never sets body `padding`, so the 20px gutter applies. */
export const VSCODE_DEFAULT_STYLES = `
@layer vscode-default {
  html { scrollbar-color: var(--vscode-scrollbarSlider-background) var(--vscode-editor-background); }
  body {
    overscroll-behavior-x: none;
    background-color: transparent;
    color: var(--vscode-editor-foreground);
    font-family: var(--vscode-font-family);
    font-weight: var(--vscode-font-weight);
    font-size: var(--vscode-font-size);
    margin: 0;
    padding: 0 20px;
  }
  a:focus, input:focus, select:focus, textarea:focus { outline: 1px solid -webkit-focus-ring-color; outline-offset: -1px; }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-corner { background-color: var(--vscode-editor-background); }
  ::-webkit-scrollbar-thumb { background-color: var(--vscode-scrollbarSlider-background); }
}`;

export function themeCss(t: ThemeDef): string {
  const decls = Object.entries(t.vars)
    .map(([k, v]) => `--vscode-${k}: ${v};`)
    .join("\n");
  // VS Code's webview iframe itself paints the editor background behind
  // a transparent body.
  return `:root { ${decls} }\nhtml { background: var(--vscode-editor-background); }\n${VSCODE_DEFAULT_STYLES}`;
}
