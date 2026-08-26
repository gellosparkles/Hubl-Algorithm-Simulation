import { describe, it, expect } from "vitest";
import {
  HaversineProvider,
  GoogleMatrixProvider,
  chunkMatrix,
  createTravelTimeProvider,
  speedAt,
  RouteMatrixClient,
  RouteMatrixElement,
  RoutingPreference,
} from "./travelTime";
import { LatLng, SpeedProfile } from "@/engine/types";

const A = { lat: 34.0522, lng: -118.2437 }; // Downtown LA
const B = { lat: 34.0195, lng: -118.4912 }; // Santa Monica
const C = { lat: 34.1478, lng: -118.1445 }; // Pasadena

const PROFILE: SpeedProfile = { offPeakKmh: 32, peakKmh: 18, peakStartMin: 420, peakEndMin: 600 };

describe("speedAt", () => {
  it("returns off-peak speed outside the peak window", () => {
    expect(speedAt(0, PROFILE)).toBe(32);
    expect(speedAt(419, PROFILE)).toBe(32);
    expect(speedAt(600, PROFILE)).toBe(32);
  });

  it("returns peak speed inside the peak window", () => {
    expect(speedAt(420, PROFILE)).toBe(18);
    expect(speedAt(599, PROFILE)).toBe(18);
  });

  it("wraps minute-of-day for sim runs longer than a day", () => {
    expect(speedAt(1440 + 420, PROFILE)).toBe(18);
    expect(speedAt(2880, PROFILE)).toBe(32);
  });
});

describe("HaversineProvider", () => {
  it("needs no API key or browser to compute a time", () => {
    const provider = new HaversineProvider(1.35, PROFILE);
    const minutes = provider.time(A, B, 0);
    expect(minutes).toBeGreaterThan(0);
    expect(Number.isFinite(minutes)).toBe(true);
  });

  it("scales linearly with the detour factor", () => {
    const base = new HaversineProvider(1, PROFILE).time(A, B, 0);
    const detoured = new HaversineProvider(1.35, PROFILE).time(A, B, 0);
    expect(detoured).toBeCloseTo(base * 1.35, 5);
  });

  it("is slower during the peak window than off-peak, for the same trip", () => {
    const provider = new HaversineProvider(1.35, PROFILE);
    const offPeak = provider.time(A, B, 0);
    const peak = provider.time(A, B, 420);
    expect(peak).toBeGreaterThan(offPeak);
  });

  it("returns zero for a trip with no distance", () => {
    const provider = new HaversineProvider(1.35, PROFILE);
    expect(provider.time(A, A, 0)).toBe(0);
  });

  it("produces a matrix shaped by origins x destinations, matching pairwise time()", async () => {
    const provider = new HaversineProvider(1.35, PROFILE);
    const matrix = await provider.matrix([A, B], [A, B], 0);
    expect(matrix).toHaveLength(2);
    expect(matrix[0]).toHaveLength(2);
    expect(matrix[0][1]).toBeCloseTo(provider.time(A, B, 0), 10);
    expect(matrix[1][0]).toBeCloseTo(provider.time(B, A, 0), 10);
  });

  it("never exposes a path() lookup — the dispatcher must not call one", () => {
    const provider = new HaversineProvider(1.35, PROFILE);
    expect(provider.path).toBeUndefined();
  });
});

describe("createTravelTimeProvider", () => {
  it("builds a haversine provider from SimConfig-shaped input", () => {
    const provider = createTravelTimeProvider({
      detourFactor: 1.35,
      speedProfile: PROFILE,
      useGoogleRouting: false,
      googleApiKey: "",
    });
    expect(provider.name).toBe("haversine");
    expect(provider.time(A, B, 0)).toBeGreaterThan(0);
  });

  it("builds a haversine provider when useGoogleRouting is on but no key is set", () => {
    const provider = createTravelTimeProvider({
      detourFactor: 1.35,
      speedProfile: PROFILE,
      useGoogleRouting: true,
      googleApiKey: "",
    });
    expect(provider.name).toBe("haversine");
  });

  it("builds a GoogleMatrixProvider when useGoogleRouting and an API key are both set", () => {
    const provider = createTravelTimeProvider({
      detourFactor: 1.35,
      speedProfile: PROFILE,
      useGoogleRouting: true,
      googleApiKey: "test-key",
    });
    expect(provider.name).toBe("google");
  });
});

// ── GoogleMatrixProvider ──

