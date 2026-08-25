import { describe, it, expect } from "vitest";
import { HaversineProvider, createTravelTimeProvider, speedAt } from "./travelTime";
import { SpeedProfile } from "@/engine/types";

const A = { lat: 34.0522, lng: -118.2437 }; // Downtown LA
const B = { lat: 34.0195, lng: -118.4912 }; // Santa Monica

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
    const provider = createTravelTimeProvider({ detourFactor: 1.35, speedProfile: PROFILE });
    expect(provider.name).toBe("haversine");
    expect(provider.time(A, B, 0)).toBeGreaterThan(0);
  });
});
