import { describe, it, expect } from "vitest";
import { createInitialState, simulateStep } from "./simulator";
import { DEFAULT_CONFIG, SimConfig, SimState } from "./types";
import { createRng } from "./rng";

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
    const { completed, pending, pickedUp, totalRequests } = s.metrics;
    expect(completed + pending + pickedUp).toBe(totalRequests);
  });

  it("never exceeds bus capacity", async () => {
    const s = await run({ seed: 64 });
    for (const bus of Object.values(s.buses)) {
      expect(bus.onboard.length).toBeLessThanOrEqual(bus.capacity);
    }
  });

  it("creates the configured number of buses", async () => {
    const s = await run({ seed: 5, numBuses: 15 }, 5);
    expect(Object.keys(s.buses).length).toBe(15);
  });

  it("serves more riders with more buses", async () => {
    const few = await run({ seed: 2024, numBuses: 4 });
    const many = await run({ seed: 2024, numBuses: 40 });
    expect(many.metrics.completed + many.metrics.pickedUp)
      .toBeGreaterThan(few.metrics.completed + few.metrics.pickedUp);
  });
});
