# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

An **on-demand transit simulator for Los Angeles**. Rider requests appear stochastically across
the LA basin; the algorithm groups nearby riders into *virtual stops*, then assigns
capacity-constrained buses to chained pickup routes ending at user-placed drop-off hubs.

The UI (React + Google Maps) is a **viewer** for the simulation, not the simulation itself. The
algorithm lives in `src/engine/` and `src/services/` and is fully independent of React.

## Commands

```bash
npm install          # bun.lock is the Lovable-maintained lockfile; package-lock.json was stale
npm run dev          # Vite dev server on http://localhost:8080
npm run build        # production build (~10s)
npm test             # both vitest projects (~2.4s)
npm run test:engine  # algorithm only — node env, no jsdom. Use this while iterating.
npm run test:ui      # components/pages — jsdom + testing-library
npm run test:watch   # vitest watch
npm run typecheck    # tsc --noEmit (clean)
npm run lint         # eslint (3 errors / 7 warnings, all pre-existing in generated files)
npm run e2e          # playwright; needs `npx playwright install chromium` once
```

`npm ci` **fails** — `package-lock.json` predates the test/maps dependencies. Use `npm install`.
On a fresh install with npm 11+, postinstall scripts are blocked by default; if `esbuild` or
`@swc/core` native binaries are missing, run `npm install-scripts approve <pkg>`.

## Architecture

```
src/engine/types.ts         All domain types + LA_BOUNDS + DEFAULT_CONFIG. Start here.
src/engine/simulator.ts     The clock. simulateStep(state, config) -> Promise<SimState>
src/engine/rng.ts           Seeded mulberry32 PRNG; state is one int, so it clones
src/engine/simulator.test.ts  Determinism + invariant tests (node env)
src/services/stops.ts       Riders -> persistent virtual stops keyed by ~150m grid cell (issue #5)
src/services/planner.ts     Stops -> bus routes (greedy nearest-neighbor + drop-off legs)
src/services/routing.ts     haversine fallback / Google DirectionsService wrapper
src/pages/Index.tsx         Drives the loop with setInterval(400ms); owns all React state
src/components/             SimulationMap (Google), FallbackMap (SVG), controls, metrics
src/components/ui/          shadcn/ui primitives — generated, don't hand-edit
```

**One tick of `simulateStep`**, in order:

1. Advance buses along `Bus.plan` (a `PlanStop[]` itinerary) by interpolating the current leg;
   board/alight riders at each entry whose `etaMin` has elapsed; retire a plan once its last entry is reached
2. Generate new riders — `poissonSample(avgRequestsPerMin)`, positions from `weightedRandomPoint`
   (60% clustered on 8 LA hotspots, 40% uniform, rejection-sampled against a coastline polygon)
