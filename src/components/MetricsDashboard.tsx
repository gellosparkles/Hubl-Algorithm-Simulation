import { SimMetrics } from "@/engine/types";
import { Bus, Users, MapPin, CheckCircle, Clock, Route } from "lucide-react";

interface Props {
  metrics: SimMetrics;
  eventLog: string[];
}

export default function MetricsDashboard({ metrics, eventLog }: Props) {
  const cards = [
    { label: "Total Riders", value: metrics.totalRequests, icon: Users, color: "text-primary" },
    { label: "Completed", value: metrics.completed, icon: CheckCircle, color: "text-accent" },
    { label: "Pending", value: metrics.pending, icon: Clock, color: "text-destructive" },
    { label: "Picked Up", value: metrics.pickedUp, icon: Bus, color: "text-secondary-foreground" },
    { label: "Virtual Stops", value: metrics.totalStops, icon: MapPin, color: "text-primary" },
    { label: "Route Assigns", value: metrics.busAssignments, icon: Route, color: "text-accent" },
  ];

  return (
    <div className="flex flex-col gap-3 p-3">
      {/* Metric cards */}
      <div className="grid grid-cols-3 gap-2">
        {cards.map((c) => (
          <div
            key={c.label}
            className="bg-card rounded-lg p-2.5 border border-border shadow-sm"
          >
            <div className="flex items-center gap-1.5 mb-1">
              <c.icon className={`h-3.5 w-3.5 ${c.color}`} />
              <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
                {c.label}
              </span>
            </div>
            <p className="text-xl font-bold font-mono text-foreground">{c.value}</p>
          </div>
        ))}
      </div>

      {/* Event log */}
      <div className="bg-card rounded-lg border border-border p-2.5 max-h-40 overflow-y-auto">
        <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">
          Event Log
        </p>
        <div className="space-y-0.5">
          {eventLog.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">No events yet…</p>
          ) : (
            eventLog
              .slice(-15)
              .reverse()
              .map((e, i) => (
                <p key={i} className="text-[11px] font-mono text-foreground/80 leading-tight">
                  {e}
                </p>
              ))
          )}
        </div>
      </div>
    </div>
  );
}
