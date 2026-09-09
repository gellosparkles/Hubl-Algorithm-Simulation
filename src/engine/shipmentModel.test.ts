import { describe, it, expect } from "vitest";
import { DispatchRequest, RiderMeta, Shipment, Vehicle } from "./dispatch";
import { serializeShipmentModel } from "./shipmentModel";
import { DEFAULT_CONFIG, LatLng } from "./types";

/**
 * Golden-file contract test (issue #12). `serializeShipmentModel` is the frozen
 * shape a solver adapter maps from; the committed snapshot below fails on any
 * unreviewed change to that shape. Regenerate deliberately with `-u` and review
 * the diff against `docs/dispatch-shipment-model.md`.
 */

const hub: LatLng = { lat: 34.05, lng: -118.24 };
const stopA: LatLng = { lat: 34.06, lng: -118.21 };
const stopB: LatLng = { lat: 34.04, lng: -118.27 };

function rider(partial: Partial<RiderMeta> = {}): RiderMeta {
  return {
    tRequest: 8,
    directTimeMin: 10,
    maxRideTimeMin: 25,
    promisedPickupBy: 22,
    walkKm: 0.1,
    boardedAt: null,
    ...partial,
  };
}

function fixture(): DispatchRequest {
  const shipments: Shipment[] = [
    {
      id: 101,
      direction: "inbound",
      hubIndex: 0,
      pickups: [{ location: stopA, timeWindowEnd: 22 }],
      deliveries: [{ location: hub, timeWindowEnd: null }],
      load: 2,
      riderIds: [1, 2],
      maxRideTimeMin: 25,
      relativeDetourLimit: 1.5,
      penaltyCost: DEFAULT_CONFIG.objective.unservedPenalty * 2,
    },
    {
      id: 102,
      direction: "outbound",
      hubIndex: 0,
      pickups: [{ location: hub, timeWindowEnd: 20 }],
      deliveries: [{ location: stopB, timeWindowEnd: null }],
      load: 1,
      riderIds: [3],
      maxRideTimeMin: 30,
      relativeDetourLimit: 2,
      penaltyCost: DEFAULT_CONFIG.objective.unservedPenalty,
    },
  ];
  const vehicles: Vehicle[] = [
    {
      id: 1,
      loadLimit: 12,
      position: { lat: 34.07, lng: -118.19 },
      onboard: [],
      plan: [],
      costPerKm: DEFAULT_CONFIG.objective.costPerKm,
      costPerHour: DEFAULT_CONFIG.objective.costPerHour,
      fixedCost: 0,
    },
    {
      id: 2,
      loadLimit: 8,
      position: { lat: 34.05, lng: -118.24 },
      onboard: [7],
      plan: [
        { kind: "hub", position: hub, stopId: null, hubIndex: 0, boarding: [], alighting: [7] },
      ],
      costPerKm: DEFAULT_CONFIG.objective.costPerKm,
      costPerHour: DEFAULT_CONFIG.objective.costPerHour,
      fixedCost: 0,
    },
  ];
  const riders = new Map<number, RiderMeta>([
    [1, rider()],
    [2, rider({ maxRideTimeMin: 20 })],
    [3, rider()],
    [7, rider({ boardedAt: 5 })],
  ]);
  return { shipments, vehicles, riders, now: 10 };
}

describe("serializeShipmentModel — frozen contract", () => {
  it("matches the committed golden file", async () => {
    const model = serializeShipmentModel(fixture(), DEFAULT_CONFIG);
    await expect(JSON.stringify(model, null, 2) + "\n").toMatchFileSnapshot(
      "./__snapshots__/shipmentModel.golden.json"
    );
  });

  it("represents detour limits and the unperformed-shipment penalty explicitly", () => {
    const model = serializeShipmentModel(fixture(), DEFAULT_CONFIG);
    for (const sh of model.shipments) {
      expect(sh.pickupToDeliveryAbsoluteDetourLimitMinutes).toBeGreaterThan(0);
      expect(sh.pickupToDeliveryRelativeDetourLimit).toBeGreaterThanOrEqual(0);
      expect(sh.penaltyCost).toBeGreaterThan(0);
    }
    expect(model.shipments[0].penaltyCost).toBe(DEFAULT_CONFIG.objective.unservedPenalty * 2);
  });

  it("carries vehicle per-km / per-hour / fixed cost and onboard state", () => {
    const model = serializeShipmentModel(fixture(), DEFAULT_CONFIG);
    expect(model.vehicles[0].costPerKilometer).toBe(DEFAULT_CONFIG.objective.costPerKm);
    expect(model.vehicles[0].costPerHour).toBe(DEFAULT_CONFIG.objective.costPerHour);
    expect(model.vehicles[1].onboardRiderIds).toEqual([7]);
    expect(model.vehicles[1].committedVisits).toBe(1);
  });

  it("normalises visit time windows to a minute offset from `now`", () => {
    const model = serializeShipmentModel(fixture(), DEFAULT_CONFIG);
    // shipment 101 pickup window ends at sim-minute 22, now = 10
    expect(model.shipments[0].pickups[0].timeWindowEndMinutes).toBe(12);
    expect(model.shipments[0].deliveries[0].timeWindowEndMinutes).toBeUndefined();
  });
});
