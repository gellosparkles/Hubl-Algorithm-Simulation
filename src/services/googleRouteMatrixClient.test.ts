import { describe, it, expect, vi, afterEach } from "vitest";
import { FetchRouteMatrixClient } from "./googleRouteMatrixClient";

const A = { lat: 34.0522, lng: -118.2437 };
const B = { lat: 34.0195, lng: -118.4912 };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FetchRouteMatrixClient", () => {
  it("posts origins/destinations and parses durations from the response", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [
        { originIndex: 0, destinationIndex: 0, duration: "930s", status: { code: 0 }, condition: "ROUTE_EXISTS" },
      ],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new FetchRouteMatrixClient("test-key");
    const elements = await client.computeRouteMatrix([A], [B], new Date("2026-01-01T00:00:00Z"), "TRAFFIC_AWARE");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("computeRouteMatrix");
    expect(init.headers["X-Goog-Api-Key"]).toBe("test-key");

    const body = JSON.parse(init.body as string);
    expect(body.origins[0].waypoint.location.latLng).toEqual({ latitude: A.lat, longitude: A.lng });
    expect(body.destinations[0].waypoint.location.latLng).toEqual({ latitude: B.lat, longitude: B.lng });
    expect(body.routingPreference).toBe("TRAFFIC_AWARE");

    expect(elements).toEqual([{ originIndex: 0, destinationIndex: 0, durationMinutes: 15.5, status: "OK" }]);
  });

  it("maps a non-OK status code to a non-OK status string", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => [{ originIndex: 0, destinationIndex: 0, duration: "0s", status: { code: 5 } }],
      }))
    );

    const client = new FetchRouteMatrixClient("test-key");
    const elements = await client.computeRouteMatrix([A], [B], new Date(), "TRAFFIC_AWARE");

    expect(elements[0].status).not.toBe("OK");
  });

  it("maps a ROUTE_NOT_FOUND condition to a non-OK status string", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => [{ originIndex: 0, destinationIndex: 0, duration: "0s", condition: "ROUTE_NOT_FOUND" }],
      }))
    );

    const client = new FetchRouteMatrixClient("test-key");
    const elements = await client.computeRouteMatrix([A], [B], new Date(), "TRAFFIC_AWARE");

    expect(elements[0].status).not.toBe("OK");
  });

  it("throws on a non-ok HTTP response, so the caller's fallback path takes over", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => [] }))
    );

    const client = new FetchRouteMatrixClient("test-key");
    await expect(client.computeRouteMatrix([A], [B], new Date(), "TRAFFIC_AWARE")).rejects.toThrow();
  });
});
