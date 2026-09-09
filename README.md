# Hubl Simulation

An **on-demand transit simulator for the Los Angeles basin**. Rider requests appear stochastically
across the map; the algorithm groups nearby riders into *virtual stops*, classifies each trip
against the nearest user-placed hub, and assigns capacity-constrained buses to chained routes with
a marginal-detour insertion dispatcher.

The React + Google Maps UI is a **viewer** for the simulation, not the simulation itself. The
algorithm lives in `src/engine/` and `src/services/`, is free of any browser dependency, and a
60-minute run executes headless in ~430 ms.

> Working on this repo with an agent? Read [CLAUDE.md](CLAUDE.md) — it is the detailed engineering
> guide (tick order, determinism contract, gotchas). [plan.md](plan.md) is the design document the
> current implementation was built from.

---

## Quick start

```bash
npm install      # NOT `npm ci` — package-lock.json predates the test/maps deps
npm run dev      # http://localhost:8080
```

In the browser: click the map to place one or more **drop-off hubs**, lock them, then start the
simulation. With no hubs nothing is classified inbound/outbound, so no shipments form and the buses
never move.

Google routing is **opt-in** and degrades silently: without an API key the engine uses an
LA-calibrated haversine travel-time model and synthesizes L-shaped display paths. Results from the
two modes are not comparable — always state which one a number came from.

### Commands

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server on port 8080 |
| `npm run build` | Production build (~10 s) |
| `npm test` | Both vitest projects (~2.4 s) |
| `npm run test:engine` | Algorithm only — node env, no jsdom. Use this while iterating |
| `npm run test:ui` | Components/pages — jsdom + testing-library |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | eslint (3 errors / 7 warnings, all pre-existing in generated files) |
| `npm run bench` | Multi-seed benchmark sweep (see below) |
| `npm run e2e` | Playwright; needs `npx playwright install chromium` once |

---

## How it works

### One tick of `simulateStep`

1. **Advance buses** along `Bus.plan` (a `PlanStop[]` itinerary) by interpolating the current leg;
   board/alight riders at each entry whose `etaMin` has elapsed; retire a plan at its last entry.
2. **Generate riders** — `poissonSample(avgRequestsPerMin)`, positions 60% clustered on 8 LA
   hotspots / 40% uniform, rejection-sampled against a coastline polygon.
3. **Maintain virtual stops** — pending riders fold into a persistent stop set keyed by
   `(≈150 m grid cell, direction, hubIndex)`. Stops live across ticks, so a later rider in the same
   cell joins the existing stop instead of spawning a duplicate.
4. **Dispatch** (`InsertionDispatcher`) — open inbound *and* outbound stops become shipments; every
   bus with spare capacity is a candidate, not only idle ones. Each stop is inserted at the
   minimum-`objectiveCost` position of some bus's live itinerary that survives the feasibility pass;
   the batch commits in regret-2 order. Runs every `batchWindowMinutes` ticks.
   - **4b. Idle repositioning** (`rebalanceEnabled`, default **off**) — a bus with no plan drifts one
     tick's travel toward demand.
5. **Recompute metrics**, `time += 1`.

**Rider lifecycle:** `pending` → `picked_up` → `completed`. `picked_up` is set when the bus
physically reaches the rider's stop and `completed` at that rider's own drop-off, so `tRequest`,
`tPickedUp` and `tDroppedOff` are real quantities every time-based KPI can be derived from.

**Feasibility gates are hard, not soft.** An insertion is rejected unless the load profile stays
≤ capacity at every point, every rider boards by `promisedPickupBy` (`tRequest + maxWaitMinutes`),
no rider exceeds `maxRideTimeMin`, and the whole itinerary fits `timeBudgetMinutes`. A rider past
their promise is dropped from the shipment and surfaces as `expired` — never picked up late.

### Layout

