/**
 * Insertion dispatcher (issue #7, plan.md Phase 3b–3d + the interface half of Phase 5).
 *
 * Replaces the greedy nearest-neighbour planner. Three pieces:
 *
 *  1. **A shipment-model interface** ({@link Dispatcher}) whose input mirrors
 *     Google Route Optimization's vocabulary — shipments with a pickup and a
 *     delivery, a load demand, a pickup time window and a detour limit; vehicles
 *     with a load limit and a current itinerary. A solver-backed implementation
 *     later is a mapping exercise, not a rewrite.
 *
 *  2. **A feasibility pass** ({@link simulateItinerary}) — one O(k) forward walk
 *     over a proposed itinerary that verifies the load profile never exceeds
 *     capacity *at any point* (including after mid-route alightings), that every
 *     rider boards by their promised-pickup deadline, that no rider — onboard or
 *     newly inserted — is pushed past their max ride time, and that the whole
 *     itinerary (first leg and drop-off legs included) fits the time budget.
 *
 *  3. **Marginal-detour insertion** ({@link bestInsertion}) — a stop is placed at
 *     the itinerary position that adds the least cost under the explicit
 *     {@link objectiveCost}, with the hub pinned at the end (inbound) or start
 *     (outbound) of the itinerary, which is what makes the metric automatically
 *     prefer stops lying along the corridor. Inbound and outbound are one
 *     parameterised code path. The batch loop ({@link InsertionDispatcher}) scores
 *     every stop against every vehicle with spare capacity — not only idle ones —
 *     and commits by regret-2.
 */

import { LatLng, SimConfig } from "./types";
import { objectiveCost, RouteParts, ZERO_PARTS } from "./objective";
import { haversine } from "@/services/routing";
import { TravelTimeProvider } from "@/services/travelTime";

// ── Itinerary representation ──

/**
 * One ordered entry of a proposed itinerary, before ETAs / load / display
 * geometry are materialised. Mirrors the shape of `PlanStop` minus the derived
 * fields — the dispatcher reasons in this lightweight form and the caller turns
 * the chosen plan into `PlanStop[]`.
 */
export interface LiteStop {
  kind: "pickup" | "dropoff" | "hub";
  position: LatLng;
  stopId: number | null;
  hubIndex: number | null;
  boarding: number[];
  alighting: number[];
}

function cloneLite(s: LiteStop): LiteStop {
  return { ...s, boarding: [...s.boarding], alighting: [...s.alighting] };
}

// ── Shipment model (Google Route Optimization `ShipmentModel`-shaped) ──
//
// This is the dispatcher's frozen input contract (issue #12). Every field maps
// to a Google Route Optimization `ShipmentModel` counterpart — see
// `docs/dispatch-shipment-model.md` and `serializeShipmentModel` in
// `./shipmentModel.ts`, which the golden-file test locks. Swapping in an
// OR-Tools / Route Optimization backend is a field-mapping exercise, not an
// engine rewrite.

/** Per-rider promise data a feasibility check needs. */
export interface RiderMeta {
  tRequest: number;
  directTimeMin: number;
  maxRideTimeMin: number;
  promisedPickupBy: number;
  walkKm: number;
  /** Sim-minute this rider physically boarded; null if not yet aboard. */
  boardedAt: number | null;
}

/**
 * One place a vehicle may perform a visit for a shipment. A shipment carrying
 * more than one pickup `VisitRequest` is Google's way of expressing alternative
 * pickup locations; the insertion dispatcher only reads `[0]`, but the contract
 * carries the array so a solver adapter does not have to reshape it.
 */
export interface VisitRequest {
  location: LatLng;
  /** Latest sim-minute this visit may occur; null = unconstrained. */
  timeWindowEnd: number | null;
}

export interface Shipment {
  /** Virtual-stop id this shipment corresponds to (Google: `label`). */
  id: number;
  direction: "inbound" | "outbound";
  hubIndex: number;
  /** Pickup alternatives — the stop for inbound, the hub for outbound. `[0]` is used. */
  pickups: VisitRequest[];
  /** Delivery alternatives — the hub for inbound, the stop for outbound. `[0]` is used. */
  deliveries: VisitRequest[];
  /** Load demand — rider count (Google: `loadDemands`). */
  load: number;
  riderIds: number[];
  /**
   * Absolute detour limit: tightest max ride time over the shipment's riders, in
   * minutes (Google: `pickupToDeliveryAbsoluteDetourLimit`).
   */
  maxRideTimeMin: number;
  /**
   * Relative detour limit: tightest `maxRideTime / directTime − 1` over the
   * shipment's riders (Google: `pickupToDeliveryRelativeDetourLimit`). Carried
   * explicitly so an adapter never has to back it out of two other fields.
   */
  relativeDetourLimit: number;
  /**
   * Cost charged to a solution that leaves this shipment unperformed (Google:
   * `penaltyCost`). Sourced from `config.objective.unservedPenalty × load`.
   */
  penaltyCost: number;
}

