import { describe, it, expect } from "vitest";
import { createInitialState, simulateStep, injectRequest } from "./simulator";
import { DEFAULT_CONFIG, SimConfig, SimState } from "./types";

const HUB = { lat: 34.0522, lng: -118.2437 }; // Downtown LA

function base(overrides: Partial<SimConfig> = {}): { state: SimState; config: SimConfig } {
  const config: SimConfig = { ...DEFAULT_CONFIG, seed: 999, ...overrides };
  const state = createInitialState(config);
  state.dropOffHubs = [HUB];
  return { state, config };
}

describe("injectRequest", () => {
  it("classifies a manual request by the same rules as generated riders", () => {
    const { state, config } = base();
    // origin ~2km from downtown, destination on the hub → inbound
    const origin = { lat: 34.07, lng: -118.25 };
    const { state: next, requestId } = injectRequest(state, config, origin, HUB);
    const r = next.requests[requestId];
    expect(r.tRequest).toBe(state.time);
    expect(r.direction).toBe("inbound");
    expect(r.hubIndex).toBe(0);
    expect(r.status).toBe("pending");
    expect(r.promisedPickupBy).toBe(state.time + config.maxWaitMinutes);
    expect(next.metrics.totalRequests).toBe(1);
  });

  it("marks a request unserved when neither end sits in a hub catchment", () => {
    const { state, config } = base({ hubCatchmentKm: 1 });
    const { state: next, requestId } = injectRequest(
      state,
      config,
      { lat: 33.95, lng: -118.45 },
      { lat: 34.14, lng: -118.16 }
    );
    expect(next.requests[requestId].direction).toBe("unserved");
    expect(next.requests[requestId].status).toBe("unserved");
  });

  it("joins the same stop formation on the next tick", async () => {
    const { state, config } = base({ avgRequestsPerMin: 0 });
    const origin = { lat: 34.07, lng: -118.25 };
    const { state: injected, requestId } = injectRequest(state, config, origin, HUB);
    const after = await simulateStep(injected, config);
    const r = after.requests[requestId];
    expect(r.assignedStop).not.toBeNull();
    expect(r.walkDistanceKm).not.toBeNull();
    expect(after.stops[r.assignedStop!].riderIds).toContain(requestId);
  });

  it("does not perturb the seeded RNG stream", () => {
    const { state, config } = base();
    const { state: injected } = injectRequest(state, config, { lat: 34.07, lng: -118.25 }, HUB);
    expect(injected.rngState).toBe(state.rngState);
  });
});
