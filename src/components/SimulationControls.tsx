import { useState } from "react";
import { SimConfig, DEFAULT_CONFIG } from "@/engine/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Play, Pause, RotateCcw, Settings, MapPin, Trash2, Lock, Unlock } from "lucide-react";

interface Props {
  config: SimConfig;
  onConfigChange: (c: SimConfig) => void;
  running: boolean;
  onStart: () => void;
  onPause: () => void;
  onReset: () => void;
  currentTime: number;
  dropOffHubCount: number;
  placingDropOff: boolean;
  onTogglePlaceDropOff: () => void;
  onClearDropOffs: () => void;
}

export default function SimulationControls({
  config,
  onConfigChange,
  running,
  onStart,
  onPause,
  onReset,
  currentTime,
  dropOffHubCount,
  placingDropOff,
  onTogglePlaceDropOff,
  onClearDropOffs,
}: Props) {
  const [showAdvanced, setShowAdvanced] = useState(false);

  const update = (partial: Partial<SimConfig>) =>
    onConfigChange({ ...config, ...partial });

  return (
    <div className="flex flex-col gap-4 p-4 h-full overflow-y-auto">
      {/* Header */}
      <div>
        <h2 className="text-lg font-bold text-sidebar-foreground tracking-tight">
          LA On-Demand Bus Sim
        </h2>
        <p className="text-xs text-sidebar-foreground/60 mt-1">
          Capacity-aware multi-stop chaining
        </p>
      </div>

      {/* Timer */}
      <div className="bg-sidebar-accent rounded-lg p-3 text-center">
        <p className="text-xs text-sidebar-foreground/60 uppercase tracking-wider">Simulation Time</p>
        <p className="text-2xl font-mono font-bold text-sidebar-primary">
          {currentTime} <span className="text-sm font-normal">min</span>
        </p>
      </div>

      {/* Playback controls */}
      <div className="flex gap-2">
        {!running ? (
          <Button onClick={onStart} className="flex-1 gap-2" size="sm">
            <Play className="h-4 w-4" /> Start
          </Button>
        ) : (
          <Button onClick={onPause} variant="secondary" className="flex-1 gap-2" size="sm">
            <Pause className="h-4 w-4" /> Pause
          </Button>
        )}
        <Button onClick={onReset} variant="outline" size="sm">
          <RotateCcw className="h-4 w-4" />
        </Button>
      </div>

      {/* Drop-off hub controls */}
      <div className="space-y-2 border border-sidebar-border rounded-lg p-3">
        <div className="flex items-center justify-between">
          <Label className="text-xs text-sidebar-foreground/80 font-semibold">Drop-off Hubs</Label>
          <span className="text-xs font-mono text-sidebar-primary">{dropOffHubCount}/10</span>
        </div>
        <p className="text-[10px] text-sidebar-foreground/50">
          Place drop-off locations on the map. Riders are routed to these after pickup.
        </p>
        <div className="flex gap-2">
          <Button
            onClick={onTogglePlaceDropOff}
            variant={placingDropOff ? "destructive" : "outline"}
            size="sm"
            className="flex-1 gap-1 text-xs"
            disabled={running || (!placingDropOff && dropOffHubCount >= 10)}
          >
            <MapPin className="h-3 w-3" />
            {placingDropOff ? "Stop Placing" : "Place Hubs"}
          </Button>
          {dropOffHubCount > 0 && (
            <Button
              onClick={onClearDropOffs}
              variant="outline"
              size="sm"
              className="gap-1 text-xs"
              disabled={running}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>

      {/* API Key */}
      <div className="space-y-1.5">
        <Label className="text-xs text-sidebar-foreground/80">Google Maps API Key</Label>
        <Input
          type="password"
          placeholder="AIza..."
          value={config.googleApiKey}
          onChange={(e) => update({ googleApiKey: e.target.value })}
          className="h-8 text-xs bg-sidebar-accent border-sidebar-border text-sidebar-foreground"
        />
      </div>

      {/* Google routing toggle */}
      <div className="flex items-center justify-between">
        <Label className="text-xs text-sidebar-foreground/80">Google Routing</Label>
        <Switch
          checked={config.useGoogleRouting}
          onCheckedChange={(v) => update({ useGoogleRouting: v })}
          disabled={!config.googleApiKey}
        />
      </div>

      {/* Quick settings */}
      <div className="space-y-3">
        <div className="space-y-1">
          <div className="flex justify-between">
            <Label className="text-xs text-sidebar-foreground/80">Buses</Label>
            <span className="text-xs font-mono text-sidebar-primary">{config.numBuses}</span>
          </div>
          <Slider
            min={2} max={20} step={1}
            value={[config.numBuses]}
            onValueChange={([v]) => update({ numBuses: v })}
            disabled={running}
          />
        </div>

        <div className="space-y-1">
          <div className="flex justify-between">
            <Label className="text-xs text-sidebar-foreground/80">Riders / min</Label>
            <span className="text-xs font-mono text-sidebar-primary">{config.avgRequestsPerMin}</span>
          </div>
          <Slider
            min={1} max={20} step={1}
            value={[config.avgRequestsPerMin]}
            onValueChange={([v]) => update({ avgRequestsPerMin: v })}
            disabled={running}
          />
        </div>

        <div className="space-y-1">
          <div className="flex justify-between">
            <Label className="text-xs text-sidebar-foreground/80">Sim Duration (min)</Label>
            <span className="text-xs font-mono text-sidebar-primary">{config.simMinutes}</span>
          </div>
          <Slider
            min={10} max={180} step={5}
            value={[config.simMinutes]}
            onValueChange={([v]) => update({ simMinutes: v })}
            disabled={running}
          />
        </div>
      </div>

      {/* Advanced toggle */}
      <button
        onClick={() => setShowAdvanced(!showAdvanced)}
        className="flex items-center gap-1.5 text-xs text-sidebar-foreground/60 hover:text-sidebar-foreground transition-colors"
      >
        <Settings className="h-3 w-3" />
        {showAdvanced ? "Hide" : "Show"} advanced settings
      </button>

      {showAdvanced && (
        <div className="space-y-3 border-t border-sidebar-border pt-3">
          <div className="space-y-1">
            <div className="flex justify-between">
              <Label className="text-xs text-sidebar-foreground/80">Bus Capacity</Label>
              <span className="text-xs font-mono text-sidebar-primary">{config.busCapacity}</span>
            </div>
            <Slider
              min={4} max={30} step={1}
              value={[config.busCapacity]}
              onValueChange={([v]) => update({ busCapacity: v })}
              disabled={running}
            />
          </div>

          <div className="space-y-1">
            <div className="flex justify-between">
              <Label className="text-xs text-sidebar-foreground/80">Walk Radius (km)</Label>
              <span className="text-xs font-mono text-sidebar-primary">{config.maxWalkKm}</span>
            </div>
            <Slider
              min={0.1} max={1.5} step={0.1}
              value={[config.maxWalkKm]}
              onValueChange={([v]) => update({ maxWalkKm: v })}
              disabled={running}
            />
          </div>

          <div className="space-y-1">
            <div className="flex justify-between">
              <Label className="text-xs text-sidebar-foreground/80">Min Group Size</Label>
              <span className="text-xs font-mono text-sidebar-primary">{config.minGroupSize}</span>
            </div>
            <Slider
              min={2} max={6} step={1}
              value={[config.minGroupSize]}
              onValueChange={([v]) => update({ minGroupSize: v })}
              disabled={running}
            />
          </div>

          <div className="space-y-1">
            <div className="flex justify-between">
              <Label className="text-xs text-sidebar-foreground/80">Max Stops / Route</Label>
              <span className="text-xs font-mono text-sidebar-primary">{config.maxStopsPerRoute}</span>
            </div>
            <Slider
              min={2} max={10} step={1}
              value={[config.maxStopsPerRoute]}
              onValueChange={([v]) => update({ maxStopsPerRoute: v })}
              disabled={running}
            />
          </div>

          <div className="space-y-1">
            <div className="flex justify-between">
              <Label className="text-xs text-sidebar-foreground/80">Time Budget (min)</Label>
              <span className="text-xs font-mono text-sidebar-primary">{config.timeBudgetMinutes}</span>
            </div>
            <Slider
              min={10} max={60} step={5}
              value={[config.timeBudgetMinutes]}
              onValueChange={([v]) => update({ timeBudgetMinutes: v })}
              disabled={running}
            />
          </div>

          <div className="space-y-1">
            <div className="flex justify-between">
              <Label className="text-xs text-sidebar-foreground/80">Max Wait Time (min)</Label>
              <span className="text-xs font-mono text-sidebar-primary">{config.maxWaitMinutes}</span>
            </div>
            <Slider
              min={3} max={30} step={1}
              value={[config.maxWaitMinutes]}
              onValueChange={([v]) => update({ maxWaitMinutes: v })}
              disabled={running}
            />
          </div>

          <div className="space-y-1">
            <div className="flex justify-between">
              <Label className="text-xs text-sidebar-foreground/80">Avg Speed (km/h)</Label>
              <span className="text-xs font-mono text-sidebar-primary">{config.busSpeed}</span>
            </div>
            <Slider
              min={10} max={80} step={5}
              value={[config.busSpeed]}
              onValueChange={([v]) => update({ busSpeed: v })}
              disabled={running}
            />
          </div>
        </div>
      )}
    </div>
  );
}
