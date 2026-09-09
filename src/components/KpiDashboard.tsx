import { SimMetrics } from "@/engine/types";
import {
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

/**
 * One point of the run's KPI time series, sampled once per sim minute by
 * `Index.tsx`. The engine keeps no history, so the viewer accumulates it.
 */
export interface KpiSample {
  minute: number;
  /** completed / totalRequests at this minute, 0–1 */
  serviceRate: number;
  /** wait P90 in minutes, or null before anyone has boarded */
  waitP90Min: number | null;
}

interface Props {
  metrics: SimMetrics;
  history: KpiSample[];
}

/** Series names, shared between the <Line>s and the tooltip formatter. */
const RATE_SERIES = "Service rate";
const WAIT_SERIES = "Wait P90";

function pct(x: number | null): string {
  return x == null ? "–" : `${Math.round(x * 100)}%`;
}

function num(x: number | null, digits = 1): string {
  return x == null ? "–" : x.toFixed(digits);
}

export default function KpiDashboard({ metrics, history }: Props) {
  const chips = [
    { label: RATE_SERIES, value: pct(metrics.serviceRate) },
    { label: WAIT_SERIES, value: `${num(metrics.waitP90Min)} min` },
    { label: "Detour ratio", value: `${num(metrics.detourRatioMean, 2)}×` },
    { label: "Mean occupancy", value: num(metrics.meanOccupancy, 2) },
  ];

  // Riders still waiting = pending minus those already past their promise.
  const stillWaiting = Math.max(0, metrics.pending - metrics.expired);
  const outcomes = [
    { label: "Completed", value: metrics.completed, color: "text-accent" },
    { label: "Riding", value: metrics.pickedUp, color: "text-secondary-foreground" },
    { label: "Waiting", value: stillWaiting, color: "text-foreground" },
    { label: "Expired", value: metrics.expired, color: "text-destructive" },
    { label: "Unserved", value: metrics.unserved, color: "text-muted-foreground" },
  ];

  return (
    <div className="flex items-stretch gap-4 px-3 py-2">
      <div className="flex flex-col gap-1.5">
        <div className="flex gap-1.5">
          {chips.map((c) => (
            <div
              key={c.label}
              className="flex flex-col px-2.5 py-1 bg-card rounded border border-border min-w-[84px]"
            >
              <span className="text-[9px] text-muted-foreground uppercase tracking-wider">
                {c.label}
              </span>
              <span className="text-sm font-bold font-mono text-foreground">
                {c.value}
              </span>
            </div>
          ))}
        </div>
        <div className="flex gap-1.5">
          {outcomes.map((o) => (
            <div
              key={o.label}
              className="flex items-baseline gap-1 px-2.5 py-1 bg-card rounded border border-border min-w-[84px]"
            >
              <span className="text-[9px] text-muted-foreground uppercase tracking-wider">
                {o.label}
              </span>
              <span className={`text-sm font-bold font-mono ${o.color}`}>
                {o.value}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1 min-w-0 h-[112px]" data-testid="kpi-timeseries">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={history} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <XAxis
              dataKey="minute"
              tick={{ fontSize: 9 }}
              stroke="currentColor"
              className="text-muted-foreground"
            />
            <YAxis
              yAxisId="rate"
              domain={[0, 1]}
              tickFormatter={pct}
              width={34}
              tick={{ fontSize: 9 }}
              stroke="currentColor"
              className="text-muted-foreground"
            />
            <YAxis
              yAxisId="wait"
              orientation="right"
              width={28}
              tick={{ fontSize: 9 }}
              stroke="currentColor"
              className="text-muted-foreground"
            />
            <Tooltip
              contentStyle={{ fontSize: 11 }}
              formatter={(value: number | null, name: string) =>
                name === RATE_SERIES ? pct(value) : `${num(value)} min`
              }
              labelFormatter={(m) => `min ${m}`}
            />
            <Legend wrapperStyle={{ fontSize: 10 }} />
            <Line
              yAxisId="rate"
              type="monotone"
              dataKey="serviceRate"
              name={RATE_SERIES}
              stroke="hsl(var(--accent))"
              dot={false}
              isAnimationActive={false}
            />
            <Line
              yAxisId="wait"
              type="monotone"
              dataKey="waitP90Min"
              name={WAIT_SERIES}
              stroke="hsl(var(--primary))"
              dot={false}
              isAnimationActive={false}
              connectNulls
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
