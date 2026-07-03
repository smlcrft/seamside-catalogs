// regatta-sim.js — pure, deterministic, no DOM. The Small Craft house game.
//
// Top-down course sailing. The wind blows FROM a seeded direction; your speed
// depends on your angle to it — point into the no-go zone and you luff to a
// crawl, so upwind legs mean tacking. Round the marks in order, then back
// through the finish. Fastest time wins.
//
// payload = { events: [{ t, k: "left"|"right", e: "down"|"up" }] }
//   — rudder edges, ms since the run started. Deterministic replay: the same
//     trace always sails the same line.
import { rng } from "./rng.js";

export const ATTEMPTS = 1;        // it's a race — one start
export const DT = 50;             // ms integration step (shared → identical results)
export const MAX_MS = 120000;     // race cap; not home by then = DNF
export const SPEED = 13;          // world units/s at the best point of sail
export const TURN_RATE = 2.4;     // rad/s of rudder
export const MARK_R = 6;          // world units — rounding radius
export const FINISH_R = 8;
export const NO_GO = 0.5;         // rad off the wind where the sail just flaps
export const WORLD = 100;         // square world, y grows downward

const TAU2 = Math.PI * 2;
const angleDiff = (a, b) => {
  let d = (a - b) % TAU2;
  if (d > Math.PI) d -= TAU2;
  if (d < -Math.PI) d += TAU2;
  return d;
};

// Boat speed factor by angle off the wind (0 = head to wind, π = dead run).
export function polar(offWind) {
  const a = Math.abs(offWind);
  if (a < NO_GO) return 0.08;                                  // in irons
  if (a < 1.6) return 0.35 + (a - NO_GO) / (1.6 - NO_GO) * 0.65; // close-hauled → beam
  if (a < 2.6) return 1.0 - (a - 1.6) / 1.0 * 0.15;            // broad reach
  return 0.85 - (a - 2.6) / (Math.PI - 2.6) * 0.15;            // dead run
}

// The course for the round: wind from roughly north (so the first legs beat
// upwind), three marks to round in order, then the finish gate back at the start.
export function courseFor(seed) {
  const r = rng(seed);
  const windFrom = (r() - 0.5) * 0.8; // ±0.4 rad around straight-up
  const marks = [
    { x: 18 + r() * 14, y: 14 + r() * 12 },  // 1 — upwind left
    { x: 68 + r() * 14, y: 16 + r() * 12 },  // 2 — upwind right
    { x: 20 + r() * 14, y: 54 + r() * 12 },  // 3 — reach back down
  ];
  const start = { x: 50, y: 86 };
  const legs = [start, ...marks, start];
  let dist = 0;
  for (let i = 1; i < legs.length; i++) {
    dist += Math.hypot(legs[i].x - legs[i - 1].x, legs[i].y - legs[i - 1].y);
  }
  const par = Math.round((dist / (SPEED * 0.62)) * 1000); // ms — a very good line
  return { windFrom, marks, start, par };
}

// Deterministic fixed-step sail. Returns the boat state at `uptoMs`:
// { x, y, heading, v, offWind, next (mark index; marks.length = heading home),
//   finishedAt (ms or null) }.
export function integrate(events, seed, uptoMs) {
  const { windFrom, marks, start } = courseFor(seed);
  const evs = [...events].sort((a, b) => a.t - b.t);
  let x = start.x, y = start.y, heading = 0; // pointing up, into the beat
  let rudder = 0, left = false, right = false, ei = 0;
  let next = 0, finishedAt = null, offWind = Math.abs(angleDiff(heading, windFrom));
  const end = Math.min(Math.max(0, uptoMs), MAX_MS);
  for (let t = 0; t < end && finishedAt === null; t += DT) {
    while (ei < evs.length && evs[ei].t < t + DT) {
      const { k, e } = evs[ei];
      if (k === "left") left = e === "down";
      else if (k === "right") right = e === "down";
      ei++;
    }
    rudder = (right ? 1 : 0) - (left ? 1 : 0);
    heading += rudder * TURN_RATE * (DT / 1000);
    offWind = Math.abs(angleDiff(heading, windFrom));
    const v = SPEED * polar(offWind);
    x += Math.sin(heading) * v * (DT / 1000);
    y -= Math.cos(heading) * v * (DT / 1000);
    x = Math.max(2, Math.min(WORLD - 2, x));
    y = Math.max(2, Math.min(WORLD - 2, y));
    if (next < marks.length) {
      const m = marks[next];
      if (Math.hypot(m.x - x, m.y - y) <= MARK_R) next++;
    } else if (Math.hypot(start.x - x, start.y - y) <= FINISH_R) {
      finishedAt = t + DT;
    }
  }
  return { x, y, heading, v: SPEED * polar(offWind), offWind, next, finishedAt };
}

export function fmtTime(ms) {
  const s = ms / 1000;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
}

export function resolve(payload, seed) {
  const raw = Array.isArray(payload && payload.events) ? payload.events : [];
  const events = raw
    .map((e) => ({ t: Number(e && e.t), k: String(e && e.k), e: e && e.e === "up" ? "up" : "down" }))
    .filter((e) => Number.isFinite(e.t) && (e.k === "left" || e.k === "right"))
    .slice(0, 600);
  const { par } = courseFor(seed);
  const run = integrate(events, seed, MAX_MS);
  if (run.finishedAt === null) {
    return { points: 0, summary: "DNF", finishedAt: null, par };
  }
  const points = Math.max(5, Math.min(100, Math.round(100 * (par / run.finishedAt))));
  return { points, summary: fmtTime(run.finishedAt), finishedAt: run.finishedAt, par };
}
