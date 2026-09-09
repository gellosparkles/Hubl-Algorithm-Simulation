import { describe, it, expect } from "vitest";
import { createInitialState, simulateStep, injectRequest } from "@/engine/simulator";
import { DEFAULT_CONFIG, SimConfig } from "@/engine/types";
import { trackedRider } from "./trackedRider";

const HUB = { lat: 34.0522, lng: -118.2437 };

async function runWithManualRider() {
  const config: SimConfig = { ...DEFAULT_CONFIG, seed: 1, numBuses: 12, maxWaitMinutes: 20, timeBudgetMinutes: 45 };
  let s = createInitialState(config);
  s.dropOffHubs = [HUB];
  for (let i = 0; i < 3; i++) s = await simulateStep(s, config);
  const { state, requestId } = injectRequest(s, config, { lat: 34.065, lng: -118.25 }, HUB);
  s = state;
  for (let i = 0; i < 4; i++) s = await simulateStep(s, config);
  return { s, requestId, config };
}

describe("trackedRider", () => {
  it("returns null for an unknown rider", () => {
    const s = createInitialState(DEFAULT_CONFIG);
    expect(trackedRider(s, null)).toBeNull();
    expect(trackedRider(s, 999)).toBeNull();
  });

  it("surfaces the promise: stop, walk, promised pickup, bus and ETAs", async () => {
    const { s, requestId } = await runWithManualRider();
    const view = trackedRider(s, requestId)!;
    expect(view.riderId).toBe(requestId);
    expect(view.assignedStopId).not.toBeNull();
    expect(view.walkDistanceKm).not.toBeNull();
    expect(view.promisedPickupByMin).toBeGreaterThan(0);
    // With a 12-bus fleet and a generous wait window this rider gets routed.
    expect(view.assignedBusId).not.toBeNull();
    expect(view.pickupEtaMin).not.toBeNull();
    expect(view.dropoffEtaMin).not.toBeNull();
    expect(view.dropoffEtaMin!).toBeGreaterThanOrEqual(view.pickupEtaMin!);
    expect(view.minutesToPickup).not.toBeNull();
  });
});
