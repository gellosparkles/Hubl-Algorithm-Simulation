// ── Core simulation types ──

export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * One ordered stop on a bus's itinerary. Replaces the old parallel
 * route/routeEtas/routePolylines/decodedLegs arrays plus the `available` flag
 * and `busyUntil` back-derivation. Hub visits are entries here — never fake
 * negative-id stops in the shared stop map (see issue #4).
 */
export interface PlanStop {
  kind: "pickup" | "dropoff" | "hub";
  position: LatLng;
  stopId: number | null; // null for hub visits
  hubIndex: number | null;
  boarding: number[]; // rider ids getting on here
  alighting: number[]; // rider ids getting off here
  etaMin: number; // absolute sim minute the bus reaches this stop
  loadAfter: number; // onboard count when the bus departs this stop
  polyline: string; // encoded polyline for the leg arriving here (display only)
  legPath: LatLng[]; // decoded path for the leg arriving here (display only)
}

export interface Bus {
  id: number;
  position: LatLng;
  capacity: number;
  speed: number; // km/h
  plan: PlanStop[]; // remaining itinerary; [] means idle
  legIndex: number; // which leg of `plan` the bus is currently traversing
  legStartedAt: number; // absolute sim minute the current leg began
  onboard: number[]; // rider ids
  positionHistory: LatLng[]; // trail of past positions
}

/**
 * A request's relationship to its anchor hub, decided from real geography at
 * request time (never random). See src/engine/tripModel.ts.
 *  - inbound:  collect near the origin, deliver to the hub
 *  - outbound: board at the hub, alight near the destination
 *  - unserved: neither end sits inside a hub catchment — a first-class KPI
 *              outcome, not a rider left pending forever
 */
export type TripDirection = "inbound" | "outbound" | "unserved";

export interface RiderRequest {
  id: number;
  tRequest: number; // minute submitted
  origin: LatLng;
  destination: LatLng;
  direction: TripDirection;
  hubIndex: number | null; // anchor hub — derived from geography, never random
  assignedStop: number | null;
  assignedBus: number | null;
  status: "pending" | "picked_up" | "completed" | "unserved";
  walkDistanceKm: number | null;
  // ── lifecycle timestamps (sim minute; null until the transition happens) ──
  tAssigned: number | null;
  tPickedUp: number | null; // sim minute the bus physically reached the rider's stop
  tDroppedOff: number | null;
  // ── promise fields feasibility work (#4, #5) depends on ──
  promisedPickupBy: number; // tRequest + maxWaitMinutes
  directTimeMin: number; // provider.time(origin, destination) at tRequest
  maxRideTimeMin: number; // directTimeMin * rideTimeFactor + rideTimeSlackMin
}

export interface VirtualStop {
  id: number;
  /** `(gridCellId, direction, hubIndex)` composite — stable across ticks; a later
   *  rider in the same cell joins this stop rather than spawning a duplicate (issue #5). */
  groupKey: string;
  direction: TripDirection;
  position: LatLng;
  riderIds: number[];
  createdAt: number;
  assignedBus: number | null;
  status: "open" | "assigned";
  dropOffHubIndex: number | null; // which drop-off hub riders go to
}

/**
 * A single daily peak window, in minutes-since-midnight (wrapped mod 1440),
 * during which travel is slower. See TravelTimeProvider in services/travelTime.ts.
 */
export interface SpeedProfile {
  offPeakKmh: number;
  peakKmh: number;
  peakStartMin: number;
  peakEndMin: number;
}

export interface SimConfig {
  bounds: { latMin: number; latMax: number; lngMin: number; lngMax: number };
  numBuses: number;
  avgRequestsPerMin: number;
  simMinutes: number;
  busCapacity: number;
  /** @deprecated unused — travel time comes from SpeedProfile / TravelTimeProvider. Bus.speed still reads this but nothing reads Bus.speed. */
  busSpeed: number;
  maxWalkKm: number;
  minGroupSize: number;
  maxStopsPerRoute: number;
  timeBudgetMinutes: number;
  maxWaitMinutes: number;
  useGoogleRouting: boolean;
  googleApiKey: string;
  /** Street-network circuity factor applied to haversine distance (LA grid ≈ 1.35). */
  detourFactor: number;
  /** Time-of-day speed profile used by the default TravelTimeProvider. */
  speedProfile: SpeedProfile;
  /** A request end must be within this many km of a hub to anchor to it (tripModel classification). */
  hubCatchmentKm: number;
  /** Promised max ride time = directTimeMin * rideTimeFactor + rideTimeSlackMin. */
  rideTimeFactor: number;
  rideTimeSlackMin: number;
  /** Fixed RNG seed for reproducible runs; null draws a fresh seed each reset. */
  seed: number | null;
}

/**
 * KPI set computed from rider lifecycle timestamps and per-tick vehicle
 * accounting (see src/engine/metrics.ts). Everything here is derived inside the
 * engine — a caller never re-derives a metric by polling rider status.
 */
export interface SimMetrics {
  /** Plain incrementing counter — never string-matched out of the event log. */
  busAssignments: number;
  completed: number;
  pending: number;
  pickedUp: number;
  /** Requests classified `unserved` at request time — reported distinctly from riders still waiting. */
  unserved: number;
  /** Pending riders never matched to a bus and already past their promised pickup time. Distinct from `unserved`. */
  expired: number;
  totalRequests: number;
  totalStops: number;
  /** completed / totalRequests */
  serviceRate: number;
  /** share of ever-boarded riders who were aboard a bus alongside ≥1 other rider */
  poolingRate: number;
  /** request → physical boarding (`tPickedUp − tRequest`), minutes */
  waitP50Min: number | null;
  waitP90Min: number | null;
  /** boarding → alighting (`tDroppedOff − tPickedUp`), minutes */
  inVehicleP50Min: number | null;
  inVehicleP90Min: number | null;
  /** mean of `(tDroppedOff − tPickedUp) / directTimeMin` over completed riders */
  detourRatioMean: number | null;
  /** total km driven, accumulated per tick (survives the positionHistory cap) */
  vehicleKm: number;
  /** share of vehicleKm driven with an empty bus */
  deadheadShare: number;
  /** mean onboard riders, weighted by travel time */
  meanOccupancy: number;
  /** mean `walkDistanceKm` over riders assigned a stop */
  meanWalkKm: number | null;
}

/**
 * Running totals the per-tick loop accumulates so time-weighted and
 * path-integrated KPIs survive `structuredClone` and the positionHistory cap.
 * Reset by `createInitialState`; read by `computeMetrics`.
 */
export interface KpiAccumulators {
  vehicleKm: number;
  /** Subset of vehicleKm driven on ticks the bus was empty start-to-end. */
  deadheadKm: number;
  /** Σ onboard riders over every traveling bus-minute (mean-occupancy numerator). */
  personMinutes: number;
  /** Count of traveling bus-minutes (mean-occupancy denominator). */
  travelMinutes: number;
  /** Rider ids that were aboard a bus at the same time as ≥1 other rider. A Set,
   *  so membership stays O(1) over a long run; it survives `structuredClone`. */
  pooledRiderIds: Set<number>;
  /** Route assignments so far — the source of `SimMetrics.busAssignments`. */
  assignments: number;
}

export interface SimState {
  time: number;
  buses: Record<number, Bus>;
  requests: Record<number, RiderRequest>;
  stops: Record<number, VirtualStop>;
  dropOffHubs: LatLng[]; // user-placed drop-off locations (up to 10)
  eventLog: string[];
  metrics: SimMetrics;
  running: boolean;
  rngState: number; // mulberry32 state — advances every step, clones cleanly
  kpi: KpiAccumulators; // running totals for time-weighted / path-integrated KPIs
  /**
   * Sticky across the run: true once any tick's TravelTimeProvider fell back
   * (e.g. Google → haversine). A fresh provider is created every tick (see
   * simulator.ts), so this is the only place a caller can learn whether the
   * *actual dispatch* ever degraded — a per-tick provider's own `degraded`
   * flag doesn't survive past that tick.
   */
  travelTimeProviderDegraded: boolean;
}

// LA metro bounding box
export const LA_BOUNDS = {
  latMin: 33.90,
  latMax: 34.15,
  lngMin: -118.50,
  lngMax: -118.15,
};

export const DEFAULT_CONFIG: SimConfig = {
  bounds: LA_BOUNDS,
  numBuses: 8,
  avgRequestsPerMin: 6,
  simMinutes: 60,
  busCapacity: 12,
  busSpeed: 35,
  maxWalkKm: 0.5,
  minGroupSize: 1,
  maxStopsPerRoute: 5,
  timeBudgetMinutes: 25,
  maxWaitMinutes: 10,
  useGoogleRouting: false,
  googleApiKey: "",
  detourFactor: 1.35,
  speedProfile: { offPeakKmh: 32, peakKmh: 18, peakStartMin: 420, peakEndMin: 600 },
  hubCatchmentKm: 8,
  rideTimeFactor: 1.5,
  rideTimeSlackMin: 5,
  seed: null,
};
