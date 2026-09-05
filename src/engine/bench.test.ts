import { describe, it, expect } from "vitest";
import { median, percentile, runBenchSeed, runBenchSweep } from "./bench";

describe("percentile helpers", () => {
  it("computes median and p90 with linear interpolation", () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(median(xs)).toBeCloseTo(5.5, 5);
    expect(percentile(xs, 90)).toBeCloseTo(9.1, 5);
  });

  it("handles a single value", () => {
    expect(median([42])).toBe(42);
  });

  it("is order-independent", () => {
    expect(median([5, 1, 3, 2, 4])).toBeCloseTo(3, 5);
  });
});

describe("runBenchSeed", () => {
  it("is deterministic for a fixed seed", async () => {
    const a = await runBenchSeed({}, 12345, 30);
    const b = await runBenchSeed({}, 12345, 30);
    expect(b).toEqual(a);
  });

  it("keeps rider status accounting consistent with the total", async () => {
    const k = await runBenchSeed({}, 42, 30);
    expect(k.completed + k.pending + k.pickedUp + k.unserved).toBe(k.totalRequests);
  });

  it("never reports a negative wait or detour ratio", async () => {
    const k = await runBenchSeed({}, 7, 30);
    expect(k.waitP50Min === null || k.waitP50Min >= 0).toBe(true);
    expect(k.waitP90Min === null || k.waitP90Min >= 0).toBe(true);
    expect(k.detourRatioMean === null || k.detourRatioMean >= 0).toBe(true);
  });

  it("reports the haversine provider when Google routing is off", async () => {
    const k = await runBenchSeed({}, 1, 15);
    expect(k.travelTimeProvider).toBe("haversine");
  });
});

describe("runBenchSweep", () => {
  it("aggregates one row per seed plus a mean summary", async () => {
    const agg = await runBenchSweep({}, [1, 2, 3], 20);
    expect(agg.perSeed).toHaveLength(3);
    expect(agg.perSeed.map((k) => k.seed)).toEqual([1, 2, 3]);
    expect(agg.mean.totalRequests).toBeGreaterThan(0);
  });

  it("applies config overrides to every seed", async () => {
    const agg = await runBenchSweep({ numBuses: 3 }, [1, 2], 10);
    for (const k of agg.perSeed) {
      expect(k.busAssignments).toBeGreaterThanOrEqual(0);
    }
    expect(agg.overrides).toEqual({ numBuses: 3 });
  });
});
