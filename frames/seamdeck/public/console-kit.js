// console-kit.js — the tiny shared surface between the Seamdeck console core and
// its game modules. A game imports { useInput, animator, wait, rng } from here
// and everything else from its own files. Keep this file small on purpose: it IS
// the console's public API for forks.
import { useEffect, useRef, useState } from "/lib/js/framelib.js";

// ---------------------------------------------------------------------------
// Input bus — input is UI, not shared state. A tiny emitter fans key/touch
// events out to whoever is listening. Names: up/down/left/right/A/B.
// Edges: "down" | "up". The console core feeds this from the on-screen deck
// and the keyboard; game screens just subscribe.
// ---------------------------------------------------------------------------
export const inputBus = (() => {
  const handlers = new Set();
  const captures = []; // modal stack — the top capture sees ALL input, alone
  return {
    on(fn) { handlers.add(fn); return () => handlers.delete(fn); },
    capture(fn) {
      captures.push(fn);
      return () => { const i = captures.indexOf(fn); if (i >= 0) captures.splice(i, 1); };
    },
    emit(name, edge) {
      if (captures.length) { captures[captures.length - 1](name, edge); return; }
      for (const fn of [...handlers]) fn(name, edge);
    },
  };
})();

// Subscribe once; always call the latest handler (avoids resubscribe churn).
export function useInput(handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => inputBus.on((n, e) => ref.current(n, e)), []);
}

// Exclusive subscription for console dialogs: while `active`, this handler is
// the ONLY input listener — games underneath hear nothing.
export function useCaptureInput(active, handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!active) return;
    return inputBus.capture((n, e) => ref.current(n, e));
  }, [active]);
}

// ---------------------------------------------------------------------------
// Motion — one animator per component. Respects prefers-reduced-motion by
// shortening tweens to a 250ms beat (never instant: cause and effect must read).
// ---------------------------------------------------------------------------
export const REDUCED = typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

export function animator() {
  let raf = 0;
  const run = (duration, onFrame) => new Promise((resolve) => {
    if (REDUCED) duration = Math.min(duration, 250);
    if (duration <= 0) { onFrame(1); resolve(); return; }
    const t0 = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - t0) / duration);
      onFrame(t);
      if (t < 1) raf = requestAnimationFrame(step);
      else resolve();
    };
    raf = requestAnimationFrame(step);
  });
  const cancel = () => cancelAnimationFrame(raf);
  return { run, cancel };
}

export const wait = (ms) => new Promise((r) => setTimeout(r, REDUCED ? Math.min(ms, 400) : ms));

// ---------------------------------------------------------------------------
// Race runner — the whole lifecycle of a REALTIME race screen: countdown for
// seated players (watch mode for everyone else), a rAF race clock, input
// recording, position beacons, and finish → flash → submit. A race game
// supplies only its pure sim hooks:
//
//   useRaceRunner(ctx, {
//     duration,                    // ms cap for a run
//     integrate(events, seed, t),  // pure sim → live state for render/beacons
//     isFinished(live, t),         // optional early finish (default t>=duration)
//     record(name, edge, t),       // input → payload event, or null to ignore
//     beaconFor(live),             // live → {x, y, heading, note}
//     resolve(payload, seed),      // the sim's resolver (for the flash)
//     flashFor(resolved),          // resolved → {main, sub}
//   }) → { phase, count, elapsed, flash, live, events }
//
// phase: boot|count|running|flash|watch. `live` is integrate()'s latest output.
// ---------------------------------------------------------------------------
export function useRaceRunner(ctx, opts) {
  const [phase, setPhase] = useState("boot");
  const [count, setCount] = useState(3);
  const [elapsed, setElapsed] = useState(0);
  const [flash, setFlash] = useState(null);
  const raf = useRef(0);
  const events = useRef([]);
  const elapsedRef = useRef(0);
  const liveRef = useRef(null);
  const done = useRef(false);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  // Everyone seated starts together: countdown on mount, then go.
  useEffect(() => {
    if (!ctx.mySeat || ctx.myFinished) { setPhase("watch"); return; }
    let alive = true;
    (async () => {
      setPhase("count");
      for (const n of [3, 2, 1]) { if (!alive) return; setCount(n); await wait(750); }
      if (alive) run();
    })();
    return () => { alive = false; };
  }, []);

  function run() {
    events.current = [];
    done.current = false;
    setPhase("running");
    const t0 = performance.now();
    const step = async (now) => {
      const t = now - t0;
      elapsedRef.current = t;
      setElapsed(t);
      const live = opts.integrate(events.current, ctx.seed, Math.min(t, opts.duration));
      liveRef.current = live;
      const over = t >= opts.duration || (opts.isFinished && opts.isFinished(live, t));
      if (!over) { raf.current = requestAnimationFrame(step); return; }
      done.current = true;
      const r = opts.resolve({ events: events.current }, ctx.seed);
      setPhase("flash");
      setFlash(opts.flashFor(r));
      await wait(1200);
      await ctx.submit({ events: events.current });
      setFlash(null); setPhase("watch");
    };
    raf.current = requestAnimationFrame(step);
  }

  useInput((name, edge) => {
    if (phase !== "running" || done.current) return;
    const ev = opts.record(name, edge, elapsedRef.current);
    if (ev) events.current.push(ev);
  });

  // Position beacons while running — rivals render these as live ghosts.
  useEffect(() => {
    if (phase !== "running" || !opts.beaconFor) return;
    const id = setInterval(() => {
      const live = liveRef.current;
      if (live) ctx.beacon(opts.beaconFor(live));
    }, 400);
    return () => clearInterval(id);
  }, [phase]);

  return { phase, count, elapsed, flash, live: liveRef.current, events };
}

// ---------------------------------------------------------------------------
// Turn runner — the sync half every turn-based game needs. It walks the shared
// turns list and REPLAYS other players' rows through your async `replay(row,
// isFinal)`, skipping your own (you animated them live). Call beginLive() when
// your player starts a live run and endLive() when it settles; gate input on
// settled(). isFinal is true on a seat's last attempt (cue an exit flourish).
// ---------------------------------------------------------------------------
export function useTurnRunner({ turns, clientId, attempts, replay }) {
  const busy = useRef(false);
  const shown = useRef(0);
  const [, force] = useState(0);
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  const replayRef = useRef(replay);
  replayRef.current = replay;

  async function pump() {
    if (busy.current) return;
    busy.current = true;
    try {
      while (shown.current < turnsRef.current.length) {
        const idx = shown.current;
        const row = turnsRef.current[idx];
        if (row.client_id !== clientId) {
          const nth = turnsRef.current.slice(0, idx + 1).filter((r) => r.seat_no === row.seat_no).length;
          await replayRef.current(row, nth >= attempts);
        }
        shown.current += 1;
      }
    } finally {
      busy.current = false;
      force((n) => n + 1); // refs settled — let the screen recompute its gates
    }
  }
  useEffect(() => { pump(); }, [turns.length]); // eslint-disable-line

  return {
    beginLive() { busy.current = true; },
    endLive() { busy.current = false; pump(); },
    settled: () => !busy.current && shown.current >= turnsRef.current.length,
  };
}
