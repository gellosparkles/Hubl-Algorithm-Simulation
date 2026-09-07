/**
 * Simulation engine — advances time, generates riders, clusters stops,
 * assigns bus routes, and tracks state.
 */

import {
  Bus,
  LatLng,
  RiderRequest,
  VirtualStop,
  SimConfig,
  SimState,
  KpiAccumulators,
  DEFAULT_CONFIG,
} from "./types";
import { computeMetrics } from "./metrics";
import { maintainStops, resetStopCounter } from "@/services/stops";
import { planRoute } from "@/services/planner";
import { createTravelTimeProvider } from "@/services/travelTime";
import { haversine } from "@/services/routing";
import { classifyRequest } from "./tripModel";
import { Rng, createRng, randomSeed } from "./rng";

// interpolate along a polyline path by fraction (0..1)
function interpolateAlongPath(path: LatLng[], fraction: number): LatLng {
  if (path.length === 0) return { lat: 0, lng: 0 };
  if (path.length === 1 || fraction <= 0) return path[0];
  if (fraction >= 1) return path[path.length - 1];

  // cumulative distances, in metres — degree deltas are not distances (issue #4)
  const dists: number[] = [0];
  for (let i = 1; i < path.length; i++) {
    dists.push(dists[i - 1] + haversine(path[i - 1], path[i]));
  }
  const totalDist = dists[dists.length - 1];
  if (totalDist === 0) return path[0];

  const targetDist = fraction * totalDist;
  for (let i = 1; i < dists.length; i++) {
    if (dists[i] >= targetDist) {
      const segLen = dists[i] - dists[i - 1];
      const segFrac = segLen > 0 ? (targetDist - dists[i - 1]) / segLen : 0;
      return {
        lat: path[i - 1].lat + (path[i].lat - path[i - 1].lat) * segFrac,
        lng: path[i - 1].lng + (path[i].lng - path[i - 1].lng) * segFrac,
      };
    }
  }
  return path[path.length - 1];
}

function randomInRange(min: number, max: number, rng: Rng): number {
  return min + rng.next() * (max - min);
}

function poissonSample(lambda: number, rng: Rng): number {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng.next();
  } while (p > L);
  return k - 1;
}

// ── LA neighborhoods for more realistic distribution ──
const LA_HOTSPOTS = [
  { lat: 34.0522, lng: -118.2437 }, // Downtown LA
  { lat: 34.0195, lng: -118.4912 }, // Santa Monica
  { lat: 34.0736, lng: -118.3911 }, // Hollywood
  { lat: 34.0259, lng: -118.3965 }, // Beverly Hills
  { lat: 33.9425, lng: -118.4081 }, // LAX area
  { lat: 34.0633, lng: -118.3488 }, // Koreatown
  { lat: 34.1478, lng: -118.1445 }, // Pasadena
  { lat: 34.0195, lng: -118.2837 }, // USC area
];

// Approximate LA coastline polygon — points west/south of this line are ocean
const LA_COASTLINE: LatLng[] = [
  { lat: 34.15, lng: -118.53 },  // north of Malibu (top-left)
  { lat: 34.04, lng: -118.52 },  // Santa Monica Mountains coast
  { lat: 34.01, lng: -118.51 },  // Santa Monica pier
  { lat: 33.96, lng: -118.47 },  // Playa del Rey
  { lat: 33.93, lng: -118.44 },  // El Segundo / LAX coast
  { lat: 33.90, lng: -118.41 },  // Manhattan Beach
  { lat: 33.86, lng: -118.39 },  // Redondo Beach (south edge)
  { lat: 33.86, lng: -118.15 },  // far SE corner (inland)
  { lat: 34.15, lng: -118.15 },  // far NE corner (inland)
];

