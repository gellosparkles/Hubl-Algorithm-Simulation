/**
 * Route-planning module for chained bus stops.
 *
 * Uses greedy nearest-neighbor: picks the closest unvisited open stop
 * that fits within capacity and time budget, repeating until done.
 * After pickups, appends drop-off legs to assigned drop-off hubs.
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
  config: SimConfig,
  dropOffHubs: LatLng[] = []
): Promise<PlanResult> {
  const route: VirtualStop[] = [];
  const etas: number[] = [];
  const polylines: string[] = [];
  const decodedLegs: LatLng[][] = [];

  let cap = bus.capacity - bus.onboard.length;
  let cur = { ...bus.position };
  let t = 0;
  const candidates = [...openStops];

  // ── Phase 1: Pickup stops (greedy nearest-neighbor) ──
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

  // ── Phase 2: Drop-off legs ──
  // Collect unique drop-off hub indices from the picked-up stops
  if (dropOffHubs.length > 0 && route.length > 0) {
    const hubIndicesUsed = new Set<number>();
    for (const stop of route) {
      if (stop.dropOffHubIndex != null) {
        hubIndicesUsed.add(stop.dropOffHubIndex);
      }
    }

    // Sort hubs by distance from current position (greedy)
    const hubList = Array.from(hubIndicesUsed).sort((a, b) => {
      return haversine(cur, dropOffHubs[a]) - haversine(cur, dropOffHubs[b]);
    });

    let dropOffStopIdBase = -1000; // negative IDs for drop-off "stops"
    for (const hubIdx of hubList) {
      const hubPos = dropOffHubs[hubIdx];
      const dist = haversine(cur, hubPos);
      let travelMin = travelTimeMinutes(dist, bus.speed);
      const unloadMin = 1;

      let polyline = "";
      let legPath: LatLng[] = [];
      if (config.useGoogleRouting && config.googleApiKey) {
        try {
          const dir = await getDirections(cur, hubPos, config.googleApiKey, true);
          polyline = dir.polyline;
          legPath = dir.decodedPath;
          if (dir.durationMinutes > 0) travelMin = dir.durationMinutes;
        } catch { /* fallback */ }
      }

      if (legPath.length < 2) {
        const midpoint: LatLng = { lat: cur.lat, lng: hubPos.lng };
        legPath = [{ ...cur }, midpoint, { ...hubPos }];
      }

      t += travelMin + unloadMin;

      // Collect rider IDs being dropped off at this hub
      const dropRiderIds: number[] = [];
      for (const stop of route) {
        if (stop.dropOffHubIndex === hubIdx) {
          for (const rid of stop.riderIds) {
            if (requests[rid]?.status === "pending") {
              dropRiderIds.push(rid);
            }
          }
        }
      }

      const dropOffStop: VirtualStop = {
        id: dropOffStopIdBase--,
        position: hubPos,
        riderIds: dropRiderIds,
        createdAt: 0,
        assignedBus: bus.id,
        status: "dropoff",
        dropOffHubIndex: hubIdx,
        isDropOff: true,
      };

      route.push(dropOffStop);
      etas.push(Math.ceil(t));
      polylines.push(polyline);
      decodedLegs.push(legPath);
      cur = { ...hubPos };
    }
  }

  return { route, etas, polylines, decodedLegs };
}
