import { useState, useRef, useCallback, useEffect } from "react";
import { SimConfig, SimState, DEFAULT_CONFIG } from "@/engine/types";
import { createInitialState, simulateStep, resetReqCounter } from "@/engine/simulator";
import SimulationControls from "@/components/SimulationControls";
import MetricsDashboard from "@/components/MetricsDashboard";
import SimulationMap from "@/components/SimulationMap";
import FallbackMap from "@/components/FallbackMap";
import MapLegend from "@/components/MapLegend";

export default function Index() {
  const [config, setConfig] = useState<SimConfig>(DEFAULT_CONFIG);
  const [state, setState] = useState<SimState>(() => createInitialState(config));
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setState((s) => ({ ...s, running: false }));
  }, []);

  const start = useCallback(() => {
    if (state.time >= config.simMinutes) return;
    setState((s) => ({ ...s, running: true }));

    intervalRef.current = setInterval(async () => {
      setState((prev) => {
        if (prev.time >= config.simMinutes) {
          stop();
          return prev;
        }
        // fire async step, update when done
        simulateStep(prev, config).then((next) => {
          setState(next);
        });
        return prev;
      });
    }, 400);
  }, [config, state.time, stop]);

  const reset = useCallback(() => {
    stop();
    resetReqCounter();
    setState(createInitialState(config));
  }, [config, stop]);

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
        />
      </aside>

      {/* Main area */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* Map */}
        <div className="flex-1 relative">
          {config.googleApiKey ? (
            <SimulationMap state={state} apiKey={config.googleApiKey} />
          ) : (
            <FallbackMap state={state} />
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
