import { foldCase } from "./caseFold";
import { parseNumber } from "./number";
import type { FilterRule } from "./types";

export function isValidRule(rule: FilterRule): boolean {
  if (rule.operator !== "regex") return true;
  try {
    new RegExp(rule.value);
    return true;
  } catch {
    return false;
  }
}

export function regexErrorMessage(value: string): string | null {
  try {
    new RegExp(value);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// An inactive rule is ignored rather than matching nothing, so a stale rule cannot hide every row.
export function isRuleActive(rule: FilterRule, headers: string[]): boolean {
  if (!isValidRule(rule)) return false;
  if (rule.column !== null && headers.indexOf(rule.column) === -1) return false;
  if (rule.operator === "in") {
    return rule.column !== null && Array.isArray(rule.values) && rule.values.length > 0;
  }
  if (rule.operator !== "isEmpty" && rule.value === "") return false;
  return true;
}

function cellMatches(cell: string, rule: FilterRule, re: RegExp | null, valueSet: Set<string> | null): boolean {
  switch (rule.operator) {
    case "in":
      // The picker lists literal cell values, so match exactly: case-sensitive and untrimmed.
      return valueSet !== null && valueSet.has(cell);
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
  valueSet: Set<string> | null;
}

function compileRule(rule: FilterRule, headers: string[]): CompiledRule {
  const re = rule.operator === "regex" ? new RegExp(rule.value, rule.caseSensitive ? "" : "i") : null;
  const valueSet = rule.operator === "in" ? new Set(rule.values ?? []) : null;
  return { rule, columnIndex: rule.column === null ? null : headers.indexOf(rule.column), re, valueSet };
}

function ruleMatchesRow(row: string[], c: CompiledRule): boolean {
  if (c.columnIndex === null) return row.some((cell) => cellMatches(cell, c.rule, c.re, c.valueSet));
  if (c.columnIndex === -1) return false;
  return cellMatches(row[c.columnIndex] ?? "", c.rule, c.re, c.valueSet);
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
