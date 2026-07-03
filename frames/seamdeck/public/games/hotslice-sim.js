// hotslice-sim.js — pure, deterministic, no DOM. Pizza delivery at full cadence.
//
// Twelve seconds on the bike. Alternate the O and I buttons to pedal — rhythm
// is speed. UP/DOWN hop between the road lane and the kerb lane to snatch pizza
// slices and dodge traffic cones. The course is seeded per round: everyone
// rides the same street.
//
// payload = { events: [{ t, k }] }  t = ms since the run started,
//                                   k = A|B (pedal strokes) | up|down (lane)
import { rng } from "./rng.js";

export const ATTEMPTS = 1;        // one delivery — make it count
export const DURATION = 12000;    // ms of riding
export const DT = 25;             // ms integration step (shared → identical results)
export const TAU = 900;           // ms speed decay constant (coasting bleeds off)
export const IMPULSE = 3.5;       // m/s per clean alternating pedal stroke
export const VMAX = 22;           // m/s cap
export const PIZZA_R = 3;         // m pickup radius
export const CONE_R = 2;          // m collision radius
export const CONE_BRAKE = 0.35;   // speed multiplier on a cone hit

// The street for the round: ~12 items across two lanes (0 = kerb, 1 = road).
export function courseFor(seed) {
  const r = rng(seed);
  const items = [];
  let d = 22;
  while (d < 240 && items.length < 14) {
    items.push({ d, lane: r() < 0.5 ? 0 : 1, kind: r() < 0.45 ? "pizza" : "cone" });
    d += 14 + Math.floor(r() * 12);
  }
  return items;
}

// Deterministic fixed-step integration of a ride up to `uptoMs`. The live screen
// calls this every frame with the events recorded so far; the worker calls it
// once with the full payload — same function, same numbers, no drift.
export function integrate(events, seed, uptoMs) {
  const course = courseFor(seed);
  const evs = [...events].sort((a, b) => a.t - b.t);
  const got = new Array(course.length).fill(false); // pizzas collected
  const hit = new Array(course.length).fill(false); // cones clipped
  let dist = 0, v = 0, lane = 0, lastStroke = "", strokes = 0, ei = 0;
  const end = Math.min(Math.max(0, uptoMs), DURATION);
  const decay = Math.exp(-DT / TAU);
  for (let t = 0; t < end; t += DT) {
    // apply this step's inputs
    while (ei < evs.length && evs[ei].t < t + DT) {
      const k = evs[ei].k;
      if (k === "down") lane = 0;
      else if (k === "up") lane = 1;
      else if ((k === "A" || k === "B") && k !== lastStroke) {
        lastStroke = k; strokes++;
        v = Math.min(VMAX, v + IMPULSE);
      }
      ei++;
    }
    v *= decay;
    dist += v * (DT / 1000);
    for (let i = 0; i < course.length; i++) {
      const it = course[i];
      if (it.lane !== lane || got[i] || hit[i]) continue;
      if (Math.abs(it.d - dist) > (it.kind === "pizza" ? PIZZA_R : CONE_R)) continue;
      if (it.kind === "pizza") got[i] = true;
      else { hit[i] = true; v *= CONE_BRAKE; }
    }
  }
  return { dist, v, lane, got, hit, strokes, course };
}

export function resolve(payload, seed) {
  const raw = Array.isArray(payload && payload.events) ? payload.events : [];
  const events = raw
    .map((e) => ({ t: Number(e && e.t), k: String(e && e.k) }))
    .filter((e) => Number.isFinite(e.t) && ["up", "down", "A", "B"].includes(e.k))
    .slice(0, 400);
  const { dist, got, hit, course } = integrate(events, seed, DURATION);
  const pizzas = got.filter(Boolean).length;
  const cones = hit.filter(Boolean).length;
  const allPizzas = pizzas > 0 && pizzas === course.filter((i) => i.kind === "pizza").length;
  const points = Math.round(dist * 0.35 + pizzas * 8);
  return {
    points,
    summary: `${Math.round(dist)} m · ${pizzas} slice${pizzas === 1 ? "" : "s"}`,
    dist, pizzas, cones, allPizzas,
  };
}
