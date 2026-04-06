import { useState, useRef, useCallback, useEffect } from "react";
import { SimConfig, SimState, DEFAULT_CONFIG, LatLng } from "@/engine/types";
import { createInitialState, simulateStep, resetReqCounter } from "@/engine/simulator";
import SimulationControls from "@/components/SimulationControls";
import MetricsDashboard from "@/components/MetricsDashboard";
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

export default function Index() {
  const [config, setConfig] = useState<SimConfig>(DEFAULT_CONFIG);
  const [state, setState] = useState<SimState>(() => {
    const initial = createInitialState(config);
    const saved = loadLockedHubs();
    if (saved) initial.dropOffHubs = saved;
    return initial;
  });
  const [hubsLocked, setHubsLocked] = useState(() => !!loadLockedHubs());
  const [placingDropOff, setPlacingDropOff] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const busyRef = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  const stop = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setState((s) => ({ ...s, running: false }));
  }, []);

  const start = useCallback(() => {
    if (state.time >= config.simMinutes) return;
    setPlacingDropOff(false);
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
        setState(next);
      } finally {
        busyRef.current = false;
      }
    }, 400);
  }, [config, state.time, stop]);

  const reset = useCallback(() => {
    stop();
    resetReqCounter();
    setState(createInitialState(config));
  }, [config, stop]);

  const handleBusDrag = useCallback((busId: number, position: { lat: number; lng: number }) => {
    setState((s) => ({
      ...s,
      buses: {
        ...s.buses,
        [busId]: { ...s.buses[busId], position, routeStartPosition: position, positionHistory: [] },
      },
    }));
  }, []);

  const handleMapClick = useCallback((pos: LatLng) => {
    if (!placingDropOff) return;
    setState((s) => {
      if (s.dropOffHubs.length >= 10) return s;
      return { ...s, dropOffHubs: [...s.dropOffHubs, pos] };
    });
  }, [placingDropOff]);

  const handleRemoveDropOff = useCallback((index: number) => {
    setState((s) => ({
      ...s,
      dropOffHubs: s.dropOffHubs.filter((_, i) => i !== index),
    }));
  }, []);

  // cleanup on unmount
  useEffect(() => () => { if (intervalRef.current) clearInterval(intervalRef.current); }, []);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background">
      {/* Sidebar */}
      <aside className="w-72 flex-shrink-0 bg-sidebar border-r border-sidebar-border flex flex-col">
        <SimulationControls
          config={config}
          onConfigChange={setConfig}
          running={state.running}
          onStart={start}
          onPause={stop}
          onReset={reset}
          currentTime={state.time}
          dropOffHubCount={state.dropOffHubs.length}
          placingDropOff={placingDropOff}
          onTogglePlaceDropOff={() => setPlacingDropOff((v) => !v)}
          onClearDropOffs={() => setState((s) => ({ ...s, dropOffHubs: [] }))}
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
              placingDropOff={placingDropOff}
            />
          ) : (
            <FallbackMap
              state={state}
              onMapClick={handleMapClick}
              placingDropOff={placingDropOff}
              onRemoveDropOff={handleRemoveDropOff}
            />
          )}
          <MapLegend />
          {placingDropOff && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-destructive text-destructive-foreground px-4 py-2 rounded-lg shadow-lg text-sm font-medium animate-pulse z-50">
              Click on the map to place drop-off locations ({state.dropOffHubs.length}/10)
            </div>
          )}
        </div>

        {/* Bottom metrics */}
        <div className="border-t border-border bg-card">
          <MetricsDashboard metrics={state.metrics} eventLog={state.eventLog} />
        </div>
      </main>
    </div>
  );
}
