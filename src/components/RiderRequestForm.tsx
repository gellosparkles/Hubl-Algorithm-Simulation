/**
 * Inject a real rider request mid-run and watch the promise being kept (issue #11).
 *
 * Two-pin placement (pickup, then destination) drives `mapMode` in the parent;
 * once both pins are down the request is submitted into the live `SimState` via
 * `injectRequest`. After that this panel becomes a read-out of what the system
 * promised the tracked rider — assigned stop + walk, promised pickup, assigned
 * bus, live ETA, and estimated drop-off.
 */

import { LatLng } from "@/engine/types";
import { TrackedRiderView } from "@/services/trackedRider";
import { MapMode } from "@/components/mapInteraction";
import { Button } from "@/components/ui/button";
import { UserPlus, X, Crosshair } from "lucide-react";

interface Props {
  mapMode: MapMode;
  pickup: LatLng | null;
  dest: LatLng | null;
  tracked: TrackedRiderView | null;
  currentTime: number;
  onBegin: () => void;
  onCancel: () => void;
  onSubmit: () => void;
  onClear: () => void;
}

function fmtLatLng(p: LatLng): string {
  return `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-xs">
      <span className="text-sidebar-foreground/60">{label}</span>
      <span className="font-mono text-sidebar-foreground text-right">{value}</span>
    </div>
  );
}

function PromisePanel({ tracked, currentTime, onClear }: { tracked: TrackedRiderView; currentTime: number; onClear: () => void }) {
  const t = tracked;
  const km = (v: number | null) => (v == null ? "—" : `${v.toFixed(2)} km`);
  const min = (v: number | null) => (v == null ? "—" : `t=${v} min`);

  const statusLabel: Record<TrackedRiderView["status"], string> = {
    pending: "Waiting for pickup",
    picked_up: "On board",
    completed: "Dropped off",
    unserved: "Unserved — outside any hub catchment",
  };

  let etaText = "—";
  if (t.status === "completed") etaText = `arrived t=${t.tDroppedOffMin} min`;
  else if (t.status === "picked_up") etaText = t.dropoffEtaMin != null ? `drop-off ~t=${t.dropoffEtaMin} min` : "on board";
  else if (t.minutesToPickup != null)
    etaText = t.minutesToPickup <= 0 ? "arriving now" : `pickup in ~${t.minutesToPickup} min`;
  else etaText = `promised by t=${t.promisedPickupByMin} min`;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-sidebar-foreground/80">
          Rider #{t.riderId} · {t.direction}
        </span>
        <Button onClick={onClear} variant="ghost" size="sm" className="h-6 px-1 text-xs">
          <X className="h-3 w-3" />
        </Button>
      </div>
      <p className="text-[11px] text-sidebar-primary" data-testid="tracked-status">{statusLabel[t.status]}</p>

      {t.direction !== "unserved" && (
        <div className="space-y-1 border-t border-sidebar-border pt-2">
          <Row label="Assigned stop" value={t.assignedStopId == null ? "forming…" : `#${t.assignedStopId}`} />
          <Row label="Walk to stop" value={km(t.walkDistanceKm)} />
          <Row label="Promised pickup" value={`by t=${t.promisedPickupByMin} min`} />
          <Row label="Assigned bus" value={t.assignedBusId == null ? "awaiting dispatch" : `B${t.assignedBusId}`} />
          <Row label="Est. drop-off" value={t.status === "completed" ? min(t.tDroppedOffMin) : min(t.dropoffEtaMin)} />
          <p className="text-[11px] text-sidebar-foreground/70 pt-1" data-testid="tracked-eta">
            {etaText} · now t={currentTime} min
          </p>
        </div>
      )}
    </div>
  );
}

export default function RiderRequestForm({
  mapMode,
  pickup,
  dest,
  tracked,
  currentTime,
  onBegin,
  onCancel,
  onSubmit,
  onClear,
}: Props) {
  const placing = mapMode === "placePickup" || mapMode === "placeDropoff";
  const canSubmit = !!pickup && !!dest;

  return (
    <div className="space-y-2 border border-sidebar-border rounded-lg p-3 m-4 mt-0">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-sidebar-foreground/80">Try a Ride Request</span>
      </div>

      {tracked ? (
        <PromisePanel tracked={tracked} currentTime={currentTime} onClear={onClear} />
      ) : placing || pickup ? (
        <div className="space-y-2">
          <p className="text-[10px] text-sidebar-foreground/50">
            {mapMode === "placePickup"
              ? "Click the map to drop the pickup pin."
              : mapMode === "placeDropoff"
              ? "Now click the map to drop the destination pin."
              : "Both pins placed — submit to enter the request."}
          </p>
          <Row label="Pickup" value={pickup ? fmtLatLng(pickup) : "—"} />
          <Row label="Destination" value={dest ? fmtLatLng(dest) : "—"} />
          <div className="flex gap-2">
            <Button onClick={onSubmit} size="sm" className="flex-1 gap-1 text-xs" disabled={!canSubmit}>
              <Crosshair className="h-3 w-3" /> Submit
            </Button>
            <Button onClick={onCancel} variant="outline" size="sm" className="gap-1 text-xs">
              <X className="h-3 w-3" />
            </Button>
          </div>
        </div>
      ) : (
        <>
          <p className="text-[10px] text-sidebar-foreground/50">
            Drop a pickup and a destination on the map. The request enters the running
            simulation and is classified exactly like a generated rider — run the clock
            to watch the promise being kept.
          </p>
          <Button
            onClick={onBegin}
            variant="outline"
            size="sm"
            className="w-full gap-1 text-xs"
            disabled={mapMode === "placeHub"}
          >
            <UserPlus className="h-3 w-3" /> Request a ride
          </Button>
        </>
      )}
    </div>
  );
}
