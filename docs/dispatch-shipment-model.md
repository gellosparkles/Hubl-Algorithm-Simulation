# The dispatcher's shipment-model contract

*Issue #12 — plan.md Phase 5.*

`InsertionDispatcher` is the only dispatcher that ships. But its **input** is
deliberately shaped as a shipment model so that a later OR-Tools or Google Route
Optimization backend is a field-mapping exercise, not an engine rewrite.

- Runtime contract: `Shipment`, `Vehicle`, `DispatchRequest`, `DispatchResult` in
  [`src/engine/dispatch.ts`](../src/engine/dispatch.ts).
- Serialised contract: `serializeShipmentModel()` in
  [`src/engine/shipmentModel.ts`](../src/engine/shipmentModel.ts), locked by the
  golden file `src/engine/__snapshots__/shipmentModel.golden.json`. Any unreviewed
  change to the shape fails `shipmentModel.test.ts`.

The objective weights (`config.objective`, [`objective.ts`](../src/engine/objective.ts))
already mirror Google's cost model (`costPerKilometer`, `costPerHour`, plus the
rider-experience penalties); this document covers the *model* fields.

## Request-level fields → Google `OptimizeToursRequest`

| Our field | Google field | Notes |
|---|---|---|
| `DispatchRequest.now` | `OptimizeToursRequest.model.globalStartTime` | Sim-minute the batch is planned at. Every visit `timeWindowEnd` is serialised as an offset from it. |
| `DispatchRequest.riders` (`Map<id, RiderMeta>`) | — | Per-rider promise data (`tRequest`, `directTimeMin`, `maxRideTimeMin`, `promisedPickupBy`, `walkKm`, `boardedAt`). Not part of a stateless `ShipmentModel` — it is the source the shipment-level detour limits and windows are folded down from, and `boardedAt` is what pins an onboard rider (see "What an adapter still needs"). |
| config `timeBudgetMinutes` | `OptimizeToursRequest.model.globalEndTime` (as `now + budget`) | Whole-itinerary cap; serialised as `globalDurationBudgetMinutes`. |

## Shipment → Google `ShipmentModel.shipments[]`

| Our field | Google Route Optimization field | Notes |
|---|---|---|
| `id` | `Shipment.label` | Serialised as `stop-<id>`. It is the virtual-stop id. |
| `direction` | — | Engine-only; picks which end is the hub. A solver infers nothing from it. |
| `hubIndex` | — | Engine-only routing constraint (a vehicle serves one hub per plan). A solver would express this as a vehicle/visit tag or a separate model per hub. |
| `pickups[]` | `Shipment.pickups[]` (`VisitRequest[]`) | Alternative pickup locations. The insertion dispatcher reads `[0]`; the array exists so an adapter passes it straight through. |
| `deliveries[]` | `Shipment.deliveries[]` (`VisitRequest[]`) | Same, for the drop-off end. |
| `pickups[].location` / `deliveries[].location` | `VisitRequest.arrivalLocation` (`LatLng`) | Serialised as `{ latitude, longitude }`. |
| `pickups[].timeWindowEnd` | `VisitRequest.timeWindows[].endTime` | Absolute sim-minute; serialised as a minute offset from `now`. `null` ⇒ omitted (no window). Derived from `min(promisedPickupBy)` over the shipment's riders. |
| `load` | `Shipment.loadDemands["riders"].amount` | Rider count. |
| `riderIds` | — | Engine bookkeeping; a solver only needs `loadDemands`. |
| `maxRideTimeMin` | `Shipment.pickupToDeliveryAbsoluteDetourLimit` | Google wants a duration string (`"1500s"`); we carry minutes. Tightest `maxRideTimeMin` over the shipment's riders. |
| `relativeDetourLimit` | `Shipment.pickupToDeliveryRelativeDetourLimit` | Carried explicitly so an adapter never back-computes it. **Approximate:** the engine derives it as the tightest `maxRideTimeMin / directTimeMin − 1` over the riders, where `directTimeMin` is each rider's *door-to-door* direct time. Google's field is relative to the direct *pickup→delivery* (stop→hub) path, which differs by the walk legs. An adapter targeting Google exactly should recompute this against its own `pickup→delivery` shortest path (see below). |
| `penaltyCost` | `Shipment.penaltyCost` | Cost charged to a solution that leaves the shipment unperformed. `config.objective.unservedPenalty × load`. |