```
src/engine/types.ts         All domain types + LA_BOUNDS + DEFAULT_CONFIG. Start here.
src/engine/simulator.ts     The clock: simulateStep(state, config) -> Promise<SimState>
                            Also exports injectRequest() for manual mid-run riders
src/engine/rng.ts           Seeded mulberry32; entire state is one 32-bit int
src/engine/tripModel.ts     inbound / outbound / unserved classification against the nearest hub
src/engine/objective.ts     The single definition of "better" — objectiveCost(parts, weights)
src/engine/dispatch.ts      Dispatcher interface + InsertionDispatcher (feasibility →
                            marginal-detour insertion → regret-2 batch commit)
src/engine/shipmentModel.ts Frozen Google Route Optimization-shaped dispatch input contract,
                            locked by a golden file (docs/dispatch-shipment-model.md)
src/engine/metrics.ts       computeMetrics — the full KPI set
src/engine/bench.ts         Multi-seed sweep harness (+ bench.cli.ts)
src/services/stops.ts       Riders -> persistent grid-snapped virtual stops
src/services/travelTime.ts  TravelTimeProvider: haversine (default) / Google route matrix
src/services/itinerary.ts   LiteStop[] from the dispatcher -> materialised PlanStop[] (ETAs, geometry)
src/services/trackedRider.ts Read-model for the one manually-injected rider a person is watching
src/pages/Index.tsx         Drives the loop with setInterval(400 ms); owns React state + mapMode
src/components/             SimulationMap (Google), FallbackMap (SVG), controls, KPI dashboard,
                            RiderRequestForm
src/components/ui/          shadcn/ui primitives — generated, don't hand-edit
```

---

## Running the algorithm headless

The engine has no `window`/`document`/`localStorage` references. Drive it directly:

```ts
import { createInitialState, simulateStep } from "@/engine/simulator";
import { DEFAULT_CONFIG } from "@/engine/types";

const config = { ...DEFAULT_CONFIG, seed: 12345, numBuses: 12, simMinutes: 60 };
let s = createInitialState(config);
s.dropOffHubs = [{ lat: 34.0522, lng: -118.2437 }];   // required — headless runs have no UI
for (let i = 0; i < config.simMinutes; i++) s = await simulateStep(s, config);
console.log(s.metrics);
```

`simulateStep` deep-clones state via `structuredClone` and returns a new `SimState`, so every tick
is inspectable and snapshot-testable.

### Runs are deterministic — pin `config.seed`

Same seed ⇒ identical metrics, event log and rider IDs. `seed: null` (the default) draws a fresh
seed on each reset. Because the PRNG's whole state is one int inside `SimState`, snapshots resume
exactly and two simulations can run in the same process without interfering.

### Benchmarking

```bash
npm run bench                                          # 5 seeds, 60 min, DEFAULT_CONFIG
npm run bench -- --seeds 8 --numBuses 12 --maxWalkKm 0.8
npm run bench -- --seedList 12345,777,4242 --out bench/baseline.json
```

Hold the seed fixed and change one parameter at a time. **One seed is an anecdote** — sweep several
before believing a result, and record metrics before and after any dispatcher/stops change rather
than judging by watching the map.

---

## Current results

At `DEFAULT_CONFIG` (8 buses, 6 req/min, 60 min, haversine, `rebalanceEnabled: false`), mean of
5 seeds — [`bench/baseline.json`](bench/baseline.json):

| | |
|---|---|
| Requests | ~363 (roughly ⅓ inbound / ⅓ outbound / ⅓ `unserved`) |
| Completed | ~4 (service rate ~1.2%) |
| Pending / expired / unserved | ~233 / ~186 / ~124 |
| Wait P50 / P90 | ~5.5 / ~8.4 min |
| Detour ratio | ~1.26 |
| Pooling rate | ~17% |
| Vehicle-km / deadhead | ~35 km / ~21% |
| Occupancy | ~0.74 |

**The design target of ≥60% service rate is not met, and is not reachable at `DEFAULT_CONFIG`
without a design change.** The binding constraint is geometry, not a bug:

- At a mid-run tick, ~40 open shipments against 7 idle buses yield **zero** feasible
  (bus, shipment) pairs. ~98% of insertion rejections are `pickup-window` — a fleet spread across
  the basin simply cannot reach a random stop within `tRequest + maxWaitMinutes` (10 min).
