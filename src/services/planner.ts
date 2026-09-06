/**
 * Route-planning module for chained bus stops.
 *
 * Uses greedy nearest-neighbor: picks the closest unvisited open stop
 * that fits within capacity and time budget, repeating until done.
 * After pickups, appends drop-off legs to assigned drop-off hubs.
 *
 * This is a prefactor (issue #4): the greedy logic below is unchanged — it now
 * emits one ordered `PlanStop[]` itinerary instead of four parallel arrays, and
 * hub visits are itinerary entries rather than fake negative-id stops written
 * into the shared stop map.
 *
 * Travel time (the number the dispatcher trusts for budgets and ETAs) always
 * comes from a TravelTimeProvider. When Google routing is available, its
 * DirectionsService additionally supplies road-snapped polylines for display,
 * but never overrides the provider's duration — see plan.md Phase 1.
 */

import { Bus, LatLng, PlanStop, RiderRequest, VirtualStop, SimConfig } from "@/engine/types";
import { haversine, getDirections } from "@/services/routing";
import { TravelTimeProvider } from "@/services/travelTime";

/** Straight L-shaped grid path, used for display when no road geometry is available. */
function gridPath(from: LatLng, to: LatLng): LatLng[] {
  return [{ ...from }, { lat: from.lat, lng: to.lng }, { ...to }];
}

export async function planRoute(
  bus: Bus,
  openStops: VirtualStop[],
  requests: Record<number, RiderRequest>,
  config: SimConfig,
  travelTime: TravelTimeProvider,
  dropOffHubs: LatLng[] = [],
  now = 0
): Promise<PlanStop[]> {
  const plan: PlanStop[] = [];

  let cap = bus.capacity - bus.onboard.length;
  let load = bus.onboard.length;
  let cur = { ...bus.position };
  let t = 0;
  const candidates = [...openStops];

  // ── Phase 1: Pickup stops (greedy nearest-neighbor) ──
  while (candidates.length > 0 && cap > 0 && plan.length < config.maxStopsPerRoute) {
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
    const travelMin = travelTime.time(cur, best.position, now + t);
    const pickupMin = 1 + 0.2 * best.riderIds.length;

    if (plan.length > 0 && t + travelMin + pickupMin > config.timeBudgetMinutes) break;

    // Get road-snapped path if Google routing enabled — geometry only, never timing.
    let polyline = "";
    let legPath: LatLng[] = [];
    if (config.useGoogleRouting && config.googleApiKey) {
      try {
        const dir = await getDirections(cur, best.position, config.googleApiKey, true);
        polyline = dir.polyline;
        legPath = dir.decodedPath;
      } catch {
        // fallback: no polyline
      }
    }
    if (legPath.length < 2) legPath = gridPath(cur, best.position);

    t += travelMin + pickupMin;

    const boarding = best.riderIds.filter((rid) => requests[rid]?.status === "pending");
    load += boarding.length;
    plan.push({
      kind: "pickup",
      position: { ...best.position },
      stopId: best.id,
      hubIndex: best.dropOffHubIndex,
      boarding,
      alighting: [],
      etaMin: now + Math.ceil(t),
      loadAfter: load,
      polyline,
      legPath,
    });

    cap -= boarding.length;
    cur = { ...best.position };
    candidates.splice(bestIdx, 1);
  }

  // ── Phase 2: Drop-off legs ──
  // Collect unique drop-off hub indices from the picked-up stops
  const pickups = plan.filter((p) => p.kind === "pickup");
  if (dropOffHubs.length > 0 && pickups.length > 0) {
    const hubIndicesUsed = new Set<number>();
    for (const p of pickups) {
      if (p.hubIndex != null) hubIndicesUsed.add(p.hubIndex);
    }

    // Sort hubs by distance from current position (greedy)
    const hubList = Array.from(hubIndicesUsed).sort((a, b) => {
      return haversine(cur, dropOffHubs[a]) - haversine(cur, dropOffHubs[b]);
    });

    for (const hubIdx of hubList) {
      const hubPos = dropOffHubs[hubIdx];
      const travelMin = travelTime.time(cur, hubPos, now + t);
      const unloadMin = 1;

      let polyline = "";
      let legPath: LatLng[] = [];
      if (config.useGoogleRouting && config.googleApiKey) {
        try {
          const dir = await getDirections(cur, hubPos, config.googleApiKey, true);
          polyline = dir.polyline;
          legPath = dir.decodedPath;
        } catch { /* fallback */ }
      }
      if (legPath.length < 2) legPath = gridPath(cur, hubPos);

      t += travelMin + unloadMin;

      const alighting: number[] = [];
      for (const p of pickups) {
        if (p.hubIndex === hubIdx) alighting.push(...p.boarding);
      }
      load -= alighting.length;

      plan.push({
        kind: "hub",
        position: { ...hubPos },
        stopId: null,
        hubIndex: hubIdx,
        boarding: [],
        alighting,
        etaMin: now + Math.ceil(t),
        loadAfter: load,
        polyline,
        legPath,
      });
      cur = { ...hubPos };
    }
  }

  return plan;
}
