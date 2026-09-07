/**
 * Turns a dispatcher's chosen `LiteStop[]` itinerary into a materialised
 * `PlanStop[]` the simulator can drive: real ETAs and load profile from
 * {@link simulateItinerary}, plus per-leg display geometry (road-snapped when
 * Google routing is on, an L-shaped grid path otherwise).
 *
 * Display geometry never affects timing — that always comes from the
 * TravelTimeProvider, same contract the retired planner module held.
 */

import { LatLng, PlanStop, SimConfig } from "@/engine/types";
import { LiteStop, RiderMeta, simulateItinerary } from "@/engine/dispatch";
import { getDirections } from "@/services/routing";
import { TravelTimeProvider } from "@/services/travelTime";

/** Straight L-shaped grid path, used for display when no road geometry is available. */
function gridPath(from: LatLng, to: LatLng): LatLng[] {
  return [{ ...from }, { lat: from.lat, lng: to.lng }, { ...to }];
}

async function resolveLeg(
  from: LatLng,
  to: LatLng,
  config: SimConfig
): Promise<{ polyline: string; legPath: LatLng[] }> {
  let polyline = "";
  let legPath: LatLng[] = [];
  if (config.useGoogleRouting && config.googleApiKey) {
    try {
      const dir = await getDirections(from, to, config.googleApiKey, true);
      polyline = dir.polyline;
      legPath = dir.decodedPath;
    } catch {
      // fall through to the grid path
    }
  }
  if (legPath.length < 2) legPath = gridPath(from, to);
  return { polyline, legPath };
}

export interface MaterializedItinerary {
  plan: PlanStop[];
  feasible: boolean;
  reason: string | null;
}

export async function materializeItinerary(
  bus: { position: LatLng; onboard: number[]; capacity: number },
  lite: LiteStop[],
  riders: Map<number, RiderMeta>,
  config: SimConfig,
  now: number,
  provider: TravelTimeProvider
): Promise<MaterializedItinerary> {
  const sim = simulateItinerary(
    bus.position,
    bus.onboard,
    lite,
    riders,
    config,
    now,
    provider,
    bus.capacity
  );

  const plan: PlanStop[] = [];
  let cur = bus.position;
  for (let i = 0; i < lite.length; i++) {
    const st = lite[i];
    const { polyline, legPath } = await resolveLeg(cur, st.position, config);
    plan.push({
      kind: st.kind,
      position: { ...st.position },
      stopId: st.stopId,
      hubIndex: st.hubIndex,
      boarding: [...st.boarding],
      alighting: [...st.alighting],
      etaMin: sim.etas[i],
      loadAfter: sim.loads[i],
      polyline,
      legPath,
    });
    cur = st.position;
  }

  return { plan, feasible: sim.feasible, reason: sim.reason };
}
