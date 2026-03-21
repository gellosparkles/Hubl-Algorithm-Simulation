/**
 * Stop-clustering module
 * Groups pending rider requests into temporary "virtual stops"
 * when riders are within walking distance of each other.
 */

import { LatLng, RiderRequest, VirtualStop } from "@/engine/types";
import { haversine } from "@/services/routing";

interface ClusterResult {
  newStops: VirtualStop[];
  updatedRequests: Record<number, Partial<RiderRequest>>;
}

let nextStopId = 1;

export function resetStopCounter(start = 1) {
  nextStopId = start;
}

export function clusterRidersIntoStops(
  requests: Record<number, RiderRequest>,
  currentTime: number,
  maxWalkKm: number,
  minGroupSize: number
): ClusterResult {
  const pending = Object.values(requests)
    .filter((r) => r.status === "pending" && r.assignedStop === null)
    .sort((a, b) => a.tRequest - b.tRequest);

  const used = new Set<number>();
  const newStops: VirtualStop[] = [];
  const updatedRequests: Record<number, Partial<RiderRequest>> = {};

  for (const anchor of pending) {
    if (used.has(anchor.id)) continue;

    // find all pending riders within walk radius of anchor
    const group: RiderRequest[] = [];
    for (const r of pending) {
      if (used.has(r.id)) continue;
      if (haversine(anchor.origin, r.origin) <= maxWalkKm) {
        group.push(r);
      }
    }

    if (group.length < minGroupSize) continue;

    // centroid
    const centroid: LatLng = {
      lat: group.reduce((s, r) => s + r.origin.lat, 0) / group.length,
      lng: group.reduce((s, r) => s + r.origin.lng, 0) / group.length,
    };

    const stop: VirtualStop = {
      id: nextStopId++,
      position: centroid,
      riderIds: group.map((r) => r.id),
      createdAt: currentTime,
      assignedBus: null,
      status: "open",
    };
    newStops.push(stop);

    for (const r of group) {
      used.add(r.id);
      const walkDist = haversine(r.origin, centroid);
      updatedRequests[r.id] = {
        assignedStop: stop.id,
        walkDistanceKm: walkDist,
        incentive: Math.min(1.5, 0.5 * walkDist),
      };
    }
  }

  return { newStops, updatedRequests };
}
