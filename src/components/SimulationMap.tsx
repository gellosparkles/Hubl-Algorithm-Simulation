import { useMemo, useCallback } from "react";
import {
  GoogleMap,
  useJsApiLoader,
  Marker,
  Polyline,
} from "@react-google-maps/api";
import { SimState } from "@/engine/types";

const MAP_CENTER = { lat: 34.05, lng: -118.35 };
const MAP_STYLES = { width: "100%", height: "100%" };

// decode Google encoded polyline
function decodePolyline(encoded: string): google.maps.LatLngLiteral[] {
  const points: google.maps.LatLngLiteral[] = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let b, shift = 0, result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
}

interface Props {
  state: SimState;
  apiKey: string;
  onBusDrag?: (busId: number, position: { lat: number; lng: number }) => void;
}

export default function SimulationMap({ state, apiKey, onBusDrag }: Props) {
  const { isLoaded } = useJsApiLoader({
    googleMapsApiKey: apiKey,
  });

  const onLoad = useCallback((map: google.maps.Map) => {
    map.setOptions({
      styles: [
        { featureType: "poi", stylers: [{ visibility: "off" }] },
        { featureType: "transit", stylers: [{ visibility: "simplified" }] },
      ],
    });
  }, []);

  const busEntries = useMemo(() => Object.values(state.buses), [state.buses]);
  const stopEntries = useMemo(() => Object.values(state.stops), [state.stops]);

  // build polylines from decoded legs or encoded polylines
  const routeLines = useMemo(() => {
    const lines: { path: google.maps.LatLngLiteral[]; busId: number }[] = [];
    for (const bus of busEntries) {
      if (bus.decodedLegs && bus.decodedLegs.length > 0) {
        for (const leg of bus.decodedLegs) {
          if (leg.length > 1) {
            lines.push({ path: leg, busId: bus.id });
          }
        }
      } else if (bus.routePolylines && bus.routePolylines.length > 0) {
        for (const enc of bus.routePolylines) {
          if (enc) {
            lines.push({ path: decodePolyline(enc), busId: bus.id });
          }
        }
      }
    }
    return lines;
  }, [busEntries]);

  // build trail lines from position history
  const trailLines = useMemo(() => {
    return busEntries
      .filter((bus) => bus.positionHistory.length >= 2)
      .map((bus) => ({ path: bus.positionHistory, busId: bus.id }));
  }, [busEntries]);

  if (!apiKey) {
    return (
      <div className="flex h-full items-center justify-center bg-muted rounded-lg">
        <div className="text-center p-8">
          <p className="text-lg font-semibold text-foreground mb-2">Google Maps API Key Required</p>
          <p className="text-muted-foreground text-sm">
            Enter your API key in the sidebar to enable the map visualization.
            <br />
            The simulation will still run using haversine-based routing.
          </p>
        </div>
      </div>
    );
  }

  if (!isLoaded) {
    return (
      <div className="flex h-full items-center justify-center bg-muted rounded-lg">
        <p className="text-muted-foreground animate-pulse">Loading Google Maps…</p>
      </div>
    );
  }

  return (
    <GoogleMap
      mapContainerStyle={MAP_STYLES}
      center={MAP_CENTER}
      zoom={11}
      onLoad={onLoad}
      options={{ disableDefaultUI: false, zoomControl: true, mapTypeControl: false }}
    >
      {/* Buses */}
      {busEntries.map((bus) => (
        <Marker
          key={`bus-${bus.id}`}
          position={bus.position}
          draggable={bus.available && !state.running && !!onBusDrag}
          onDragEnd={(e) => {
            if (e.latLng && onBusDrag) {
              onBusDrag(bus.id, { lat: e.latLng.lat(), lng: e.latLng.lng() });
            }
          }}
          label={{ text: `B${bus.id}`, color: "#fff", fontSize: "10px", fontWeight: "bold" }}
          icon={{
            path: google.maps.SymbolPath.CIRCLE,
            scale: 10,
            fillColor: bus.available ? "#1a8cff" : "#2db87a",
            fillOpacity: 1,
            strokeColor: "#fff",
            strokeWeight: 2,
          }}
          title={`Bus ${bus.id} – ${bus.available ? "Available" : `${bus.onboard.length} onboard`}${bus.available && !state.running ? " (drag to reposition)" : ""}`}
        />
      ))}

      {/* Virtual stops */}
      {stopEntries.map((stop) => (
        <Marker
          key={`stop-${stop.id}`}
          position={stop.position}
          icon={{
            path: google.maps.SymbolPath.BACKWARD_CLOSED_ARROW,
            scale: 4,
            fillColor: stop.status === "open" ? "#e6a817" : "#4d9de0",
            fillOpacity: 0.9,
            strokeColor: "#fff",
            strokeWeight: 1,
          }}
          title={`Stop ${stop.id} – ${stop.riderIds.length} riders – ${stop.status}`}
        />
      ))}

      {/* Trail polylines (past path) */}
      {trailLines.map((line, i) => (
        <Polyline
          key={`trail-${line.busId}-${i}`}
          path={line.path}
          options={{
            strokeColor: "#888",
            strokeWeight: 2,
            strokeOpacity: 0.35,
            icons: [{ icon: { path: "M 0,-1 0,1", strokeOpacity: 0.5, scale: 2 }, offset: "0", repeat: "10px" }],
          }}
        />
      ))}

      {/* Active route polylines */}
      {routeLines.map((line, i) => (
        <Polyline
          key={`poly-${line.busId}-${i}`}
          path={line.path}
          options={{
            strokeColor: "#2db87a",
            strokeWeight: 3,
            strokeOpacity: 0.8,
          }}
        />
      ))}
    </GoogleMap>
  );
}
