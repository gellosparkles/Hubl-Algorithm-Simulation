/**
 * Shared map-interaction types for the simulation viewer (issue #11).
 *
 * `MapMode` is the single click-mode machine that replaced the old boolean
 * drop-off-placement flag; it is owned by `Index.tsx` and consumed by
 * `SimulationControls`, `RiderRequestForm`, and both map components.
 *
 * `TrackedOverlay` bundles the manual-request pins and the highlighted
 * stop/bus so the Google and canvas maps take one prop, not four.
 */

import { LatLng } from "@/engine/types";

export type MapMode = "idle" | "placeHub" | "placePickup" | "placeDropoff";

export interface TrackedOverlay {
  /** Pending pickup pin, before submission. */
  pickup: LatLng | null;
  /** Pending destination pin, before submission. */
  dest: LatLng | null;
  /** Virtual stop the tracked rider was grouped into — highlighted on the map. */
  trackedStopId: number | null;
  /** Bus assigned to the tracked rider — highlighted on the map. */
  trackedBusId: number | null;
}

export const EMPTY_OVERLAY: TrackedOverlay = {
  pickup: null,
  dest: null,
  trackedStopId: null,
  trackedBusId: null,
};
