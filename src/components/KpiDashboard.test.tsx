import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import KpiDashboard, { KpiSample } from "./KpiDashboard";
import { SimMetrics } from "@/engine/types";

const metrics: SimMetrics = {
  busAssignments: 3,
  completed: 12,
  pending: 20,
  pickedUp: 4,
  unserved: 7,
  expired: 5,
  totalRequests: 48,
  totalStops: 30,
  serviceRate: 0.25,
  poolingRate: 0.1,
  waitP50Min: 4.2,
  waitP90Min: 9.6,
  inVehicleP50Min: 8,
  inVehicleP90Min: 15,
  detourRatioMean: 1.31,
  vehicleKm: 40,
  deadheadShare: 0.2,
  meanOccupancy: 1.74,
  meanWalkKm: 0.12,
};

describe("KpiDashboard", () => {
  it("shows the headline KPI chips", () => {
    render(<KpiDashboard metrics={metrics} history={[]} />);
    expect(screen.getByText("Service rate")).toBeInTheDocument();
    expect(screen.getByText("25%")).toBeInTheDocument();
    expect(screen.getByText("9.6 min")).toBeInTheDocument();
    expect(screen.getByText("1.31×")).toBeInTheDocument();
    expect(screen.getByText("1.74")).toBeInTheDocument();
  });

  it("distinguishes waiting, expired and unserved riders", () => {
    render(<KpiDashboard metrics={metrics} history={[]} />);
    // pending 20 - expired 5 = 15 still waiting
    const waiting = screen.getByText("Waiting").parentElement!;
    expect(waiting).toHaveTextContent("15");
    const expired = screen.getByText("Expired").parentElement!;
    expect(expired).toHaveTextContent("5");
    const unserved = screen.getByText("Unserved").parentElement!;
    expect(unserved).toHaveTextContent("7");
  });

  it("renders the time series container", () => {
    const history: KpiSample[] = [
      { minute: 0, serviceRate: 0, waitP90Min: null },
      { minute: 1, serviceRate: 0.1, waitP90Min: 3 },
    ];
    render(<KpiDashboard metrics={metrics} history={history} />);
    expect(screen.getByTestId("kpi-timeseries")).toBeInTheDocument();
  });
});