/** Ray-casting point-in-polygon test */
function isOnLand(pt: LatLng): boolean {
  let inside = false;
  const poly = LA_COASTLINE;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const yi = poly[i].lat, xi = poly[i].lng;
    const yj = poly[j].lat, xj = poly[j].lng;
    if ((yi > pt.lat) !== (yj > pt.lat) &&
        pt.lng < ((xj - xi) * (pt.lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function weightedRandomPoint(config: SimConfig, rng: Rng): { lat: number; lng: number } {
  for (let attempt = 0; attempt < 20; attempt++) {
    let pt: LatLng;
    if (rng.next() < 0.6) {
      const hs = LA_HOTSPOTS[Math.floor(rng.next() * LA_HOTSPOTS.length)];
      pt = {
        lat: hs.lat + (rng.next() - 0.5) * 0.03,
        lng: hs.lng + (rng.next() - 0.5) * 0.03,
      };
    } else {
      pt = {
        lat: randomInRange(config.bounds.latMin, config.bounds.latMax, rng),
        lng: randomInRange(config.bounds.lngMin, config.bounds.lngMax, rng),
      };
    }
    if (isOnLand(pt)) return pt;
  }
  // fallback to a known land point
  return { ...LA_HOTSPOTS[0] };
}

export function createInitialState(config: SimConfig = DEFAULT_CONFIG): SimState {
  resetStopCounter(1);
  resetReqCounter();

  const rng = createRng(config.seed ?? randomSeed());

  const kpi: KpiAccumulators = {
    vehicleKm: 0,
    deadheadKm: 0,
    personMinutes: 0,
    travelMinutes: 0,
    pooledRiderIds: new Set<number>(),
    assignments: 0,
  };

  const buses: Record<number, Bus> = {};
  for (let i = 1; i <= config.numBuses; i++) {
    const pos = weightedRandomPoint(config, rng);
    buses[i] = {
      id: i,
      position: pos,
      capacity: config.busCapacity,
      speed: config.busSpeed,
      plan: [],
      legIndex: 0,
      legStartedAt: 0,
      onboard: [],
      positionHistory: [],
    };
  }

  return {
    time: 0,
    buses,
    requests: {},
    stops: {},
    dropOffHubs: [],
    eventLog: [],
    metrics: {
      busAssignments: 0,
      completed: 0,
      pending: 0,
      pickedUp: 0,
      unserved: 0,
      expired: 0,
      totalRequests: 0,
      totalStops: 0,
      serviceRate: 0,
      poolingRate: 0,
      waitP50Min: null,
      waitP90Min: null,
      inVehicleP50Min: null,
      inVehicleP90Min: null,
      detourRatioMean: null,
      vehicleKm: 0,
      deadheadShare: 0,
      meanOccupancy: 0,
      meanWalkKm: null,
    },
    running: false,
    rngState: rng.state,
    kpi,
    travelTimeProviderDegraded: false,
  };
}

/** Ring-buffer bound on `SimState.eventLog` — keep the most recent N lines. */
export const EVENT_LOG_LIMIT = 500;

let nextReqId = 1;

export function resetReqCounter() {
  nextReqId = 1;
}

export async function simulateStep(
  state: SimState,
  config: SimConfig
): Promise<SimState> {
  const s = structuredClone(state) as SimState;
  const log = s.eventLog;

  // Resume the seeded sequence where the previous step left off. Written back
  // to s.rngState at the end so the next step continues deterministically.
  const rng = createRng(s.rngState);

  // One provider per tick (see the batch-warming note at step 4). Created up
  // front because rider classification at step 2 needs it too.
  const travelTime = createTravelTimeProvider(config);

  // 1. Advance buses along their itineraries; board and alight riders on arrival
  for (const bus of Object.values(s.buses)) {
    if (bus.plan.length === 0) continue;

    // Per-tick KPI accounting: where the bus started, and whether it was empty
    // going in. A tick's distance is booked as deadhead only when the bus is
    // empty at both ends — a leg that began loaded isn't deadhead even if the
    // last rider alights partway through (the sliver of empty km after that
    // alighting is deliberately not split out at minute resolution).
    const posBefore = { lat: bus.position.lat, lng: bus.position.lng };
    const emptyAtStart = bus.onboard.length === 0;

    // Process every itinerary entry whose ETA has now elapsed. Riders board
    // when the bus physically reaches their stop and alight at their own
    // drop-off — not in bulk at route end (issue #4).
    while (bus.legIndex < bus.plan.length && s.time >= bus.plan[bus.legIndex].etaMin) {
      const ps = bus.plan[bus.legIndex];
      bus.position = { ...ps.position };
      for (const rid of ps.boarding) {
        const r = s.requests[rid];
        if (r && r.status === "pending") {
          r.status = "picked_up";
          r.tPickedUp = s.time;
          bus.onboard.push(rid);
        }
      }
      for (const rid of ps.alighting) {
        const r = s.requests[rid];
        if (r && r.status === "picked_up") {
          r.status = "completed";
          r.tDroppedOff = s.time;
        }
        bus.onboard = bus.onboard.filter((id) => id !== rid);
      }
      bus.legStartedAt = ps.etaMin;
      bus.legIndex += 1;
    }

    // Pooling: anyone sharing the cabin with ≥1 other rider this tick.
    if (bus.onboard.length >= 2) {
      for (const rid of bus.onboard) s.kpi.pooledRiderIds.add(rid);
    }

    if (bus.legIndex >= bus.plan.length) {
      // itinerary complete — snap to the final stop and go idle. Any rider still
      // aboard had no hub entry to alight at (e.g. a config with no drop-off
      // hubs, where buses do pickups only) — drop them here rather than leave
      // them stranded in `picked_up` on an idle bus.
      for (const rid of bus.onboard) {
        const r = s.requests[rid];
        if (r && r.status === "picked_up") {
          r.status = "completed";
          r.tDroppedOff = s.time;
        }
      }
      bus.onboard = [];
      bus.plan = [];
      bus.legIndex = 0;
      bus.positionHistory.push({ ...bus.position });
    } else {
      const ps = bus.plan[bus.legIndex];
      const legDuration = ps.etaMin - bus.legStartedAt;
      const legElapsed = s.time - bus.legStartedAt;
      const frac = legDuration > 0 ? Math.min(1, Math.max(0, legElapsed / legDuration)) : 1;
      bus.position = interpolateAlongPath(ps.legPath, frac);
      bus.positionHistory.push({ ...bus.position });
    }

    // cap history length to avoid memory bloat
    if (bus.positionHistory.length > 200) {
      bus.positionHistory = bus.positionHistory.slice(-200);
    }

    // Distance driven this tick — accumulated here so it survives the 200-entry
    // positionHistory cap, unlike a post-hoc sum over that array.
    const moved = haversine(posBefore, bus.position);
    s.kpi.vehicleKm += moved;
    if (emptyAtStart && bus.onboard.length === 0) s.kpi.deadheadKm += moved;
    s.kpi.personMinutes += bus.onboard.length;
    s.kpi.travelMinutes += 1;
  }

  // 2. Generate new rider requests
  const n = poissonSample(config.avgRequestsPerMin, rng);
  for (let i = 0; i < n; i++) {
    const origin = weightedRandomPoint(config, rng);
    const dest = weightedRandomPoint(config, rng);
    const trip = classifyRequest(origin, dest, s.time, s.dropOffHubs, config, travelTime);
    const r: RiderRequest = {
      id: nextReqId++,
      tRequest: s.time,
      origin,
      destination: dest,
      direction: trip.direction,
      hubIndex: trip.hubIndex,
      assignedStop: null,
      assignedBus: null,
      // `unserved` is terminal — never clustered, never pending forever.
      status: trip.direction === "unserved" ? "unserved" : "pending",
      walkDistanceKm: null,
      tAssigned: null,
      tPickedUp: null,
      tDroppedOff: null,
      promisedPickupBy: trip.promisedPickupBy,
      directTimeMin: trip.directTimeMin,
      maxRideTimeMin: trip.maxRideTimeMin,
    };
    s.requests[r.id] = r;
  }

  // 3. Fold pending riders into the persistent grid-snapped stop set. Stops are
  //    keyed by (cell, direction, hub) and live across ticks — no per-tick
  //    re-clustering, no expiry churn (issue #5). A rider's promised-pickup
  //    deadline, not a stop lifetime, is the wait bound now.
  const { updatedRequests, log: stopLog } = maintainStops(s.requests, s.stops, s.time, config);
  for (const line of stopLog) log.push(`t=${s.time}: ${line}`);
  for (const [ridStr, updates] of Object.entries(updatedRequests)) {
    const rid = Number(ridStr);
    if (s.requests[rid]) Object.assign(s.requests[rid], updates);
  }

  // 4. Assign routes to idle buses. Only inbound stops are dispatchable here:
  //    the greedy planner boards riders at the stop, which is wrong for outbound
  //    (they board at the hub). Outbound stops still persist in s.stops for the
  //    Phase 3 direction-aware dispatcher (issue #7).
  let openStops = Object.values(s.stops).filter(
    (st) => st.status === "open" && st.direction === "inbound"
  );
  openStops.sort((a, b) => a.createdAt - b.createdAt);

  // planRoute below calls travelTime.time() synchronously, per leg, as its
  // greedy search discovers each next stop — that can never itself be the
  // batched call a network-backed provider needs (see TravelTimeProvider's
  // interface docstring). So warm the batch cache once per tick, up front,
  // over every point this tick's planning might touch: bus positions, open
  // stops, and drop-off hubs. Skipped for the haversine provider, which has
  // no network round-trip to batch and would just pay an O(n^2) cost here
  // for nothing.
  if (config.useGoogleRouting && config.googleApiKey) {
    const points = [
      ...Object.values(s.buses).filter((b) => b.plan.length === 0).map((b) => b.position),
      ...openStops.map((st) => st.position),
      ...s.dropOffHubs,
    ];
    if (points.length > 0) {
      await travelTime.matrix(points, points, s.time);
    }
  }

  for (const bus of Object.values(s.buses)) {
    if (bus.plan.length > 0 || openStops.length === 0) continue;

    const plan = await planRoute(bus, openStops, s.requests, config, travelTime, s.dropOffHubs, s.time);
    if (plan.length === 0) continue;

    bus.plan = plan;
    bus.legIndex = 0;
    bus.legStartedAt = s.time;
    s.kpi.assignments += 1;

    for (const ps of plan) {
      if (ps.kind !== "pickup" || ps.stopId == null) continue;
      const stop = s.stops[ps.stopId];
      if (stop) {
        stop.status = "assigned";
        stop.assignedBus = bus.id;
      }
      for (const rid of ps.boarding) {
        const r = s.requests[rid];
        if (r && r.status === "pending") {
          r.assignedBus = bus.id;
          r.tAssigned = s.time;
        }
      }
    }

    const routeLabel = plan
      .map((ps) => (ps.kind === "hub" ? `H${(ps.hubIndex ?? 0) + 1}` : ps.stopId))
      .join(",");
    log.push(`t=${s.time}: bus ${bus.id} assigned route [${routeLabel}]`);
    openStops = openStops.filter((st) => st.status === "open");
  }

  if (travelTime.degraded) s.travelTimeProviderDegraded = true;

  // Bound the event log to a ring buffer — it is rescanned nowhere now that
  // busAssignments is a counter, but it still grows once per tick.
  if (log.length > EVENT_LOG_LIMIT) log.splice(0, log.length - EVENT_LOG_LIMIT);

  // 5. Recompute the KPI set from rider timestamps + the per-tick accumulators.
  s.metrics = computeMetrics(s);

  s.rngState = rng.state;
  s.time += 1;
  return s;
}
