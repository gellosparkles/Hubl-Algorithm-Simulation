/**
 * Headless benchmark harness — sweeps a config across seeds and reports
 * aggregate KPIs. See plan.md Phase 0.
 *
 * Every KPI is read straight off `SimState.metrics` (computed inside the engine
 * from rider timestamps — see src/engine/metrics.ts). The harness no longer
 * re-derives waits, detours, occupancy or vehicle-km by watching status
 * transitions from outside; it only adds two trivial ratios of engine counts.
 */

import { createInitialState, simulateStep } from "./simulator";
import { DEFAULT_CONFIG, LatLng, SimConfig, SimMetrics, SimState } from "./types";
import { createTravelTimeProvider, TravelTimeProvider } from "@/services/travelTime";

/** Default drop-off hubs for a bench run that doesn't supply its own. Mirrors simulator.test.ts. */
export const DEFAULT_BENCH_HUBS: LatLng[] = [
  { lat: 34.0522, lng: -118.2437 }, // Downtown LA
  { lat: 34.0195, lng: -118.4912 }, // Santa Monica
];

export interface BenchKpis extends SimMetrics {
  seed: number;
  unservedRate: number; // unserved / totalRequests — trips with no hub-anchored path
  pendingRate: number; // pending / totalRequests, at horizon end
  travelTimeProvider: TravelTimeProvider["name"] | "google-fallback";
}

export type BenchSummary = Omit<BenchKpis, "seed" | "travelTimeProvider">;

export interface BenchAggregate {
  overrides: Partial<SimConfig>;
  seeds: number[];
  minutes: number;
  travelTimeProvider: TravelTimeProvider["name"] | "google-fallback";
  perSeed: BenchKpis[];
  mean: BenchSummary;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/**
 * A provider's `name` is fixed at construction and would keep reporting
 * "google" even if every lookup that tick silently fell back to haversine —
 * which would make a benchmark comparison a lie. `simulateStep` builds a
 * fresh provider every tick (see simulator.ts), so no single provider
 * instance ever sees the whole run; `SimState.travelTimeProviderDegraded`
 * is the sticky, run-wide signal of whether *any* tick's dispatch fell back.
 */
function providerLabel(name: TravelTimeProvider["name"], degraded: boolean): BenchKpis["travelTimeProvider"] {
  return name === "google" && degraded ? "google-fallback" : name;
}

/** Run one seeded simulation to completion and read its KPIs. */
export async function runBenchSeed(
  overrides: Partial<SimConfig>,
  seed: number,
  minutes: number,
  hubs: LatLng[] = DEFAULT_BENCH_HUBS
): Promise<BenchKpis> {
  const config: SimConfig = { ...DEFAULT_CONFIG, ...overrides, seed, simMinutes: minutes };
  const travelTime = createTravelTimeProvider(config);

  let s: SimState = createInitialState(config);
  s.dropOffHubs = hubs;
  for (let i = 0; i < minutes; i++) s = await simulateStep(s, config);

  const m = s.metrics;
  const total = m.totalRequests;

  return {
    ...m,
    seed,
    unservedRate: total ? m.unserved / total : 0,
    pendingRate: total ? m.pending / total : 0,
    travelTimeProvider: providerLabel(travelTime.name, s.travelTimeProviderDegraded),
  };
}

/** Sweep a config across N seeds and aggregate. Always state which provider a benchmark used. */
export async function runBenchSweep(
  overrides: Partial<SimConfig>,
  seeds: number[],
  minutes = 60,
  hubs: LatLng[] = DEFAULT_BENCH_HUBS
): Promise<BenchAggregate> {
  const perSeed: BenchKpis[] = [];
  for (const seed of seeds) {
    perSeed.push(await runBenchSeed(overrides, seed, minutes, hubs));
  }

  // Mean of a field across seeds, skipping seeds where it came back null.
  // Enumerated (not key-iterated) so a new SimMetrics field is a compile error
  // here until it's added, rather than silently missing from the summary.
  const avg = (f: (k: BenchKpis) => number | null): number =>
    mean(perSeed.map(f).filter((v): v is number => v != null));
  const avgN = (f: (k: BenchKpis) => number | null): number | null =>
    perSeed.some((k) => f(k) != null) ? avg(f) : null;

  const meanSummary: BenchSummary = {
    busAssignments: avg((k) => k.busAssignments),
    completed: avg((k) => k.completed),
    pending: avg((k) => k.pending),
    pickedUp: avg((k) => k.pickedUp),
    unserved: avg((k) => k.unserved),
    expired: avg((k) => k.expired),
    totalRequests: avg((k) => k.totalRequests),
    totalStops: avg((k) => k.totalStops),
    serviceRate: avg((k) => k.serviceRate),
    poolingRate: avg((k) => k.poolingRate),
    waitP50Min: avgN((k) => k.waitP50Min),
    waitP90Min: avgN((k) => k.waitP90Min),
    inVehicleP50Min: avgN((k) => k.inVehicleP50Min),
    inVehicleP90Min: avgN((k) => k.inVehicleP90Min),
    detourRatioMean: avgN((k) => k.detourRatioMean),
    vehicleKm: avg((k) => k.vehicleKm),
    deadheadShare: avg((k) => k.deadheadShare),
    meanOccupancy: avg((k) => k.meanOccupancy),
    meanWalkKm: avgN((k) => k.meanWalkKm),
    unservedRate: avg((k) => k.unservedRate),
    pendingRate: avg((k) => k.pendingRate),
  };

  // A sweep-wide label must not hide a seed that degraded: report
  // "google-fallback" if *any* seed did, not just the first one.
  const sweepProvider: BenchAggregate["travelTimeProvider"] = perSeed.some(
    (k) => k.travelTimeProvider === "google-fallback"
  )
    ? "google-fallback"
    : (perSeed[0]?.travelTimeProvider ?? "haversine");

  return {
    overrides,
    seeds,
    minutes,
    travelTimeProvider: sweepProvider,
    perSeed,
    mean: meanSummary,
  };
}
