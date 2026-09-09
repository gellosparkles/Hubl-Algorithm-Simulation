# Hubl routing algorithm — rebuild plan

> **For the implementing agent:** read [CLAUDE.md](CLAUDE.md) first — it documents the build commands,
> the headless-simulation workflow, the determinism contract, and the gotchas this plan builds on.
> File links below are relative to this repo root. Phases are ordered; Phase 0 is a hard prerequisite.
> Nothing here has been implemented yet.

---

## Context

> **Status (issue #13, post-rewrite):** the sections below describe the *pre-rewrite* starting
> point. `clustering.ts` and `planner.ts` are retired — the shipped algorithm lives in
> [`src/services/stops.ts`](src/services/stops.ts), [`src/engine/tripModel.ts`](src/engine/tripModel.ts)
> and [`src/engine/dispatch.ts`](src/engine/dispatch.ts). The current `DEFAULT_CONFIG` baseline is
> ~363 requests → ~4 completed / ~233 pending / ~124 unserved / ~186 expired (5 seeds, haversine —
> `bench/baseline.json`), and the ≥60% acceptance gate in the Verification section below was
> **not met**: issue #13 found it unreachable at `DEFAULT_CONFIG` without a design change. See the
> "Baseline to beat" paragraph in `CLAUDE.md` for the diagnosis and parameter sweeps.

`la-transit-navigator` is a browser-side on-demand transit simulator for the LA basin. Riders appear
stochastically, are grouped into *virtual stops* by origin proximity, and capacity-limited buses are
assigned chained pickup routes ending at user-placed drop-off hubs. The whole algorithm is ~250 lines
across [clustering.ts](src/services/clustering.ts) and
[planner.ts](src/services/planner.ts), driven by
[simulator.ts](src/engine/simulator.ts). There is no backend.

**It did not work.** At `DEFAULT_CONFIG` over 60 minutes: ~372 requests → **~14 completed, ~297 still
pending**. Two root causes, both structural rather than tuning problems:

1. **The trip model is fake.** `RiderRequest.destination` is generated and stored but never read.
   The hub a rider is sent to is drawn uniformly at random at stop-formation time
   ([simulator.ts:293](src/engine/simulator.ts:293)). So riders standing next to
   each other but bound for opposite ends of LA get pooled, then hauled to an unrelated hub. This is
   "group nearby people and drive them somewhere," not origin-destination routing.

2. **The dispatcher is myopic and single-shot.** Pickup order is greedy nearest-neighbor from the
   bus's current position ([planner.ts:51](src/services/planner.ts:51)), which
   ignores the direction of the hub — the one thing that makes a many-to-one problem tractable.
   Buses are then locked (`available = false`) until `busyUntil`, so a bus with 7 empty seats driving
   directly past a waiting stop cannot take it. `minGroupSize: 2` permanently strands any rider
   without a neighbor within 500 m ([clustering.ts:47](src/services/clustering.ts:47)).

**Intended outcome:** a dispatcher that genuinely models *many pickups → one hub* (inbound) and
*one hub → many drop-offs* (outbound), lifts service rate from ~4% to a defensible number, exposes
the KPIs needed to prove it, and leaves a clean seam for a real solver later.

### Decisions taken (from the requirements discussion)

| | |
|---|---|
| **Deliverable** | Staged. Rewrite the in-browser dispatcher behind a pluggable interface. No backend, no API key required, headless tests stay fast. Leave a seam for an OR-Tools / Google Route Optimization adapter. |
| **Trip pattern** | Both directions, hub-anchored. Each request is classified INBOUND or OUTBOUND from its real origin/destination against the nearest hub. |
| **Travel times** | LA-calibrated haversine by default (detour factor + time-of-day speed), behind a `TravelTimeProvider` interface with a Google `computeRouteMatrix` adapter. |
| **Frontend** | Real KPI dashboard + a rider request form (manual O/D pin entry). *Not* in scope: hub/zone editor, route inspector. |

---

## What the industry actually does

Research findings that drive the design below.

**Hub-anchored pooling is a corridor problem, not a nearest-neighbor problem.** The standard DARP
insertion heuristic (Jaw et al. 1986; [Diana & Dessouky 2004](https://bpb-us-w1.wpmucdn.com/sites.usc.edu/dist/0/249/files/2017/02/22A-New-Regret-Insertion-Heuristic-for-Solving-Large-scale-Dial-a-ride-Problems-with-Time-Windows22-Transportation-Research-Part-B-Methodological-38-539-557-2004-M.-Diana-and-M.-M.-Dessouky-PDF-28havuo.pdf))
scores a candidate by **marginal detour** — `t(prev, s) + t(s, next) − t(prev, next)` — over every
insertion position in the existing itinerary. Because the hub is pinned at the end of the route, this
metric automatically prefers stops that lie *along the way*. That is the single highest-value change here.

**Batch, then resolve with regret.** Uber and Via accumulate requests over a short window rather than
matching on arrival, which materially improves assignment quality
([Uber batched matching](https://dev.to/ishaanthedev/designing-uber-a-real-time-ride-matching-system-at-scale-pc9)).
Within a batch, **regret-2** insertion — assign the request whose *second-best* option is much worse
than its best (`Δ₂ − Δ₁`) first — beats plain cheapest-insertion for ~30 lines of code
([Ropke & Pisinger ALNS](https://pubsonline.informs.org/doi/10.1287/trsc.2018.0837)).

**Insert into live routes.** [Alonso-Mora et al., PNAS 2017](https://www.pnas.org/doi/10.1073/pnas.1611675114)
showed 2,000 vehicles serving 98% of NYC taxi demand at 2.8 min mean wait — the enabling property is
that in-progress vehicles remain assignable. Our "lock the bus until `busyUntil`" model gives away
most of the fleet's capacity.

**Virtual stops are the right primitive.** Via's model — riders walk a block to a shared corner so the
vehicle avoids a door-to-door detour ([Via](https://ridewithvia.com/resources/what-is-microtransit)) —
is exactly what `VirtualStop` is reaching for. The fix is to make stops *persistent grid cells* rather
than per-tick centroids, so late arrivals join an existing stop instead of spawning a duplicate.

**Promises, not best-effort.** UberX Share commits to a bounded detour (~8 min added on average,
[Uber](https://www.uber.com/us/en/ride/uberx-share/)). Google's
[Route Optimization `ShipmentModel`](https://developers.google.com/maps/documentation/route-optimization/reference/rest/v1/ShipmentModel)
formalizes the same thing as `pickupToDeliveryRelativeDetourLimit` +
`pickupToDeliveryAbsoluteDetourLimit`, with `penaltyCost` for unperformed shipments. Adopt that shape —
it makes the objective explicit and makes the future solver adapter a mechanical mapping.

**Matrices, once per batch.** `computeRouteMatrix` allows 625 elements per request (100 with
`TRAFFIC_AWARE_OPTIMAL`) at ~$5/1k elements
([Routes API billing](https://developers.google.com/maps/documentation/routes/usage-and-billing)).
The current code instead makes one sequential `DirectionsService` round-trip *per leg, per bus, per tick*
inside a 400 ms interval ([planner.ts:71](src/services/planner.ts:71)).

---

## Target architecture

```
src/engine/types.ts          domain types  (extended: TripDirection, PlanStop, Bus.plan, timestamps)
src/engine/simulator.ts      the clock     (slimmed: delegates to dispatcher, drives kinematics)
src/engine/objective.ts      NEW  scoreRoute() + cost weights — the single definition of "better"
src/engine/metrics.ts        NEW  KPI computation from rider timestamps

src/services/travelTime.ts   NEW  TravelTimeProvider interface
                                  + HaversineProvider (LA-calibrated, default)
                                  + GoogleMatrixProvider (computeRouteMatrix + LRU cache)
src/services/stops.ts        NEW  persistent grid-snapped virtual stops (replaces clustering.ts)
src/services/dispatch/
  index.ts                   NEW  Dispatcher interface + DispatchInput/DispatchResult
  insertion.ts               NEW  InsertionDispatcher — feasibility + marginal detour + regret-2
src/services/routing.ts      keep haversine helpers; move Google path fetch to display-only

src/components/KpiDashboard.tsx   NEW  replaces MetricsDashboard
src/components/RiderRequestForm.tsx NEW  two-pin manual request injection
```

Files retired: `src/services/clustering.ts` → `stops.ts`; `src/services/planner.ts` →
`dispatch/insertion.ts`.

---

## Phase 0 — Benchmark harness first

Nothing else is measurable without this. **Do this before touching the algorithm.**

- `src/engine/bench.ts` — sweep a config across N seeds, return aggregated KPIs.
  Reuse the existing headless pattern from
  [simulator.test.ts:12-18](src/engine/simulator.test.ts:12) (`run(overrides, minutes)`),
  which already runs a 60-min sim in ~430 ms with no browser.
- `npm run bench` script printing a table: service rate, P50/P90 wait, mean detour ratio, vehicle-km,
  occupancy, unserved.
- Record the current baseline across ≥5 seeds and commit it as `bench/baseline.json`. Per
  [CLAUDE.md:98](CLAUDE.md:98), one seed is an anecdote — always sweep.
- Always state which travel-time provider a benchmark used; haversine and Google modes are not comparable.

---

## Phase 1 — `TravelTimeProvider`

**New file `src/services/travelTime.ts`.**

```ts
export interface TravelTimeProvider {
  /** minutes, a→b, departing at sim-minute t */
  time(a: LatLng, b: LatLng, atMin: number): number;
  /** batched; called once per dispatch batch, never per leg */
  matrix(origins: LatLng[], dests: LatLng[], atMin: number): Promise<number[][]>;
  /** display geometry only — never called from the dispatcher hot loop */
  path?(a: LatLng, b: LatLng): Promise<LatLng[]>;
}
```

**`HaversineProvider` (default).** `time = haversine(a,b) × detourFactor / speedAt(atMin) × 60`.
Reuse `haversine` from [routing.ts:12](src/services/routing.ts:12) as-is.

- `detourFactor` ≈ **1.35** — street-network circuity for the LA grid. Straight-line distance
  systematically under-states LA driving distance; this is why the current sim's ETAs are optimistic.
- `speedAt(minute)` — piecewise profile over the sim horizon, e.g. 32 km/h off-peak, 18 km/h during a
  configurable peak window. Add `detourFactor`, `speedProfile` to `SimConfig`.
- Fixes the latent mismatch where
  [`travelTimeMinutes` defaults to 25 km/h](src/services/routing.ts:28) while
  `DEFAULT_CONFIG.busSpeed` is 35 — one code path used each.

**`GoogleMatrixProvider`.** Wraps `computeRouteMatrix`. Chunk to ≤625 elements (≤100 for
`TRAFFIC_AWARE_OPTIMAL`). LRU cache keyed by `(round(lat,4), round(lng,4), 15-min bucket)`.
Falls back to `HaversineProvider` on any failure, and reports which provider answered so benchmarks
stay honest.

**Delete** the now-dead `getDistance` and `getDistanceMatrix`
([routing.ts:121,144](src/services/routing.ts:121)) — neither is imported anywhere.

---

## Phase 2 — Trip direction + destination-aware stops

### 2a. Classify every request

Extend `RiderRequest` in [types.ts:24](src/engine/types.ts:24):

```ts
type TripDirection = "inbound" | "outbound" | "unserved";

interface RiderRequest {
  // ...existing...
  direction: TripDirection;
  hubIndex: number | null;      // the anchor hub — derived, never random
  tAssigned: number | null;
  tPickedUp: number | null;     // physical arrival, not assignment
  tDroppedOff: number | null;
  promisedPickupBy: number;     // tRequest + maxWaitMinutes
  directTimeMin: number;        // provider.time(origin, destination) at tRequest
  maxRideTimeMin: number;       // directTimeMin * rideTimeFactor + rideTimeSlackMin
}
```

Classification (new `src/engine/tripModel.ts`, or top of `stops.ts`):

- `dOrigin = dist(origin, nearestHub)`, `dDest = dist(destination, nearestHub)`
- **inbound** if `dDest ≤ hubCatchmentKm` and `dDest < dOrigin` → collect at a virtual stop near
  `origin`, deliver to that hub.
- **outbound** if `dOrigin ≤ hubCatchmentKm` and `dOrigin < dDest` → board at the hub, alight at a
  virtual stop near `destination`.
- otherwise **unserved** — counted explicitly in KPIs rather than silently pending forever.

**Delete `simulator.ts:291-294`** (`stop.dropOffHubIndex = Math.floor(rng.next() * ...)`). That line is
the core defect.

### 2b. Persistent grid-snapped virtual stops

**New `src/services/stops.ts`, replacing `clustering.ts`.**

Current clustering re-derives stops from scratch every tick over all pending riders — O(n²) with ~300
pending, and it churns: an unassigned stop expires at `maxWaitMinutes`, its riders reset to pending,
and the identical group re-forms next tick with a fresh id. That livelock inflates `totalStops` and
starves everyone.

Replace with stable stops:

- Snap each rider's origin (inbound) or destination (outbound) to a **~150 m grid cell**; the stop key
  is `(cellId, direction, hubIndex)`. A late-arriving rider **joins the existing stop** rather than
  creating a new one.
- Stop position = the cell's representative point (centroid of its current members, recomputed on join),
  with a hard check that **every member is within `maxWalkKm` of the final position**. Today the radius
  is measured from the *anchor* while riders walk to the *centroid*, so real walk distance can reach ~2×
  `maxWalkKm` and `walkDistanceKm` is never validated
  ([clustering.ts:42,68](src/services/clustering.ts:42)).
- **Change `minGroupSize` semantics.** Today `< minGroupSize` means *never served*
  ([clustering.ts:47](src/services/clustering.ts:47)); with the default of 2 that
  strands every isolated rider permanently and is the dominant cause of the ~297 pending baseline.
  New default `minGroupSize: 1`, with consolidation driven by the objective function's per-stop dwell
  cost instead of a hard gate.
- Index pending riders by grid cell so stop maintenance is O(n), not O(n²).
- Drop the `incentive` field, or use it — it is written at
  [clustering.ts:72](src/services/clustering.ts:72) and read nowhere.

---

## Phase 3 — Insertion dispatcher (the core rewrite)

### 3a. Represent a bus's itinerary explicitly

Today `Bus.route: number[]` plus parallel `routeEtas` / `routePolylines` / `decodedLegs` arrays, and
`available: boolean`. Replace with one structure in [types.ts:8](src/engine/types.ts:8):

```ts
interface PlanStop {
  kind: "pickup" | "dropoff" | "hub";
  position: LatLng;
  stopId: number | null;        // null for hub visits
  hubIndex: number | null;
  boarding: number[];           // rider ids getting on here
  alighting: number[];          // rider ids getting off here
  etaMin: number;               // absolute sim minute
  loadAfter: number;            // occupancy leaving this stop
}

interface Bus {
  // ...existing position/capacity/speed...
  plan: PlanStop[];             // remaining itinerary; [] means idle
  legIndex: number;             // which leg of `plan` the bus is currently traversing
  legStartedAt: number;         // absolute sim minute the current leg began
  onboard: number[];
  positionHistory: LatLng[];
}
```

This kills several bugs at once:

- **Colliding drop-off stop ids.** `dropOffStopIdBase` is a local `let` reset to `-1000` on every
  `planRoute` call ([planner.ts:114](src/services/planner.ts:114)), and
  [simulator.ts:339](src/engine/simulator.ts:339) writes them into the shared
  `s.stops` map — bus 2's hub stop silently overwrites bus 1's. Hub visits become plan entries, not
  fake stops in the global map.
- **`busyUntil` back-derivation.** [simulator.ts:219](src/engine/simulator.ts:219)
  reconstructs the route start as `busyUntil − lastEta − 5`, re-deriving the hardcoded 5-min buffer
  from [simulator.ts:334](src/engine/simulator.ts:334). `legStartedAt` replaces it.
- **`available` as a lock.** Eligibility becomes "can this plan absorb the insertion feasibly?"

### 3b. Feasibility check

`isFeasible(plan, insertion, config): boolean` — one O(k) forward pass over the proposed plan:

- **Load profile**: `loadAfter ≤ capacity` at *every* stop. Today capacity is a single running counter
  ([planner.ts:34,94](src/services/planner.ts:34)) that never accounts for riders
  alighting mid-route.
- **Pickup window**: every rider's `etaMin` at their boarding stop `≤ promisedPickupBy`.
- **Max ride time**: `alightEta − boardEta ≤ maxRideTimeMin` for every onboard and newly-inserted rider.
  This is Google's `pickupToDeliveryRelativeDetourLimit`/`AbsoluteDetourLimit` pair; it is the promise
  that makes pooling acceptable, and it does not exist today at all.
- **Route duration**: total plan duration ≤ `timeBudgetMinutes`. Today the budget check exempts the
  first leg (`route.length > 0` guard,
  [planner.ts:64](src/services/planner.ts:64)) and never covers drop-off legs at all.
- Dwell model stays `1 + 0.2 × riders` for pickups, `1` for drop-offs
  ([planner.ts:62,119](src/services/planner.ts:62)) — move both to `SimConfig`.

**Never mutate a plan that violates a promise already made to an onboard rider.** That invariant is what
makes continuous insertion safe.

### 3c. Marginal-detour insertion

```ts
function bestInsertion(bus, stop, provider, config): { cost, plan } | null
```

For an **inbound** stop bound for hub `h`: the bus's plan ends at `h`. Try inserting the pickup at every
position `i` before the hub visit; cost is

```
Δ(i) = t(plan[i-1], s) + t(s, plan[i]) − t(plan[i-1], plan[i])
```

Take the min-cost feasible `i`. If the bus has no plan yet, seed it as `[s, hub]`.

For an **outbound** stop: the plan starts with a hub visit; insert the drop-off at every position after
it, same formula. Symmetric — one code path, parameterized by direction.

A bus's plan is **direction-homogeneous** in v1 (all-inbound or all-outbound). Mixed plans (drop off at
a hub, then immediately pick up outbound riders there) are a Phase 5 extension.

Score with an explicit objective in **new `src/engine/objective.ts`**, mirroring Google's cost model:

```ts
cost = costPerKm · km
     + costPerHour · hours
     + waitWeight   · Σ rider wait
     + rideWeight   · Σ (actualRide − directRide)
     + walkWeight   · Σ walkDistanceKm
     + unservedPenalty · unservedCount
```

Every weight lives in `SimConfig`. This is the single definition of "better" — benchmarks, regret
scoring, and any future solver all read from it.

### 3d. Batch matching with regret-2

Replace the first-come loop at
[simulator.ts:322-355](src/engine/simulator.ts:322) (`for (const bus of buses)
planRoute(bus, openStops)`, which lets bus 1 greedily take the best stops):

```
for each dispatch tick:
  1. collect all open stops + all buses with spare capacity
  2. one provider.matrix() call for the whole batch          ← not per-leg
  3. for each stop: compute bestInsertion against every eligible bus
  4. regret(stop) = Δ_secondBestBus − Δ_bestBus
  5. repeatedly: assign the stop with the highest regret to its best bus,
     commit the plan, recompute affected stops' insertions
  6. leave stops with no feasible insertion open for the next batch
```

Add `batchWindowMinutes` to `SimConfig` (default 1 = current per-tick behavior; ≥2 trades wait for
match quality, which is the Uber/Via lever worth sweeping).

**Continuous insertion is the throughput unlock**: step 1 considers *every* bus with spare capacity, not
only idle ones.

### 3e. Idle repositioning (small, high-value)

When a bus finishes a plan it currently freezes at the last drop-off. Add a cheap rebalancing step:
idle buses drift toward the demand-weighted centroid of open inbound stops (or toward the nearest hub
for outbound service). Literature reports meaningful wait-time reductions from rebalancing alone
([Non-myopic matching and rebalancing](https://arxiv.org/abs/2510.25796)). Keep it behind a
`rebalanceEnabled` config flag so its contribution is measurable in isolation.

---

## Phase 4 — Metrics and frontend

### 4a. `src/engine/metrics.ts`

Replace the six raw counters in
[types.ts:65](src/engine/types.ts:65). Computed from the new rider timestamps:

| KPI | Definition |
|---|---|
| Service rate | `completed / totalRequests` |
| Wait P50 / P90 | `tPickedUp − tRequest` |
| In-vehicle P50 / P90 | `tDroppedOff − tPickedUp` |
| Detour ratio | `(tDroppedOff − tPickedUp) / directTimeMin` |
| Vehicle-km, deadhead % | total km; share driven with zero onboard |
| Mean occupancy | load-weighted over travel time |
| Pooling rate | share of riders who shared at least one leg |
| Unserved / expired | classified `unserved`, or never matched by horizon end |
| Mean walk | `walkDistanceKm` |

Prerequisite fix: **`picked_up` must be set at physical arrival, not at route assignment**
([simulator.ts:344](src/engine/simulator.ts:344)), and `completed` per drop-off
stop rather than for the whole `onboard` list at `busyUntil`
([simulator.ts:208](src/engine/simulator.ts:208)). Without this, no time-based KPI
is meaningful.

Also: make `busAssignments` a plain counter. It is currently
`log.filter(l => l.includes("assigned route")).length`
([simulator.ts:360](src/engine/simulator.ts:360)) — O(n²) over a run and silently
broken by any log-wording change. Cap `eventLog` to a ring buffer while there.

### 4b. `KpiDashboard.tsx`

Replaces [MetricsDashboard.tsx](src/components/MetricsDashboard.tsx). Headline
chips (service rate, wait P90, detour ratio, occupancy) plus a small time-series of service rate and
wait. `recharts` is already a dependency — no new packages.

### 4c. `RiderRequestForm.tsx`

Lets a person inject a real request mid-run:

- Two-pin placement — pickup, then drop-off — reusing the existing map-click plumbing
  (`placingDropOff` / `handleMapClick` in
  [Index.tsx:97](src/pages/Index.tsx:97)); generalize that flag into a
  `mapMode: "idle" | "placeHub" | "placePickup" | "placeDropoff"`.
- On submit, push a `RiderRequest` into `state.requests` with `tRequest = state.time`, run the same
  classification as generated riders, and surface: assigned virtual stop + walk distance, promised
  pickup time, assigned bus, live ETA, and estimated drop-off.
- Works in both [SimulationMap](src/components/SimulationMap.tsx) (Google) and
  [FallbackMap](src/components/FallbackMap.tsx) (canvas) — the latter already has
  inverse-projected click handling.
- Highlight the tracked rider's stop and bus on the map.

---

## Phase 5 — Solver seam

`src/services/dispatch/index.ts`:

```ts
export interface Dispatcher {
  dispatch(input: DispatchInput): Promise<DispatchResult>;
}
```

`DispatchInput` should mirror Google's `ShipmentModel` shape — `shipments[]` with `pickups[]` /
`deliveries[]` (`VisitRequest` arrays, which is exactly how alternative pickup locations are expressed),
`loadDemands`, `timeWindows`, `pickupToDeliveryRelativeDetourLimit`, `penaltyCost`; `vehicles[]` with
`loadLimits`, `costPerKilometer`, `costPerHour`, `fixedCost`. Then:

- `InsertionDispatcher` — the Phase 3 implementation, the default, zero dependencies.
- `OrToolsDispatcher` / `GoogleRouteOptimizationDispatcher` — future, backend-hosted, near-mechanical
  mapping from `DispatchInput`.

Nothing in Phase 5 ships now beyond the interface and the default implementation behind it.

---

## Ordering and risk

| Phase | Depends on | Risk |
|---|---|---|
| 0 Benchmark harness | — | none; do first |
| 1 TravelTimeProvider | 0 | low — pure refactor + calibration constants |
| 2 Trip model + stops | 1 | **changes baseline numbers**; re-record benchmarks |
| 3 Insertion dispatcher | 2 | highest; `Bus.plan` refactor touches simulator + both maps |
| 4 Metrics + frontend | 3 | medium; needs the corrected `tPickedUp` semantics |
| 5 Solver seam | 3 | low; interface extraction |

Phase 3 is the only place with real integration risk. Land Phases 0–2 as separate commits with
benchmarks recorded at each step, so a regression is attributable.

---

## Verification

**Determinism must survive.** The existing suite in
[simulator.test.ts](src/engine/simulator.test.ts) asserts that a fixed
`config.seed` reproduces identical metrics, event log, `rngState`, and rider ids, and that two
interleaved sims stay isolated. Every one of those tests must still pass. Note the module-global
`nextReqId` / `nextStopId` counters (CLAUDE.md gotcha) — `stops.ts` must keep resetting its counter in
`createInitialState`.

```bash
npm run test:engine
```

**New engine tests** (`src/services/dispatch/insertion.test.ts`, `src/services/stops.test.ts`):

- Insertion returns `null` when capacity would be exceeded *at any point* in the load profile.
- Insertion returns `null` when it would push an onboard rider past `maxRideTimeMin`.
- Marginal-detour cost strictly prefers an on-corridor stop over a nearer off-corridor one — the exact
  case current nearest-neighbor gets wrong. Construct a fixture: bus at A, hub at H, stop S1 slightly
  nearer to A but perpendicular to A→H, stop S2 farther but directly on A→H. Assert S2 wins.
- Direction classification: an origin near a hub with a far destination is `outbound`; the reverse is
  `inbound`; both far is `unserved`.
- Grid stops are stable — a rider arriving 3 ticks later in the same cell joins the existing stop id.
- Every rider's `walkDistanceKm ≤ config.maxWalkKm` (currently violable).
- Load-profile invariant across a full run: `loadAfter ≤ capacity` at every `PlanStop`.

**Benchmark, not vibes.**

```bash
npm run bench -- --seeds 5 --minutes 60
```

Compare against `bench/baseline.json`. Success criteria, haversine provider, 8 buses,
6 req/min, 60 min:

- Service rate from ~4% to **≥ 60%**, with wait P90 ≤ `maxWaitMinutes` and mean detour ratio ≤ 1.6.
- Mean occupancy meaningfully above 1.0 — the current model averages roughly one rider per bus-route.
- Sweep `numBuses`, `batchWindowMinutes`, `maxWalkKm`, `minGroupSize`, `timeBudgetMinutes` and confirm
  monotonic, explicable behavior. Hold the seed fixed and change one parameter at a time; sweep several
  seeds before believing any result.

> **Issue #13 outcome:** the ≥60% gate is **not met** at `DEFAULT_CONFIG` (actual ~1.2%) and was
> found unreachable there without a design change — the binding constraint is the pickup-promise
> vs. an 8-bus fleet spread over the basin (≈98% of insertion rejections are `pickup-window`), plus
> ~34% structurally `unserved` and near-zero stop pooling at ~150 m cells. Sweeps are monotonic and
> explicable *except* two grid-granularity artefacts: `maxWalkKm` is completely inert (walk ≈ 0 at
> ~150 m cells) and `minGroupSize ≥ 2` collapses service to 0% (no cell ever holds 2 concurrent
> pending riders). Full diagnosis, sweep tables and the regenerated baseline: `CLAUDE.md`
> "Baseline to beat".

**UI.**

```bash
npm run typecheck && npm run test:ui && npm run e2e
```

Then drive the dev server (`npm run dev`, port 8080) with the browser tools: place two hubs, start the
sim, confirm buses visibly chain pickups *toward* a hub rather than zig-zagging, submit a manual rider
request through the new form, and confirm it is matched with a promised ETA that the bus then meets.
Screenshot before/after for the corridor behavior. Note `tsconfig` has `strictNullChecks: false`, so a
clean `tsc` does not imply null-safety — lean on the runtime invariant tests.

**Housekeeping while in these files** — dead code to remove:
`decodePolyline` in [simulator.ts:21](src/engine/simulator.ts:21) (duplicated in
`SimulationMap.tsx`), `getDistance` / `getDistanceMatrix` in
[routing.ts:121](src/services/routing.ts:121), and `RiderRequest.incentive`.
Also fix `interpolateAlongPath`, which measures distance in raw degrees rather than metres
([simulator.ts:47](src/engine/simulator.ts:47)) — harmless for display, wrong for
anything derived from it.

---

## Sources

- [Alonso-Mora et al., *On-demand high-capacity ride-sharing via dynamic trip-vehicle assignment*, PNAS 2017](https://www.pnas.org/doi/10.1073/pnas.1611675114)
- [Diana & Dessouky, *A new regret insertion heuristic for large-scale DARP with time windows*](https://bpb-us-w1.wpmucdn.com/sites.usc.edu/dist/0/249/files/2017/02/22A-New-Regret-Insertion-Heuristic-for-Solving-Large-scale-Dial-a-ride-Problems-with-Time-Windows22-Transportation-Research-Part-B-Methodological-38-539-557-2004-M.-Diana-and-M.-M.-Dessouky-PDF-28havuo.pdf)
- [Gschwind & Drexl, *ALNS with a constant-time feasibility test for the DARP*, Transportation Science](https://pubsonline.informs.org/doi/10.1287/trsc.2018.0837)
- [Google Route Optimization API — `ShipmentModel` reference](https://developers.google.com/maps/documentation/route-optimization/reference/rest/v1/ShipmentModel)
- [Google Routes API — `computeRouteMatrix` limits and billing](https://developers.google.com/maps/documentation/routes/usage-and-billing)
- [Via — what is microtransit / virtual bus stops](https://ridewithvia.com/resources/what-is-microtransit)
- [Uber — UberX Share](https://www.uber.com/us/en/ride/uberx-share/)
- [Uber batched matching architecture overview](https://dev.to/ishaanthedev/designing-uber-a-real-time-ride-matching-system-at-scale-pc9)
- [Non-myopic matching and rebalancing in large-scale ride-pooling](https://arxiv.org/abs/2510.25796)
- [LA Metro GTFS / regional feeds](https://developer.metro.net/gtfs-schedule-data/) — for a future upgrade from the 8 hardcoded `LA_HOTSPOTS` to real demand and stop data
