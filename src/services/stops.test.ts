import { describe, it, expect, beforeEach } from "vitest";
import { maintainStops, gridCellId, resetStopCounter } from "@/services/stops";
import { createInitialState, simulateStep } from "@/engine/simulator";
import { DEFAULT_CONFIG, RiderRequest, SimConfig, VirtualStop } from "@/engine/types";

const DTLA = { lat: 34.0522, lng: -118.2437 };
const HUBS = [DTLA, { lat: 34.0195, lng: -118.4912 }];

function rider(id: number, origin: { lat: number; lng: number }, over: Partial<RiderRequest> = {}): RiderRequest {
  return {
    id,
    tRequest: 0,
    origin,
    destination: DTLA,
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
    directTimeMin: 5,
    maxRideTimeMin: 12,
    ...over,
  };
}

const cfg = { maxWalkKm: DEFAULT_CONFIG.maxWalkKm, minGroupSize: 1 };

describe("maintainStops", () => {
  beforeEach(() => resetStopCounter(1));

  it("keys a stop by grid cell + direction + hub and persists it across ticks", () => {
    const a = rider(1, { lat: 34.06, lng: -118.30 });
    const requests: Record<number, RiderRequest> = { 1: a };
    const stops: Record<number, VirtualStop> = {};

    const first = maintainStops(requests, stops, 0, cfg);
    Object.assign(requests[1], first.updatedRequests[1]);
    const firstId = requests[1].assignedStop;
    expect(firstId).not.toBeNull();

    // A rider in the SAME cell three ticks later joins the same stop id.
    const near = { lat: 34.06 + 1e-5, lng: -118.30 + 1e-5 };
    expect(gridCellId(near)).toBe(gridCellId(a.origin));
    requests[2] = rider(2, near);
    const { updatedRequests } = maintainStops(requests, stops, 3, cfg);
    expect(updatedRequests[2].assignedStop).toBe(firstId);
    expect(Object.keys(stops)).toHaveLength(1);
  });

  it("does not pool riders bound for different hubs in the same cell", () => {
    const requests: Record<number, RiderRequest> = {
      1: rider(1, { lat: 34.06, lng: -118.30 }, { hubIndex: 0 }),
      2: rider(2, { lat: 34.06, lng: -118.30 }, { hubIndex: 1 }),
    };
    const stops: Record<number, VirtualStop> = {};
    maintainStops(requests, stops, 0, cfg);
    expect(Object.keys(stops)).toHaveLength(2);
  });

  it("serves a lone rider when minGroupSize is 1", () => {
    const requests: Record<number, RiderRequest> = { 1: rider(1, { lat: 34.07, lng: -118.31 }) };
    const stops: Record<number, VirtualStop> = {};
    const { updatedRequests } = maintainStops(requests, stops, 0, cfg);
    expect(updatedRequests[1].assignedStop).not.toBeNull();
  });

  it("defers stop formation until minGroupSize riders share a cell", () => {
    const requests: Record<number, RiderRequest> = { 1: rider(1, { lat: 34.07, lng: -118.31 }) };
    const stops: Record<number, VirtualStop> = {};
    maintainStops(requests, stops, 0, { ...cfg, minGroupSize: 2 });
    expect(Object.keys(stops)).toHaveLength(0);

    requests[2] = rider(2, { lat: 34.07, lng: -118.31 });
    maintainStops(requests, stops, 1, { ...cfg, minGroupSize: 2 });
    expect(Object.keys(stops)).toHaveLength(1);
  });

  it("retires a stop once all its riders have completed", () => {
    const requests: Record<number, RiderRequest> = { 1: rider(1, { lat: 34.07, lng: -118.31 }) };
    const stops: Record<number, VirtualStop> = {};
    const { updatedRequests } = maintainStops(requests, stops, 0, cfg);
    Object.assign(requests[1], updatedRequests[1]);
    expect(Object.keys(stops)).toHaveLength(1);

    requests[1].status = "completed";
    maintainStops(requests, stops, 5, cfg);
    expect(Object.keys(stops)).toHaveLength(0);
  });
});

describe("stops over a full simulation", () => {
  async function run(overrides: Partial<SimConfig>, minutes: number) {
    const config: SimConfig = { ...DEFAULT_CONFIG, simMinutes: minutes, ...overrides };
    let s = createInitialState(config);
    s.dropOffHubs = HUBS;
    for (let i = 0; i < minutes; i++) s = await simulateStep(s, config);
    return { s, config };
  }

  it("keeps every recorded walk distance within maxWalkKm", async () => {
    const { s, config } = await run({ seed: 4242 }, 60);
    let checked = 0;
    for (const r of Object.values(s.requests)) {
      if (r.walkDistanceKm == null) continue;
      checked++;
      expect(r.walkDistanceKm).toBeLessThanOrEqual(config.maxWalkKm + 1e-9);
    }
    expect(checked).toBeGreaterThan(50);
  });

  it("persists a stop past the old max-wait mark and never re-uses an id", async () => {
    const config: SimConfig = { ...DEFAULT_CONFIG, seed: 99, simMinutes: 40 };
    let s = createInitialState(config);
    s.dropOffHubs = HUBS;
    const firstSeen: Record<number, number> = {};
    const lastSeen: Record<number, number> = {};
    for (let i = 0; i < config.simMinutes; i++) {
      s = await simulateStep(s, config);
      for (const id of Object.keys(s.stops).map(Number)) {
        // an id that vanished and came back would mean the group re-formed
        if (lastSeen[id] != null) expect(lastSeen[id]).toBe(s.time - 1);
        if (firstSeen[id] == null) firstSeen[id] = s.time;
        lastSeen[id] = s.time;
      }
    }
    // No expiry churn: some stop lived well past the 10-min maxWaitMinutes that
    // used to force it to expire and its riders back to pending.
    const longestSpan = Math.max(
      ...Object.keys(firstSeen).map((id) => lastSeen[+id] - firstSeen[+id])
    );
    expect(longestSpan).toBeGreaterThan(DEFAULT_CONFIG.maxWaitMinutes);
    expect(s.eventLog.some((l) => l.includes("expired"))).toBe(false);
  });

  it("resets the stop-id counter on initial-state creation, so ids do not leak", async () => {
    const a = await run({ seed: 7 }, 15);
    const b = await run({ seed: 7 }, 15);
    expect(Object.keys(b.s.stops)).toEqual(Object.keys(a.s.stops));
  });
});
