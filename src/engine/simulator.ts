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
  SimMetrics,
  DEFAULT_CONFIG,
} from "./types";
import { clusterRidersIntoStops, resetStopCounter } from "@/services/clustering";
import { planRoute } from "@/services/planner";

// decode Google encoded polyline into coordinate array
function decodePolyline(encoded: string): LatLng[] {
  const points: LatLng[] = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let b, shift = 0, result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
}

// interpolate along a polyline path by fraction (0..1)
function interpolateAlongPath(path: LatLng[], fraction: number): LatLng {
  if (path.length === 0) return { lat: 0, lng: 0 };
  if (path.length === 1 || fraction <= 0) return path[0];
  if (fraction >= 1) return path[path.length - 1];

  // compute cumulative distances
  const dists: number[] = [0];
  for (let i = 1; i < path.length; i++) {
    const dlat = path[i].lat - path[i - 1].lat;
    const dlng = path[i].lng - path[i - 1].lng;
    dists.push(dists[i - 1] + Math.sqrt(dlat * dlat + dlng * dlng));
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

function randomInRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function poissonSample(lambda: number): number {
  let L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= Math.random();
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

function weightedRandomPoint(config: SimConfig): { lat: number; lng: number } {
  // 60% chance near a hotspot, 40% uniform
  if (Math.random() < 0.6) {
    const hs = LA_HOTSPOTS[Math.floor(Math.random() * LA_HOTSPOTS.length)];
    return {
      lat: hs.lat + (Math.random() - 0.5) * 0.03,
      lng: hs.lng + (Math.random() - 0.5) * 0.03,
    };
  }
  return {
    lat: randomInRange(config.bounds.latMin, config.bounds.latMax),
    lng: randomInRange(config.bounds.lngMin, config.bounds.lngMax),
  };
}

export function createInitialState(config: SimConfig = DEFAULT_CONFIG): SimState {
  resetStopCounter(1);

  const buses: Record<number, Bus> = {};
  for (let i = 1; i <= config.numBuses; i++) {
    const pos = weightedRandomPoint(config);
    buses[i] = {
      id: i,
      position: pos,
      routeStartPosition: pos,
      capacity: config.busCapacity,
      speed: config.busSpeed,
      available: true,
      route: [],
      routeEtas: [],
      routePolylines: [],
      decodedLegs: [],
      onboard: [],
      busyUntil: 0,
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
    metrics: { busAssignments: 0, completed: 0, pending: 0, pickedUp: 0, totalRequests: 0, totalStops: 0 },
    running: false,
  };
}

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

  // 1. Advance bus positions along their routes & complete finished routes
  for (const bus of Object.values(s.buses)) {
    if (!bus.available && bus.busyUntil <= s.time) {
      // route complete — snap to last stop position
      const lastStopId = bus.route[bus.route.length - 1];
      if (lastStopId != null && s.stops[lastStopId]) {
        bus.position = { ...s.stops[lastStopId].position };
      }
      bus.positionHistory.push({ ...bus.position });
      // Mark riders whose drop-off stop was reached as completed
      for (const rid of bus.onboard) {
        if (s.requests[rid]) s.requests[rid].status = "completed";
      }
      bus.onboard = [];
      bus.available = true;
      bus.route = [];
      bus.routeEtas = [];
      bus.routePolylines = [];
      bus.decodedLegs = [];
    } else if (!bus.available && bus.route.length > 0) {
      // interpolate position along route based on elapsed time
      const routeStart = bus.busyUntil - (bus.routeEtas[bus.routeEtas.length - 1] || 0) - 5;
      const elapsed = s.time - routeStart;

      // find which leg we're on
      let legIdx = 0;
      for (let i = 0; i < bus.routeEtas.length; i++) {
        if (elapsed < bus.routeEtas[i]) {
          legIdx = i;
          break;
        }
        legIdx = i;
      }

      const prevEta = legIdx > 0 ? bus.routeEtas[legIdx - 1] : 0;
      const legDuration = bus.routeEtas[legIdx] - prevEta;
      const legElapsed = elapsed - prevEta;
      const frac = legDuration > 0 ? Math.min(1, Math.max(0, legElapsed / legDuration)) : 1;

      // Use decoded polyline points if available for this leg
      if (bus.decodedLegs[legIdx] && bus.decodedLegs[legIdx].length > 1) {
        bus.position = interpolateAlongPath(bus.decodedLegs[legIdx], frac);
      } else {
        // fallback straight-line lerp
        const targetStopId = bus.route[legIdx];
        const targetStop = s.stops[targetStopId];
        if (targetStop) {
          const from = legIdx === 0
            ? bus.routeStartPosition
            : (s.stops[bus.route[legIdx - 1]]?.position ?? bus.routeStartPosition);
          bus.position = {
            lat: from.lat + (targetStop.position.lat - from.lat) * frac,
            lng: from.lng + (targetStop.position.lng - from.lng) * frac,
          };
        }
      }

      // record trail
      bus.positionHistory.push({ ...bus.position });
      // cap history length to avoid memory bloat
      if (bus.positionHistory.length > 200) {
        bus.positionHistory = bus.positionHistory.slice(-200);
      }
    }
  }

  // 2. Generate new rider requests
  const n = poissonSample(config.avgRequestsPerMin);
  for (let i = 0; i < n; i++) {
    const origin = weightedRandomPoint(config);
    const dest = weightedRandomPoint(config);
    const r: RiderRequest = {
      id: nextReqId++,
      tRequest: s.time,
      origin,
      destination: dest,
      assignedStop: null,
      assignedBus: null,
      status: "pending",
      walkDistanceKm: null,
      incentive: 0,
    };
    s.requests[r.id] = r;
  }

  // 3. Cluster pending riders into virtual stops
  const { newStops, updatedRequests } = clusterRidersIntoStops(
    s.requests,
    s.time,
    config.maxWalkKm,
    config.minGroupSize
  );
  for (const stop of newStops) {
    // Randomly assign a drop-off hub if hubs exist
    if (s.dropOffHubs.length > 0) {
      stop.dropOffHubIndex = Math.floor(Math.random() * s.dropOffHubs.length);
    }
    s.stops[stop.id] = stop;
    log.push(`t=${s.time}: formed stop ${stop.id} with ${stop.riderIds.length} riders${stop.dropOffHubIndex != null ? ` → hub ${stop.dropOffHubIndex + 1}` : ""}`);
  }
  for (const [ridStr, updates] of Object.entries(updatedRequests)) {
    const rid = Number(ridStr);
    if (s.requests[rid]) Object.assign(s.requests[rid], updates);
  }

  // 3b. Expire open stops that exceeded max wait time
  for (const stop of Object.values(s.stops)) {
    if (stop.status === "open" && (s.time - stop.createdAt) >= config.maxWaitMinutes) {
      // mark riders back to pending (unassigned) so they can be re-clustered, then remove stop
      for (const rid of stop.riderIds) {
        if (s.requests[rid]) {
          s.requests[rid].assignedStop = null;
          s.requests[rid].status = "pending";
        }
      }
      log.push(`t=${s.time}: stop ${stop.id} expired (waited ${config.maxWaitMinutes} min)`);
      delete s.stops[stop.id];
    }
  }

  // 4. Assign routes to available buses
  let openStops = Object.values(s.stops).filter((st) => st.status === "open");
  openStops.sort((a, b) => a.createdAt - b.createdAt);

  for (const bus of Object.values(s.buses)) {
    if (!bus.available || openStops.length === 0) continue;

    const { route, etas, polylines, decodedLegs } = await planRoute(bus, openStops, s.requests, config, s.dropOffHubs);
    if (route.length === 0) continue;

    bus.routeStartPosition = { ...bus.position };
    bus.available = false;
    bus.route = route.map((st) => st.id);
    bus.routeEtas = etas;
    bus.routePolylines = polylines;
    bus.decodedLegs = decodedLegs;
    bus.busyUntil = s.time + etas[etas.length - 1] + 5;

    for (const st of route) {
      if (st.isDropOff) {
        // Register drop-off stop in state
        s.stops[st.id] = st;
      } else {
        s.stops[st.id].status = "assigned";
        s.stops[st.id].assignedBus = bus.id;
        for (const rid of st.riderIds) {
          if (s.requests[rid] && s.requests[rid].status === "pending") {
            s.requests[rid].status = "picked_up";
            s.requests[rid].assignedBus = bus.id;
            bus.onboard.push(rid);
          }
        }
      }
    }

    log.push(`t=${s.time}: bus ${bus.id} assigned route [${bus.route.join(",")}]`);
    openStops = openStops.filter((st) => st.status === "open");
  }

  // 5. Update metrics
  const reqs = Object.values(s.requests);
  s.metrics = {
    busAssignments: log.filter((l) => l.includes("assigned route")).length,
    completed: reqs.filter((r) => r.status === "completed").length,
    pending: reqs.filter((r) => r.status === "pending").length,
    pickedUp: reqs.filter((r) => r.status === "picked_up").length,
    totalRequests: reqs.length,
    totalStops: Object.keys(s.stops).length,
  };

  s.time += 1;
  return s;
}
