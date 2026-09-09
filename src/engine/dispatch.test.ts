import { describe, it, expect } from "vitest";
import {
  bestInsertion,
  simulateItinerary,
  InsertionDispatcher,
  LiteStop,
  RiderMeta,
  Shipment,
  Vehicle,
} from "./dispatch";
import { objectiveCost, DEFAULT_OBJECTIVE, ZERO_PARTS } from "./objective";
import { DEFAULT_CONFIG, LatLng, SimConfig } from "./types";
import { HaversineProvider } from "@/services/travelTime";

const provider = new HaversineProvider(DEFAULT_CONFIG.detourFactor, DEFAULT_CONFIG.speedProfile);
const config: SimConfig = { ...DEFAULT_CONFIG };

/** The `directTimeMin` the fixtures' riders use — kept explicit for `relativeDetourLimit`. */
const FIXTURE_DIRECT_MIN = 10;

/** Vehicle fixture — fills the shipment-model cost fields with the defaults. */
function vhcl(v: Omit<Vehicle, "costPerKm" | "costPerHour" | "fixedCost">): Vehicle {
  return {
    costPerKm: DEFAULT_OBJECTIVE.costPerKm,
    costPerHour: DEFAULT_OBJECTIVE.costPerHour,
    fixedCost: 0,
    ...v,
  };
}

/** Shipment fixture — takes flat pickup/delivery points and fills the detour + penalty fields. */
function shpmt(
  s: Omit<Shipment, "pickups" | "deliveries" | "relativeDetourLimit" | "penaltyCost"> & {
    pickup: LatLng;
    delivery: LatLng;
    pickupBy: number;
  }
): Shipment {
  const { pickup, delivery, pickupBy, ...rest } = s;
  return {
    ...rest,
    pickups: [{ location: pickup, timeWindowEnd: pickupBy }],
    deliveries: [{ location: delivery, timeWindowEnd: null }],
    relativeDetourLimit: rest.maxRideTimeMin / FIXTURE_DIRECT_MIN - 1,
    penaltyCost: DEFAULT_OBJECTIVE.unservedPenalty * rest.load,
  };
}

function meta(partial: Partial<RiderMeta> = {}): RiderMeta {
  return {
    tRequest: 0,
    directTimeMin: 5,
    maxRideTimeMin: 60,
    promisedPickupBy: 100,
    walkKm: 0,
    boardedAt: null,
    ...partial,
  };
}

/** A point `km` east / `north` km of `origin` (rough equirectangular, fine at city scale). */
function offset(origin: LatLng, east: number, north: number): LatLng {
  return {
    lat: origin.lat + north / 110.574,
    lng: origin.lng + east / (111.32 * Math.cos((origin.lat * Math.PI) / 180)),
  };
}

describe("objectiveCost", () => {
  it("is a weighted sum — every weight is a live knob", () => {
    const parts = { km: 1, hours: 1, waitMin: 1, excessRideMin: 1, walkKm: 1, unserved: 1 };
    const w = DEFAULT_OBJECTIVE;
    expect(objectiveCost(parts, w)).toBeCloseTo(
      w.costPerKm + w.costPerHour + w.waitWeight + w.rideWeight + w.walkWeight + w.unservedPenalty
    );
    // bump one weight, cost moves by exactly that delta
    expect(objectiveCost(parts, { ...w, waitWeight: w.waitWeight + 10 })).toBeCloseTo(
      objectiveCost(parts, w) + 10
    );
  });

  it("scores an empty route at zero", () => {
    expect(objectiveCost(ZERO_PARTS, DEFAULT_OBJECTIVE)).toBe(0);
  });
});