## Vehicle → Google `ShipmentModel.vehicles[]`

| Our field | Google Route Optimization field | Notes |
|---|---|---|
| `id` | `Vehicle.label` | Serialised as `bus-<id>`. |
| `loadLimit` | `Vehicle.loadLimits["riders"].maxLoad` | Seat capacity. |
| `position` | `Vehicle.startLocation` (`LatLng`) | The vehicle's current point — for a mid-run re-plan, not a depot. |
| `costPerKm` | `Vehicle.costPerKilometer` | From `config.objective.costPerKm`. |
| `costPerHour` | `Vehicle.costPerHour` | From `config.objective.costPerHour`. |
| `fixedCost` | `Vehicle.fixedCost` | Currently `0` — every bus is already deployed. |
| `onboard` | — | Riders already aboard. See "What an adapter still needs" below. |
| `plan` (`LiteStop[]`) | — | The vehicle's committed remaining itinerary. Not part of a stateless `ShipmentModel`. |

## Result → Google `OptimizeToursResponse`

| Our field | Google field | Notes |
|---|---|---|
| `DispatchResult.assignments[]` | `routes[]` | One entry per vehicle touched this batch. |
| `VehicleAssignment.vehicleId` | `ShipmentRoute.vehicleLabel` | |
| `VehicleAssignment.lite` (`LiteStop[]`) | `ShipmentRoute.visits[]` | Our lite itinerary vs Google's ordered visit list. |
| `VehicleAssignment.stopIds` | — | Which shipments this vehicle newly took this batch (regret bookkeeping). |
| `DispatchResult.skippedShipmentIds` | `skippedShipments[]` | Shipments no vehicle could feasibly take; stay open for the next batch, priced at `penaltyCost` by a whole-solution scorer. |

## What a solver adapter still needs to supply

The serialised model is a clean stateless `ShipmentModel`; a real solver run
additionally requires:

1. **Onboard riders as fixed in-progress shipments.** `Vehicle.onboard` +
   `RiderMeta.boardedAt` must become already-picked-up shipments pinned to that
   vehicle (Google: an injected first solution / `Vehicle.startTime` with the
   pickup already performed), or the solver will try to re-pick them up.
2. **The committed plan as an injected route.** `Vehicle.plan` is the itinerary
   the insertion dispatcher is extending in place. A batch solver either takes it
   as `injectedFirstSolutionRoutes` or is allowed to re-plan from scratch —
   different latency/stability trade-off.
3. **A distance/duration source.** The engine passes a `TravelTimeProvider`
   separately (`provider.time` / `provider.matrix`); Google computes its own
   matrix, OR-Tools needs one supplied. The adapter should also recompute
   `relativeDetourLimit` against that matrix's `pickup→delivery` time rather than
   trusting the engine's door-to-door approximation.
4. **The hub-per-plan constraint.** `hubIndex` today is enforced by the dispatcher
   refusing cross-hub insertions. A solver needs this as an explicit constraint
   (visit tags, or one model per hub).
5. **Global time bounds.** `globalDurationBudgetMinutes` (= `config.timeBudgetMinutes`)
   maps to `OptimizeToursRequest` global start/end; per-rider `maxWaitMinutes`
   feeds the pickup `timeWindows`.
6. **A unit convention.** Google wants duration strings (`"900s"`) and metres; the
   contract is in minutes and degrees-of-`LatLng`. The adapter converts.

## Sources

- [Google Route Optimization API — `ShipmentModel` reference](https://developers.google.com/maps/documentation/route-optimization/reference/rest/v1/ShipmentModel)
- `plan.md` Phase 5.