/** Convenience accessors — the insertion dispatcher serves the first alternative. */
export function shipmentPickup(sh: Shipment): LatLng {
  return sh.pickups[0].location;
}
export function shipmentDelivery(sh: Shipment): LatLng {
  return sh.deliveries[0].location;
}

export interface Vehicle {
  id: number;
  /** Seat capacity (Google: `loadLimits`). */
  loadLimit: number;
  position: LatLng;
  /** Rider ids currently aboard. */
  onboard: number[];
  /** Remaining committed itinerary in lite form; [] means idle. */
  plan: LiteStop[];
  /** Cost per vehicle-km driven (Google: `costPerKilometer`). */
  costPerKm: number;
  /** Cost per vehicle-hour elapsed (Google: `costPerHour`). */
  costPerHour: number;
  /** Flat cost of using this vehicle at all (Google: `fixedCost`). */
  fixedCost: number;
}

export interface DispatchRequest {
  shipments: Shipment[];
  vehicles: Vehicle[];
  /** Per-rider promise data for every rider referenced by a shipment or aboard a vehicle. */
  riders: Map<number, RiderMeta>;
  now: number;
}

export interface VehicleAssignment {
  vehicleId: number;
  /** Shipment (== virtual-stop) ids newly assigned to this vehicle this batch. */
  stopIds: number[];
  /** The vehicle's full new remaining itinerary. */
  lite: LiteStop[];
}

export interface DispatchResult {
  assignments: VehicleAssignment[];
  /**
   * Shipment ids no vehicle could feasibly take this batch (Google:
   * `skippedShipments`). They stay open for the next batch; a caller scoring a
   * whole solution prices each at its `penaltyCost`.
   */
  skippedShipmentIds: number[];
}

export interface Dispatcher {
  readonly name: string;
  dispatch(
    req: DispatchRequest,
    config: SimConfig,
    provider: TravelTimeProvider
  ): Promise<DispatchResult>;
}

// ── Feasibility + ETA simulation ──

/** Which feasibility invariant a rejected itinerary broke. */
export type InfeasibilityReason =
  | "capacity"
  | "load-negative"
  | "pickup-window"
  | "max-ride"
  | "time-budget";

export interface ItinerarySim {
  /** Absolute sim-minute the vehicle reaches each stop (ceil of continuous arrival). */
  etas: number[];
  /** Onboard count leaving each stop. */
  loads: number[];
  parts: RouteParts;
  feasible: boolean;
  /** Which invariant failed, when `feasible` is false. */
  reason: InfeasibilityReason | null;
}

function dwellFor(stop: LiteStop, config: SimConfig): number {
  return stop.boarding.length > 0
    ? config.dwellPickupMin + config.dwellPickupPerRiderMin * stop.boarding.length
    : config.dwellDropoffMin;
}

/**
 * One forward walk over `lite` from the vehicle's current position. Fills ETAs
 * and the load profile, tallies the objective's measured quantities, and checks
 * every feasibility invariant. Pure and synchronous — the travel-time provider
 * is only ever read through `provider.time`.
 */
