/**
 * Seeded pseudo-random number generator (mulberry32).
 *
 * The generator's entire state is a single 32-bit integer, which is what lets
 * `SimState.rngState` survive the `structuredClone` in `simulateStep` — a
 * closure or class instance would not clone. Because the seed travels inside
 * simulation state rather than a module global, two simulations can run in the
 * same process without interfering, and any snapshot can be resumed exactly.
 */

export interface Rng {
  /** Next float in [0, 1). */
  next(): number;
  /** Current internal state — store this to resume the sequence later. */
  readonly state: number;
}

export function createRng(seed: number): Rng {
  let a = seed | 0;
  return {
    next(): number {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    get state() {
      return a;
    },
  };
}

/** A fresh seed for runs that don't pin one (config.seed === null). */
export function randomSeed(): number {
  return (Math.random() * 0x100000000) | 0;
}
