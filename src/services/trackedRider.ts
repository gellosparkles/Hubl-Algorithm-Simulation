/**
 * Read-model for the one rider a person injected and is now watching (issue #11).
 *
 * Pure projection over `SimState`: it turns the tracked rider's request, its
 * virtual stop, and its assigned bus's live itinerary into the promise the UI
 * surfaces — assigned stop + walk, promised pickup, assigned bus, live ETA, and
 * estimated drop-off — plus the stop/bus ids the map highlights.
 */

import { SimState, TripDirection } from "@/engine/types";

export interface TrackedRiderView {
  riderId: number;
  direction: TripDirection;
  status: "pending" | "picked_up" | "completed" | "unserved";
  /** Virtual stop the rider was grouped into, once stop formation has run. */
  assignedStopId: number | null;
  walkDistanceKm: number | null;
  /** `tRequest + maxWaitMinutes` — the hard pickup promise. */
  promisedPickupByMin: number;
  assignedBusId: number | null;
  /** Absolute sim-minute the assigned bus reaches the pickup stop (null until routed). */
  pickupEtaMin: number | null;
  /** Absolute sim-minute the assigned bus reaches the drop-off (null until routed). */
  dropoffEtaMin: number | null;
  /** Minutes from `now` until pickup; negative once overdue. Null until routed. */
  minutesToPickup: number | null;
  tPickedUpMin: number | null;
  tDroppedOffMin: number | null;
}

export function trackedRider(state: SimState, riderId: number | null): TrackedRiderView | null {
  if (riderId == null) return null;
  const r = state.requests[riderId];
  if (!r) return null;

  let pickupEtaMin: number | null = null;
  let dropoffEtaMin: number | null = null;
  if (r.assignedBus != null) {
    const bus = state.buses[r.assignedBus];
    if (bus) {
      for (const ps of bus.plan) {
        if (ps.boarding.includes(riderId)) pickupEtaMin = ps.etaMin;
        if (ps.alighting.includes(riderId)) dropoffEtaMin = ps.etaMin;
      }
    }
  }

  const minutesToPickup =
    r.tPickedUp != null ? 0 : pickupEtaMin != null ? pickupEtaMin - state.time : null;

  return {
    riderId,
    direction: r.direction,
    status: r.status,
    assignedStopId: r.assignedStop,
    walkDistanceKm: r.walkDistanceKm,
    promisedPickupByMin: r.promisedPickupBy,
    assignedBusId: r.assignedBus,
    pickupEtaMin,
    dropoffEtaMin,
    minutesToPickup,
    tPickedUpMin: r.tPickedUp,
    tDroppedOffMin: r.tDroppedOff,
  };
}
