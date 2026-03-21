/**
 * Route-planning module for chained bus stops.
 *
 * Uses greedy nearest-neighbor: picks the closest unvisited open stop
 * that fits within capacity and time budget, repeating until done.
 *
 * When Google routing is available, travel times come from the Distance
 * Matrix API; otherwise haversine + constant speed.
 */

import { Bus, RiderRequest, VirtualStop, SimConfig } from "@/engine/types";
import { haversine, travelTimeMinutes, getDirections } from "@/services/routing";

interface PlanResult {
  route: VirtualStop[];
  etas: number[];
  polylines: string[];
}

export async function planRoute(
  bus: Bus,
  openStops: VirtualStop[],
  requests: Record<number, RiderRequest>,
  config: SimConfig
): Promise<PlanResult> {
  const route: VirtualStop[] = [];
  const etas: number[] = [];
  const polylines: string[] = [];

  let cap = bus.capacity - bus.onboard.length;
  let cur = { ...bus.position };
  let t = 0;
  const candidates = [...openStops];

  while (candidates.length > 0 && cap > 0 && route.length < config.maxStopsPerRoute) {
    // find nearest stop that fits in capacity
    let bestIdx = -1;
    let bestDist = Infinity;

    for (let i = 0; i < candidates.length; i++) {
      const s = candidates[i];
      const pendingRiders = s.riderIds.filter(
        (rid) => requests[rid]?.status === "pending"
      ).length;
      if (pendingRiders > cap || pendingRiders === 0) continue;

      const d = haversine(cur, s.position);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) break;

    const best = candidates[bestIdx];
    const travelMin = travelTimeMinutes(bestDist, bus.speed);
    const pickupMin = 1 + 0.2 * best.riderIds.length;

    if (route.length > 0 && t + travelMin + pickupMin > config.timeBudgetMinutes) break;

    // get polyline if Google routing enabled
    let polyline = "";
    if (config.useGoogleRouting && config.googleApiKey) {
      try {
        const dir = await getDirections(cur, best.position, config.googleApiKey, true);
        polyline = dir.polyline;
      } catch {
        // fallback: no polyline
      }
    }

    t += travelMin + pickupMin;
    route.push(best);
    etas.push(Math.ceil(t));
    polylines.push(polyline);

    cap -= best.riderIds.filter((rid) => requests[rid]?.status === "pending").length;
    cur = { ...best.position };
    candidates.splice(bestIdx, 1);
  }

  return { route, etas, polylines };
}
