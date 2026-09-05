import { SimMetrics } from "@/engine/types";
import { Bus, Users, MapPin, CheckCircle, Clock, Route, Ban } from "lucide-react";

interface Props {
  metrics: SimMetrics;
  eventLog: string[];
}

export default function MetricsDashboard({ metrics, eventLog }: Props) {
  const cards = [
    { label: "Total Riders", value: metrics.totalRequests, icon: Users, color: "text-primary" },
    { label: "Completed", value: metrics.completed, icon: CheckCircle, color: "text-accent" },
    { label: "Pending", value: metrics.pending, icon: Clock, color: "text-destructive" },
    { label: "Unserved", value: metrics.unserved, icon: Ban, color: "text-muted-foreground" },
    { label: "Picked Up", value: metrics.pickedUp, icon: Bus, color: "text-secondary-foreground" },
    { label: "Virtual Stops", value: metrics.totalStops, icon: MapPin, color: "text-primary" },
    { label: "Route Assigns", value: metrics.busAssignments, icon: Route, color: "text-accent" },
  ];

  return (
    <div className="flex items-center gap-2 px-3 py-2">
      {cards.map((c) => (
        <div
          key={c.label}
          className="flex items-center gap-1.5 px-2.5 py-1.5 bg-card rounded border border-border"
        >
          <c.icon className={`h-3.5 w-3.5 ${c.color}`} />
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
            {c.label}
          </span>
          <span className="text-sm font-bold font-mono text-foreground">{c.value}</span>
        </div>
      ))}
    </div>
  );
}
