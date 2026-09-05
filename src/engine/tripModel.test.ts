import { describe, it, expect } from "vitest";
import { classifyRequest } from "./tripModel";
import { DEFAULT_CONFIG, LatLng } from "./types";
import { createTravelTimeProvider } from "@/services/travelTime";

const provider = createTravelTimeProvider(DEFAULT_CONFIG);

const HUB_A: LatLng = { lat: 34.0522, lng: -118.2437 }; // Downtown LA
const HUB_B: LatLng = { lat: 34.0195, lng: -118.4912 }; // Santa Monica
const hubs = [HUB_A, HUB_B];

// A point ~10 km east of Downtown — well outside any catchment.
const FAR_EAST: LatLng = { lat: 34.0522, lng: -118.13 };
// A point ~15 km north — outside any catchment.
const FAR_NORTH: LatLng = { lat: 34.19, lng: -118.2437 };

function classify(origin: LatLng, destination: LatLng) {
  return classifyRequest(origin, destination, 0, hubs, DEFAULT_CONFIG, provider);
}

describe("classifyRequest", () => {
  it("classifies origin-far / destination-near-hub as inbound, anchored to the destination hub", () => {
    const c = classify(FAR_EAST, HUB_A);
    expect(c.direction).toBe("inbound");
    expect(c.hubIndex).toBe(0);
  });

  it("classifies origin-near-hub / destination-far as outbound, anchored to the origin hub", () => {
    const c = classify(HUB_B, FAR_NORTH);
    expect(c.direction).toBe("outbound");
    expect(c.hubIndex).toBe(1);
  });

  it("classifies both-ends-far as unserved with no hub", () => {
    const c = classify(FAR_EAST, FAR_NORTH);
    expect(c.direction).toBe("unserved");
    expect(c.hubIndex).toBeNull();
  });

  it("is unserved when there are no hubs", () => {
    const c = classifyRequest(HUB_A, FAR_EAST, 0, [], DEFAULT_CONFIG, provider);
    expect(c.direction).toBe("unserved");
  });

  it("derives promise fields from the provider and config, not a speed constant", () => {
    const c = classify(FAR_EAST, HUB_A);
    const direct = provider.time(FAR_EAST, HUB_A, 0);
    expect(c.directTimeMin).toBeCloseTo(direct, 6);
    expect(c.maxRideTimeMin).toBeCloseTo(
      direct * DEFAULT_CONFIG.rideTimeFactor + DEFAULT_CONFIG.rideTimeSlackMin,
      6
    );
    expect(c.promisedPickupBy).toBe(DEFAULT_CONFIG.maxWaitMinutes);
  });
});