class MockRouteMatrixClient implements RouteMatrixClient {
  calls: Array<{ origins: LatLng[]; destinations: LatLng[]; routingPreference: RoutingPreference }> = [];

  constructor(
    private readonly respond: (origins: LatLng[], destinations: LatLng[]) => RouteMatrixElement[],
    private readonly shouldThrow = false
  ) {}

  async computeRouteMatrix(
    origins: LatLng[],
    destinations: LatLng[],
    _departureTime: Date,
    routingPreference: RoutingPreference
  ): Promise<RouteMatrixElement[]> {
    this.calls.push({ origins, destinations, routingPreference });
    if (this.shouldThrow) throw new Error("network failure");
    return this.respond(origins, destinations);
  }
}

// Duration keyed by point identity (not by in-request index), so a chunked
// request — whose local indices don't match the global matrix position —
// still stitches back into the same values as an unchunked call would give.
const POINT_TAG = new Map<LatLng, number>([[A, 1], [B, 2], [C, 3]]);
function tagOf(p: LatLng): number {
  return POINT_TAG.get(p) ?? 0;
}

/** Every element OK, duration = tag(origin) * 10 + tag(dest) minutes. */
function okResponder(origins: LatLng[], destinations: LatLng[]): RouteMatrixElement[] {
  const elements: RouteMatrixElement[] = [];
  origins.forEach((o, oi) => {
    destinations.forEach((d, di) => {
      elements.push({ originIndex: oi, destinationIndex: di, durationMinutes: tagOf(o) * 10 + tagOf(d), status: "OK" });
    });
  });
  return elements;
}

describe("chunkMatrix", () => {
  it("returns a single chunk covering the whole cross product when under the cap", () => {
    const chunks = chunkMatrix(3, 3, 625);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].originIndices).toEqual([0, 1, 2]);
    expect(chunks[0].destIndices).toEqual([0, 1, 2]);
  });

  it("splits into multiple chunks that each stay within the element cap", () => {
    const chunks = chunkMatrix(3, 3, 4);
    for (const c of chunks) {
      expect(c.originIndices.length * c.destIndices.length).toBeLessThanOrEqual(4);
    }
    // every pair covered exactly once
    const covered = new Set<string>();
    for (const c of chunks) {
      for (const oi of c.originIndices) {
        for (const di of c.destIndices) covered.add(`${oi},${di}`);
      }
    }
    expect(covered.size).toBe(9);
  });

  it("returns no chunks when either dimension is empty", () => {
    expect(chunkMatrix(0, 5, 625)).toEqual([]);
    expect(chunkMatrix(5, 0, 625)).toEqual([]);
  });
});