describe("simulateItinerary feasibility", () => {
  const hub: LatLng = { lat: 34.05, lng: -118.24 };
  const bus: LatLng = { lat: 34.05, lng: -118.20 };

  it("rejects a plan that exceeds capacity at any point, including after a mid-route alighting", () => {
    // load profile: +3, +3 (=6), −3 (=3), +3 (=6) — never over a cap of 6, fine
    const riders = new Map<number, RiderMeta>();
    for (let i = 1; i <= 12; i++) riders.set(i, meta());
    const p = (n: number, boarding: number[], alighting: number[]): LiteStop => ({
      kind: alighting.length ? "hub" : "pickup",
      position: offset(bus, n * 0.2, 0),
      stopId: alighting.length ? null : n,
      hubIndex: 0,
      boarding,
      alighting,
    });
    const okPlan = [p(1, [1, 2, 3], []), p(2, [4, 5, 6], []), p(3, [], [1, 2, 3]), p(4, [7, 8, 9], [])];
    expect(simulateItinerary(bus, [], okPlan, riders, config, 0, provider, 6).feasible).toBe(true);

    // same but the last pickup pushes load to 9 with the alighting removed — over cap 6
    const badPlan = [p(1, [1, 2, 3], []), p(2, [4, 5, 6], []), p(4, [7, 8, 9], [])];
    const sim = simulateItinerary(bus, [], badPlan, riders, config, 0, provider, 6);
    expect(sim.feasible).toBe(false);
    expect(sim.reason).toBe("capacity");
  });

  it("rejects a plan that boards a rider after their promised-pickup deadline", () => {
    const riders = new Map([[1, meta({ promisedPickupBy: 2 })]]);
    const plan: LiteStop[] = [
      { kind: "pickup", position: offset(bus, 5, 0), stopId: 1, hubIndex: 0, boarding: [1], alighting: [] },
      { kind: "hub", position: hub, stopId: null, hubIndex: 0, boarding: [], alighting: [1] },
    ];
    const sim = simulateItinerary(bus, [], plan, riders, config, 0, provider, 12);
    expect(sim.feasible).toBe(false);
    expect(sim.reason).toBe("pickup-window");
  });

  it("rejects a plan that pushes an onboard rider past their max ride time", () => {
    const riders = new Map([[1, meta({ maxRideTimeMin: 3, boardedAt: 0 })]]);
    const plan: LiteStop[] = [
      { kind: "pickup", position: offset(bus, 8, 0), stopId: 2, hubIndex: 0, boarding: [2], alighting: [] },
      { kind: "hub", position: offset(bus, 16, 0), stopId: null, hubIndex: 0, boarding: [], alighting: [1, 2] },
    ];
    riders.set(2, meta());
    const sim = simulateItinerary(bus, [1], plan, riders, config, 0, provider, 12);
    expect(sim.feasible).toBe(false);
    expect(sim.reason).toBe("max-ride");
  });

  it("counts the first leg and the drop-off legs against the time budget", () => {
    const tight: SimConfig = { ...config, timeBudgetMinutes: 5 };
    const riders = new Map([[1, meta()]]);
    const plan: LiteStop[] = [
      { kind: "pickup", position: offset(bus, 6, 0), stopId: 1, hubIndex: 0, boarding: [1], alighting: [] },
      { kind: "hub", position: offset(bus, 12, 0), stopId: null, hubIndex: 0, boarding: [], alighting: [1] },
    ];
    const sim = simulateItinerary(bus, [], plan, riders, tight, 0, provider, 12);
    expect(sim.feasible).toBe(false);
    expect(sim.reason).toBe("time-budget");
  });
});

describe("bestInsertion — marginal detour prefers the corridor", () => {
  // budget widened so this test isolates the corridor property, not the time cap
  const wide: SimConfig = { ...config, timeBudgetMinutes: 120 };
  const A: LatLng = { lat: 34.02, lng: -118.30 };
  const H = offset(A, 10, 0); // hub 10 km due east of the bus
  const idleBus: Vehicle = vhcl({ id: 1, loadLimit: 12, position: A, onboard: [], plan: [] });

  function inboundShipment(id: number, stopPos: LatLng): Shipment {
    return shpmt({
      id,
      direction: "inbound",
      hubIndex: 0,
      pickup: stopPos,
      delivery: H,
      load: 1,
      riderIds: [id],
      pickupBy: 100,
      maxRideTimeMin: 120,
    });
  }

  it("a farther stop on the A→H line beats a nearer stop perpendicular to it", () => {
    const onCorridor = offset(A, 5, 0); // 5 km along, 0 off — dead on the line
    const perpendicular = offset(A, 4.8, 3); // slightly nearer along, but 3 km off-axis
    const riders = new Map<number, RiderMeta>([
      [10, meta({ tRequest: 0, promisedPickupBy: 100, directTimeMin: 12 })],
      [20, meta({ tRequest: 0, promisedPickupBy: 100, directTimeMin: 12 })],
    ]);

    const corridorCost = bestInsertion(idleBus, inboundShipment(10, onCorridor), riders, wide, 0, provider);
    const perpCost = bestInsertion(idleBus, inboundShipment(20, perpendicular), riders, wide, 0, provider);

    expect(corridorCost).not.toBeNull();
    expect(perpCost).not.toBeNull();
    expect(corridorCost!.cost).toBeLessThan(perpCost!.cost);
  });
});

