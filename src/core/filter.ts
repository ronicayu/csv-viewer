// Row filtering: a global quick search plus a list of rules that combine
// with AND semantics (all enabled include rules must match; any enabled
// exclude rule that matches drops the row). Pure module, no vscode/DOM.

import { foldCase } from "./caseFold";
import { parseNumber } from "./number";
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

/**
 * Whether a rule can actually apply right now, independent of its
 * `enabled` checkbox: its regex (if any) parses, its column (if any) still
 * exists in `headers`, and — for every operator except `isEmpty`, which
 * takes no value — it has a non-empty value. `applyFilters` uses this (in
 * combination with `enabled`) to decide which rules take part; the UI uses
 * it to decide whether to show a "column not found" / "enter a value"
 * hint on a rule row, so the two always agree on what "active" means.
 *
 * A rule that fails this check is IGNORED (as if disabled), not applied as
 * a rule that matches nothing — those are very different outcomes for an
 * include rule: "ignored" leaves every row as-is, "matches nothing" drops
 * every row. A stale/incomplete rule doing the latter (the pre-fix
 * behavior) meant one leftover rule — e.g. pointing at a column removed by
 * a header rename or separator change — could silently hide the entire
 * file instead of just not filtering.
 */
export function isRuleActive(rule: FilterRule, headers: string[]): boolean {
  if (!isValidRule(rule)) return false;
  if (rule.column !== null && headers.indexOf(rule.column) === -1) return false;
  if (rule.operator !== "isEmpty" && rule.value === "") return false;
  return true;
}

function cellMatches(cell: string, rule: FilterRule, re: RegExp | null): boolean {
  switch (rule.operator) {
    case "isEmpty":
      return cell.trim() === "";
    case "contains":
    case "equals":
    case "startsWith":
    case "endsWith": {
      const a = rule.caseSensitive ? cell : foldCase(cell);
      const b = rule.caseSensitive ? rule.value : foldCase(rule.value);
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
    case "regex":
      return re !== null && re.test(cell);
    case "gt":
    case "lt":
    case "gte":
    case "lte": {
      const cellNum = parseNumber(cell);
      const ruleNum = parseNumber(rule.value);
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

interface CompiledRule {
  rule: FilterRule;
  columnIndex: number | null;
  re: RegExp | null;
}

function compileRule(rule: FilterRule, headers: string[]): CompiledRule {
  const re = rule.operator === "regex" ? new RegExp(rule.value, rule.caseSensitive ? "" : "i") : null;
  return { rule, columnIndex: rule.column === null ? null : headers.indexOf(rule.column), re };
}

function ruleMatchesRow(row: string[], c: CompiledRule): boolean {
  if (c.columnIndex === null) return row.some((cell) => cellMatches(cell, c.rule, c.re));
  if (c.columnIndex === -1) return false;
  return cellMatches(row[c.columnIndex] ?? "", c.rule, c.re);
}

export function applyFilters(
  headers: string[],
  rows: string[][],
  quickSearch: string,
  rules: FilterRule[],
): string[][] {
  const activeRules = rules
    .filter((r) => r.enabled && isRuleActive(r, headers))
    .map((r) => compileRule(r, headers));
  const search = foldCase(quickSearch.trim());

  return rows.filter((row) => {
    if (search !== "" && !row.some((cell) => foldCase(cell).includes(search))) {
      return false;
    }
    for (const c of activeRules) {
      const matched = ruleMatchesRow(row, c);
      if (c.rule.mode === "include" && !matched) return false;
      if (c.rule.mode === "exclude" && matched) return false;
    }
    return true;
  });
}
