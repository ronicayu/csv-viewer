export const smallFixture = {
  headers: ["id", "name", "age", "city"],
  rows: [
    ["1", "Alice", "30", "NYC"],
    ["2", "Bob", "25", "LA"],
    ["3", "Charlie", "35", "LA"],
    ["4", "Dana", "28", "SF"],
    ["5", "Eve", "40", "NYC"],
  ],
};

export function largeFixture(count: number): { headers: string[]; rows: string[][] } {
  const headers = ["id", "name", "age", "city", "note"];
  const rows: string[][] = [];
  for (let i = 0; i < count; i++) {
    rows.push([String(i), `Person ${i}`, String(20 + (i % 50)), i % 2 === 0 ? "NYC" : "LA", ""]);
  }
  return { headers, rows };
}
