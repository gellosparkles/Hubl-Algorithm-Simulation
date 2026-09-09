import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import RiderRequestForm from "./RiderRequestForm";
import { TrackedRiderView } from "@/services/trackedRider";

const noop = () => {};

describe("RiderRequestForm", () => {
  it("starts placement when 'Request a ride' is clicked", async () => {
    const onBegin = vi.fn();
    render(
      <RiderRequestForm
        mapMode="idle"
        pickup={null}
        dest={null}
        tracked={null}
        currentTime={0}
        onBegin={onBegin}
        onCancel={noop}
        onSubmit={noop}
        onClear={noop}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /request a ride/i }));
    expect(onBegin).toHaveBeenCalledOnce();
  });

  it("enables Submit only once both pins are placed", () => {
    const { rerender } = render(
      <RiderRequestForm
        mapMode="placeDropoff"
        pickup={{ lat: 34.05, lng: -118.24 }}
        dest={null}
        tracked={null}
        currentTime={3}
        onBegin={noop}
        onCancel={noop}
        onSubmit={noop}
        onClear={noop}
      />
    );
    expect(screen.getByRole("button", { name: /submit/i })).toBeDisabled();

    rerender(
      <RiderRequestForm
        mapMode="idle"
        pickup={{ lat: 34.05, lng: -118.24 }}
        dest={{ lat: 34.0, lng: -118.3 }}
        tracked={null}
        currentTime={3}
        onBegin={noop}
        onCancel={noop}
        onSubmit={noop}
        onClear={noop}
      />
    );
    expect(screen.getByRole("button", { name: /submit/i })).toBeEnabled();
  });

  it("shows the promise once a rider is tracked", () => {
    const tracked: TrackedRiderView = {
      riderId: 42,
      direction: "inbound",
      status: "pending",
      assignedStopId: 8,
      walkDistanceKm: 0.12,
      promisedPickupByMin: 13,
      assignedBusId: 9,
      pickupEtaMin: 11,
      dropoffEtaMin: 18,
      minutesToPickup: 5,
      tPickedUpMin: null,
      tDroppedOffMin: null,
    };
    render(
      <RiderRequestForm
        mapMode="idle"
        pickup={null}
        dest={null}
        tracked={tracked}
        currentTime={6}
        onBegin={noop}
        onCancel={noop}
        onSubmit={noop}
        onClear={noop}
      />
    );
    expect(screen.getByText(/Rider #42/)).toBeInTheDocument();
    expect(screen.getByText("#8")).toBeInTheDocument();
    expect(screen.getByText("0.12 km")).toBeInTheDocument();
    expect(screen.getByText("B9")).toBeInTheDocument();
    expect(screen.getByTestId("tracked-eta")).toHaveTextContent("pickup in ~5 min");
  });
});
