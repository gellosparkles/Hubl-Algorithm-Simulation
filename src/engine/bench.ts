/**
 * Headless benchmark harness — sweeps a config across seeds and reports
 * aggregate KPIs. See plan.md Phase 0.
 *
 * KPI caveats, all inherent to the *current* pre-rewrite engine and expected
 * to change meaning once later phases land (re-baseline after each):
 *  - "wait" is time from request to *assignment* (status pending -> picked_up),
 *    not physical boarding — the engine sets `picked_up` at route-assignment
 *    time, not arrival (see CLAUDE.md gotchas; Phase 4 fixes this).
 *  - "detour ratio" divides (completion time − assignment time) by the
 *    haversine direct-drive time. `completed` fires for a bus's entire
 *    onboard list when its whole route finishes, not per rider drop-off, so
 *    this systematically overstates ride time for pooled riders (Phase 4
 *    adds per-stop completion).
 *  - "vehicle-km" sums haversine distance between consecutive
 *    `bus.positionHistory` samples; the engine caps that array at 200
 *    entries per bus, so runs much longer than ~200 minutes will undercount.
 */

import { createInitialState, simulateStep } from "./simulator";
import { DEFAULT_CONFIG, LatLng, SimConfig, SimState } from "./types";
import { haversine, travelTimeMinutes } from "@/services/routing";

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
  serviceRate: number; // completed / totalRequests
  unservedRate: number; // pending / totalRequests, at horizon end
  waitP50Min: number | null;
  waitP90Min: number | null;
  detourRatioMean: number | null;
  vehicleKm: number;
  meanOccupancy: number; // mean onboard riders per bus, averaged over ticks
  totalStops: number;
  busAssignments: number;
  travelTimeProvider: "haversine" | "google";
}

export type BenchSummary = Omit<BenchKpis, "seed" | "travelTimeProvider">;

export interface BenchAggregate {
  overrides: Partial<SimConfig>;
  seeds: number[];
  minutes: number;
  travelTimeProvider: "haversine" | "google";
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

/** Run one seeded simulation to completion and compute its KPIs. */
export async function runBenchSeed(
  overrides: Partial<SimConfig>,
  seed: number,
  minutes: number,
  hubs: LatLng[] = DEFAULT_BENCH_HUBS
): Promise<BenchKpis> {
  const config: SimConfig = { ...DEFAULT_CONFIG, ...overrides, seed, simMinutes: minutes };

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
    const directMin = travelTimeMinutes(haversine(r.origin, r.destination), config.busSpeed);
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
    serviceRate: totalRequests ? s.metrics.completed / totalRequests : 0,
    unservedRate: totalRequests ? s.metrics.pending / totalRequests : 0,
    waitP50Min: waits.length ? median(waits) : null,
    waitP90Min: waits.length ? percentile(waits, 90) : null,
    detourRatioMean: detours.length ? mean(detours) : null,
    vehicleKm,
    meanOccupancy: mean(occupancySamples),
    totalStops: s.metrics.totalStops,
    busAssignments: s.metrics.busAssignments,
    travelTimeProvider: config.useGoogleRouting && config.googleApiKey ? "google" : "haversine",
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
    serviceRate: mean(pick((k) => k.serviceRate)),
    unservedRate: mean(pick((k) => k.unservedRate)),
    waitP50Min: pick((k) => k.waitP50Min).length ? mean(pick((k) => k.waitP50Min)) : null,
    waitP90Min: pick((k) => k.waitP90Min).length ? mean(pick((k) => k.waitP90Min)) : null,
    detourRatioMean: pick((k) => k.detourRatioMean).length ? mean(pick((k) => k.detourRatioMean)) : null,
    vehicleKm: mean(pick((k) => k.vehicleKm)),
    meanOccupancy: mean(pick((k) => k.meanOccupancy)),
    totalStops: mean(pick((k) => k.totalStops)),
    busAssignments: mean(pick((k) => k.busAssignments)),
  };

  return {
    overrides,
    seeds,
    minutes,
    travelTimeProvider: perSeed[0]?.travelTimeProvider ?? "haversine",
    perSeed,
    mean: meanSummary,
  };
}
