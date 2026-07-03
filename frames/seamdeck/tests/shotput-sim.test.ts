import { assertEquals } from "jsr:@std/assert";
import { simulate, score, resolveThrow, MAX_DISTANCE, ATTEMPTS } from "../public/games/shotput-sim.js";

Deno.test("simulate: no charge lands at zero, no foul", () => {
  assertEquals(simulate(0), { landing: 0, foul: false });
});
Deno.test("simulate: half charge lands at half max", () => {
  assertEquals(simulate(0.5), { landing: MAX_DISTANCE * 0.5, foul: false });
});
Deno.test("simulate: reaching the line fouls", () => {
  assertEquals(simulate(1).foul, true);
  assertEquals(simulate(1.3).foul, true);
});
Deno.test("score: dead center is a PERFECT 100", () => {
  assertEquals(score(20, 20), 100);
});
Deno.test("score: rings step down by miss distance", () => {
  assertEquals(score(20.7, 20), 100); // d=0.7  (≤0.75)
  assertEquals(score(21.5, 20), 75);  // d=1.5  (≤2)
  assertEquals(score(23, 20), 50);    // d=3    (≤4)
  assertEquals(score(26, 20), 25);    // d=6    (≤7)
  assertEquals(score(29, 20), 10);    // d=9    (≤10)
  assertEquals(score(40, 20), 0);     // way off
});
Deno.test("resolveThrow: foul zeroes points regardless of landing", () => {
  assertEquals(resolveThrow(1, 20).points, 0);
  assertEquals(resolveThrow(1, 20).foul, true);
});
Deno.test("resolveThrow: valid throw scores against target", () => {
  assertEquals(resolveThrow(0.5, 20), { landing: 20, foul: false, points: 100 });
});
Deno.test("attempts: three throws per player per round", () => {
  assertEquals(ATTEMPTS, 3);
});
