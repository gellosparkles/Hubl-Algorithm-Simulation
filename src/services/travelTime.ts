/**
 * Travel-time seam. Everything that needs "how long from a to b" goes through
 * a TravelTimeProvider instead of guessing a speed inline — see plan.md Phase 1.
 */

import { LatLng, SimConfig, SpeedProfile } from "@/engine/types";
import { haversine } from "@/services/routing";
import { FetchRouteMatrixClient } from "@/services/googleRouteMatrixClient";

export interface TravelTimeProvider {
  readonly name: "haversine" | "google";
  /**
   * True once this provider's lifetime has included at least one lookup that
   * silently fell back to a different provider (e.g. Google → haversine on a
   * cache miss or API failure). Undefined/absent for a provider that never
   * falls back. Lets a caller like the bench harness report which provider
   * actually answered instead of trusting the static `name`.
   */
  readonly degraded?: boolean;
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

// ── Google computeRouteMatrix provider ──

export type RoutingPreference = "TRAFFIC_AWARE" | "TRAFFIC_AWARE_OPTIMAL";

/** "OK" on success; anything else is treated as a missing element and filled from the fallback. */
export type RouteMatrixStatus = "OK" | "NOT_FOUND" | "ERROR";

export interface RouteMatrixElement {
  originIndex: number;
  destinationIndex: number;
  durationMinutes: number;
  status: RouteMatrixStatus;
}

/**
 * Thin seam over the Google Routes `computeRouteMatrix` network call, so
 * GoogleMatrixProvider can be unit-tested with a mock — no network or API
 * key required. See googleRouteMatrixClient.ts for the real implementation.
 */
export interface RouteMatrixClient {
  computeRouteMatrix(
    origins: LatLng[],
    destinations: LatLng[],
    departureTime: Date,
    routingPreference: RoutingPreference
  ): Promise<RouteMatrixElement[]>;
}

/** Minimal LRU: insertion order in a Map doubles as recency once touched entries are re-inserted. */
class LruCache<V> {
  private readonly map = new Map<string, V>();

  constructor(private readonly maxSize: number) {}

  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    if (this.map.size >= this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, value);
  }
}

function round(n: number, precision: number): number {
  const f = 10 ** precision;
  return Math.round(n * f) / f;
}

interface MatrixChunk {
  originIndices: number[];
  destIndices: number[];
}

/**
 * Splits an origins×destinations cross product into chunks that each stay
 * within `maxElements`, covering every pair exactly once.
 */
export function chunkMatrix(numOrigins: number, numDests: number, maxElements: number): MatrixChunk[] {
  if (numOrigins === 0 || numDests === 0) return [];

  const originChunkSize = Math.max(1, Math.min(numOrigins, maxElements));
  const destChunkSize = Math.max(1, Math.floor(maxElements / originChunkSize));

  const range = (start: number, end: number): number[] => {
    const out: number[] = [];
    for (let i = start; i < end; i++) out.push(i);
    return out;
  };

  const chunks: MatrixChunk[] = [];
  for (let oStart = 0; oStart < numOrigins; oStart += originChunkSize) {
    const originIndices = range(oStart, Math.min(oStart + originChunkSize, numOrigins));
    for (let dStart = 0; dStart < numDests; dStart += destChunkSize) {
      const destIndices = range(dStart, Math.min(dStart + destChunkSize, numDests));
      chunks.push({ originIndices, destIndices });
    }
  }
  return chunks;
}

export interface GoogleMatrixProviderOptions {
  routingPreference?: RoutingPreference;
  /** Overrides the routingPreference-derived element cap (625 / 100) — mainly for tests. */
  maxElementsPerRequest?: number;
  cacheSize?: number;
  cacheBucketMinutes?: number;
  coordPrecision?: number;
}

/**
 * Wraps computeRouteMatrix behind TravelTimeProvider. `matrix()` is the only
 * method that ever talks to `client` — it chunks to the element cap and
 * caches by rounded coordinates + a departure-time bucket so a batch never
 * repeats a lookup. `time()` is synchronous per the interface, so it can only
 * read what `matrix()` already cached; an uncached time() call — and any
 * matrix() chunk the client fails to answer — falls back to `fallback`
 * without throwing. `degraded` flips permanently once that has happened, so
 * a caller (e.g. the bench harness) can report which provider actually
 * answered instead of trusting the static `name`.
 */
