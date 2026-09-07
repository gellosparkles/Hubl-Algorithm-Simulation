/**
 * KPI computation — turns rider lifecycle timestamps and the per-tick
 * `SimState.kpi` accumulators into the `SimMetrics` set. See plan.md Phase 4a.
 *
 * Nothing here polls status transitions from outside the engine: waits come
 * from `tPickedUp − tRequest`, in-vehicle from `tDroppedOff − tPickedUp`,
 * detour from each rider's own `directTimeMin`, and the vehicle figures from
 * the running totals the simulator loop maintains.
 */

import { SimMetrics, SimState } from "./types";

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

/** Compute the full KPI set from `state`. Pure — safe to call every tick. */
export function computeMetrics(state: SimState): SimMetrics {
  const reqs = Object.values(state.requests);
  const total = reqs.length;

  let completed = 0;
  let pending = 0;
  let pickedUp = 0;
  let unserved = 0;
  let expired = 0;
  let everBoarded = 0;

  const waits: number[] = [];
  const inVehicle: number[] = [];
  const detours: number[] = [];
  const walks: number[] = [];

  for (const r of reqs) {
    switch (r.status) {
      case "completed":
        completed++;
        break;
      case "pending":
        pending++;
        break;
      case "picked_up":
        pickedUp++;
        break;
      case "unserved":
        unserved++;
        break;
    }

    // Expired: still waiting, never matched to a bus, and already past the
    // promised pickup time — a strict subset of `pending`, distinct from the
    // request-time `unserved` classification.
    if (r.status === "pending" && r.assignedBus == null && r.promisedPickupBy < state.time) {
      expired++;
    }

    if (r.tPickedUp != null) {
      everBoarded++;
      waits.push(r.tPickedUp - r.tRequest);
      if (r.tDroppedOff != null) {
        const iv = r.tDroppedOff - r.tPickedUp;
        inVehicle.push(iv);
        if (r.directTimeMin > 0.01) detours.push(iv / r.directTimeMin);
      }
    }

    if (r.walkDistanceKm != null) walks.push(r.walkDistanceKm);
  }

  const k = state.kpi;
  const pooled = k.pooledRiderIds.size;

  return {
    busAssignments: k.assignments,
    completed,
    pending,
    pickedUp,
    unserved,
    expired,
    totalRequests: total,
    totalStops: Object.keys(state.stops).length,
    serviceRate: total ? completed / total : 0,
    poolingRate: everBoarded ? pooled / everBoarded : 0,
    waitP50Min: waits.length ? median(waits) : null,
    waitP90Min: waits.length ? percentile(waits, 90) : null,
    inVehicleP50Min: inVehicle.length ? median(inVehicle) : null,
    inVehicleP90Min: inVehicle.length ? percentile(inVehicle, 90) : null,
    detourRatioMean: detours.length ? mean(detours) : null,
    vehicleKm: k.vehicleKm,
    deadheadShare: k.vehicleKm > 0 ? k.deadheadKm / k.vehicleKm : 0,
    meanOccupancy: k.travelMinutes > 0 ? k.personMinutes / k.travelMinutes : 0,
    meanWalkKm: walks.length ? mean(walks) : null,
  };
}
