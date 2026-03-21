/**
 * Canvas-based fallback map when no Google API key is provided.
 * Renders buses, stops, and connections on a simple 2D plane.
 */

import { useRef, useEffect } from "react";
import { SimState, LA_BOUNDS } from "@/engine/types";

interface Props {
  state: SimState;
}

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

    // draw route lines
    for (const bus of Object.values(state.buses)) {
      if (bus.route.length > 0) {
        ctx.strokeStyle = "rgba(45, 184, 122, 0.5)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(toX(bus.position.lng), toY(bus.position.lat));
        for (const sid of bus.route) {
          const stop = state.stops[sid];
          if (stop) {
            ctx.lineTo(toX(stop.position.lng), toY(stop.position.lat));
          }
        }
        ctx.stroke();
      }
    }

    // draw stops
    for (const stop of Object.values(state.stops)) {
      const x = toX(stop.position.lng);
      const y = toY(stop.position.lat);
      ctx.fillStyle = stop.status === "open" ? "#e6a817" : "#4d9de0";
      ctx.beginPath();
      ctx.moveTo(x, y - 6);
      ctx.lineTo(x - 4, y + 3);
      ctx.lineTo(x + 4, y + 3);
      ctx.closePath();
      ctx.fill();
    }

    // draw buses
    for (const bus of Object.values(state.buses)) {
      const x = toX(bus.position.lng);
      const y = toY(bus.position.lat);
      ctx.fillStyle = bus.available ? "#1a8cff" : "#2db87a";
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = "#fff";
      ctx.font = "bold 8px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(`${bus.id}`, x, y);
    }

    // legend
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("Los Angeles Metro Area (No API Key – Fallback View)", 10, 18);
  }, [state]);

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full rounded-lg"
      style={{ display: "block" }}
    />
  );
}
