import { useState, useRef, useCallback, useEffect } from "react";
import { SimConfig, SimState, DEFAULT_CONFIG, LatLng } from "@/engine/types";
import { createInitialState, simulateStep, resetReqCounter, injectRequest } from "@/engine/simulator";
import { trackedRider } from "@/services/trackedRider";
import SimulationControls from "@/components/SimulationControls";
import KpiDashboard, { KpiSample } from "@/components/KpiDashboard";
import RiderRequestForm from "@/components/RiderRequestForm";
import { MapMode, TrackedOverlay } from "@/components/mapInteraction";
import SimulationMap from "@/components/SimulationMap";
import FallbackMap from "@/components/FallbackMap";
import MapLegend from "@/components/MapLegend";

const HUBS_STORAGE_KEY = "sim-dropoff-hubs";

function loadLockedHubs(): LatLng[] | null {
  try {
    const raw = localStorage.getItem(HUBS_STORAGE_KEY);
    if (raw) return JSON.parse(raw) as LatLng[];
  } catch { /* ignore */ }
  return null;
}

const MODE_BANNER: Record<Exclude<MapMode, "idle">, string> = {
  placeHub: "Click on the map to place drop-off hubs",
  placePickup: "Click on the map to drop the rider's pickup pin",
  placeDropoff: "Click on the map to drop the rider's destination pin",
};