describe("GoogleMatrixProvider", () => {
  const fallback = new HaversineProvider(1.35, PROFILE);

  it("reports its name as google and starts undegraded", () => {
    const client = new MockRouteMatrixClient(okResponder);
    const provider = new GoogleMatrixProvider(client, fallback);
    expect(provider.name).toBe("google");
    expect(provider.degraded).toBe(false);
  });

  it("computes a matrix in a single client call when within the element cap", async () => {
    const client = new MockRouteMatrixClient(okResponder);
    const provider = new GoogleMatrixProvider(client, fallback);

    const matrix = await provider.matrix([A, B], [A, B, C], 0);

    expect(client.calls).toHaveLength(1);
    expect(matrix).toEqual([
      [11, 12, 13],
      [21, 22, 23],
    ]);
    expect(provider.degraded).toBe(false);
  });

  it("chunks matrix requests to stay within a custom element cap", async () => {
    const client = new MockRouteMatrixClient(okResponder);
    const provider = new GoogleMatrixProvider(client, fallback, { maxElementsPerRequest: 4 });

    const matrix = await provider.matrix([A, B, C], [A, B, C], 0);

    expect(client.calls.length).toBeGreaterThan(1);
    for (const call of client.calls) {
      expect(call.origins.length * call.destinations.length).toBeLessThanOrEqual(4);
    }
    // stitched result still matches what a single unchunked call would produce
    expect(matrix).toEqual([
      [11, 12, 13],
      [21, 22, 23],
      [31, 32, 33],
    ]);
  });

  it("applies a 100-element cap under TRAFFIC_AWARE_OPTIMAL instead of 625", async () => {
    const client = new MockRouteMatrixClient(okResponder);
    const provider = new GoogleMatrixProvider(client, fallback, { routingPreference: "TRAFFIC_AWARE_OPTIMAL" });

    // 11 x 10 = 110 elements, over the 100 cap for TRAFFIC_AWARE_OPTIMAL but under 625.
    // Distinct coordinates so the cache doesn't collapse repeats into one key.
    const origins = Array.from({ length: 11 }, (_, i) => ({ lat: A.lat + i * 0.001, lng: A.lng }));
    const dests = Array.from({ length: 10 }, (_, i) => ({ lat: B.lat + i * 0.001, lng: B.lng }));
    await provider.matrix(origins, dests, 0);

    expect(client.calls.length).toBeGreaterThan(1);
    for (const call of client.calls) {
      expect(call.routingPreference).toBe("TRAFFIC_AWARE_OPTIMAL");
      expect(call.origins.length * call.destinations.length).toBeLessThanOrEqual(100);
    }
  });

  it("prevents repeat lookups within a batch — a fully cached chunk skips the client", async () => {
    const client = new MockRouteMatrixClient(okResponder);
    const provider = new GoogleMatrixProvider(client, fallback);

    await provider.matrix([A, B], [A, B], 5); // same 15-min bucket as below (bucket 0)
    expect(client.calls).toHaveLength(1);

    await provider.matrix([A, B], [A, B], 7);
    expect(client.calls).toHaveLength(1); // still cached — no second network call
  });

  it("re-queries once the departure bucket moves past the cache window", async () => {
    const client = new MockRouteMatrixClient(okResponder);
    const provider = new GoogleMatrixProvider(client, fallback);

    await provider.matrix([A], [B], 0); // bucket 0
    await provider.matrix([A], [B], 20); // bucket 1 (15-min buckets)

    expect(client.calls).toHaveLength(2);
  });

  it("time() reads a value matrix() already cached, without touching the client", async () => {
    const client = new MockRouteMatrixClient(okResponder);
    const provider = new GoogleMatrixProvider(client, fallback);

    await provider.matrix([A], [B], 0);
    const cachedCalls = client.calls.length;

    expect(provider.time(A, B, 0)).toBe(12);
    expect(client.calls).toHaveLength(cachedCalls);
    expect(provider.degraded).toBe(false);
  });

  it("time() falls back to haversine synchronously for an uncached pair, and flips degraded", () => {
    const client = new MockRouteMatrixClient(okResponder);
    const provider = new GoogleMatrixProvider(client, fallback);

    const minutes = provider.time(A, B, 0);

    expect(minutes).toBeCloseTo(fallback.time(A, B, 0), 10);
    expect(client.calls).toHaveLength(0); // time() never talks to the network
    expect(provider.degraded).toBe(true);
  });

  it("falls back to haversine without throwing when the client rejects", async () => {
    const client = new MockRouteMatrixClient(okResponder, /* shouldThrow */ true);
    const provider = new GoogleMatrixProvider(client, fallback);

    const matrix = await provider.matrix([A, B], [C], 0);

    expect(matrix[0][0]).toBeCloseTo(fallback.time(A, C, 0), 10);
    expect(matrix[1][0]).toBeCloseTo(fallback.time(B, C, 0), 10);
    expect(provider.degraded).toBe(true);
  });

  it("falls back per-element when the API reports a non-OK status, keeping the rest from the response", async () => {
    const client = new MockRouteMatrixClient((origins, destinations) =>
      okResponder(origins, destinations).map((el) =>
        el.originIndex === 0 && el.destinationIndex === 0 ? { ...el, status: "NOT_FOUND" } : el
      )
    );
    const provider = new GoogleMatrixProvider(client, fallback);

    const matrix = await provider.matrix([A, B], [C], 0);

    expect(matrix[0][0]).toBeCloseTo(fallback.time(A, C, 0), 10); // fell back
    expect(matrix[1][0]).toBe(23); // still from the API response
    expect(provider.degraded).toBe(true);
  });

  it("evicts the least-recently-used entry once the cache exceeds its size", async () => {
    const client = new MockRouteMatrixClient(okResponder);
    const provider = new GoogleMatrixProvider(client, fallback, { cacheSize: 2 });

    // Three distinct (origin, dest) pairs, one cache slot too many — A→B evicted first.
    await provider.matrix([A], [B], 0);
    await provider.matrix([A], [C], 0);
    await provider.matrix([B], [C], 0);

    const callsBeforeReread = client.calls.length;
    provider.time(A, B, 0); // evicted — synchronous fallback, no new client call possible
    expect(provider.degraded).toBe(true);
    expect(client.calls).toHaveLength(callsBeforeReread);
  });
});
