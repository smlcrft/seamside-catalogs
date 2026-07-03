// registry.js — the cartridge shelf. The console core iterates this to build the
// library and render the active game; it knows nothing about any game's rules.
// Adding a game = one import + one list entry (see README.md in this directory).
import { shotput } from "./shotput.js";
import { regatta } from "./regatta.js";
import { hotslice } from "./hotslice.js";

// Coming-soon cartridges advertise the extension point (dimmed in the library).
export const comingSoon = [
  { id: "hairpin", title: "Hairpin", icon: "steering-wheel", available: false },
  { id: "boohop", title: "Boo Hop", icon: "ghost", available: false },
];

export const GAMES = [shotput, regatta, hotslice, ...comingSoon];

export function gameById(id) {
  return GAMES.find((g) => g.id === id) || null;
}
