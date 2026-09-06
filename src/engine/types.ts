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
  incentive: number;
}

export interface VirtualStop {
  id: number;
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

export interface SimMetrics {
  busAssignments: number;
  completed: number;
  pending: number;
  pickedUp: number;
  /** Requests classified `unserved` at request time — reported distinctly from riders still waiting. */
  unserved: number;
  totalRequests: number;
  totalStops: number;
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
  minGroupSize: 2,
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
