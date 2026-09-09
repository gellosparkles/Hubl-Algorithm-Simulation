/**
 * The dispatcher's input contract, serialised (issue #12, plan.md Phase 5).
 *
 * {@link serializeShipmentModel} projects a runtime {@link DispatchRequest} onto
 * a plain, deterministic, JSON-serialisable object whose field names mirror
 * Google Route Optimization's `ShipmentModel` / `OptimizeToursRequest`. This is
 * the shape a solver adapter (OR-Tools, Google Route Optimization) would map
 * from — see `docs/dispatch-shipment-model.md` for the field-by-field mapping
 * and what an adapter still has to supply.
 *
 * The golden-file test (`shipmentModel.test.ts`) locks this output: any
 * unreviewed change to the contract's shape fails there.
 */

import { DispatchRequest } from "./dispatch";
import { LatLng, SimConfig } from "./types";

export interface SerializedVisitRequest {
  arrivalLocation: { latitude: number; longitude: number };
  /** Sim-minute offset from `now`; omitted when unconstrained. */
  timeWindowEndMinutes?: number;
}

export interface SerializedShipment {
  label: string;
  direction: "inbound" | "outbound";
  pickups: SerializedVisitRequest[];
  deliveries: SerializedVisitRequest[];
  loadDemands: { riders: { amount: number } };
  pickupToDeliveryAbsoluteDetourLimitMinutes: number;
  pickupToDeliveryRelativeDetourLimit: number;
  penaltyCost: number;
}

export interface SerializedVehicle {
  label: string;
  loadLimits: { riders: { maxLoad: number } };
  costPerKilometer: number;
  costPerHour: number;
  fixedCost: number;
  startLocation: { latitude: number; longitude: number };
  /** Rider ids already aboard — solver state a fresh `ShipmentModel` cannot carry. */
  onboardRiderIds: number[];
  committedVisits: number;
}

export interface SerializedShipmentModel {
  nowMinutes: number;
  globalDurationBudgetMinutes: number;
  shipments: SerializedShipment[];
  vehicles: SerializedVehicle[];
}

function loc(p: { lat: number; lng: number }) {
  return { latitude: p.lat, longitude: p.lng };
}

const round = (n: number) => (Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : n);

export function serializeShipmentModel(
  req: DispatchRequest,
  config: SimConfig
): SerializedShipmentModel {
  const rel = (v: number | null) => (v == null ? undefined : round(v - req.now));
  const visitReq = (vr: { location: LatLng; timeWindowEnd: number | null }): SerializedVisitRequest => {
    const out: SerializedVisitRequest = { arrivalLocation: loc(vr.location) };
    const tw = rel(vr.timeWindowEnd);
    if (tw !== undefined) out.timeWindowEndMinutes = tw;
    return out;
  };

  const shipments: SerializedShipment[] = [...req.shipments]
    .sort((a, b) => a.id - b.id)
    .map((sh) => ({
      label: `stop-${sh.id}`,
      direction: sh.direction,
      pickups: sh.pickups.map(visitReq),
      deliveries: sh.deliveries.map(visitReq),
      loadDemands: { riders: { amount: sh.load } },
      pickupToDeliveryAbsoluteDetourLimitMinutes: round(sh.maxRideTimeMin),
      pickupToDeliveryRelativeDetourLimit: round(sh.relativeDetourLimit),
      penaltyCost: round(sh.penaltyCost),
    }));

  const vehicles: SerializedVehicle[] = [...req.vehicles]
    .sort((a, b) => a.id - b.id)
    .map((v) => ({
      label: `bus-${v.id}`,
      loadLimits: { riders: { maxLoad: v.loadLimit } },
      costPerKilometer: round(v.costPerKm),
      costPerHour: round(v.costPerHour),
      fixedCost: round(v.fixedCost),
      startLocation: loc(v.position),
      onboardRiderIds: [...v.onboard].sort((a, b) => a - b),
      committedVisits: v.plan.length,
    }));

  return {
    nowMinutes: req.now,
    globalDurationBudgetMinutes: config.timeBudgetMinutes,
    shipments,
    vehicles,
  };
}
