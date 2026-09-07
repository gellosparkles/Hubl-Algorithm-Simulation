import { describe, it, expect } from "vitest";
import { computeMetrics, median, percentile } from "./metrics";
import { createInitialState, simulateStep, EVENT_LOG_LIMIT } from "./simulator";
import { DEFAULT_CONFIG, RiderRequest, SimConfig, SimState } from "./types";

const HUBS = [
  { lat: 34.0522, lng: -118.2437 },
  { lat: 34.0195, lng: -118.4912 },
];

function rider(over: Partial<RiderRequest>): RiderRequest {
  return {
    id: 0,
    tRequest: 0,
    origin: { lat: 0, lng: 0 },
    destination: { lat: 0, lng: 0 },
    direction: "inbound",
    hubIndex: 0,
    assignedStop: null,
    assignedBus: null,
    status: "pending",
    walkDistanceKm: null,
    tAssigned: null,
    tPickedUp: null,
    tDroppedOff: null,
    promisedPickupBy: 10,
    directTimeMin: 10,
    maxRideTimeMin: 20,
    ...over,
  };
}

function stateWith(requests: RiderRequest[], time: number, kpi: Partial<SimState["kpi"]> = {}): SimState {
  const s = createInitialState({ ...DEFAULT_CONFIG, seed: 1, numBuses: 1 });
  s.time = time;
  s.requests = Object.fromEntries(requests.map((r) => [r.id, r]));
  s.kpi = { ...s.kpi, ...kpi };
  return s;
}

describe("percentile helpers", () => {
  it("computes median and p90 with linear interpolation", () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(median(xs)).toBeCloseTo(5.5, 5);
    expect(percentile(xs, 90)).toBeCloseTo(9.1, 5);
  });
});

describe("computeMetrics", () => {
  it("derives service rate, wait and in-vehicle distributions from timestamps", () => {
    const reqs = [
      rider({ id: 1, tRequest: 0, tPickedUp: 4, tDroppedOff: 14, directTimeMin: 10, status: "completed" }),
      rider({ id: 2, tRequest: 0, tPickedUp: 8, tDroppedOff: 28, directTimeMin: 10, status: "completed" }),
      rider({ id: 3, tRequest: 2, tPickedUp: 12, status: "picked_up" }),
      rider({ id: 4, tRequest: 5, status: "pending", promisedPickupBy: 15 }),
    ];
    const m = computeMetrics(stateWith(reqs, 12));

    expect(m.totalRequests).toBe(4);
    expect(m.completed).toBe(2);
    expect(m.serviceRate).toBe(0.5);
    // waits: 4, 8, 10
    expect(m.waitP50Min).toBe(8);
    // in-vehicle: 10, 20
    expect(m.inVehicleP50Min).toBe(15);
    // detour ratios: 1.0, 2.0
    expect(m.detourRatioMean).toBeCloseTo(1.5, 5);
  });

  it("separates unserved (classified) from expired (promise already broken)", () => {
    const reqs = [
      rider({ id: 1, direction: "unserved", status: "unserved" }),
      rider({ id: 2, status: "pending", tRequest: 0, promisedPickupBy: 10 }), // expired at t=20
      rider({ id: 3, status: "pending", tRequest: 15, promisedPickupBy: 25 }), // still in promise
      rider({ id: 4, status: "pending", tRequest: 0, promisedPickupBy: 10, assignedBus: 2 }), // matched — not expired
    ];
    const m = computeMetrics(stateWith(reqs, 20));
    expect(m.unserved).toBe(1);
    expect(m.expired).toBe(1);
    expect(m.pending).toBe(3);
  });

  it("reports deadhead share and time-weighted mean occupancy from the accumulators", () => {
    const m = computeMetrics(
      stateWith([], 10, {
        vehicleKm: 100,
        deadheadKm: 25,
        personMinutes: 30,
        travelMinutes: 20,
      })
    );
    expect(m.deadheadShare).toBe(0.25);
    expect(m.meanOccupancy).toBe(1.5);
  });

  it("computes pooling rate over ever-boarded riders and mean walk", () => {
    const reqs = [
      rider({ id: 1, tPickedUp: 3, walkDistanceKm: 0.2 }),
      rider({ id: 2, tPickedUp: 4, walkDistanceKm: 0.4 }),
      rider({ id: 3, status: "pending", walkDistanceKm: 0.6 }),
    ];
    const m = computeMetrics(stateWith(reqs, 10, { pooledRiderIds: new Set([1, 2]) }));
    expect(m.poolingRate).toBeCloseTo(1, 5); // 2 distinct pooled / 2 boarded
    expect(m.meanWalkKm).toBeCloseTo(0.4, 5);
  });

  it("returns nulls, not NaN, when no rider has boarded yet", () => {
    const m = computeMetrics(stateWith([rider({ id: 1, status: "pending" })], 0));
    expect(m.waitP50Min).toBeNull();
    expect(m.inVehicleP90Min).toBeNull();
    expect(m.detourRatioMean).toBeNull();
    expect(m.meanWalkKm).toBeNull();
  });
});

describe("engine wiring", () => {
  it("counts assignments without string-matching the event log", async () => {
    const config: SimConfig = { ...DEFAULT_CONFIG, seed: 12345, simMinutes: 40 };
    let s = createInitialState(config);
    s.dropOffHubs = HUBS;
    for (let i = 0; i < config.simMinutes; i++) s = await simulateStep(s, config);

    const logMatches = s.eventLog.filter((l) => l.includes("assigned route")).length;
    expect(s.metrics.busAssignments).toBe(s.kpi.assignments);
    expect(s.metrics.busAssignments).toBeGreaterThanOrEqual(logMatches);
  });

  it("bounds the event log to a ring buffer over a long run", async () => {
    const config: SimConfig = { ...DEFAULT_CONFIG, seed: 3, simMinutes: 220, avgRequestsPerMin: 10 };
    let s = createInitialState(config);
    s.dropOffHubs = HUBS;
    for (let i = 0; i < config.simMinutes; i++) s = await simulateStep(s, config);

    expect(s.eventLog.length).toBeLessThanOrEqual(EVENT_LOG_LIMIT);
    expect(s.metrics.busAssignments).toBeGreaterThan(0);
  });

  it("accumulates vehicle-km past the positionHistory cap", async () => {
    const config: SimConfig = { ...DEFAULT_CONFIG, seed: 7, simMinutes: 90 };
    let s = createInitialState(config);
    s.dropOffHubs = HUBS;
    for (let i = 0; i < config.simMinutes; i++) s = await simulateStep(s, config);

    expect(s.metrics.vehicleKm).toBeGreaterThan(0);
    expect(s.metrics.deadheadShare).toBeGreaterThanOrEqual(0);
    expect(s.metrics.deadheadShare).toBeLessThanOrEqual(1);
  });
});
