interface LegendItem {
  color: string;
  label: string;
  shape: "circle" | "triangle" | "line";
}

const items: LegendItem[] = [
  { color: "#1a8cff", label: "Bus (available)", shape: "circle" },
  { color: "#2db87a", label: "Bus (en route)", shape: "circle" },
  { color: "#e6a817", label: "Stop (open / waiting)", shape: "triangle" },
  { color: "#4d9de0", label: "Stop (assigned)", shape: "triangle" },
  { color: "rgba(45,184,122,0.7)", label: "Active route", shape: "line" },
  { color: "rgba(136,136,136,0.5)", label: "Path taken (trail)", shape: "line" },
];

function Shape({ item }: { item: LegendItem }) {
  if (item.shape === "circle")
    return (
      <span
        className="inline-block w-3 h-3 rounded-full border border-white/60"
        style={{ background: item.color }}
      />
    );
  if (item.shape === "triangle")
    return (
      <svg width="14" height="14" viewBox="0 0 14 14">
        <polygon points="7,2 3,12 11,12" fill={item.color} stroke="#fff" strokeWidth="0.8" />
      </svg>
    );
  return (
    <svg width="18" height="6" viewBox="0 0 18 6">
      <line x1="0" y1="3" x2="18" y2="3" stroke={item.color} strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export default function MapLegend() {
  return (
    <div className="absolute bottom-3 left-3 bg-background/85 backdrop-blur-sm border border-border rounded-lg px-3 py-2 z-10 pointer-events-auto">
      <p className="text-[10px] font-semibold text-foreground/70 uppercase tracking-wider mb-1">Legend</p>
      <ul className="space-y-0.5">
        {items.map((item) => (
          <li key={item.label} className="flex items-center gap-2 text-xs text-foreground/80">
            <Shape item={item} />
            {item.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
