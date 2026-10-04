// PERF_TESTS=1 enforces the strict bound; the looser default avoids failing on noisy shared runners.
export const PERF_TESTS_ENABLED = process.env.PERF_TESTS === "1";

export function perfBoundMs(strictMs: number, generousMs: number): number {
  return PERF_TESTS_ENABLED ? strictMs : generousMs;
}