export class GoogleMatrixProvider implements TravelTimeProvider {
  readonly name = "google" as const;

  private readonly cache: LruCache<number>;
  private readonly routingPreference: RoutingPreference;
  private readonly maxElementsPerRequest: number;
  private readonly bucketMinutes: number;
  private readonly precision: number;
  private fellBack = false;

  constructor(
    private readonly client: RouteMatrixClient,
    private readonly fallback: TravelTimeProvider,
    options: GoogleMatrixProviderOptions = {}
  ) {
    this.routingPreference = options.routingPreference ?? "TRAFFIC_AWARE";
    this.maxElementsPerRequest =
      options.maxElementsPerRequest ?? (this.routingPreference === "TRAFFIC_AWARE_OPTIMAL" ? 100 : 625);
    this.cache = new LruCache(options.cacheSize ?? 5000);
    this.bucketMinutes = options.cacheBucketMinutes ?? 15;
    this.precision = options.coordPrecision ?? 4;
  }

  /** True once any lookup in this provider's lifetime fell back to haversine. */
  get degraded(): boolean {
    return this.fellBack;
  }

  private cacheKey(a: LatLng, b: LatLng, atMin: number): string {
    const bucket = Math.floor(atMin / this.bucketMinutes);
    return `${round(a.lat, this.precision)},${round(a.lng, this.precision)}|${round(b.lat, this.precision)},${round(b.lng, this.precision)}|${bucket}`;
  }

  time(a: LatLng, b: LatLng, atMin: number): number {
    const cached = this.cache.get(this.cacheKey(a, b, atMin));
    if (cached !== undefined) return cached;
    // Synchronous per the interface — can't make a network call here. An
    // uncached point counts as a fallback, not an error.
    this.fellBack = true;
    return this.fallback.time(a, b, atMin);
  }

  async matrix(origins: LatLng[], dests: LatLng[], atMin: number): Promise<number[][]> {
    const result: number[][] = origins.map(() => new Array(dests.length).fill(0));
    if (origins.length === 0 || dests.length === 0) return result;

    const filled: boolean[][] = origins.map(() => new Array(dests.length).fill(false));
    // Real departure time the API needs, approximated from the sim clock —
    // exact wall-clock mapping doesn't exist in a simulation.
    const departureTime = new Date(Date.now() + Math.max(0, atMin) * 60_000);

    for (const { originIndices, destIndices } of chunkMatrix(origins.length, dests.length, this.maxElementsPerRequest)) {
      const keys = originIndices.map((oi) => destIndices.map((di) => this.cacheKey(origins[oi], dests[di], atMin)));

      const allCached = keys.every((row) => row.every((k) => this.cache.get(k) !== undefined));
      if (allCached) {
        originIndices.forEach((oi, r) => {
          destIndices.forEach((di, c) => {
            result[oi][di] = this.cache.get(keys[r][c])!;
            filled[oi][di] = true;
          });
        });
        continue;
      }

      try {
        const elements = await this.client.computeRouteMatrix(
          originIndices.map((oi) => origins[oi]),
          destIndices.map((di) => dests[di]),
          departureTime,
          this.routingPreference
        );

        for (const el of elements) {
          if (el.status !== "OK") continue;
          const oi = originIndices[el.originIndex];
          const di = destIndices[el.destinationIndex];
          result[oi][di] = el.durationMinutes;
          filled[oi][di] = true;
          this.cache.set(keys[el.originIndex][el.destinationIndex], el.durationMinutes);
        }
      } catch {
        // whole-chunk failure — every element in it gets filled by the fallback below
      }

      originIndices.forEach((oi, r) => {
        destIndices.forEach((di, c) => {
          if (!filled[oi][di]) {
            this.fellBack = true;
            result[oi][di] = this.fallback.time(origins[oi], dests[di], atMin);
            filled[oi][di] = true;
          }
        });
      });
    }

    return result;
  }
}

export function createTravelTimeProvider(
  config: Pick<SimConfig, "detourFactor" | "speedProfile" | "useGoogleRouting" | "googleApiKey">
): TravelTimeProvider {
  const haversineProvider = new HaversineProvider(config.detourFactor, config.speedProfile);
  if (!config.useGoogleRouting || !config.googleApiKey) return haversineProvider;

  const client = new FetchRouteMatrixClient(config.googleApiKey);
  return new GoogleMatrixProvider(client, haversineProvider);
}
