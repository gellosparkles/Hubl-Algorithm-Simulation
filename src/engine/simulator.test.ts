import { describe, it, expect, vi, afterEach } from "vitest";
import { createInitialState, simulateStep } from "./simulator";
import { DEFAULT_CONFIG, SimConfig, SimState } from "./types";
import { createRng } from "./rng";
import { haversine } from "@/services/routing";

const HUBS = [
  { lat: 34.0522, lng: -118.2437 },
  { lat: 34.0195, lng: -118.4912 },
];

/** Run a headless simulation to completion and return the final state. */
async function run(overrides: Partial<SimConfig>, minutes = 30): Promise<SimState> {
  const config: SimConfig = { ...DEFAULT_CONFIG, simMinutes: minutes, ...overrides };
  let s = createInitialState(config);
  s.dropOffHubs = HUBS;
  for (let i = 0; i < minutes; i++) s = await simulateStep(s, config);
  return s;
}

describe("rng", () => {
  it("produces a repeatable sequence for a given seed", () => {
    const a = createRng(42);
    const b = createRng(42);
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it("produces different sequences for different seeds", () => {
    const a = createRng(1).next();
    const b = createRng(2).next();
    expect(a).not.toBe(b);
  });

  it("stays within [0, 1)", () => {
    const rng = createRng(7);
    for (let i = 0; i < 1000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("can resume from a captured state", () => {
    const a = createRng(99);
    a.next();
    a.next();
    const captured = a.state;
    const rest = [a.next(), a.next(), a.next()];

    const resumed = createRng(captured);
    expect([resumed.next(), resumed.next(), resumed.next()]).toEqual(rest);
  });
});

describe("simulation determinism", () => {
  it("gives identical metrics for the same seed", async () => {
    const first = await run({ seed: 12345 });
    const second = await run({ seed: 12345 });
    expect(second.metrics).toEqual(first.metrics);
  });

  it("reproduces full state, not just metrics", async () => {
    const first = await run({ seed: 777 }, 20);
    const second = await run({ seed: 777 }, 20);
    expect(second.eventLog).toEqual(first.eventLog);
    expect(second.rngState).toBe(first.rngState);
    expect(Object.keys(second.requests).length).toBe(Object.keys(first.requests).length);
  });

  it("gives different results for different seeds", async () => {
    const a = await run({ seed: 1 });
    const b = await run({ seed: 2 });
    expect(b.eventLog).not.toEqual(a.eventLog);
  });

  it("does not leak request ids between runs", async () => {
    const first = await run({ seed: 555 }, 10);
    const second = await run({ seed: 555 }, 10);
    expect(Object.keys(second.requests)).toEqual(Object.keys(first.requests));
  });

  it("isolates two interleaved simulations", async () => {
    const config: SimConfig = { ...DEFAULT_CONFIG, seed: 4242, simMinutes: 10 };
    let a = createInitialState(config);
    let b = createInitialState(config);

    // Advance them in lockstep — a module-global RNG would cross-contaminate here.
    for (let i = 0; i < 10; i++) {
      a = await simulateStep(a, config);
      b = await simulateStep(b, config);
    }
    expect(b.rngState).toBe(a.rngState);
    expect(b.metrics).toEqual(a.metrics);
  });
});

describe("TravelTimeProvider wiring", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pre-warms one batched matrix call per tick instead of calling per leg, and records a run-wide fallback honestly", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("no network in tests");
    });
    vi.stubGlobal("fetch", fetchMock);

    const config: SimConfig = {
      ...DEFAULT_CONFIG,
      seed: 9,
      simMinutes: 3,
      useGoogleRouting: true,
      googleApiKey: "test-key",
    };
    let s = createInitialState(config);
    s.dropOffHubs = HUBS;
    for (let i = 0; i < config.simMinutes; i++) s = await simulateStep(s, config);

    // One matrix() call per tick that had points to warm, never one per leg.
    // The matrix() call may fan out into a small number of element-capped
    // chunks, so allow a couple of fetches per tick — still O(ticks), not O(legs).
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(config.simMinutes * 2);
    // The client always failed, so every tick's dispatch fell back — and that
    // must survive in final state even though the provider itself is
    // recreated (and discarded) fresh every tick.
    expect(s.travelTimeProviderDegraded).toBe(true);
  });

  it("never touches fetch when useGoogleRouting is off, at any point in a run", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const s = await run({ seed: 9, useGoogleRouting: false }, 5);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(s.travelTimeProviderDegraded).toBe(false);
  });
});