export function simulateItinerary(
  position: LatLng,
  onboard: number[],
  lite: LiteStop[],
  riders: Map<number, RiderMeta>,
  config: SimConfig,
  now: number,
  provider: TravelTimeProvider,
  capacity: number
): ItinerarySim {
  const etas: number[] = [];
  const loads: number[] = [];
  const boardEta = new Map<number, number>();
  const alightEta = new Map<number, number>();
  for (const id of onboard) boardEta.set(id, riders.get(id)?.boardedAt ?? now);

  let cur = position;
  let t = now;
  let load = onboard.length;
  let km = 0;
  let waitMin = 0;
  let walkKm = 0;
  let reason: InfeasibilityReason | null = null;

  for (const st of lite) {
    const legMin = provider.time(cur, st.position, t);
    km += haversine(cur, st.position) * config.detourFactor;
    t += legMin + dwellFor(st, config);
    const eta = Math.ceil(t);
    etas.push(eta);

    for (const id of st.boarding) {
      boardEta.set(id, eta);
      const m = riders.get(id);
      if (m) {
        waitMin += Math.max(0, eta - m.tRequest);
        walkKm += m.walkKm;
        if (reason === null && eta > m.promisedPickupBy) reason = "pickup-window";
      }
    }
    for (const id of st.alighting) alightEta.set(id, eta);

    load += st.boarding.length - st.alighting.length;
    loads.push(load);
    if (reason === null && load > capacity) reason = "capacity";
    if (reason === null && load < 0) reason = "load-negative";

    cur = st.position;
  }

  let excessRideMin = 0;
  for (const [id, ae] of alightEta) {
    const be = boardEta.get(id);
    const m = riders.get(id);
    if (be == null || !m) continue;
    const ride = ae - be;
    excessRideMin += Math.max(0, ride - m.directTimeMin);
    if (reason === null && ride > m.maxRideTimeMin) reason = "max-ride";
  }

  const lastEta = etas.length ? etas[etas.length - 1] : now;
  if (reason === null && lastEta - now > config.timeBudgetMinutes) reason = "time-budget";

  return {
    etas,
    loads,
    parts: { km, hours: (t - now) / 60, waitMin, excessRideMin, walkKm, unserved: 0 },
    feasible: reason === null,
    reason,
  };
}

// ── Marginal-detour insertion ──

/** Non-hub stop count — the quantity `maxStopsPerRoute` bounds. */
function pickupStops(lite: LiteStop[]): number {
  return lite.filter((s) => s.kind !== "hub").length;
}

function planDirection(lite: LiteStop[]): "inbound" | "outbound" | null {
  if (lite.length === 0) return null;
  return lite[0].kind === "hub" ? "outbound" : "inbound";
}

function planHubIndex(lite: LiteStop[]): number | null {
  const hub = lite.find((s) => s.kind === "hub");
  return hub ? hub.hubIndex : null;
}

/**
 * Cheapest feasible position to insert `sh` into `vehicle`'s current itinerary,
 * scored as the increase in {@link objectiveCost} over the itinerary without it.
 * Returns null when no position is feasible.
 *
 * Inbound: the itinerary ends at the hub; the pickup goes at every position
 * before it. Outbound: the itinerary starts at the hub; the drop-off goes at
 * every position after it. One code path, mirrored.
 */
export function bestInsertion(
  vehicle: Vehicle,
  sh: Shipment,
  riders: Map<number, RiderMeta>,
  config: SimConfig,
  now: number,
  provider: TravelTimeProvider
): { cost: number; lite: LiteStop[] } | null {
  const working = vehicle.plan;
  const w = config.objective;

  const baseParts: RouteParts =
    working.length > 0
      ? simulateItinerary(
          vehicle.position,
          vehicle.onboard,
          working,
          riders,
          config,
          now,
          provider,
          vehicle.loadLimit
        ).parts
      : ZERO_PARTS;
  const baseCost = objectiveCost(baseParts, w);

  const candidates: LiteStop[][] = [];

  if (sh.direction === "inbound") {
    const pickup: LiteStop = {
      kind: "pickup",
      position: shipmentPickup(sh),
      stopId: sh.id,
      hubIndex: sh.hubIndex,
      boarding: [...sh.riderIds],
      alighting: [],
    };
    if (working.length === 0) {
      const hub: LiteStop = {
        kind: "hub",
        position: shipmentDelivery(sh),
        stopId: null,
        hubIndex: sh.hubIndex,
        boarding: [],
        alighting: [...sh.riderIds],
      };
      candidates.push([pickup, hub]);
    } else {
      // working === [...pickups, hub]; insert before the trailing hub visit
      const hubPos = working.length - 1;
      for (let i = 0; i <= hubPos; i++) {
        const next = working.map(cloneLite);
        next[hubPos].alighting.push(...sh.riderIds);
        candidates.push([...next.slice(0, i), cloneLite(pickup), ...next.slice(i)]);
      }
    }
  } else {
    const delivery: LiteStop = {
      kind: "dropoff",
      position: shipmentDelivery(sh),
      stopId: sh.id,
      hubIndex: sh.hubIndex,
      boarding: [],
      alighting: [...sh.riderIds],
    };
    if (working.length === 0) {
      const hub: LiteStop = {
        kind: "hub",
        position: shipmentPickup(sh),
        stopId: null,
        hubIndex: sh.hubIndex,
        boarding: [...sh.riderIds],
        alighting: [],
      };
      candidates.push([hub, delivery]);
    } else {
      // working === [hub, ...deliveries]; board at the leading hub, insert after it
      for (let i = 1; i <= working.length; i++) {
        const next = working.map(cloneLite);
        next[0].boarding.push(...sh.riderIds);
        candidates.push([...next.slice(0, i), cloneLite(delivery), ...next.slice(i)]);
      }
    }
  }

  let best: { cost: number; lite: LiteStop[] } | null = null;
  for (const lite of candidates) {
    if (pickupStops(lite) > config.maxStopsPerRoute) continue;
    const sim = simulateItinerary(
      vehicle.position,
      vehicle.onboard,
      lite,
      riders,
      config,
      now,
      provider,
      vehicle.loadLimit
    );
    if (!sim.feasible) continue;
    const cost = objectiveCost(sim.parts, w) - baseCost;
    if (best === null || cost < best.cost) best = { cost, lite };
  }
  return best;
}

