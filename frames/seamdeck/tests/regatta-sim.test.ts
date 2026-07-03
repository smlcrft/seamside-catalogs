import { assertEquals } from "jsr:@std/assert";
import { courseFor, integrate, polar, resolve, fmtTime, NO_GO, MAX_MS } from "../public/games/regatta-sim.js";

Deno.test("courseFor: deterministic for a seed, sane par", () => {
  assertEquals(courseFor(42), courseFor(42));
  const { par, marks } = courseFor(42);
  assertEquals(marks.length, 3);
  if (par < 10000 || par > 60000) throw new Error(`odd par: ${par}`);
});
Deno.test("polar: no-go zone crawls, beam reach flies", () => {
  if (polar(0.1) > 0.1) throw new Error("should luff head to wind");
  if (polar(Math.PI / 2) < 0.9) throw new Error("beam reach should be fast");
  if (!(polar(Math.PI) < polar(Math.PI / 2))) throw new Error("dead run slower than beam");
});
Deno.test("integrate: deterministic; no input drifts in irons and never finishes", () => {
  const a = integrate([], 7, MAX_MS);
  assertEquals(a, integrate([], 7, MAX_MS));
  assertEquals(a.finishedAt, null); // pointed at the wind, going nowhere
  if (a.offWind > NO_GO) throw new Error("should still be in irons");
});
Deno.test("integrate: steering changes the track", () => {
  const bear = [{ t: 0, k: "right", e: "down" }, { t: 700, k: "right", e: "up" }];
  const s = integrate([], 7, 8000);
  const b = integrate(bear, 7, 8000);
  const moved = Math.hypot(b.x - s.x, b.y - s.y);
  if (moved < 10) throw new Error(`rudder should matter: ${moved}`);
});
Deno.test("resolve: junk payloads DNF at zero, never throw", () => {
  assertEquals(resolve({}, 3).points, 0);
  assertEquals(resolve(null, 3).summary, "DNF");
  assertEquals(resolve({ events: "junk" }, 3).points, 0);
});
Deno.test("fmtTime: race-clock format", () => {
  assertEquals(fmtTime(83400), "1:23.4");
  assertEquals(fmtTime(9500), "0:09.5");
});
