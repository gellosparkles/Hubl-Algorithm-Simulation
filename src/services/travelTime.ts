/**
 * Travel-time seam. Everything that needs "how long from a to b" goes through
 * a TravelTimeProvider instead of guessing a speed inline — see plan.md Phase 1.
 */

import { LatLng, SimConfig, SpeedProfile } from "@/engine/types";
import { haversine } from "@/services/routing";

export interface TravelTimeProvider {
  readonly name: "haversine" | "google";
  /** Minutes, a→b, departing at sim-minute `atMin`. */
  time(a: LatLng, b: LatLng, atMin: number): number;
  /** Batched pairwise lookup — prefer this over many time() calls when computing a whole matrix at once. */
  matrix(origins: LatLng[], dests: LatLng[], atMin: number): Promise<number[][]>;
  /** Display geometry only — the dispatcher must never call this for timing. */
  path?(a: LatLng, b: LatLng): Promise<LatLng[]>;
}

/** Speed in km/h at a given sim-minute, per the configured daily peak window. */
export function speedAt(atMin: number, profile: SpeedProfile): number {
  const minuteOfDay = ((atMin % 1440) + 1440) % 1440;
  const inPeak = minuteOfDay >= profile.peakStartMin && minuteOfDay < profile.peakEndMin;
  return inPeak ? profile.peakKmh : profile.offPeakKmh;
}

/**
 * Default provider: haversine distance scaled by a street-network detour
 * factor, divided by a time-of-day speed. Dependency-free — no API key or
 * browser required.
 */
export class HaversineProvider implements TravelTimeProvider {
  readonly name = "haversine" as const;

  constructor(
    private readonly detourFactor: number,
    private readonly speedProfile: SpeedProfile
  ) {}

  time(a: LatLng, b: LatLng, atMin: number): number {
    const distKm = haversine(a, b) * this.detourFactor;
    const speedKmh = speedAt(atMin, this.speedProfile);
    return (distKm / speedKmh) * 60;
  }

  async matrix(origins: LatLng[], dests: LatLng[], atMin: number): Promise<number[][]> {
    return origins.map((o) => dests.map((d) => this.time(o, d, atMin)));
  }
}

export function createTravelTimeProvider(
  config: Pick<SimConfig, "detourFactor" | "speedProfile">
): TravelTimeProvider {
  return new HaversineProvider(config.detourFactor, config.speedProfile);
}