- ~34% of requests are structurally `unserved`: two hubs cannot cover the LA basin.
- Each bus serves ~1 rider per ~20-minute round trip, because ~150 m cells at 6 req/min almost never
  pool. Max throughput ≈ (fleet × 3)/hr against ~370 demand.

Sweeps are monotonic and explicable (5 seeds, haversine, all else default):
`numBuses` 4→24 lifts service 0.6%→3.2%; `timeBudgetMinutes` 15→50 lifts it 1.1%→2.5%;
`batchWindowMinutes` 1→10 *drops* it 1.2%→0.7% (staler batches). Two knobs are artefacts of the
grid-stop granularity rather than regressions: **`maxWalkKm` has no effect at all** (a rider is
always inside their own stop's cell, so walk ≈ 0 and the gate never binds), and
**`minGroupSize ≥ 2` collapses service to exactly 0%** (no cell ever holds two concurrent pending
riders, so no stop reaches the dispatch threshold).

Note that the pre-rewrite greedy planner also reported ~4 completions, but those were long trips it
*started* and never finished. The ~4 here are trips actually delivered, and wait dropped hard along
the way (P50 26 → 5.5 min).

---

## Future directions

The current dispatcher is sound; the service rate is bounded by the demand/fleet/promise geometry
around it. These are ordered roughly by expected payoff per unit of work.

### 1. Make the pickup promise elastic

`promisedPickupBy = tRequest + maxWaitMinutes` is a flat 10 minutes for every rider regardless of
where they are, and it causes ~98% of all insertion rejections. Real systems quote a *feasible*
promise at request time rather than a fixed one. Options, in increasing order of realism:

- Quote the promise from the actual nearest-vehicle travel time (`t(nearestBus, stop) + slack`), so
  a far-flung rider gets a longer, honest promise instead of an instantly-doomed one.
- Offer/decline at request time: if no vehicle can meet any acceptable promise, mark the request
  `declined` immediately. Honest, and it separates "we said no" from "we failed".
- Surge-style dynamic windows that widen as the open-shipment backlog grows.

This is the single highest-leverage change, and it is mostly a change to `tripModel.ts` plus a new
KPI split.

### 2. Coarser stops / demand-aware zoning

At ~150 m cells and 6 req/min, pooling essentially never happens — which defeats the whole point of
virtual stops. Worth trying:

- Sweep the grid cell size (300 m, 500 m, 800 m) and watch pooling rate against mean walk. This is
  also what would make `maxWalkKm` and `minGroupSize` behave like real knobs again.
- Snap stops to *real* infrastructure instead of an abstract grid — LA Metro publishes
  [GTFS feeds](https://developer.metro.net/gtfs-schedule-data/), which would replace both the
  8 hardcoded hotspots and the synthetic grid with actual stop and demand geography.
- Let a stop hold a short accumulation window before it becomes dispatchable, trading a little wait
  for a real chance to pool.

### 3. Fleet-vs-area rebalancing

`rebalanceEnabled` exists but is off by default because, as tuned, it is a bad trade: completions
4→7 but vehicle-km 35→219, waitP50 5.5→7.2, deadhead 21%→79%. The idea is right and the
implementation is naive (drift toward a haversine-weighted centroid every tick). Better versions:

- Move toward *predicted* demand, not the current centroid, and only when idle beyond a threshold.
- Cap repositioning km per bus per hour so the deadhead cost stays bounded.
- Partition the basin into service zones with a per-zone fleet allocation, rather than letting all
  8 buses roam the whole area — this attacks the same geometry problem as (1) from the supply side.

The literature reports meaningful wait reductions from rebalancing alone
([non-myopic matching and rebalancing](https://arxiv.org/abs/2510.25796)); the current numbers say
the *policy*, not the concept, is wrong.

### 4. A real solver behind the frozen seam

`src/engine/shipmentModel.ts` already serializes dispatch input as a Google Route Optimization-shaped
`ShipmentModel`, locked by a golden file and documented in
[`docs/dispatch-shipment-model.md`](docs/dispatch-shipment-model.md). The mapping to a real solver
is deliberately mechanical:

- `GoogleRouteOptimizationDispatcher` — backend-hosted, near-mechanical translation.
- `OrToolsDispatcher` — self-hosted alternative, same contract.

Because `Dispatcher` is a one-method interface and the model is frozen, either can be benchmarked
head-to-head against `InsertionDispatcher` on the same seeds. That comparison — how much service
rate a true optimizer buys over regret-2 insertion under identical constraints — is the most
interesting open question in the repo.

### 5. Mixed-direction plans

A bus's plan is direction-homogeneous today (all-inbound or all-outbound). Letting a bus drop
inbound riders at a hub and immediately board outbound riders waiting there would roughly halve
deadhead on the hub-return leg. This is a contained change to the insertion candidate generation.

### 6. Better travel times

The default provider is haversine × `detourFactor` 1.35 with a two-level time-of-day speed profile.
A `GoogleMatrixProvider` exists (batched `computeRouteMatrix`, LRU-cached, falls back on failure),
but no benchmark has been recorded against it. Worth doing: run the full sweep under Google routing
once and calibrate `detourFactor` / `speedProfile` against the result, so the free default is a
faithful approximation of the paid one.

### 7. Smaller cleanups

- `SimConfig.busSpeed` is deprecated and inert — travel time comes from `speedProfile`. Remove it.
- `tsconfig` runs with `strictNullChecks: false` / `noImplicitAny: false`, so a clean `tsc` does not
  imply null-safety. Tightening it is mostly mechanical and would pay for itself.
- Module-level ID counters (`nextReqId`, `nextStopId`) reset per run but are still shared across
  concurrent sims in one process — IDs interleave if two run at once (the *simulations* stay
  independent; only the IDs mix).
- Lovable build coupling remains in `vite.config.ts` (`componentTagger`), `index.html` meta tags,
  and the duplicated `bun.lock` / `bun.lockb` / `package-lock.json` lockfiles. Nothing in
  `src/engine` or `src/services` touches it — the algorithm is already portable.

---

## Testing

`vitest.config.ts` defines two projects:

- **`engine`** — `src/{engine,services}/**/*.test.ts`, `environment: "node"`, no setup file. The
  full engine suite runs in ~2 s. Algorithm tests go here.
- **`ui`** — `src/{components,pages,hooks,test}/**/*.test.{ts,tsx}`, jsdom + `src/test/setup.ts`.

E2E lives in `e2e/` on a stock Playwright config whose `webServer` boots `npm run dev`
automatically.

Beyond unit coverage, the suite pins the properties that make the simulator trustworthy: a fixed
seed reproduces identical metrics, event log, `rngState` and rider IDs; two interleaved sims stay
isolated; the load profile never exceeds capacity at any `PlanStop`; and the serialized shipment
model matches its golden file.

## Sources

- [Alonso-Mora et al., *On-demand high-capacity ride-sharing via dynamic trip-vehicle assignment*, PNAS 2017](https://www.pnas.org/doi/10.1073/pnas.1611675114)
- [Diana & Dessouky, *A new regret insertion heuristic for large-scale DARP with time windows*](https://bpb-us-w1.wpmucdn.com/sites.usc.edu/dist/0/249/files/2017/02/22A-New-Regret-Insertion-Heuristic-for-Solving-Large-scale-Dial-a-ride-Problems-with-Time-Windows22-Transportation-Research-Part-B-Methodological-38-539-557-2004-M.-Diana-and-M.-M.-Dessouky-PDF-28havuo.pdf)
- [Google Route Optimization API — `ShipmentModel` reference](https://developers.google.com/maps/documentation/route-optimization/reference/rest/v1/ShipmentModel)
- [Google Routes API — `computeRouteMatrix` limits and billing](https://developers.google.com/maps/documentation/routes/usage-and-billing)
- [Via — what is microtransit / virtual bus stops](https://ridewithvia.com/resources/what-is-microtransit)
- [LA Metro GTFS / regional feeds](https://developer.metro.net/gtfs-schedule-data/)
