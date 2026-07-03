// rng.js — mulberry32, pure, no imports. Every round has ONE shared integer seed
// drawn by the worker; a game's sim derives its whole course/target from it, so
// every client (and the worker's authoritative scoring) computes identical worlds.
export function rng(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
