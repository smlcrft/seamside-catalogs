// frame.sim.ts — the worker's game table. Each entry points at the SAME pure sim
// module the frontend animates with, so authoritative scoring and client-side
// play can never diverge. Adding a game to the console = one line here plus a
// registry entry (see public/games/README.md).
import { ATTEMPTS as SHOTPUT_ATTEMPTS, resolve as shotputResolve } from "./public/games/shotput-sim.js";
import { ATTEMPTS as REGATTA_ATTEMPTS, resolve as regattaResolve } from "./public/games/regatta-sim.js";
import { ATTEMPTS as HOTSLICE_ATTEMPTS, resolve as hotsliceResolve } from "./public/games/hotslice-sim.js";

export type GameSim = {
  // "turns" = players rotate, one at a time (attempts each, best counts).
  // "race"  = everyone plays SIMULTANEOUSLY: local play + position beacons,
  //           each player submits their deterministic input trace on finish.
  mode: "turns" | "race";
  attempts: number;
  raceMs?: number; // race mode: max run length; the worker adds a grace window
  resolve: (payload: unknown, seed: number) => { points: number; summary: string };
};

export const SIMS: Record<string, GameSim> = {
  shotput: { mode: "turns", attempts: SHOTPUT_ATTEMPTS, resolve: shotputResolve },
  regatta: { mode: "race", attempts: REGATTA_ATTEMPTS, raceMs: 120000, resolve: regattaResolve },
  hotslice: { mode: "race", attempts: HOTSLICE_ATTEMPTS, raceMs: 12000, resolve: hotsliceResolve },
};
