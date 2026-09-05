/**
 * Trip classification — the fix for "destination is generated, stored, and
 * never read". Every request is anchored to its nearest hub from its *actual*
 * origin and destination and labelled inbound / outbound / unserved. See
 * plan.md Phase 2a.
 */

import { LatLng, SimConfig, TripDirection } from "./types";
import { haversine } from "@/services/routing";
import { TravelTimeProvider } from "@/services/travelTime";

export interface TripClassification {
  direction: TripDirection;
  hubIndex: number | null;
  directTimeMin: number;
  maxRideTimeMin: number;
  promisedPickupBy: number;
}

/**
 * The one hub this trip is anchored to: the hub closest to *either* endpoint.
 * Both `dOrigin` and `dDest` in the classifier are then measured against this
 * same hub (plan.md Phase 2a: "dOrigin = dist(origin, nearestHub), dDest =
 * dist(destination, nearestHub)").
 */
function anchorHub(
  origin: LatLng,
  destination: LatLng,
  hubs: LatLng[]
): { index: number; dOrigin: number; dDest: number } | null {
  if (hubs.length === 0) return null;
  let best = { index: 0, dOrigin: Infinity, dDest: Infinity, near: Infinity };
  for (let i = 0; i < hubs.length; i++) {
    const dOrigin = haversine(origin, hubs[i]);
    const dDest = haversine(destination, hubs[i]);
    const near = Math.min(dOrigin, dDest);
    if (near < best.near) best = { index: i, dOrigin, dDest, near };
  }
  return { index: best.index, dOrigin: best.dOrigin, dDest: best.dDest };
}

/**
 * Classify one request against the hub set.
 *
 *  - **inbound**  when the destination is within `hubCatchmentKm` of a hub and
 *    closer to that hub than the origin is — collect near the origin, deliver
 *    to the hub.
 *  - **outbound** when the mirror holds for the origin — board at the hub,
 *    alight near the destination.
 *  - **unserved** otherwise (including when there are no hubs).
 *
 * `directTimeMin` / `maxRideTimeMin` come from the travel-time provider, not an
 * ad-hoc speed constant.
 */
export function classifyRequest(
  origin: LatLng,
  destination: LatLng,
  tRequest: number,
  hubs: LatLng[],
  config: Pick<SimConfig, "hubCatchmentKm" | "rideTimeFactor" | "rideTimeSlackMin" | "maxWaitMinutes">,
  travelTime: TravelTimeProvider
): TripClassification {
  const directTimeMin = travelTime.time(origin, destination, tRequest);
  const maxRideTimeMin = directTimeMin * config.rideTimeFactor + config.rideTimeSlackMin;
  const promisedPickupBy = tRequest + config.maxWaitMinutes;

  const hub = anchorHub(origin, destination, hubs);

  let direction: TripDirection = "unserved";
  let hubIndex: number | null = null;

  if (hub) {
    if (hub.dDest <= config.hubCatchmentKm && hub.dDest < hub.dOrigin) {
      direction = "inbound";
      hubIndex = hub.index;
    } else if (hub.dOrigin <= config.hubCatchmentKm && hub.dOrigin < hub.dDest) {
      direction = "outbound";
      hubIndex = hub.index;
    }
  }

  return { direction, hubIndex, directTimeMin, maxRideTimeMin, promisedPickupBy };
}
