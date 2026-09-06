/**
 * Persistent grid-snapped virtual stops (issue #5, plan.md Phase 2b).
 *
 * Replaces the old per-tick centroid clustering, which re-derived every stop
 * from scratch across all pending riders (quadratic at ~300 pending) and
 * churned: an unassigned stop expired at the max-wait mark, its riders dropped
 * back to pending, and the identical group re-formed next tick under a fresh id.
 *
 * Here a stop is keyed by `(gridCellId, direction, hubIndex)` and lives across
 * ticks. A rider arriving three ticks later in the same cell joins the existing
 * stop. Pending riders are bucketed by that key once per tick, so maintenance is
 * linear in the pending count, not quadratic.
 */

import { LatLng, RiderRequest, SimConfig, TripDirection, VirtualStop } from "@/engine/types";
import { haversine } from "@/services/routing";

/** Grid cell edge length — ~150 m per plan.md Phase 2b. */
const CELL_KM = 0.15;
const KM_PER_DEG_LAT = 110.574;
/**
 * Longitude km-per-degree at a fixed reference latitude (LA basin center). Using
 * a constant rather than each point's own latitude keeps every cell the same
 * width and the snapping fully deterministic.
 */
const REF_LAT = 34.02;
const KM_PER_DEG_LNG = 111.32 * Math.cos((REF_LAT * Math.PI) / 180);

let nextStopId = 1;

export function resetStopCounter(start = 1) {
  nextStopId = start;
}

/** Deterministic id of the ~150 m grid cell containing `p`. */
export function gridCellId(p: LatLng): string {
  const latIdx = Math.floor((p.lat * KM_PER_DEG_LAT) / CELL_KM);
  const lngIdx = Math.floor((p.lng * KM_PER_DEG_LNG) / CELL_KM);
  return `${latIdx}:${lngIdx}`;
}

/** Composite id shared by every rider who forms one stop: same cell, same trip direction, same hub. */
function groupKeyOf(cellId: string, direction: TripDirection, hubIndex: number): string {
  return `${cellId}|${direction}|${hubIndex}`;
}

/** The endpoint a rider walks to their virtual stop from: origin inbound, destination outbound. */
function walkEndpoint(r: RiderRequest): LatLng {
  return r.direction === "outbound" ? r.destination : r.origin;
}

function centroid(points: LatLng[]): LatLng {
  return {
    lat: points.reduce((s, p) => s + p.lat, 0) / points.length,
    lng: points.reduce((s, p) => s + p.lng, 0) / points.length,
  };
}

export interface StopMaintenanceResult {
  /** Per-rider field patches the caller applies to `state.requests`. */
  updatedRequests: Record<number, Partial<RiderRequest>>;
  log: string[];
}

/**
 * Fold this tick's unassigned pending riders into the persistent stop set,
 * mutating `stops` in place. Returns the rider patches to apply and human log
 * lines (without the `t=` prefix — the caller adds it).
 */
export function maintainStops(
  requests: Record<number, RiderRequest>,
  stops: Record<number, VirtualStop>,
  currentTime: number,
  config: Pick<SimConfig, "maxWalkKm" | "minGroupSize">
): StopMaintenanceResult {
  const updatedRequests: Record<number, Partial<RiderRequest>> = {};
  const log: string[] = [];

  // 1. Drop members that have completed or been detached; retire empty stops
  //    (of any status — an assigned stop whose riders have all been delivered
  //    would otherwise leak forever).
  for (const stop of Object.values(stops)) {
    stop.riderIds = stop.riderIds.filter((rid) => {
      const r = requests[rid];
      return (
        r &&
        r.assignedStop === stop.id &&
        r.status !== "completed" &&
        r.status !== "unserved"
      );
    });
    if (stop.riderIds.length === 0) delete stops[stop.id];
  }

  // 2. Index still-open stops by their key.
  const openByKey = new Map<string, VirtualStop>();
  for (const stop of Object.values(stops)) {
    if (stop.status === "open") openByKey.set(stop.groupKey, stop);
  }

  // 3. Bucket unassigned pending riders by the same key — one linear pass over
  //    the request map, no pairwise distance work.
  const buckets = new Map<string, RiderRequest[]>();
  for (const r of Object.values(requests)) {
    if (r.status !== "pending" || r.assignedStop !== null) continue;
    if (r.hubIndex === null || r.direction === "unserved") continue;
    const key = groupKeyOf(gridCellId(walkEndpoint(r)), r.direction, r.hubIndex);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(r);
    else buckets.set(key, [r]);
  }

  // 4. Join riders to their existing stop, or form a new one.
  for (const [key, riders] of buckets) {
    let stop = openByKey.get(key);
    const forming = !stop;

    if (!stop) {
      // `minGroupSize` is a soft floor now, not a permanent gate: a lone rider
      // is servable at the default of 1, and a larger value just defers stop
      // formation until enough riders share the cell.
      if (riders.length < config.minGroupSize) continue;
      const first = riders[0];
      stop = {
        id: nextStopId++,
        groupKey: key,
        direction: first.direction,
        position: walkEndpoint(first),
        riderIds: [],
        createdAt: currentTime,
        assignedBus: null,
        status: "open",
        dropOffHubIndex: first.hubIndex,
      };
      stops[stop.id] = stop;
      openByKey.set(key, stop);
    }

    // Representative point = centroid of the members. Existing members are
    // already inside `maxWalkKm` (checked when they joined) and stay in; new
    // riders are admitted only if they end up within `maxWalkKm` of the *final*
    // position. Since the centroid moves as riders drop out, iterate to a fixed
    // point — a whole cell spans ~210 m corner to corner, so this converges in
    // one pass at the default 0.5 km and a rejection is essentially unreachable.
    const existing = stop.riderIds.map((rid) => walkEndpoint(requests[rid]));
    let admitted = [...riders];
    let pos = centroid([...existing, ...admitted.map(walkEndpoint)]);
    for (;;) {
      const kept = admitted.filter((r) => haversine(walkEndpoint(r), pos) <= config.maxWalkKm);
      if (kept.length === admitted.length) break;
      admitted = kept;
      if (admitted.length === 0) break;
      pos = centroid([...existing, ...admitted.map(walkEndpoint)]);
    }

    const rejected = riders.filter((r) => !admitted.includes(r));
    for (const r of rejected) {
      log.push(`rider ${r.id} too far from stop ${stop.id} centroid — still pending`);
    }

    if (admitted.length === 0) {
      if (stop.riderIds.length === 0) {
        delete stops[stop.id];
        openByKey.delete(key);
      }
      continue;
    }

    stop.riderIds.push(...admitted.map((r) => r.id));
    stop.position = pos;

    // Re-record walk distance for every member — a join shifts the centroid, so
    // existing members' distances change too.
    for (const rid of stop.riderIds) {
      updatedRequests[rid] = {
        assignedStop: stop.id,
        walkDistanceKm: haversine(walkEndpoint(requests[rid]), stop.position),
      };
    }

    if (forming) {
      log.push(
        `formed stop ${stop.id} (${stop.direction}) with ${admitted.length} rider${
          admitted.length === 1 ? "" : "s"
        }${stop.dropOffHubIndex != null ? ` → hub ${stop.dropOffHubIndex + 1}` : ""}`
      );
    } else {
      log.push(`stop ${stop.id} +${admitted.length} (now ${stop.riderIds.length})`);
    }
  }

  return { updatedRequests, log };
}