3. Fold pending riders into the persistent grid-snapped stop set (`maintainStops`) — stops are
   keyed `(gridCellId, direction, hubIndex)` and live across ticks; a later rider in the same cell
   joins the existing stop. Empty stops are retired; no max-wait expiry (issue #5)
4. Assign a `PlanStop[]` itinerary to each idle bus (`planRoute`), inbound stops only — idle means
   `bus.plan.length === 0`
5. Recompute metrics, `time += 1`

**Rider lifecycle:** `pending` → `picked_up` → `completed`. Since issue #4, `picked_up` is set when the
bus physically reaches the rider's stop and `completed` at that rider's own drop-off — so `tRequest`,
`tPickedUp`, `tDroppedOff` are real quantities. `tAssigned` still records planning time (a rider can be
assigned to a bus while still `pending`).

## Testing and iterating the algorithm without Lovable

This is the important part. **The engine is completely decoupled from the browser** — there are
no `window`/`document`/`localStorage`/`navigator` references in `src/engine` or `src/services`,
and the only runtime `google` reference (`routing.ts:37`) is guarded by `typeof google === "undefined"`.

**A 60-minute simulation runs headless in ~430ms.** No Lovable, no browser, no dev server, and
no Google API key are needed to exercise the algorithm. Drive it directly:

```ts
import { createInitialState, simulateStep } from "@/engine/simulator";
import { DEFAULT_CONFIG } from "@/engine/types";

const config = { ...DEFAULT_CONFIG, seed: 12345, numBuses: 12, simMinutes: 60 };
let s = createInitialState(config);
s.dropOffHubs = [{ lat: 34.0522, lng: -118.2437 }];
for (let i = 0; i < config.simMinutes; i++) s = await simulateStep(s, config);
console.log(s.metrics);
```

`simulateStep` deep-clones state via `structuredClone` and returns a new `SimState`, so every
tick is inspectable and snapshot-testable. `SimConfig` is the complete parameter surface —
sweeping `numBuses`, `maxWalkKm`, `minGroupSize`, `maxStopsPerRoute`, `timeBudgetMinutes`, and
`maxWaitMinutes` in a loop is the natural way to evaluate an algorithm change.

### Runs are deterministic — pin `config.seed`

`SimConfig.seed` fixes the whole run. Same seed ⇒ identical metrics, identical event log,
identical rider IDs. `seed: null` (the default) draws a fresh seed on each reset, preserving the
original UX; the sidebar's advanced panel exposes a seed field and a dice button.

The generator (`src/engine/rng.ts`) is mulberry32, and its **entire state is one 32-bit int**
stored as `SimState.rngState`. That matters: it survives `structuredClone`, so a snapshot can be
resumed exactly, and two simulations can run in the same process without interfering — which a
module-global RNG would not allow. `src/engine/simulator.test.ts` asserts all of this.

When comparing algorithm variants, hold the seed fixed and change one parameter. Sweep several
seeds before believing a result — one seed is an anecdote.

**Baseline to beat.** At `DEFAULT_CONFIG` (8 buses, 6 req/min) over 60 minutes, mean of 5 seeds
with the haversine `TravelTimeProvider` (`bench/baseline.json`): ~363 requests, **~227 pending,
~124 unserved, ~4 completed**, ~234 stops, ~12 bus assignments. Requests split roughly ⅓ inbound / ⅓
outbound / ⅓ `unserved` (neither end within `hubCatchmentKm` of a hub). Only inbound stops are
dispatched — outbound needs board-at-hub routing, so ~124 of the ~227 `pending` are
outbound riders parked until the Phase 3 dispatcher. Completions are near zero over 60 min because the
single-shot greedy planner can't finish many hub deliveries in the horizon.
The issue-#5 change (persistent grid-snapped stops, `minGroupSize` default 1) inflated
`totalStops` ~10→~234: every occupied ~150 m cell — inbound *and* outbound, lone riders included —
is now one stable stop that lives across ticks instead of a per-tick centroid that expired and
re-formed. That is a meaning change, not a regression; throughput is still the Phase 3
target. Record metrics before and after any planner/stops change
rather than judging by watching the map, and note which `TravelTimeProvider` a benchmark used
since haversine and Google runs aren't comparable.

Since issue #6 the engine computes the full KPI set (`src/engine/metrics.ts`, `computeMetrics`)
from rider timestamps and per-tick vehicle accounting (`SimState.kpi`): service/pooling rates,
wait & in-vehicle P50/P90, detour ratio, vehicle-km, deadhead share, time-weighted occupancy,
`expired` (pending past `promisedPickupBy`) vs `unserved`, and mean walk. `bench.ts` reads
`SimState.metrics` directly — no status-polling shims. `busAssignments` is a plain counter
(`kpi.assignments`) and `eventLog` is a ring buffer capped at `EVENT_LOG_LIMIT` (500).

### Test layout

`vitest.config.ts` defines two projects:

- **`engine`** — `src/{engine,services}/**/*.test.ts`, `environment: "node"`, **no setup file**.
  No jsdom cost; the full engine suite runs in ~2s. Put algorithm tests here.
- **`ui`** — `src/{components,pages,hooks,test}/**/*.test.{ts,tsx}`, jsdom + `src/test/setup.ts`.

`src/test/setup.ts` guards its `window` access, so it is inert outside jsdom.

E2E lives in `e2e/` on a stock Playwright config whose `webServer` boots `npm run dev`
automatically. Browsers install once with `npx playwright install chromium`.

### Lovable coupling inventory

| Where | What | To cut it |
|---|---|---|
| `vite.config.ts` | `componentTagger()` from `lovable-tagger`, dev mode only | Remove plugin + devDependency |
| `index.html:15,19` | `og:image` / `twitter:image` → lovable.dev | Point at your own asset |
| `index.html` `<title>` | "Lovable App" | Rename |
| `README.md` | "Welcome to your Lovable project" placeholder | Rewrite |
| `bun.lock` + `bun.lockb` | Lovable builds with bun | Pick one package manager, delete the others |

*Resolved:* `playwright.config.ts` now uses stock `@playwright/test`; the
`lovable-agent-playwright-config` fixture file has been deleted.

Nothing in `src/engine` or `src/services` touches Lovable. The algorithm is already portable —
only the build and test scaffolding is tied to the platform.

## Gotchas

- **Module-level ID counters.** `nextReqId` in `simulator.ts` and `nextStopId` in `stops.ts`
  are still module globals, but `createInitialState()` now resets **both**, so IDs no longer leak
  between runs. They remain shared across concurrent simulations in one process — IDs will
  interleave if you run two sims at once, though `rngState` keeps the *simulations* independent.
- **`metrics.busAssignments` is a plain counter** (`SimState.kpi.assignments`, incremented in
  `simulateStep` step 4) since issue #6 — no longer string-matched out of the event log. The
  event log is now a ring buffer capped at `EVENT_LOG_LIMIT` (500) and nothing rescans it.
- **`tsconfig` is loose**: `strictNullChecks: false`, `noImplicitAny: false`. A clean `tsc` does
  not imply null-safety.
- **`useGoogleRouting` is opt-in and degrades silently.** Without an API key, `planRoute` uses
  haversine + constant speed and synthesizes L-shaped grid paths for display. Results differ
  substantially between the two modes — state which one a benchmark used.
- **Drop-off hubs persist in `localStorage`** under `sim-dropoff-hubs` when locked (`Index.tsx`).
  Headless runs must set `state.dropOffHubs` manually; with no hubs, buses do pickups only.
- **`@/` aliases `./src`** in three places: `vite.config.ts`, `vitest.config.ts`, and
  `tsconfig.json`. A new build entry point means updating all three.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `gellosparkles/la-transit-navigator`, driven by the `gh` CLI.
See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its name.
See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root.
See `docs/agents/domain.md`.
