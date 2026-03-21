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
  status: "open" | "assigned";
}

export interface SimConfig {
  bounds: { latMin: number; latMax: number; lngMin: number; lngMax: number };
  numBuses: number;
  avgRequestsPerMin: number;
  simMinutes: number;
  busCapacity: number;
  maxWalkKm: number;
  minGroupSize: number;
  maxStopsPerRoute: number;
  timeBudgetMinutes: number;
  maxWaitMinutes: number;
  useGoogleRouting: boolean;
  googleApiKey: string;
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
  eventLog: string[];
  metrics: SimMetrics;
  running: boolean;
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
  maxWalkKm: 0.5,
  minGroupSize: 2,
  maxStopsPerRoute: 5,
  timeBudgetMinutes: 25,
  maxWaitMinutes: 10,
  useGoogleRouting: false,
  googleApiKey: "",
};