describe("bus itineraries (issue #4)", () => {
  it("represents a route as one PlanStop[] with no parallel arrays or negative-id stops", async () => {
    const s = await run({ seed: 12345 }, 40);

    for (const bus of Object.values(s.buses)) {
      expect(bus).not.toHaveProperty("route");
      expect(bus).not.toHaveProperty("routeEtas");
      expect(bus).not.toHaveProperty("available");
      expect(bus).not.toHaveProperty("busyUntil");
      expect(Array.isArray(bus.plan)).toBe(true);
      for (const ps of bus.plan) {
        expect(["pickup", "dropoff", "hub"]).toContain(ps.kind);
        expect(ps.etaMin).toBeGreaterThan(0);
        expect(ps.loadAfter).toBeGreaterThanOrEqual(0);
        if (ps.kind === "hub") expect(ps.stopId).toBeNull();
      }
    }

    // Hub visits never leak into the shared stop map.
    for (const id of Object.keys(s.stops)) expect(Number(id)).toBeGreaterThan(0);
    for (const st of Object.values(s.stops)) expect(st.status).not.toBe("dropoff");
  });

  it("marks a rider picked_up only once a bus has physically reached their stop", async () => {
    const config: SimConfig = { ...DEFAULT_CONFIG, seed: 12345, simMinutes: 40 };
    let s = createInitialState(config);
    s.dropOffHubs = HUBS;
    for (let i = 0; i < config.simMinutes; i++) {
      s = await simulateStep(s, config);
      for (const bus of Object.values(s.buses)) {
        for (const rid of bus.onboard) {
          // an onboard rider's board stop ETA is in the past
          expect(s.requests[rid].tPickedUp).not.toBeNull();
          expect(s.requests[rid].tPickedUp!).toBeLessThanOrEqual(s.time);
        }
      }
    }

    // Some rider is assigned (tAssigned set) but still waiting (pending) — the
    // old engine flipped straight to picked_up at assignment.
    const assignedButWaiting = Object.values(s.requests).filter(
      (r) => r.tAssigned !== null && r.status === "pending"
    );
    expect(assignedButWaiting.length).toBeGreaterThan(0);
  });

  it("completes each rider at their own drop-off with a real in-vehicle time", async () => {
    const s = await run({ seed: 777 }, 120);
    const completed = Object.values(s.requests).filter((r) => r.status === "completed");
    expect(completed.length).toBeGreaterThan(0);
    for (const r of completed) {
      expect(r.tPickedUp).not.toBeNull();
      expect(r.tDroppedOff).not.toBeNull();
      expect(r.tDroppedOff!).toBeGreaterThanOrEqual(r.tPickedUp!);
      expect(r.tPickedUp!).toBeGreaterThanOrEqual(r.tRequest);
    }
  });
});

describe("idle repositioning (issue #9)", () => {
  // Warm up with dispatch disabled (batchWindowMinutes huge, tick not a
  // multiple) so buses stay idle and open demand accumulates; then step once
  // more with dispatch still off, isolating step 4b.
  async function idleStateWithDemand(seed: number) {
    const config: SimConfig = {
      ...DEFAULT_CONFIG,
      seed,
      simMinutes: 60,
      numBuses: 4,
      batchWindowMinutes: 1000,
      rebalanceEnabled: false,
    };
    let s = createInitialState(config);
    s.dropOffHubs = HUBS;
    for (let i = 0; i < 20; i++) s = await simulateStep(s, config);
    return { s, config };
  }

  it("leaves idle buses put when the flag is off", async () => {
    const { s, config } = await idleStateWithDemand(12345);
    const before = Object.values(s.buses).map((b) => ({ ...b.position }));
    const after = await simulateStep(s, { ...config, rebalanceEnabled: false });
    Object.values(after.buses).forEach((b, i) => {
      expect(b.position).toEqual(before[i]);
    });
  });

  it("drifts idle buses toward demand when the flag is on, and books the drift as deadhead", async () => {
    const { s, config } = await idleStateWithDemand(12345);
    const before = Object.values(s.buses).map((b) => ({ ...b.position }));

    const off = await simulateStep(structuredClone(s) as SimState, { ...config, rebalanceEnabled: false });
    const on = await simulateStep(structuredClone(s) as SimState, { ...config, rebalanceEnabled: true });

    const moved = Object.values(on.buses).filter(
      (b, i) => haversine(b.position, before[i]) > 1e-9
    );
    expect(moved.length).toBeGreaterThan(0);
    expect(on.kpi.deadheadKm).toBeGreaterThan(off.kpi.deadheadKm);
    expect(on.kpi.vehicleKm).toBeGreaterThan(off.kpi.vehicleKm);
  });

  it("sets no plan while repositioning, so the bus stays interruptible by the dispatcher", async () => {
    const { s, config } = await idleStateWithDemand(12345);
    const before = Object.values(s.buses).map((b) => ({ ...b.position }));
    const on = await simulateStep(s, { ...config, rebalanceEnabled: true });
    // Some bus drifted, yet no bus holds a reposition "plan" — the dispatcher
    // sees a plain spare-capacity vehicle at the new position next tick.
    expect(
      Object.values(on.buses).some((b, i) => haversine(b.position, before[i]) > 1e-9)
    ).toBe(true);
    for (const bus of Object.values(on.buses)) {
      expect(bus.plan).toEqual([]);
      expect(bus.legIndex).toBe(0);
    }
  });

  it("repositioning is deterministic for a fixed seed", async () => {
    const a = await idleStateWithDemand(777);
    const b = await idleStateWithDemand(777);
    const onA = await simulateStep(a.s, { ...a.config, rebalanceEnabled: true });
    const onB = await simulateStep(b.s, { ...b.config, rebalanceEnabled: true });
    expect(Object.values(onB.buses).map((x) => x.position)).toEqual(
      Object.values(onA.buses).map((x) => x.position)
    );
  });
});

