/**
 * The single definition of "better" (issue #7, plan.md Phase 3c).
 *
 * One explicit objective scores a route. Insertion, regret scoring, benchmarks
 * and any future solver adapter all read from this function — there is no other
 * notion of route quality in the engine. It mirrors Google Route Optimization's
 * cost model: per-km and per-hour vehicle cost, plus weighted rider wait,
 * weighted excess ride time over the direct trip, weighted walking, and a flat
 * penalty per rider left unserved.
 */

/** Cost weights for {@link objectiveCost}. Every field is surfaced on `SimConfig.objective`. */
export interface ObjectiveWeights {
  /** Cost per vehicle-km driven. */
  costPerKm: number;
  /** Cost per vehicle-hour elapsed (dominant term — this is what makes insertion prefer corridor stops). */
  costPerHour: number;
  /** Cost per minute of rider wait (request → physical boarding). */
  waitWeight: number;
  /** Cost per minute a rider's actual ride exceeds their direct point-to-point time. */
  rideWeight: number;
  /** Cost per km a rider walks to their virtual stop. */
  walkWeight: number;
  /**
   * Flat penalty per rider left unserved. A committed route never carries
   * unserved riders, so marginal insertion never prices this — it is the
   * dispatch-level term, applied by a caller scoring a whole solution (the
   * benchmark harness, a future solver adapter) against `RouteParts.unserved`.
   */
  unservedPenalty: number;
}

export const DEFAULT_OBJECTIVE: ObjectiveWeights = {
  costPerKm: 1,
  costPerHour: 30,
  waitWeight: 2,
  rideWeight: 1,
  walkWeight: 4,
  unservedPenalty: 500,
};

/** The measured quantities of a (partial) route, before weighting. */
export interface RouteParts {
  /** Vehicle-km driven over the itinerary. */
  km: number;
  /** Vehicle-hours elapsed over the itinerary. */
  hours: number;
  /** Σ rider wait, minutes (request → boarding), over riders boarding in this route. */
  waitMin: number;
  /** Σ max(0, actualRide − directRide), minutes, over riders delivered in this route. */
  excessRideMin: number;
  /** Σ walk distance, km, over riders boarding in this route. */
  walkKm: number;
  /** Riders this route fails to serve. */
  unserved: number;
}

export const ZERO_PARTS: RouteParts = {
  km: 0,
  hours: 0,
  waitMin: 0,
  excessRideMin: 0,
  walkKm: 0,
  unserved: 0,
};

/** Weighted scalar cost of a route. Lower is better. Pure. */
export function objectiveCost(parts: RouteParts, w: ObjectiveWeights): number {
  return (
    w.costPerKm * parts.km +
    w.costPerHour * parts.hours +
    w.waitWeight * parts.waitMin +
    w.rideWeight * parts.excessRideMin +
    w.walkWeight * parts.walkKm +
    w.unservedPenalty * parts.unserved
  );
}