export default function Index() {
  const [config, setConfig] = useState<SimConfig>(DEFAULT_CONFIG);
  const [state, setState] = useState<SimState>(() => {
    const initial = createInitialState(config);
    const saved = loadLockedHubs();
    if (saved) initial.dropOffHubs = saved;
    return initial;
  });
  const [hubsLocked, setHubsLocked] = useState(() => !!loadLockedHubs());
  const [kpiHistory, setKpiHistory] = useState<KpiSample[]>([]);
  const [mapMode, setMapMode] = useState<MapMode>("idle");
  const [manualPickup, setManualPickup] = useState<LatLng | null>(null);
  const [manualDest, setManualDest] = useState<LatLng | null>(null);
  const [trackedRiderId, setTrackedRiderId] = useState<number | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const busyRef = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const configRef = useRef(config);
  configRef.current = config;
  // Manual requests wait here until a moment no `simulateStep` is in flight, so a
  // submission during a tick can't be clobbered when that tick calls setState.
  const injectionQueueRef = useRef<{ origin: LatLng; dest: LatLng }[]>([]);

  /** Drain queued manual requests onto `base`, tracking the last one injected. */
  const applyInjections = useCallback((base: SimState): SimState => {
    let s = base;
    const queue = injectionQueueRef.current;
    while (queue.length > 0) {
      const { origin, dest } = queue.shift()!;
      const res = injectRequest(s, configRef.current, origin, dest);
      s = res.state;
      setTrackedRiderId(res.requestId);
      setManualPickup(null);
      setManualDest(null);
    }
    return s;
  }, []);

  const stop = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setState((s) => ({ ...s, running: false }));
  }, []);

  const start = useCallback(() => {
    if (state.time >= config.simMinutes) return;
    setMapMode("idle");
    setState((s) => ({ ...s, running: true }));

    intervalRef.current = setInterval(async () => {
      if (busyRef.current) return;
      const prev = stateRef.current;
      if (prev.time >= config.simMinutes) {
        stop();
        return;
      }
      busyRef.current = true;
      try {
        const next = await simulateStep(prev, config);
        setState(applyInjections(next));
      } finally {
        busyRef.current = false;
      }
    }, 400);
  }, [config, state.time, stop, applyInjections]);

  const reset = useCallback(() => {
    stop();
    resetReqCounter();
    const initial = createInitialState(config);
    setKpiHistory([]);
    setMapMode("idle");
    setManualPickup(null);
    setManualDest(null);
    setTrackedRiderId(null);
    injectionQueueRef.current = [];
    if (hubsLocked) {
      const saved = loadLockedHubs();
      if (saved) initial.dropOffHubs = saved;
    }
    setState(initial);
  }, [config, stop, hubsLocked]);

  const handleToggleLockHubs = useCallback(() => {
    setHubsLocked((prev) => {
      if (!prev) {
        localStorage.setItem(HUBS_STORAGE_KEY, JSON.stringify(stateRef.current.dropOffHubs));
      } else {
        localStorage.removeItem(HUBS_STORAGE_KEY);
      }
      return !prev;
    });
  }, []);

  const handleBusDrag = useCallback((busId: number, position: { lat: number; lng: number }) => {
    setState((s) => ({
      ...s,
      buses: {
        ...s.buses,
        [busId]: { ...s.buses[busId], position, positionHistory: [] },
      },
    }));
  }, []);

  const handleMapClick = useCallback((pos: LatLng) => {
    if (mapMode === "placeHub") {
      setState((s) => {
        if (s.dropOffHubs.length >= 10) return s;
        return { ...s, dropOffHubs: [...s.dropOffHubs, pos] };
      });
    } else if (mapMode === "placePickup") {
      setManualPickup(pos);
      setManualDest(null);
      setMapMode("placeDropoff");
    } else if (mapMode === "placeDropoff") {
      setManualDest(pos);
      setMapMode("idle");
    }
  }, [mapMode]);

  const handleRemoveDropOff = useCallback((index: number) => {
    setState((s) => ({
      ...s,
      dropOffHubs: s.dropOffHubs.filter((_, i) => i !== index),
    }));
  }, []);

  const beginManualRequest = useCallback(() => {
    setTrackedRiderId(null);
    setManualPickup(null);
    setManualDest(null);
    setMapMode("placePickup");
  }, []);

  const cancelManualRequest = useCallback(() => {
    setManualPickup(null);
    setManualDest(null);
    setMapMode("idle");
  }, []);

  const submitManualRequest = useCallback(() => {
    if (!manualPickup || !manualDest) return;
    injectionQueueRef.current.push({ origin: manualPickup, dest: manualDest });
    setMapMode("idle");
    // Apply now if no tick is mid-flight; otherwise the running tick drains the
    // queue when it finishes (see `start`).
    if (!busyRef.current) {
      setState(applyInjections(stateRef.current));
    }
  }, [manualPickup, manualDest, applyInjections]);

  // Accumulate the KPI time series — the engine keeps no history.
  useEffect(() => {
    setKpiHistory((h) => {
      if (h.length && h[h.length - 1].minute === state.time) return h;
      return [
        ...h,
        {
          minute: state.time,
          serviceRate: state.metrics.serviceRate,
          waitP90Min: state.metrics.waitP90Min,
        },
      ];
    });
  }, [state.time, state.metrics]);

  // cleanup on unmount
  useEffect(() => () => { if (intervalRef.current) clearInterval(intervalRef.current); }, []);

  const tracked = trackedRider(state, trackedRiderId);
  const placing = mapMode !== "idle";
  const overlay: TrackedOverlay = {
    pickup: manualPickup,
    dest: manualDest,
    trackedStopId: tracked?.assignedStopId ?? null,
    trackedBusId: tracked?.assignedBusId ?? null,
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background">
      {/* Sidebar */}
      <aside className="w-72 flex-shrink-0 bg-sidebar border-r border-sidebar-border flex flex-col overflow-y-auto">
        <SimulationControls
          config={config}
          onConfigChange={setConfig}
          running={state.running}
          onStart={start}
          onPause={stop}
          onReset={reset}
          currentTime={state.time}
          dropOffHubCount={state.dropOffHubs.length}
          placingDropOff={mapMode === "placeHub"}
          onTogglePlaceDropOff={() => setMapMode((m) => (m === "placeHub" ? "idle" : "placeHub"))}
          onClearDropOffs={() => setState((s) => ({ ...s, dropOffHubs: [] }))}
          hubsLocked={hubsLocked}
          onToggleLockHubs={handleToggleLockHubs}
        />
        <RiderRequestForm
          mapMode={mapMode}
          pickup={manualPickup}
          dest={manualDest}
          tracked={tracked}
          currentTime={state.time}
          onBegin={beginManualRequest}
          onCancel={cancelManualRequest}
          onSubmit={submitManualRequest}
          onClear={() => setTrackedRiderId(null)}
        />
      </aside>

      {/* Main area */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* Map */}
        <div className="flex-1 relative">
          {config.googleApiKey ? (
            <SimulationMap
              state={state}
              apiKey={config.googleApiKey}
              onBusDrag={handleBusDrag}
              onMapClick={handleMapClick}
              placing={placing}
              overlay={overlay}
            />
          ) : (
            <FallbackMap
              state={state}
              onMapClick={handleMapClick}
              placing={placing}
              onRemoveDropOff={handleRemoveDropOff}
              overlay={overlay}
            />
          )}
          <MapLegend />
          {placing && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-destructive text-destructive-foreground px-4 py-2 rounded-lg shadow-lg text-sm font-medium animate-pulse z-50">
              {MODE_BANNER[mapMode as Exclude<MapMode, "idle">]}
              {mapMode === "placeHub" && ` (${state.dropOffHubs.length}/10)`}
            </div>
          )}
        </div>

        {/* Bottom metrics */}
        <div className="border-t border-border bg-card">
          <KpiDashboard metrics={state.metrics} history={kpiHistory} />
        </div>
      </main>
    </div>
  );
}
