/**
 * Routing service – wraps Google Maps APIs with haversine fallback.
 *
 * When a valid API key is present and useGoogleRouting is true, calls:
 *   • Distance Matrix API  → pairwise travel times / distances
 *   • Directions API       → road polylines + ETA
 *
 * Otherwise falls back to haversine + constant speed estimates.
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

export function travelTimeMinutes(distKm: number, speedKmh = 25): number {
  return (distKm / speedKmh) * 60;
}

// ── Google Maps wrappers ──

interface DistanceResult {
  distanceKm: number;
  durationMinutes: number;
}

/**
 * Get distance & duration between two points using Google Distance Matrix API.
 * Falls back to haversine on any failure.
 */
export async function getDistance(
  origin: LatLng,
  dest: LatLng,
  apiKey: string,
  useGoogle: boolean
): Promise<DistanceResult> {
  if (!useGoogle || !apiKey) {
    const d = haversine(origin, dest);
    return { distanceKm: d, durationMinutes: travelTimeMinutes(d) };
  }

  try {
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origin.lat},${origin.lng}&destinations=${dest.lat},${dest.lng}&departure_time=now&traffic_model=best_guess&key=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const el = data.rows?.[0]?.elements?.[0];
    if (el?.status !== "OK") throw new Error(el?.status ?? "NO_RESULT");
    return {
      distanceKm: el.distance.value / 1000,
      durationMinutes: (el.duration_in_traffic?.value ?? el.duration.value) / 60,
    };
  } catch (err) {
    console.warn("Google Distance Matrix failed, falling back to haversine:", err);
    const d = haversine(origin, dest);
    return { distanceKm: d, durationMinutes: travelTimeMinutes(d) };
  }
}

interface DirectionsResult {
  durationMinutes: number;
  distanceKm: number;
  polyline: string; // encoded polyline
}

/**
 * Get road-following directions between two points.
 * Falls back to straight line on failure.
 */
export async function getDirections(
  origin: LatLng,
  dest: LatLng,
  apiKey: string,
  useGoogle: boolean
): Promise<DirectionsResult> {
  if (!useGoogle || !apiKey) {
    const d = haversine(origin, dest);
    return { durationMinutes: travelTimeMinutes(d), distanceKm: d, polyline: "" };
  }

  try {
    const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin.lat},${origin.lng}&destination=${dest.lat},${dest.lng}&departure_time=now&traffic_model=best_guess&key=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.status !== "OK") throw new Error(data.status);
    const leg = data.routes[0].legs[0];
    return {
      durationMinutes: (leg.duration_in_traffic?.value ?? leg.duration.value) / 60,
      distanceKm: leg.distance.value / 1000,
      polyline: data.routes[0].overview_polyline.points,
    };
  } catch (err) {
    console.warn("Google Directions failed, falling back:", err);
    const d = haversine(origin, dest);
    return { durationMinutes: travelTimeMinutes(d), distanceKm: d, polyline: "" };
  }
}

/**
 * Batch distance matrix: returns a 2D array of durations in minutes.
 * origins[i] → destinations[j] = result[i][j]
 */
export async function getDistanceMatrix(
  origins: LatLng[],
  destinations: LatLng[],
  apiKey: string,
  useGoogle: boolean
): Promise<number[][]> {
  if (!useGoogle || !apiKey || origins.length === 0 || destinations.length === 0) {
    return origins.map((o) =>
      destinations.map((d) => travelTimeMinutes(haversine(o, d)))
    );
  }

  try {
    const oStr = origins.map((p) => `${p.lat},${p.lng}`).join("|");
    const dStr = destinations.map((p) => `${p.lat},${p.lng}`).join("|");
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${oStr}&destinations=${dStr}&departure_time=now&traffic_model=best_guess&key=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.rows.map((row: any) =>
      row.elements.map((el: any) =>
        el.status === "OK"
          ? (el.duration_in_traffic?.value ?? el.duration.value) / 60
          : travelTimeMinutes(haversine(origins[0], destinations[0]))
      )
    );
  } catch (err) {
    console.warn("Google Distance Matrix batch failed:", err);
    return origins.map((o) =>
      destinations.map((d) => travelTimeMinutes(haversine(o, d)))
    );
  }
}
