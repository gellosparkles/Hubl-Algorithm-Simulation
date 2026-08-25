// ── Core simulation types ──

export interface LatLng {
  lat: number;
  lng: number;
}

export interface Bus {
  id: number;
  position: LatLng;
  routeStartPosition: LatLng; // position when route was assigned
  capacity: number;
  speed: number; // km/h
  available: boolean;
  route: number[]; // stop ids
  routeEtas: number[]; // cumulative ETA per stop (minutes)
  routePolylines: string[]; // encoded polylines per leg
  decodedLegs: LatLng[][]; // decoded road points per leg
  onboard: number[]; // rider ids
  busyUntil: number; // sim minute when route completes
  positionHistory: LatLng[]; // trail of past positions
}

export interface RiderRequest {
  id: number;
  tRequest: number; // minute submitted
  origin: LatLng;
  destination: LatLng;
  assignedStop: number | null;
  assignedBus: number | null;
  status: "pending" | "picked_up" | "completed";
  walkDistanceKm: number | null;
  incentive: number;
}

export interface VirtualStop {
  id: number;
  position: LatLng;
  riderIds: number[];
  createdAt: number;
  assignedBus: number | null;
  status: "open" | "assigned" | "dropoff";
  dropOffHubIndex: number | null; // which drop-off hub riders go to
  isDropOff?: boolean; // true if this "stop" is actually a drop-off destination
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
  /** @deprecated no longer used for travel-time estimates — see SpeedProfile / TravelTimeProvider. Still seeds Bus.speed. */
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
  /** Fixed RNG seed for reproducible runs; null draws a fresh seed each reset. */
  seed: number | null;
}

export interface SimMetrics {
  busAssignments: number;
  completed: number;
  pending: number;
  pickedUp: number;
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
  seed: null,
};
