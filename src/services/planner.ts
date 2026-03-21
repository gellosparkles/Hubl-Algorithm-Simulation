/**
 * Route-planning module for chained bus stops.
 *
 * Uses greedy nearest-neighbor: picks the closest unvisited open stop
 * that fits within capacity and time budget, repeating until done.
 *
 * When Google routing is available, travel times and road paths come from
 * the Maps JS API DirectionsService; otherwise haversine + constant speed.
 */

import { Bus, LatLng, RiderRequest, VirtualStop, SimConfig } from "@/engine/types";
import { haversine, travelTimeMinutes, getDirections } from "@/services/routing";

interface PlanResult {
  route: VirtualStop[];
  etas: number[];
  polylines: string[];
  decodedLegs: LatLng[][]; // road-snapped points per leg
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
  const decodedLegs: LatLng[][] = [];

  let cap = bus.capacity - bus.onboard.length;
  let cur = { ...bus.position };
  let t = 0;
  const candidates = [...openStops];

  while (candidates.length > 0 && cap > 0 && route.length < config.maxStopsPerRoute) {
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
    let travelMin = travelTimeMinutes(bestDist, bus.speed);
    const pickupMin = 1 + 0.2 * best.riderIds.length;

    if (route.length > 0 && t + travelMin + pickupMin > config.timeBudgetMinutes) break;

    // Get road-snapped path if Google routing enabled
    let polyline = "";
    let legPath: LatLng[] = [];
    if (config.useGoogleRouting && config.googleApiKey) {
      try {
        const dir = await getDirections(cur, best.position, config.googleApiKey, true);
        polyline = dir.polyline;
        legPath = dir.decodedPath;
        if (dir.durationMinutes > 0) {
          travelMin = dir.durationMinutes;
        }
      } catch {
        // fallback: no polyline
      }
    }

    // If no road path available, generate L-shaped grid path
    if (legPath.length < 2) {
      const midpoint: LatLng = { lat: cur.lat, lng: best.position.lng };
      legPath = [{ ...cur }, midpoint, { ...best.position }];
    }

    t += travelMin + pickupMin;
    route.push(best);
    etas.push(Math.ceil(t));
    polylines.push(polyline);
    decodedLegs.push(legPath);

    cap -= best.riderIds.filter((rid) => requests[rid]?.status === "pending").length;
    cur = { ...best.position };
    candidates.splice(bestIdx, 1);
  }

  return { route, etas, polylines, decodedLegs };
}