describe("bestInsertion — inbound and outbound share one code path", () => {
  const hub: LatLng = { lat: 34.05, lng: -118.24 };

  it("seeds [pickup, hub] for inbound and [hub, dropoff] for outbound", () => {
    const riders = new Map([[1, meta()]]);
    const inbound = bestInsertion(
      vhcl({ id: 1, loadLimit: 12, position: offset(hub, 3, 0), onboard: [], plan: [] }),
      shpmt({
        id: 1, direction: "inbound", hubIndex: 0,
        pickup: offset(hub, 3, 0), delivery: hub,
        load: 1, riderIds: [1], pickupBy: 100, maxRideTimeMin: 120,
      }),
      riders, config, 0, provider
    );
    expect(inbound!.lite.map((s) => s.kind)).toEqual(["pickup", "hub"]);

    const outbound = bestInsertion(
      vhcl({ id: 2, loadLimit: 12, position: hub, onboard: [], plan: [] }),
      shpmt({
        id: 2, direction: "outbound", hubIndex: 0,
        pickup: hub, delivery: offset(hub, 3, 0),
        load: 1, riderIds: [1], pickupBy: 100, maxRideTimeMin: 120,
      }),
      riders, config, 0, provider
    );
    expect(outbound!.lite.map((s) => s.kind)).toEqual(["hub", "dropoff"]);
    expect(outbound!.lite[0].boarding).toEqual([1]);
  });
});

