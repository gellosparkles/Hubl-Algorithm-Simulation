/**
 * Canvas-based fallback map when no Google API key is provided.
 * Renders buses, stops, route paths, and pickup-point labels.
 */

import { useRef, useEffect } from "react";
import { SimState, LA_BOUNDS } from "@/engine/types";

interface Props {
  state: SimState;
}

const ROUTE_COLORS = [
  "rgba(45,184,122,0.7)",
  "rgba(26,140,255,0.6)",
  "rgba(230,168,23,0.6)",
  "rgba(180,80,220,0.6)",
  "rgba(220,80,80,0.6)",
  "rgba(80,200,200,0.6)",
  "rgba(255,140,60,0.6)",
  "rgba(120,200,80,0.6)",
];

export default function FallbackMap({ state }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * window.devicePixelRatio;
    canvas.height = rect.height * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    const w = rect.width;
    const h = rect.height;

    const { latMin, latMax, lngMin, lngMax } = LA_BOUNDS;
    const toX = (lng: number) => ((lng - lngMin) / (lngMax - lngMin)) * w;
    const toY = (lat: number) => h - ((lat - latMin) / (latMax - latMin)) * h;

    // background
    ctx.fillStyle = "#1a1f2e";
    ctx.fillRect(0, 0, w, h);

    // grid
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 10; i++) {
      const x = (w / 10) * i;
      const y = (h / 10) * i;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    // ── Draw position history trails ──
    busEntries.forEach((bus, idx) => {
      if (bus.positionHistory.length < 2) return;
      const color = ROUTE_COLORS[idx % ROUTE_COLORS.length];

      ctx.strokeStyle = color.replace(/[\d.]+\)$/, "0.3)");
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(toX(bus.positionHistory[0].lng), toY(bus.positionHistory[0].lat));
      for (let i = 1; i < bus.positionHistory.length; i++) {
        ctx.lineTo(toX(bus.positionHistory[i].lng), toY(bus.positionHistory[i].lat));
      }
      ctx.stroke();
      ctx.setLineDash([]);
    });

    // ── Draw active route paths (decoded road legs) ──
    busEntries.forEach((bus, idx) => {
      if (bus.decodedLegs.length === 0) return;
      const color = ROUTE_COLORS[idx % ROUTE_COLORS.length];

      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.setLineDash([]);
      ctx.beginPath();
      let started = false;
      for (const leg of bus.decodedLegs) {
        for (const pt of leg) {
          if (!started) {
            ctx.moveTo(toX(pt.lng), toY(pt.lat));
            started = true;
          } else {
            ctx.lineTo(toX(pt.lng), toY(pt.lat));
          }
        }
      }
      ctx.stroke();

      // Draw numbered waypoints along the route
      bus.route.forEach((sid, stopIdx) => {
        const stop = state.stops[sid];
        if (!stop) return;
        const sx = toX(stop.position.lng);
        const sy = toY(stop.position.lat);

        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(sx, sy, 4, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = "#fff";
        ctx.font = "bold 8px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillText(`${stopIdx + 1}`, sx, sy - 6);
      });
    });

    // ── Draw stops ──
    for (const stop of Object.values(state.stops)) {
      const x = toX(stop.position.lng);
      const y = toY(stop.position.lat);
      const isOpen = stop.status === "open";

      // triangle marker
      ctx.fillStyle = isOpen ? "#e6a817" : "#4d9de0";
      ctx.beginPath();
      ctx.moveTo(x, y - 8);
      ctx.lineTo(x - 5, y + 4);
      ctx.lineTo(x + 5, y + 4);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1;
      ctx.stroke();

      // rider count badge
      if (stop.riderIds.length > 0) {
        const badge = `${stop.riderIds.length}`;
        ctx.fillStyle = "rgba(0,0,0,0.65)";
        const bw = ctx.measureText(badge).width + 6;
        ctx.fillRect(x - bw / 2, y + 5, bw, 12);
        ctx.fillStyle = "#fff";
        ctx.font = "bold 9px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(badge, x, y + 6);
      }
    }

    // ── Draw buses ──
    for (const bus of busEntries) {
      const x = toX(bus.position.lng);
      const y = toY(bus.position.lat);
      ctx.fillStyle = bus.available ? "#1a8cff" : "#2db87a";
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // bus id
      ctx.fillStyle = "#fff";
      ctx.font = "bold 9px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(`${bus.id}`, x, y);

      // onboard count
      if (bus.onboard.length > 0) {
        ctx.fillStyle = "#2db87a";
        ctx.beginPath();
        ctx.arc(x + 10, y - 8, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.font = "bold 7px sans-serif";
        ctx.fillText(`${bus.onboard.length}`, x + 10, y - 8);
      }
    }

    // header
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("Los Angeles Metro — Fallback View (no API key)", 10, 8);
  }, [state]);

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full rounded-lg"
      style={{ display: "block" }}
    />
  );
}
