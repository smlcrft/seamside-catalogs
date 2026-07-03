import { assertEquals } from "jsr:@std/assert";
import { courseFor, integrate, resolve, DURATION } from "../public/games/hotslice-sim.js";

// A steady alternating cadence at `hz` strokes per second.
function cadence(hz: number, until = DURATION) {
  const out: { t: number; k: string }[] = [];
  const step = 1000 / hz;
  for (let t = 100, i = 0; t < until; t += step, i++) {
    out.push({ t, k: i % 2 === 0 ? "A" : "B" });
  }
  return out;
}

Deno.test("courseFor: deterministic for a seed", () => {
  assertEquals(courseFor(555), courseFor(555));
  if (courseFor(555).length < 8) throw new Error("course too sparse");
});
Deno.test("integrate: no input goes nowhere", () => {
  assertEquals(integrate([], 1, DURATION).dist, 0);
});
Deno.test("integrate: pedaling covers ground; faster cadence covers more", () => {
  const slow = integrate(cadence(3), 1, DURATION).dist;
  const fast = integrate(cadence(7), 1, DURATION).dist;
  if (!(slow > 20)) throw new Error(`slow ride too short: ${slow}`);
  if (!(fast > slow * 1.5)) throw new Error(`cadence should matter: ${slow} vs ${fast}`);
});
Deno.test("integrate: repeating the same stroke key does not pedal", () => {
  const spam = Array.from({ length: 60 }, (_, i) => ({ t: 100 + i * 150, k: "A" }));
  const d = integrate(spam, 1, DURATION).dist;
  // one real stroke (the first) then decay — barely moves
  if (!(d < 10)) throw new Error(`same-key spam should not ride: ${d}`);
});
Deno.test("integrate: replay is deterministic (same events → same dist)", () => {
  const evs = cadence(6);
  assertEquals(integrate(evs, 99, DURATION).dist, integrate(evs, 99, DURATION).dist);
});
Deno.test("resolve: empty payload scores zero, never throws", () => {
  assertEquals(resolve({}, 5).points, 0);
  assertEquals(resolve(null, 5).points, 0);
});
Deno.test("resolve: a decent ride scores real points with a summary", () => {
  const r = resolve({ events: cadence(6) }, 123);
  if (!(r.points > 20)) throw new Error(`expected real points: ${r.points}`);
  if (!/m ·/.test(r.summary)) throw new Error(`summary shape: ${r.summary}`);
});
