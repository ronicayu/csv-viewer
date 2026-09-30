// Shared numeric-string parsing, used by both src/core/filter.ts (numeric
// operators) and src/core/sort.ts (numeric vs. text sort keys), so the two
// features agree on exactly what counts as "a number". Pure module, no
// vscode/DOM.
//
// Deliberately stricter than plain `Number()`: only a decimal number,
// optionally signed, with an optional fractional part and an optional
// exponent. This rejects several things `Number()` would otherwise accept
// that would surprise a user filtering/sorting a CSV column:
//   - "0x10"     (hex)            -> Number("0x10") is 16
//   - "Infinity" / "NaN" (text)   -> Number("Infinity") is Infinity
//   - "1,000"    (thousands sep)  -> Number("1,000") is NaN anyway, but
//                                    documented here as an explicit reject
//   - "$5", "5%" (currency/percent) -> not numbers, no symbol stripping
// "1e3" (scientific notation) is intentionally still accepted.
const NUMBER_PATTERN = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

export function parseNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "" || !NUMBER_PATTERN.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}