describe("InsertionDispatcher", () => {
  const hub: LatLng = { lat: 34.05, lng: -118.24 };

  it("assigns a stop to a moving bus that has spare capacity, not only idle buses", async () => {
    // bus 1 is idle far away; bus 2 already has a plan but passes right by the new stop
    const near = offset(hub, 2, 0);
    const riders = new Map<number, RiderMeta>([
      [1, meta({ boardedAt: 0 })], // aboard bus 2
      [2, meta()], // waiting at the new stop
    ]);
    const busyBus: Vehicle = vhcl({
      id: 2,
      loadLimit: 12,
      position: offset(hub, 3, 0),
      onboard: [1],
      plan: [
        { kind: "pickup", position: offset(hub, 2.2, 0.1), stopId: 5, hubIndex: 0, boarding: [], alighting: [] },
        { kind: "hub", position: hub, stopId: null, hubIndex: 0, boarding: [], alighting: [1] },
      ],
    });
    const idleFar: Vehicle = vhcl({ id: 1, loadLimit: 12, position: offset(hub, 40, 40), onboard: [], plan: [] });
    const shipment: Shipment = shpmt({
      id: 9, direction: "inbound", hubIndex: 0,
      pickup: near, delivery: hub,
      load: 1, riderIds: [2], pickupBy: 100, maxRideTimeMin: 120,
    });

    const result = await new InsertionDispatcher().dispatch(
      { shipments: [shipment], vehicles: [idleFar, busyBus], riders, now: 0 },
      config,
      provider
    );
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0].vehicleId).toBe(2);
    expect(result.assignments[0].stopIds).toEqual([9]);
  });

  it("commits the higher-regret stop first", async () => {
    // two shipments, two buses. shipment A is only feasible for bus 1 (infinite regret);
    // shipment B is feasible for both. A must be committed to bus 1.
    const riders = new Map<number, RiderMeta>([
      [1, meta()],
      [2, meta()],
    ]);
    const b1: Vehicle = vhcl({ id: 1, loadLimit: 1, position: offset(hub, 1, 0), onboard: [], plan: [] });
    const b2: Vehicle = vhcl({ id: 2, loadLimit: 12, position: offset(hub, 1.5, 0), onboard: [], plan: [] });
    const shipA: Shipment = shpmt({
      id: 1, direction: "inbound", hubIndex: 0,
      pickup: offset(hub, 1, 0), delivery: hub,
      load: 1, riderIds: [1], pickupBy: 100, maxRideTimeMin: 120,
    });
    const shipB: Shipment = shpmt({
      id: 2, direction: "inbound", hubIndex: 0,
      pickup: offset(hub, 1.5, 0), delivery: hub,
      load: 1, riderIds: [2], pickupBy: 100, maxRideTimeMin: 120,
    });
    const result = await new InsertionDispatcher().dispatch(
      { shipments: [shipA, shipB], vehicles: [b1, b2], riders, now: 0 },
      config,
      provider
    );
    const a = result.assignments.find((x) => x.stopIds.includes(1));
    expect(a?.vehicleId).toBe(1);
  });

  it("regret ordering beats first-come ordering on total objective cost", async () => {
    // Two inbound stops, two capacity-1 buses. B1 is the only bus that can serve
    // S2 without a large off-corridor detour; B2 is a near-tie with B1 for S1.
    // First-come walks the buses in order and lets B1 grab its own cheapest stop
    // (S1), stranding S2 on B2 at a big cost. Regret sees S2 has far more to lose
    // and commits it to B1 first, leaving S1 for the near-tie bus B2.
    const A: LatLng = { lat: 34.02, lng: -118.3 };
    const H = offset(A, 30, 0);
    const S1 = offset(A, 10, 0); // dead on the A→H corridor
    const S2 = offset(A, 10, 8); // 8 km off-corridor, and far from B2
    const B1 = offset(A, 8, 2);
    const B2 = offset(A, 9, -1);
    const wide: SimConfig = { ...config, timeBudgetMinutes: 300 };

    const riders = new Map<number, RiderMeta>([
      [1, meta({ directTimeMin: 20, maxRideTimeMin: 300, promisedPickupBy: 300 })],
      [2, meta({ directTimeMin: 20, maxRideTimeMin: 300, promisedPickupBy: 300 })],
    ]);
    const ship = (id: number, pos: LatLng): Shipment =>
      shpmt({
        id,
        direction: "inbound",
        hubIndex: 0,
        pickup: pos,
        delivery: H,
        load: 1,
        riderIds: [id],
        pickupBy: 300,
        maxRideTimeMin: 300,
      });
    const shipments = [ship(1, S1), ship(2, S2)];
    const vehicles: Vehicle[] = [
      vhcl({ id: 1, loadLimit: 1, position: B1, onboard: [], plan: [] }),
      vhcl({ id: 2, loadLimit: 1, position: B2, onboard: [], plan: [] }),
    ];

    const totalCost = (asg: { vehicleId: number; lite: LiteStop[] }[]): number => {
      let sum = 0;
      for (const a of asg) {
        const v = vehicles.find((x) => x.id === a.vehicleId)!;
        const sim = simulateItinerary(v.position, [], a.lite, riders, wide, 0, provider, v.loadLimit);
        sum += objectiveCost(sim.parts, wide.objective);
      }
      return sum;
    };

    // First-come: each vehicle in turn greedily absorbs its own cheapest feasible
    // shipment until none remains feasible — the pre-#8 assignment strategy.
    const remaining = new Set(shipments.map((s) => s.id));
    const firstCome: { vehicleId: number; lite: LiteStop[] }[] = [];
    for (const v of vehicles) {
      let cur: Vehicle = { ...v, plan: [] };
      for (;;) {
        let best: { id: number; lite: LiteStop[]; cost: number } | null = null;
        for (const sid of remaining) {
          const bi = bestInsertion(cur, shipments.find((s) => s.id === sid)!, riders, wide, 0, provider);
          if (bi && (best === null || bi.cost < best.cost)) best = { id: sid, lite: bi.lite, cost: bi.cost };
        }
        if (!best) break;
        cur = { ...cur, plan: best.lite };
        remaining.delete(best.id);
      }
      if (cur.plan.length) firstCome.push({ vehicleId: v.id, lite: cur.plan });
    }

    const regret = (
      await new InsertionDispatcher().dispatch({ shipments, vehicles, riders, now: 0 }, wide, provider)
    ).assignments;

    const pickups = (asg: { lite: LiteStop[] }[]) =>
      asg.flatMap((a) => a.lite.filter((s) => s.kind === "pickup")).length;
    expect(pickups(firstCome)).toBe(2); // first-come places both stops…
    expect(pickups(regret)).toBe(2); // …and so does regret, but on a better pairing

    expect(totalCost(regret)).toBeLessThan(totalCost(firstCome));
  });
});
