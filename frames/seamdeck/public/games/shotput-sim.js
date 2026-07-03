// shotput-sim.js — pure, deterministic, no DOM. Shared verbatim by the frontend
// (live play + spectator replay), the worker (authoritative scoring), and the
// test suite. The only randomness is the round seed drawn once by the worker.
//
// Game-sim contract (every game exports these two):
//   ATTEMPTS                 — turns per player per round; best one counts
//   resolve(payload, seed)   — → { points, summary, ...game extras }

export const MAX_DISTANCE = 40;   // metres — landing at charge = 1.0
export const TARGET_MIN = 12;     // inclusive round-target range (metres)
export const TARGET_MAX = 34;
export const ATTEMPTS = 3;        // throws per player per round — best one counts

// The round target, derived from the shared seed.
export function targetFor(seed) {
  return TARGET_MIN + ((seed >>> 0) % (TARGET_MAX - TARGET_MIN + 1));
}

// charge ∈ [0,1] is the power-meter value at release.
// foul = crossed the foul line (charge reached/passed 1); landing only meaningful when !foul.
export function simulate(charge) {
  const foul = charge >= 1;
  const landing = charge * MAX_DISTANCE;
  return { landing, foul };
}

// Ring points by absolute miss d = |landing - target|. Bands are sized for the
// hand, not the machine: at 2.4s full charge, 1m of distance ≈ 60ms of hold, so
// PERFECT (±0.75m) is a ~90ms window — hard, hittable, worth chasing.
export function score(landing, target) {
  const d = Math.abs(landing - target);
  if (d <= 0.75) return 100;
  if (d <= 2) return 75;
  if (d <= 4) return 50;
  if (d <= 7) return 25;
  if (d <= 10) return 10;
  return 0;
}

// Convenience: a foul zeroes points regardless of where the ball fell.
export function resolveThrow(charge, target) {
  const { landing, foul } = simulate(charge);
  return { landing, foul, points: foul ? 0 : score(landing, target) };
}

// Generic entry point the console worker calls. payload = { charge }.
export function resolve(payload, seed) {
  const raw = Number(payload && payload.charge);
  const charge = Number.isFinite(raw) ? Math.max(0, Math.min(1.5, raw)) : 0;
  const target = targetFor(seed);
  const { landing, foul, points } = resolveThrow(charge, target);
  return {
    points,
    summary: foul ? "FOUL" : `${landing.toFixed(1)} m`,
    landing, foul, charge, target,
  };
}