describe("simulation invariants", () => {
  it("advances one minute per step", async () => {
    const config: SimConfig = { ...DEFAULT_CONFIG, seed: 3 };
    let s = createInitialState(config);
    expect(s.time).toBe(0);
    s = await simulateStep(s, config);
    expect(s.time).toBe(1);
  });

  it("does not mutate the state passed in", async () => {
    const config: SimConfig = { ...DEFAULT_CONFIG, seed: 8 };
    const s = createInitialState(config);
    const before = structuredClone(s);
    await simulateStep(s, config);
    expect(s).toEqual(before);
  });

  it("keeps rider status counts consistent with the total", async () => {
    const s = await run({ seed: 31 });
    const { completed, pending, pickedUp, unserved, totalRequests } = s.metrics;
    expect(completed + pending + pickedUp + unserved).toBe(totalRequests);
  });

  it("never exceeds bus capacity", async () => {
    const s = await run({ seed: 64 });
    for (const bus of Object.values(s.buses)) {
      expect(bus.onboard.length).toBeLessThanOrEqual(bus.capacity);
    }
  });

  it("counts unserved riders distinctly and never leaves them pending", async () => {
    const s = await run({ seed: 88 }, 40);
    const reqs = Object.values(s.requests);
    const unserved = reqs.filter((r) => r.direction === "unserved");
    expect(unserved.length).toBeGreaterThan(0); // both-far trips do occur
    expect(s.metrics.unserved).toBe(unserved.length);
    for (const r of unserved) {
      expect(r.status).toBe("unserved");
      expect(r.hubIndex).toBeNull();
      expect(r.assignedStop).toBeNull();
    }
    // pending is a strictly different bucket
    expect(reqs.filter((r) => r.status === "pending").every((r) => r.direction !== "unserved")).toBe(true);
  });

  it("anchors every served request to a hub by geography and never at random", async () => {
    const s = await run({ seed: 88 }, 40);
    for (const r of Object.values(s.requests)) {
      if (r.direction === "unserved") continue;
      expect(r.hubIndex).not.toBeNull();
      const anchor = r.direction === "inbound" ? r.destination : r.origin;
      // the anchored end really is this rider's nearest hub (same metric as tripModel)
      const nearest = s.dropOffHubs.reduce(
        (bi, h, i) => (haversine(anchor, h) < haversine(anchor, s.dropOffHubs[bi]) ? i : bi),
        0
      );
      expect(r.hubIndex).toBe(nearest);
      expect(r.directTimeMin).toBeGreaterThan(0);
      expect(r.maxRideTimeMin).toBeGreaterThan(r.directTimeMin);
      expect(r.promisedPickupBy).toBe(r.tRequest + DEFAULT_CONFIG.maxWaitMinutes);
    }
  });

  it("creates the configured number of buses", async () => {
    const s = await run({ seed: 5, numBuses: 15 }, 5);
    expect(Object.keys(s.buses).length).toBe(15);
  });

  it("leaves fewer riders waiting with more buses", async () => {
    // Throughput stays low until the Phase 3 dispatcher lands, so compare the
    // riders still `pending` at horizon end rather than a tiny completed count.
    const few = await run({ seed: 2024, numBuses: 4 }, 60);
    const many = await run({ seed: 2024, numBuses: 40 }, 60);
    expect(many.metrics.pending).toBeLessThan(few.metrics.pending);
  });
});
