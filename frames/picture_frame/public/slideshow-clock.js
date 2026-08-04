// ----------------------------------------------------------------------------------------
// The slideshow clock.
//
// A running slideshow's position is COMPUTED, never stored. The backend persists four values —
// slideshow_on, slideshow_secs, anchor_photo_id, anchor_ms — and every client derives which
// photo should be on screen right now from them. Nothing is written per tick, every device
// converges on the same answer without talking to the others, and a restart lands where the show
// should be, because position is a pure function of the clock.
//
// This module is deliberately pure and dependency-free so it can be tested directly with
// `deno test` — see ../tests/slideshow-clock.test.ts. It is the only non-obvious logic in the
// frame; everything else is I/O.
// ----------------------------------------------------------------------------------------

const MIN_DWELL_MS = 1000;

function dwellMs(secs) {
  const n = Number(secs);
  return Number.isFinite(n) && n > 0 ? Math.max(MIN_DWELL_MS, Math.round(n * 1000)) : MIN_DWELL_MS;
}

// Milliseconds since the anchor, floored at zero. A negative span means the anchor is in the
// future — an unsynced device clock, or an anchor stamped by a host that is slightly ahead — and
// the honest answer there is "the show hasn't advanced yet" rather than a negative step count.
function elapsedMs(anchorMs, nowMs) {
  const a = Number(anchorMs), n = Number(nowMs);
  if (!Number.isFinite(a) || !Number.isFinite(n)) return 0;
  return Math.max(0, n - a);
}

/**
 * Which photo should be showing right now.
 *
 * @param {Array<{id: string}>} order  photos in sort_order — the frame's one ordering
 * @param {string} anchorId            id of the photo the show was anchored to
 * @param {number} anchorMs            when it was anchored (server clock, skew-corrected)
 * @param {number} secs                dwell per photo
 * @param {number} nowMs               current time (server clock, skew-corrected)
 * @returns {{id: string}|null}        the photo, or null when there is nothing to show
 */
export function photoAtTime(order, anchorId, anchorMs, secs, nowMs) {
  if (!Array.isArray(order) || order.length === 0) return null;
  if (order.length === 1) return order[0];

  // An anchor naming a photo that has since been deleted falls back to the start of the list,
  // rather than letting findIndex's -1 drag the whole computation negative.
  const found = order.findIndex((p) => p && p.id === anchorId);
  const anchorIdx = found >= 0 ? found : 0;

  const steps = Math.floor(elapsedMs(anchorMs, nowMs) / dwellMs(secs));

  // Double modulus keeps the index in range for any input, including a frame left running for
  // days (where steps is enormous) or a hostile anchor index.
  const n = order.length;
  const idx = (((anchorIdx + steps) % n) + n) % n;
  return order[idx];
}

/**
 * Milliseconds until the displayed photo should change.
 *
 * Callers schedule a timeout to this exact boundary rather than a repeating interval, so timer
 * error cannot accumulate over a long-running show.
 *
 * @returns {number} always >= 1, so a caller can never spin on a zero-delay timeout
 */
export function msUntilNextChange(anchorMs, secs, nowMs) {
  const dwell = dwellMs(secs);
  const rem = dwell - (elapsedMs(anchorMs, nowMs) % dwell);
  return rem > 0 ? rem : dwell;
}
