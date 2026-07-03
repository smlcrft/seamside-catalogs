# Making a Seamdeck game

Every game is a **pair of files** in this directory. Fork the shot put pair to
start — it's the smallest complete example.

## 1. `<id>-sim.js` — the rules (pure, no DOM)

Shared verbatim by the browser, the worker, and the tests. Must export:

```js
export const ATTEMPTS = 3;              // turns per player; best one counts
export function resolve(payload, seed)  // → { points, summary, ...extras }
```

- `payload` is whatever your screen submitted for one turn — treat it as
  untrusted input (clamp, validate, never throw).
- `seed` is one shared integer drawn by the worker per round. Derive your whole
  course/target/level from it with `rng(seed)` (`./rng.js`) so every player gets
  the same world and every replay is deterministic.
- `points` ranks players; `summary` is the short human string shown in results
  ("18.4 m", "6/8 gusts").

No randomness, no `Date.now()`, no globals — same inputs, same outputs, always.

## 2. `<id>.js` — the cartridge (screen + metadata)

```js
export const mygame = {
  id: "mygame", title: "My Game", icon: "phosphor-icon-name",
  blurb: "One line of attract-mode copy.",
  available: true,
  mode: "turns",            // or "race" — see below
  attempts: ATTEMPTS,       // re-export from your sim
  screen: PlayScreen,       // ({ ctx }) => html
};
```

**Two game modes:**

- `"turns"` (shot put): players rotate one at a time, `attempts` each, best
  counts. Use `useTurnRunner` to replay other players' turns to spectators.
- `"race"` (regatta, hot slice): everyone plays SIMULTANEOUSLY. Each client
  runs its own deterministic sim locally (zero input latency), broadcasts its
  position a few times a second so rivals render as live ghosts (`ctx.racers`),
  and submits its full input trace at the finish — the worker re-runs the trace
  through your sim for the authoritative time/points. Set `raceMs` for your
  game in `frame.sim.ts`; the worker force-resolves stragglers to DNF after a
  grace window. Don't hand-roll the lifecycle: `useRaceRunner(ctx, opts)` in
  console-kit gives you the countdown, race clock, input recording, beacons,
  and finish→flash→submit — your screen supplies pure hooks (`integrate`,
  `record`, `beaconFor`, `resolve`, `flashFor`) and just renders. Both race
  cartridges are examples of exactly this.

Your `PlayScreen` gets a `ctx` with everything the console knows:

- `ctx.seed` — the round seed. `ctx.seats`, `ctx.turns` (rows with parsed
  `payload`), `ctx.turnIndex`, `ctx.attempt`, `ctx.isMyTurn`, `ctx.clientId`.
- `ctx.submit(payload)` — send my finished turn to the worker (it re-scores it
  through your sim's `resolve`, so a tampered client can't lie about points).

From `../console-kit.js`:

- `useInput((name, edge) => ...)` — the hardware: `up/down/left/right/A/B`,
  edges `"down"|"up"`. `A` is the O key (primary), `B` is I (back — the console
  core owns it; don't bind it).
- `useTurnRunner({ turns, clientId, attempts, replay })` — replays other
  players' turns through your `replay(row, isFinal)` so spectators watch every
  turn. Call `beginLive()`/`endLive()` around your own player's live run and
  gate input on `settled()`.
- `animator()`, `wait(ms)` — reduced-motion-aware tweens.

Style with the shared screen furniture (`.field`, `.flash`, `.meter`,
`.prompt`, `.game-read`) and carry game-specific CSS in your own `<style>`
block inside the screen — the whole game stays in one file.

## 3. Register it

- `registry.js`: import your cartridge, add it to `GAMES`.
- `../../frame.sim.ts`: add your sim to `SIMS` so the worker can score it.
- Add a test file in `../../tests/` — sims are pure, so they test in one line.

That's it. The console gives you the lobby, turn rotation, replays, results,
and the leaderboard for free.
