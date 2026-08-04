import { assertEquals } from "jsr:@std/assert";
import { msUntilNextChange, photoAtTime } from "../public/slideshow-clock.js";

const ORDER = ["a", "b", "c", "d"].map((id) => ({ id }));
const T0 = 1_700_000_000_000; // fixed epoch — these tests must never read the wall clock
const SECS = 15;
const DWELL = SECS * 1000;

// `at` is the id showing `steps` dwells after the anchor.
function at(steps: number, anchor = "a", order = ORDER) {
  return photoAtTime(order, anchor, T0, SECS, T0 + steps * DWELL)?.id;
}

Deno.test("photoAtTime: at the anchor instant, the anchor photo shows", () => {
  assertEquals(at(0), "a");
  assertEquals(at(0, "c"), "c");
});

Deno.test("photoAtTime: holds the photo until the boundary, then advances exactly one", () => {
  assertEquals(photoAtTime(ORDER, "a", T0, SECS, T0 + DWELL - 1)?.id, "a");
  assertEquals(photoAtTime(ORDER, "a", T0, SECS, T0 + DWELL)?.id, "b");
  assertEquals(photoAtTime(ORDER, "a", T0, SECS, T0 + DWELL + 1)?.id, "b");
});

Deno.test("photoAtTime: wraps past the end of the list", () => {
  assertEquals(at(3), "d");
  assertEquals(at(4), "a");
  assertEquals(at(5), "b");
  // and wraps from a non-zero anchor too
  assertEquals(at(2, "c"), "a");
});

Deno.test("photoAtTime: an unknown anchor degrades to the first photo, never a negative index", () => {
  assertEquals(at(0, "deleted-photo"), "a");
  assertEquals(at(1, "deleted-photo"), "b");
  assertEquals(at(5, "deleted-photo"), "b");
});

Deno.test("photoAtTime: an empty order returns null and never throws", () => {
  assertEquals(photoAtTime([], "a", T0, SECS, T0 + DWELL), null);
  // Cast: the JSDoc signature forbids these, but state can arrive malformed at runtime and the
  // frame must render an empty state rather than throw inside a render pass.
  assertEquals(photoAtTime(null as never, "a", T0, SECS, T0 + DWELL), null);
  assertEquals(photoAtTime(undefined as never, "a", T0, SECS, T0), null);
});

Deno.test("photoAtTime: a single photo always shows, at any elapsed time", () => {
  const one = [{ id: "solo" }];
  assertEquals(photoAtTime(one, "solo", T0, SECS, T0)?.id, "solo");
  assertEquals(photoAtTime(one, "solo", T0, SECS, T0 + 999 * DWELL)?.id, "solo");
  // even if the anchor names something that is no longer there
  assertEquals(photoAtTime(one, "gone", T0, SECS, T0 + 3 * DWELL)?.id, "solo");
});

Deno.test("photoAtTime: a frame left running for days stays in range", () => {
  // The modulus case a naive implementation gets wrong.
  const week = 7 * 24 * 60 * 60 * 1000;
  const id = photoAtTime(ORDER, "a", T0, SECS, T0 + week)?.id;
  assertEquals(ORDER.some((p) => p.id === id), true);
  // 7 days / 15s = 40320 steps; 40320 % 4 === 0, so it lands back on the anchor
  assertEquals(id, "a");
});

Deno.test("photoAtTime: an anchor in the future does not run the show backwards", () => {
  // Clock skew, or an anchor stamped by a host that is slightly ahead.
  assertEquals(photoAtTime(ORDER, "b", T0, SECS, T0 - 5 * DWELL)?.id, "b");
});

Deno.test("photoAtTime: skew correction shifts the result by whole photos", () => {
  // A client whose clock runs 2 dwells slow sees the right photo once it adds its skew back.
  const clientNow = T0 + 3 * DWELL;
  const skew = 2 * DWELL; // server_ms - client Date.now()
  assertEquals(photoAtTime(ORDER, "a", T0, SECS, clientNow)?.id, "d");
  assertEquals(photoAtTime(ORDER, "a", T0, SECS, clientNow + skew)?.id, "b");
});

Deno.test("photoAtTime: a nonsense dwell falls back to a floor instead of dividing by zero", () => {
  assertEquals(photoAtTime(ORDER, "a", T0, 0, T0 + 1000)?.id, "b");
  assertEquals(photoAtTime(ORDER, "a", T0, NaN, T0 + 2000)?.id, "c");
  assertEquals(photoAtTime(ORDER, "a", T0, -5, T0 + 3000)?.id, "d");
});

Deno.test("msUntilNextChange: counts down to the boundary, then resets to a full dwell", () => {
  assertEquals(msUntilNextChange(T0, SECS, T0), DWELL);
  assertEquals(msUntilNextChange(T0, SECS, T0 + 1), DWELL - 1);
  assertEquals(msUntilNextChange(T0, SECS, T0 + DWELL - 1), 1);
  assertEquals(msUntilNextChange(T0, SECS, T0 + DWELL), DWELL);
});

Deno.test("msUntilNextChange: never returns zero or negative, so a caller cannot spin", () => {
  for (const now of [T0 - DWELL, T0, T0 + DWELL, T0 + 7 * DWELL + 3]) {
    const ms = msUntilNextChange(T0, SECS, now);
    assertEquals(ms > 0, true, `expected a positive delay, got ${ms}`);
  }
  assertEquals(msUntilNextChange(T0, 0, T0 + 500) > 0, true);
});
