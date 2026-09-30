// Row filtering: a global quick search plus a list of rules that combine
// with AND semantics (all enabled include rules must match; any enabled
// exclude rule that matches drops the row). Pure module, no vscode/DOM.

import type { FilterRule } from "./types";

/** A rule is invalid only when it's a regex rule with an unparsable pattern. */
export function isValidRule(rule: FilterRule): boolean {
  if (rule.operator !== "regex") return true;
  try {
    new RegExp(rule.value);
    return true;
  } catch {
    return false;
  }
}

function parseNumeric(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function cellMatches(cell: string, rule: FilterRule): boolean {
  switch (rule.operator) {
    case "isEmpty":
      return cell.trim() === "";
    case "contains":
    case "equals":
    case "startsWith":
    case "endsWith": {
      const a = rule.caseSensitive ? cell : cell.toLowerCase();
      const b = rule.caseSensitive ? rule.value : rule.value.toLowerCase();
      switch (rule.operator) {
        case "contains":
          return a.includes(b);
        case "equals":
          return a === b;
        case "startsWith":
          return a.startsWith(b);
        case "endsWith":
          return a.endsWith(b);
      }
      break;
    }
    case "regex": {
      try {
        const re = new RegExp(rule.value, rule.caseSensitive ? "" : "i");
        return re.test(cell);
      } catch {
        return false;
      }
    }
    case "gt":
    case "lt":
    case "gte":
    case "lte": {
      const cellNum = parseNumeric(cell);
      const ruleNum = parseNumeric(rule.value);
      if (cellNum === null || ruleNum === null) return false;
      switch (rule.operator) {
        case "gt":
          return cellNum > ruleNum;
        case "lt":
          return cellNum < ruleNum;
        case "gte":
          return cellNum >= ruleNum;
        case "lte":
          return cellNum <= ruleNum;
      }
      break;
    }
  }
  return false;
}

function ruleMatchesRow(row: string[], headers: string[], rule: FilterRule): boolean {
  if (rule.column === null) {
    return row.some((cell) => cellMatches(cell, rule));
  }
  const idx = headers.indexOf(rule.column);
  if (idx === -1) return false;
  return cellMatches(row[idx] ?? "", rule);
}

export function applyFilters(
  headers: string[],
  rows: string[][],
  quickSearch: string,
  rules: FilterRule[],
): string[][] {
  const activeRules = rules.filter((r) => r.enabled && isValidRule(r));
  const search = quickSearch.trim().toLowerCase();

  return rows.filter((row) => {
    if (search !== "" && !row.some((cell) => cell.toLowerCase().includes(search))) {
      return false;
    }
    for (const rule of activeRules) {
      const matched = ruleMatchesRow(row, headers, rule);
      if (rule.mode === "include" && !matched) return false;
      if (rule.mode === "exclude" && matched) return false;
    }
    return true;
  });
}
