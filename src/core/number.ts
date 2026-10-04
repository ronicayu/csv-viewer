// Stricter than Number(): hex ("0x10") and "Infinity" are not numbers, "1e3" is.
const NUMBER_PATTERN = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

export function parseNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "" || !NUMBER_PATTERN.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}
