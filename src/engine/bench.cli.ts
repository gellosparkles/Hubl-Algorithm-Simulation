/**
 * CLI for the bench harness (Phase 0).
 *
 *   npm run bench                                    # 5 seeds, 60 min, DEFAULT_CONFIG
 *   npm run bench -- --seeds 5 --minutes 60
 *   npm run bench -- --seeds 8 --numBuses 12 --maxWalkKm 0.8
 *   npm run bench -- --seedList 12345,777,4242 --out bench/baseline.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BenchAggregate, runBenchSweep } from "./bench";
import { SimConfig } from "./types";

const NUMERIC_CONFIG_KEYS: (keyof Pick<
  SimConfig,
  | "numBuses"
  | "avgRequestsPerMin"
  | "busCapacity"
  | "busSpeed"
  | "maxWalkKm"
  | "minGroupSize"
  | "maxStopsPerRoute"
  | "timeBudgetMinutes"
  | "maxWaitMinutes"
>)[] = [
  "numBuses",
  "avgRequestsPerMin",
  "busCapacity",
  "busSpeed",
  "maxWalkKm",
  "minGroupSize",
  "maxStopsPerRoute",
  "timeBudgetMinutes",
  "maxWaitMinutes",
];

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

function fmt(n: number | null, digits = 1): string {
  return n == null ? "—" : n.toFixed(digits);
}

function printTable(agg: BenchAggregate): void {
  const headers = ["seed", "reqs", "done", "pend", "svc%", "waitP50", "waitP90", "detour", "vehKm", "occ", "stops", "asgn"];
  const rows = agg.perSeed.map((k) => [
    String(k.seed),
    String(k.totalRequests),
    String(k.completed),
    String(k.pending),
    fmt(k.serviceRate * 100, 1),
    fmt(k.waitP50Min),
    fmt(k.waitP90Min),
    fmt(k.detourRatioMean, 2),
    fmt(k.vehicleKm),
    fmt(k.meanOccupancy, 2),
    String(k.totalStops),
    String(k.busAssignments),
  ]);

  const m = agg.mean;
  const meanRow = [
    "mean",
    fmt(m.totalRequests, 0),
    fmt(m.completed, 0),
    fmt(m.pending, 0),
    fmt(m.serviceRate * 100, 1),
    fmt(m.waitP50Min),
    fmt(m.waitP90Min),
    fmt(m.detourRatioMean, 2),
    fmt(m.vehicleKm),
    fmt(m.meanOccupancy, 2),
    fmt(m.totalStops, 0),
    fmt(m.busAssignments, 0),
  ];

  const allRows = [...rows, meanRow];
  const widths = headers.map((h, i) => Math.max(h.length, ...allRows.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padStart(widths[i])).join("  ");

  console.log(`\nProvider: ${agg.travelTimeProvider}  |  minutes: ${agg.minutes}  |  seeds: ${agg.seeds.join(",")}`);
  if (Object.keys(agg.overrides).length > 0) {
    console.log(`Overrides: ${JSON.stringify(agg.overrides)}`);
  }
  console.log(line(headers));
  console.log(line(headers.map((h) => "-".repeat(h.length))));
  for (const row of rows) console.log(line(row));
  console.log(line(headers.map((h) => "-".repeat(h.length))));
  console.log(line(meanRow));

  console.log(
    "\nCaveats: wait = time-to-assignment, not physical pickup; detour ratio uses whole-route " +
      "completion time (both change in Phase 4); vehicle-km undercounts past ~200 sim-minutes " +
      "(positionHistory cap). See src/engine/bench.ts header."
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const minutes = args.minutes ? Number(args.minutes) : 60;
  const seedCount = args.seeds ? Number(args.seeds) : 5;
  const seeds = args.seedList
    ? args.seedList.split(",").map(Number)
    : Array.from({ length: seedCount }, (_, i) => i + 1);

  const overrides: Partial<SimConfig> = {};
  for (const key of NUMERIC_CONFIG_KEYS) {
    if (args[key] !== undefined) overrides[key] = Number(args[key]);
  }
  if (args.useGoogleRouting !== undefined) {
    overrides.useGoogleRouting = args.useGoogleRouting === "true";
  }

  const result = await runBenchSweep(overrides, seeds, minutes);
  printTable(result);

  if (args.out) {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, JSON.stringify(result, null, 2) + "\n");
    console.log(`\nWrote ${args.out}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
