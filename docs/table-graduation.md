# Per-placement table graduation (local → shared)

The common pattern for letting a user move ONE placement's data from private
LocalTables to shared tables (SyncTables), so other frames can bind the same
rows, while every other placement of the same frame stays local. Two modes,
both owner-only:

- **convert** — copy this placement's local rows into freshly bound shared
  tables (spreadsheet's "share").
- **adopt** — bind existing shared tables instead, no copy; the frame shows
  whatever they contain (spreadsheet's "import").

First shipped in `kanban` (this repo); the backend mechanics originate in the
bundled `spreadsheet` frame. Say **shared table** in all user-facing copy — it
is the platform's term (the Tables view); don't invent synonyms.

**Install-time default is always local.** Zero ceremony: LocalTables self-ensure,
no binding modal, data encrypted at rest on the host device. Graduation is an
owner choice made later, per placement (per `sfi_id`), typically because a second
frame should work over the same data (a gantt view over kanban cards, a report
over inventory rows).

Worked example: [`frames/kanban/frame.ts`](../frames/kanban/frame.ts) (backend)
and [`frames/kanban/public/index.html`](../frames/kanban/public/index.html) (UI).

## Backend recipe

1. **One schema constant per table**, used by both declarations:

   ```ts
   declareTables([
     { key: "cards", title: "…", local: true, schema: CARDS_SCHEMA },
   ]);
   let sharedDeclsRegistered = false;
   function ensureSharedDecls() {           // LAZY — see invariant 1
     if (sharedDeclsRegistered) return;
     sharedDeclsRegistered = true;
     declareTables([{ key: "cards_shared", title: "…", schema: CARDS_SCHEMA }]);
   }
   ```

2. **Per-placement settings** persisted via `loadJsonFile`/`saveJsonFile` (or a
   local meta table): `{ backend: "local" | "shared", pending_graduation?: true }`.

3. **Backend-agnostic table resolution.** All data access goes through one
   resolver; everything downstream is unchanged by graduation:

   ```ts
   const t = table(settings.backend === "shared" ? "cards_shared" : "cards", sfiId);
   ```

4. **The graduate endpoint** (owner-only): set `pending_graduation` to the mode
   (`"convert"` | `"adopt"`), save, `ensureSharedDecls()`, then
   `ensureTables(peer)` with REAL owner privilege — that fires the OS binding
   modal(s) for this placement. A matching `cancel_graduate` clears the flag.

5. **Finish on sight.** On any subsequent request: if `pending_graduation` and all
   shared bindings resolve, finish and flip `backend: "shared"`, clear pending,
   push a refresh. `convert` first copies rows, **preserving row ids** —
   `sharedT.upsert(localRowId, values)` creates the row under that id — which
   keeps cross-table references (`cards.column_id` → columns row id) valid with
   no remapping AND makes a rerun after a partial copy an idempotent overwrite.
   `adopt` copies nothing. Only clear `pending_graduation` after a full
   successful pass.

6. **The waiting state.** A graduated placement whose bindings are missing (fresh
   worker on a migrated host, picker closed mid-flow) answers data routes 503 and
   the main state route with `{ waiting_for_binding: true }`; when the OWNER hits
   that route, call `ensureTables(peer)` to re-fire the picker.

7. **Foreign-write refresh.** After graduation, `table(...).onChange(...)` →
   `pushToInstance` so edits arriving from other frames or peer devices refresh
   viewers just like the frame's own writes.

### Invariants (each guards a real failure mode)

1. **Shared decls register lazily.** Declared up-front, the host's binding refire
   would pop the owner's table picker on frame start for every placement.
2. **Passive paths ensure QUIETLY.** Once one placement graduates, the shared
   decls exist worker-globally; `ensureTables({ ...peer, is_owner: false })`
   keeps every OTHER (still-local) placement from popping the picker. Only the
   graduate/waiting paths pass real owner privilege.
3. **Decls don't survive worker restarts; bindings and settings do.** Re-register
   the shared decls on any request from a placement whose settings say
   `shared` or pending.
4. **A GET from a viewer must not mutate.** Seeding and graduation completion are
   fine on read routes, but gate seeding on the editor role and remember
   graduation completion only needs the bindings, not the requester's role.
5. **Graduation is one-way in the UI.** Framecore's synced→local direction starts
   a fresh local table (shared rows are never pulled private) — don't offer it as
   an "undo".

## UI recipe

**The frame explains nothing.** The platform's binding picker carries the
explanation; the frame offers a switch. No custom data modal — a frame-authored
explainer duplicates the system surface and goes stale. (Longer-term this
control belongs in the frame chrome itself, driven by the platform's knowledge
of the frame's declared local tables; until then the switch lives in the frame,
as small as possible.)

- **A storage chip in the header rail** (right side, before the mode text):
  neutral inset chip, 12px icon + lowercase word — `ph-hard-drive` "local",
  "sharing" with a 2s breathe on the icon while pending, `ph-table` "synced".
  Keep it neutral: storage is status, never channel-tinted (mind an existing
  `.header i` channel rule). For the owner, while local or pending, the chip is
  a button; once shared (and for everyone else) it's a static chip with a title
  tooltip.
- **One system chooser** (framelib `frame.choose`, added for exactly this):
  - local, chip click → title "Board data", two options and nothing else:
    **"Convert to shared tables"** (detail: "copies this board's columns and
    cards") and **"Use existing shared tables"** (detail: "points this board at
    tables you already have") → `graduate` with the picked mode; the platform's
    table picker takes it from there. Feature-detect `frame.choose` and fall
    back to a convert-only `frame.confirm` on older chassis (and set
    `app_version_min` to the release that ships `frame.choose`).
  - pending, chip click → `frame.confirm("Stop the move to shared tables?")`,
    ok "Stop", cancel "Keep going" → `cancel_graduate`.
- **Auto-refire while pending.** If the owner dismissed the picker (or the app
  restarted), their next load of the main state route calls `ensureTables(peer)`
  so the picker comes back — no "reopen" button needed. Pending is an explicit
  owner-initiated state, so this is wanted, unlike the quiet passive paths.
- **A waiting notice** replacing the content area when `waiting_for_binding`:
  centered `ph-table`, "Almost there", one short line for the owner (name the
  pick order) and one for everyone else (the owner is finishing the move).
- Copy rules: plain sentences, no em dashes, name the concept **space tables**.

## Graduation units — sharing one table, keeping the rest

Graduation is per **unit**, not per frame. A unit is the smallest set of tables
that must move together because they reference each other. Each unit graduates
independently with exactly the recipe above; tables the frame never declares as
a unit simply stay local forever.

- Kanban is ONE unit (`columns` + `cards` — cards hold column row ids), so its
  chip drives the whole board.
- A game frame that wants shareable high scores declares a `highscores` unit
  and nothing else: the scores table can convert or adopt, while all live game
  state stays in local tables (or worker memory) with no graduation surface.

Multi-unit settings shape (single-unit frames can keep the flat
`{ backend, pending_graduation }`):

```ts
type SfiSettings = Record<string, { backend: Backend; pending_graduation?: GradMode }>;
// unit key → state, e.g. { highscores: { backend: "shared" } }
```

Everything else scales per unit: shared decls per unit (registered lazily when
that unit graduates), `sharedBound(unit)`, `runGraduation(unit)`, and
`graduate`/`cancel_graduate` take the unit key.

UI: a frame with one unit puts the chip in the header (it speaks for the whole
frame's data). A frame with several units — or a unit that is one section of
the frame — puts the same affordance next to that section instead (a small
chip by the high-score board), still one `frame.choose` per unit. Don't build
a data-management panel; that's #755's job.

## When to use

Any frame whose rows another frame could plausibly want (task lists, inventories,
rosters, recipes). Skip it for data that is meaningless outside the frame
(ephemeral game state, per-viewer prefs). If the frame has multiple tables,
graduate them together as one action — name the pick order in the pending copy.
