# Seamdeck

A toy game console that lives in a Seamside space. The frame is the whole
device: a handheld on narrow screens, a TV + controller on wide ones. People
open sessions of little Phosphor-icon games, join each other's lobbies, race
in realtime, and chase the shared high-score board.

**This frame is a template.** Fork it, reskin the console, and — mostly —
build your own games. The games are the point: each one is a self-contained
two-file cartridge, and the console gives every cartridge lobbies, turn
rotation, realtime racing, spectators, results, and high scores for free.

## Controls

D-pad (arrows/WASD), **O** = primary (the `KeyO` key, called `A` in code),
**I** = secondary/back (`KeyI`, called `B` in code). The center pill leaves
your session and returns to the library.

## The map

| Path | What it is |
|---|---|
| `frame.ts` | Worker: sessions, seats, turns, races, high scores. Knows no game rules. |
| `frame.sim.ts` | The worker's game table — one line per game (`SIMS`). |
| `public/index.html` | Thin shell. |
| `public/console.js` | The console UI: library, lobby, playing shell, results. |
| `public/console.css` | The chassis: device, deck, screens. |
| `public/console-kit.js` | The API games import: input bus, `useTurnRunner`, `useRaceRunner`, animator, rng. |
| `public/games/` | **The cartridges.** Start here: `games/README.md` is the contract. |
| `tests/` | Sim tests. `deno test tests/` |

## Make a game

Read `public/games/README.md` — it's one page. Short version: a pure sim file
(`resolve(payload, seed)`) plus a screen file, then register in
`games/registry.js` and `frame.sim.ts`. Copy shotput (turn-based) or hotslice
(realtime race) as your starting point.

## Tuning knobs

Every game keeps its feel in named constants at the top of its sim:

- Shot put: `CHARGE_MS` (screen), scoring rings in `score()`
- Regatta: `TURN_RATE`, `NO_GO`, `SPEED`, the par factor in `courseFor`
- Hot Slice: `IMPULSE`, `TAU`, `VMAX`, `DURATION`
- Races generally: the straggler grace (30s) and deadline padding in `frame.ts`

## Architecture in three sentences

The worker runs **once**, on the space owner's device; every viewer's requests
are proxied to it, so worker memory is already shared multiplayer state (high
scores persist to `data/high-scores.json`). Live updates are pushed with
`pushToInstance(sfi, { type: "state_changed" })`. Races run locally on each
player's screen from a shared per-round `seed`; the finished input trace is
re-simulated by the worker for the authoritative score, so nobody can lie.
