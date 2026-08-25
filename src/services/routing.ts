/**
 * Routing service – wraps Google Maps APIs with haversine fallback.
 *
 * Uses the Maps JavaScript API DirectionsService (works client-side, no CORS issues)
 * instead of the REST Directions API. Falls back to haversine when unavailable.
 */

import { LatLng } from "@/engine/types";

// ── Haversine fallback ──

export function haversine(a: LatLng, b: LatLng): number {
  const R = 6371;
  const dLat = deg2rad(b.lat - a.lat);
  const dLng = deg2rad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h =
    sinLat * sinLat +
    Math.cos(deg2rad(a.lat)) * Math.cos(deg2rad(b.lat)) * sinLng * sinLng;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function deg2rad(d: number) {
  return (d * Math.PI) / 180;
}

// Geometry-only fallback speed for getDirections() below when Google is
// unavailable — display purposes only. The dispatcher's travel-time
// estimates come from TravelTimeProvider (src/services/travelTime.ts), never
// from this default.
const DISPLAY_FALLBACK_SPEED_KMH = 32;

export function travelTimeMinutes(distKm: number, speedKmh: number = DISPLAY_FALLBACK_SPEED_KMH): number {
  return (distKm / speedKmh) * 60;
}

// ── Singleton DirectionsService (reused across calls) ──

let directionsService: google.maps.DirectionsService | null = null;

function getDirectionsService(): google.maps.DirectionsService | null {
  if (typeof google === "undefined" || !google.maps) return null;
  if (!directionsService) {
    directionsService = new google.maps.DirectionsService();
  }
  return directionsService;
}

// ── Google Maps JS API wrappers ──

interface DirectionsResult {
  durationMinutes: number;
  distanceKm: number;
  polyline: string; // encoded polyline
  decodedPath: LatLng[]; // decoded road points
}

/**
 * Get road-following directions using the Maps JS API DirectionsService.
 * Falls back to haversine on failure or when API unavailable.
 */
export async function getDirections(
  origin: LatLng,
  dest: LatLng,
  _apiKey: string,
  useGoogle: boolean
): Promise<DirectionsResult> {
  const fallback = (): DirectionsResult => {
    const d = haversine(origin, dest);
    return { durationMinutes: travelTimeMinutes(d), distanceKm: d, polyline: "", decodedPath: [] };
  };

  if (!useGoogle) return fallback();

  const svc = getDirectionsService();
  if (!svc) return fallback();

  try {
    const result = await new Promise<google.maps.DirectionsResult>((resolve, reject) => {
      svc.route(
        {
          origin: { lat: origin.lat, lng: origin.lng },
          destination: { lat: dest.lat, lng: dest.lng },
          travelMode: google.maps.TravelMode.DRIVING,
          drivingOptions: {
            departureTime: new Date(),
            trafficModel: google.maps.TrafficModel.BEST_GUESS,
          },
        },
        (res, status) => {
          if (status === google.maps.DirectionsStatus.OK && res) {
            resolve(res);
          } else {
            reject(new Error(`DirectionsService: ${status}`));
          }
        }
      );
    });

    const leg = result.routes[0].legs[0];
    const encodedPolyline = result.routes[0].overview_polyline;
    const path = result.routes[0].overview_path;

    return {
      durationMinutes: (leg.duration_in_traffic?.value ?? leg.duration?.value ?? 0) / 60,
      distanceKm: (leg.distance?.value ?? 0) / 1000,
      polyline: typeof encodedPolyline === "string" ? encodedPolyline : "",
      decodedPath: path
        ? path.map((p) => ({ lat: p.lat(), lng: p.lng() }))
        : [],
    };
  } catch (err) {
    console.warn("DirectionsService failed, falling back to haversine:", err);
    return fallback();
  }
}

