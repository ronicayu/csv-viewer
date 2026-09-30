// Adversarial tests for src/core/columns.ts, focused on header names that
// collide with Object.prototype members. ColumnVisibilityMap is a plain
// object keyed by header name (`map[h] = ...`), which is generally safe
// because the code reads it back via Object.prototype.hasOwnProperty.call
// (defends against a header literally named "hasOwnProperty") — but one
// name breaks the whole scheme via a different mechanism.
import { describe, expect, it, test } from "vitest";
import fc from "fast-check";
import { defaultVisibility, detailFieldsFor, detailOnlyColumns, reconcileVisibility, visibleColumns } from "../../core/columns";

describe("header named 'constructor' — safe", () => {
  it("gets a real own property and round-trips through reconcileVisibility normally", () => {
    const headers = ["constructor", "name"];
    const vis = defaultVisibility(headers, 1); // only first column ("constructor") in table
    expect(vis.constructor).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(vis, "constructor")).toBe(true);
    expect(visibleColumns(headers, vis)).toEqual(["constructor"]);
    expect(detailOnlyColumns(headers, vis)).toEqual(["name"]);

    const reconciled = reconcileVisibility(headers, vis, 1);
    expect(reconciled).toEqual(vis);
  });
});

describe("header named 'hasOwnProperty' — safe (code explicitly guards this)", () => {
  it("round-trips because the code calls Object.prototype.hasOwnProperty.call, not map.hasOwnProperty", () => {
    const headers = ["hasOwnProperty", "name"];
    const vis = defaultVisibility(headers, 1);
    expect(vis.hasOwnProperty).toBe(true); // shadows the inherited method with the boolean `true`
    const reconciled = reconcileVisibility(headers, vis, 0); // default would now hide it, but previous value must win
    expect(reconciled.hasOwnProperty).toBe(true);
  });
});

describe("header named '__proto__' — BUG", () => {
  test.fails(
    "BUG: assigning map['__proto__'] = <boolean> on a plain object literal invokes Object.prototype's __proto__ ACCESSOR (a setter), not a normal property write. Since the assigned value (true/false) is neither an object nor null, the setter is a silent no-op per the ECMAScript spec — no own property named '__proto__' is ever created. So a column literally named '__proto__' never gets a real visibility entry: defaultVisibility() silently drops it. Expected: every header in `headers` should get an own entry in the returned map, checkable via Object.prototype.hasOwnProperty.call. Location: src/core/columns.ts defaultVisibility() and reconcileVisibility(), `map[h] = ...` — needs `Object.defineProperty` or a Map instead of a plain object literal to be safe for arbitrary header names.",
    () => {
      const headers = ["__proto__", "name"];
      const vis = defaultVisibility(headers, 2); // both columns should be in the table
      expect(Object.prototype.hasOwnProperty.call(vis, "__proto__")).toBe(true);
    },
  );

  test.fails(
    "BUG (consequence #1): because '__proto__' never becomes an own property, reading vis['__proto__'] back returns Object.prototype itself (an object, hence truthy and !== false), so visibleColumns() happens to still show it — but only by accident, not because the column's actual visibility flag was ever stored or honored.",
    () => {
      const headers = ["__proto__", "name"];
      const vis = defaultVisibility(headers, 0); // BOTH columns should be detail-only (0 shown by default)
      // Expected: '__proto__' should be detail-only, matching every other
      // column when defaultTableColumns is 0.
      expect(detailOnlyColumns(headers, vis)).toEqual(["__proto__", "name"]);
    },
  );

  test.fails(
    "BUG (consequence #2, the more serious one): reconcileVisibility's whole point is to preserve a user's prior visibility choice across a header reload. For a column named '__proto__', Object.prototype.hasOwnProperty.call(previous, '__proto__') is ALWAYS false (since no own property could ever be written), so the user's saved choice is silently discarded every single time and the column reverts to the default rule on every reload — a real, persistent data-loss bug for anyone with a column named '__proto__' (unlikely, but not impossible — e.g. a JSON-derived export). Expected: a previously-hidden '__proto__' column should stay hidden after reconciliation, exactly like any other column name.",
    () => {
      const headers = ["__proto__", "name"];
      const previous = { name: true } as Record<string, boolean>;
      // Attempt to record that '__proto__' was explicitly hidden by the user...
      (previous as any).__proto__ = false; // this itself no-ops for the same reason
      const reconciled = reconcileVisibility(headers, previous, 5); // default would show it (i < 5)
      // Expected: still hidden, honoring the (attempted) prior choice.
      expect(reconciled.__proto__).toBe(false);
    },
  );

  it("detailFieldsFor does not crash on a '__proto__' header, at least (defensive smoke test)", () => {
    const headers = ["__proto__", "name"];
    const vis = defaultVisibility(headers, 1);
    expect(() => detailFieldsFor(headers, vis)).not.toThrow();
  });
});

describe("property: every ordinary (non-Object.prototype-colliding) header round-trips through defaultVisibility -> reconcileVisibility unchanged", () => {
  it("holds for random ASCII header sets that avoid known-dangerous names", () => {
    const dangerousNames = new Set(["__proto__"]);
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 10 }).filter((s) => !dangerousNames.has(s)), {
          minLength: 1,
          maxLength: 15,
        }),
        fc.nat({ max: 15 }),
        (headers, defaultTableColumns) => {
          const vis = defaultVisibility(headers, defaultTableColumns);
          const reconciled = reconcileVisibility(headers, vis, defaultTableColumns);
          expect(reconciled).toEqual(vis);
        },
      ),
      { numRuns: 200 },
    );
  });
});
