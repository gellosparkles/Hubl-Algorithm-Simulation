/**
 * Real network client for Google's Routes `computeRouteMatrix` endpoint.
 * Kept separate from travelTime.ts so GoogleMatrixProvider can be unit-tested
 * against a mock RouteMatrixClient with no fetch/network involved. Live
 * verification against a real API key is a manual follow-up — see #2.
 */

import { LatLng } from "@/engine/types";
import type { RouteMatrixClient, RouteMatrixElement, RouteMatrixStatus, RoutingPreference } from "@/services/travelTime";

const ENDPOINT = "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix";

interface RawElement {
  originIndex?: number;
  destinationIndex?: number;
  duration?: string; // e.g. "123s"
  status?: { code?: number };
  condition?: string; // "ROUTE_EXISTS" | "ROUTE_NOT_FOUND"
}

export class FetchRouteMatrixClient implements RouteMatrixClient {
  constructor(private readonly apiKey: string) {}

  async computeRouteMatrix(
    origins: LatLng[],
    destinations: LatLng[],
    departureTime: Date,
    routingPreference: RoutingPreference
  ): Promise<RouteMatrixElement[]> {
    const body = {
      origins: origins.map((o) => ({
        waypoint: { location: { latLng: { latitude: o.lat, longitude: o.lng } } },
      })),
      destinations: destinations.map((d) => ({
        waypoint: { location: { latLng: { latitude: d.lat, longitude: d.lng } } },
      })),
      travelMode: "DRIVE",
      routingPreference,
      departureTime: departureTime.toISOString(),
    };

    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": this.apiKey,
        "X-Goog-FieldMask": "originIndex,destinationIndex,duration,status,condition",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`computeRouteMatrix: HTTP ${res.status}`);
    }

    const data = (await res.json()) as RawElement[];
    return data.map((el) => ({
      originIndex: el.originIndex ?? 0,
      destinationIndex: el.destinationIndex ?? 0,
      durationMinutes: parseDurationSeconds(el.duration) / 60,
      status: normalizeStatus(el.status, el.condition),
    }));
  }
}

function parseDurationSeconds(duration: string | undefined): number {
  if (!duration) return 0;
  const match = /^(\d+(?:\.\d+)?)s$/.exec(duration);
  return match ? parseFloat(match[1]) : 0;
}

function normalizeStatus(status: RawElement["status"], condition: string | undefined): RouteMatrixStatus {
  if (condition && condition !== "ROUTE_EXISTS") return "NOT_FOUND";
  if (status?.code) return "ERROR";
  return "OK";
}