// ── Batch dispatcher with regret-2 ──

interface Option {
  vehicleId: number;
  cost: number;
  lite: LiteStop[];
}

/**
 * Default dispatcher: marginal-detour insertion, batched with regret-2. No
 * external dependencies — it only reads the passed travel-time provider.
 */
export class InsertionDispatcher implements Dispatcher {
  readonly name = "insertion";

  async dispatch(
    req: DispatchRequest,
    config: SimConfig,
    provider: TravelTimeProvider
  ): Promise<DispatchResult> {
    // Mutable working itinerary per vehicle, seeded from its committed plan.
    const working = new Map<number, Vehicle>(
      req.vehicles.map((v) => [v.id, { ...v, plan: v.plan.map(cloneLite) }])
    );
    const shById = new Map(req.shipments.map((s) => [s.id, s]));
    const remaining = new Set(req.shipments.map((s) => s.id));
    const assignedTo = new Map<number, number>(); // shipmentId -> vehicleId
    const touched = new Set<number>();

    const computeOptions = (sid: number): Option[] => {
      const sh = shById.get(sid)!;
      const opts: Option[] = [];
      for (const v of working.values()) {
        if (sh.load > v.loadLimit) continue; // loose gate; the load profile is the real check
        const dir = planDirection(v.plan);
        if (dir !== null && dir !== sh.direction) continue;
        const hub = planHubIndex(v.plan);
        if (hub !== null && hub !== sh.hubIndex) continue;
        const bi = bestInsertion(v, sh, req.riders, config, req.now, provider);
        if (bi) opts.push({ vehicleId: v.id, cost: bi.cost, lite: bi.lite });
      }
      opts.sort((a, b) => a.cost - b.cost);
      return opts;
    };

    const cache = new Map<number, Option[]>();
    for (const sid of remaining) cache.set(sid, computeOptions(sid));

    for (;;) {
      let pick: { sid: number; opt: Option; regret: number } | null = null;
      for (const sid of remaining) {
        const opts = cache.get(sid)!;
        if (opts.length === 0) continue;
        const regret = opts.length > 1 ? opts[1].cost - opts[0].cost : Infinity;
        if (
          pick === null ||
          regret > pick.regret ||
          (regret === pick.regret && opts[0].cost < pick.opt.cost)
        ) {
          pick = { sid, opt: opts[0], regret };
        }
      }
      if (pick === null) break;

      const v = working.get(pick.opt.vehicleId)!;
      v.plan = pick.opt.lite;
      touched.add(v.id);
      assignedTo.set(pick.sid, v.id);
      remaining.delete(pick.sid);
      cache.delete(pick.sid);

      // Only shipments that had this vehicle as an option can be affected.
      for (const sid of remaining) {
        if (cache.get(sid)!.some((o) => o.vehicleId === v.id)) {
          cache.set(sid, computeOptions(sid));
        }
      }
    }

    const assignments: VehicleAssignment[] = [];
    for (const vid of touched) {
      assignments.push({
        vehicleId: vid,
        lite: working.get(vid)!.plan,
        stopIds: [...assignedTo].filter(([, v]) => v === vid).map(([s]) => s),
      });
    }
    return { assignments, skippedShipmentIds: [...remaining].sort((a, b) => a - b) };
  }
}
