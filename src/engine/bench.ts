/**
 * Headless benchmark harness — sweeps a config across seeds and reports
 * aggregate KPIs. See plan.md Phase 0.
 *
 * KPI caveats:
 *  - "wait" is time from request to physical boarding (the pending -> picked_up
 *    transition, which issue #4 moved to the moment the bus reaches the stop).
 *  - "detour ratio" divides (rider drop-off time − rider board time) by the
 *    haversine direct-drive time. Since issue #4 each rider is completed at
 *    their own drop-off, not in bulk at route end, so this is a real per-rider
 *    in-vehicle ratio.
 *  - "vehicle-km" sums haversine distance between consecutive
 *    `bus.positionHistory` samples; the engine caps that array at 200
 *    entries per bus, so runs much longer than ~200 minutes will undercount.
 */

import { createInitialState, simulateStep } from "./simulator";
import { DEFAULT_CONFIG, LatLng, SimConfig, SimState } from "./types";
import { haversine } from "@/services/routing";
import { createTravelTimeProvider, TravelTimeProvider } from "@/services/travelTime";

/** Default drop-off hubs for a bench run that doesn't supply its own. Mirrors simulator.test.ts. */
export const DEFAULT_BENCH_HUBS: LatLng[] = [
  { lat: 34.0522, lng: -118.2437 }, // Downtown LA
  { lat: 34.0195, lng: -118.4912 }, // Santa Monica
];

export interface BenchKpis {
  seed: number;
  totalRequests: number;
  completed: number;
  pending: number;
  pickedUp: number;
  unserved: number; // classified `unserved` at request time
  serviceRate: number; // completed / totalRequests
  unservedRate: number; // unserved / totalRequests — trips with no hub-anchored path
  pendingRate: number; // pending / totalRequests, at horizon end
  waitP50Min: number | null;
  waitP90Min: number | null;
  detourRatioMean: number | null;
  vehicleKm: number;
  meanOccupancy: number; // mean onboard riders per bus, averaged over ticks
  totalStops: number;
  busAssignments: number;
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

function sortedCopy(xs: number[]): number[] {
  return [...xs].sort((a, b) => a - b);
}

export function percentile(xs: number[], p: number): number {
  const sorted = sortedCopy(xs);
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function median(xs: number[]): number {
  return percentile(xs, 50);
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

/** Run one seeded simulation to completion and compute its KPIs. */
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

  const prevStatus: Record<number, string> = {};
  const tAssigned: Record<number, number> = {};
  const tCompleted: Record<number, number> = {};
  const occupancySamples: number[] = [];
  const numBuses = Object.keys(s.buses).length;

  for (let i = 0; i < minutes; i++) {
    s = await simulateStep(s, config);

    for (const r of Object.values(s.requests)) {
      const prev = prevStatus[r.id];
      if (prev !== "picked_up" && prev !== "completed" && r.status === "picked_up") {
        tAssigned[r.id] = s.time;
      }
      if (prev !== "completed" && r.status === "completed") {
        tCompleted[r.id] = s.time;
      }
      prevStatus[r.id] = r.status;
    }

    const onboardTotal = Object.values(s.buses).reduce((sum, b) => sum + b.onboard.length, 0);
    occupancySamples.push(numBuses ? onboardTotal / numBuses : 0);
  }

  const waits: number[] = [];
  const detours: number[] = [];
  for (const r of Object.values(s.requests)) {
    const ta = tAssigned[r.id];
    if (ta == null) continue;
    waits.push(ta - r.tRequest);

    const tc = tCompleted[r.id];
    if (tc == null) continue;
    const directMin = travelTime.time(r.origin, r.destination, r.tRequest);
    if (directMin > 0.01) detours.push((tc - ta) / directMin);
  }

  let vehicleKm = 0;
  for (const bus of Object.values(s.buses)) {
    for (let i = 1; i < bus.positionHistory.length; i++) {
      vehicleKm += haversine(bus.positionHistory[i - 1], bus.positionHistory[i]);
    }
  }

  const totalRequests = Object.keys(s.requests).length;

  return {
    seed,
    totalRequests,
    completed: s.metrics.completed,
    pending: s.metrics.pending,
    pickedUp: s.metrics.pickedUp,
    unserved: s.metrics.unserved,
    serviceRate: totalRequests ? s.metrics.completed / totalRequests : 0,
    unservedRate: totalRequests ? s.metrics.unserved / totalRequests : 0,
    pendingRate: totalRequests ? s.metrics.pending / totalRequests : 0,
    waitP50Min: waits.length ? median(waits) : null,
    waitP90Min: waits.length ? percentile(waits, 90) : null,
    detourRatioMean: detours.length ? mean(detours) : null,
    vehicleKm,
    meanOccupancy: mean(occupancySamples),
    totalStops: s.metrics.totalStops,
    busAssignments: s.metrics.busAssignments,
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

  const pick = (f: (k: BenchKpis) => number | null): number[] =>
    perSeed.map(f).filter((v): v is number => v != null);

  const meanSummary: BenchSummary = {
    totalRequests: mean(pick((k) => k.totalRequests)),
    completed: mean(pick((k) => k.completed)),
    pending: mean(pick((k) => k.pending)),
    pickedUp: mean(pick((k) => k.pickedUp)),
    unserved: mean(pick((k) => k.unserved)),
    serviceRate: mean(pick((k) => k.serviceRate)),
    unservedRate: mean(pick((k) => k.unservedRate)),
    pendingRate: mean(pick((k) => k.pendingRate)),
    waitP50Min: pick((k) => k.waitP50Min).length ? mean(pick((k) => k.waitP50Min)) : null,
    waitP90Min: pick((k) => k.waitP90Min).length ? mean(pick((k) => k.waitP90Min)) : null,
    detourRatioMean: pick((k) => k.detourRatioMean).length ? mean(pick((k) => k.detourRatioMean)) : null,
    vehicleKm: mean(pick((k) => k.vehicleKm)),
    meanOccupancy: mean(pick((k) => k.meanOccupancy)),
    totalStops: mean(pick((k) => k.totalStops)),
    busAssignments: mean(pick((k) => k.busAssignments)),
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
