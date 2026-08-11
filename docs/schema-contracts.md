# Shared-table schema contracts (frame sets)

How independent frames compose over the same rows: a **contract** is a named,
versioned column schema that more than one frame declares verbatim. One frame
*owns* the contract (it creates and broadly manages the rows); other frames
*link* to it (they bind the same shared table and make only the writes their
contract role documents). This is what makes a "set" of frames cheap: swap the
frame, keep the data.

The mechanics are the ones already shipped: LocalTables by default, per-placement
graduation to shared tables ([table-graduation.md](table-graduation.md)), and the
platform's binding picker. A contract adds only discipline: exact schemas, who
writes what, and rules for evolving them.

## When NOT to write a contract

A contract is a cost before it is a feature. It buys a real thing — swap the frame,
keep the data — but it charges the user ceremony to get there: graduate this
table, link that one, pick the right one out of a list, and understand why any
of that was necessary. Most frames should never ask for that.

Share a table only when **two frames a person would genuinely place in the same
space need to act on the same rows**, and the second frame's job is not just to
show them differently. The household kitchen trio passes: you pick a recipe in
the planner and its ingredients land in the grocery list, which is a real flow
across three frames that people really do run side by side.

It fails when the "set" is actually one frame cut into pieces. A course list, an
assignment tracker and a semester dashboard sharing a `courses` table is three
installs, two link steps and a table picker to arrive at what one assignment
tracker models on its own — the courses are that frame's own data, not a
commons. Ratified 2026-08-08: **the study set ships as standalone frames.** If a
frame's contract exists mainly so another frame can re-render the same rows,
delete the contract and keep the rows private.

Rules of thumb:

- Ask what **moves** between the frames. No movement, no contract.
- If one frame writes and the others only read, consider whether the reader
  should just be a view inside the writer.
- Splitting an entity into its own frame "for reuse" that nothing else reuses
  is the most common false positive.
- A link unit is cheaper than a shared owned table, but it is not free — it
  still costs a picker and an explanation.

## Conventions (all contracts)

- **Names** are snake_case, singular-descriptive (`recipes`, `meal_plan`,
  `grocery`). Column names snake_case.
- **Types** are only `text` | `integer` | `real`, always `nullable: false` with a
  `default_val`. Encode everything else:
  - dates: ISO `yyyy-mm-dd` in text (empty string = unset)
  - timestamps: integer epoch-ms, column suffix `_ms`
  - booleans: integer 0/1
  - multi-line lists: newline-separated text, column suffix `_lines`
  - tag lists: comma-separated lowercase text
  - cross-table references: the target table's `_row_id` in text, suffix `_id`
    (empty string = none)
- **Declare verbatim.** A frame speaking a contract copies the schema constant
  from this doc character-for-character into its `declareTables` calls. Never a
  private variation.
- **Evolution is append-only.** A contract may gain columns (with defaults);
  columns are never renamed, retyped, or repurposed. Readers MUST tolerate
  columns they don't know and missing optional values. Breaking changes are a
  NEW contract name (`recipes2`), not an edit.
- **Snapshot beside the reference.** A row that references another table also
  stores the display text it needs (usually `title`). References may dangle
  after deletes; readers render the snapshot and quietly treat the link as
  broken. Never cascade deletes across a contract boundary.
- **Writers stay in role.** The owning frame seeds, edits, and deletes rows
  freely. A linked frame makes only the writes its role line documents below.
  Everything still goes through the frame's own editor gate
  (`peer.is_sfi_editor`) — a contract never loosens access.

## Link units (consuming another frame's contract)

A frame that consumes a contract it doesn't own declares a **link unit**: an
adopt-only graduation unit (see "Graduation units" in table-graduation.md).

- Lazily declare `<contract>_shared` with the verbatim contract schema; never a
  local twin (there is nothing to convert — the data lives with the owning
  frame's table).
- **Links live in the data drawer, not in the header.** A frame with several data
  units (its own, plus each link) lists them all inside the one drawer button
  described in table-graduation.md: `frame.choose` with a row per unit, the
  unit's state as the detail line ("in a shared table" / "linked to a shared
  table" / "not linked"), and picking one opens that unit's actions. Owner-only.
  A link unit's actions are `frame.confirm("Link a shared <x> table?")` → the
  standard graduate-with-adopt path → the platform's table picker, or, when
  linked, an unlink confirm that says the frame keeps working without it.
  (Ratified 2026-08-06: per-unit header chips do not scale — three units meant
  three chips shouting a setting nobody touches.)
- Settings use the multi-unit shape: `{ <unit>: { backend, pending_graduation } }`
  where a link unit's `backend` is `"none" | "shared"`.
- Unlinking just clears the unit back to `"none"` (the platform binding remains
  and is harmless); the frame returns to its standalone behavior. This is safe
  precisely because a link unit owns no data.
- A linked table can be missing/unbound on a fresh host exactly like any
  graduated unit: degrade to the standalone behavior rather than a blocking
  waiting state, since the frame works without it.

## Contract: `recipes` v1

Owner: **Recipe Box**. Readers: Meal Planner (picker + ingredient expansion).

```ts
const RECIPES_SCHEMA = [
  { name: "title",            col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "ingredients_lines", col_type: "text"   as const, nullable: false, default_val: "" },
  { name: "steps_lines",      col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "servings",         col_type: "integer" as const, nullable: false, default_val: "0" },
  { name: "tags",             col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "notes",            col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "created_ms",       col_type: "integer" as const, nullable: false, default_val: "0" },
  { name: "photo",            col_type: "text"    as const, nullable: false, default_val: "" },
];
```

- `ingredients_lines`: one ingredient per line, freeform ("2 cups flour",
  "salt"). No structured qty parsing in v1 — consumers use the whole line as
  the item text.
- `steps_lines`: one step per line, rendered numbered.
- `servings` 0 = unspecified. `tags` comma-separated lowercase.
- `photo`: a `data:image/jpeg;base64,` (or webp/png) data URI, or empty. The
  writing frame MUST downscale before storing (longest edge ≤ 512px, JPEG
  quality ~0.75; keep the string under ~200 KB) — every byte lives in the
  table's CRDT history, so this column carries a thumbnail, never an original.
  Readers treat any non-`data:image/` value as empty. (Added 2026-08-05 as an
  append-only evolution; readers must tolerate its absence on older rows.)
- Roles: Recipe Box full CRUD. Meal Planner reads only.

## Contract: `meal_plan` v1

Owner: **Meal Planner**. No linked readers in wave 1 (a future "tonight's
dinner" display frame reads it).

```ts
const MEAL_PLAN_SCHEMA = [
  { name: "day_date",  col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "slot",      col_type: "text"    as const, nullable: false, default_val: "dinner" },
  { name: "title",     col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "recipe_id", col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "servings",  col_type: "integer" as const, nullable: false, default_val: "0" },
  { name: "notes",     col_type: "text"    as const, nullable: false, default_val: "" },
];
```

- `slot`: `breakfast` | `lunch` | `dinner` | `snack` canonically; readers
  tolerate free text.
- `title` is the display snapshot: the recipe title at planning time, or a
  freeform meal ("leftovers"). `recipe_id` optionally points into `recipes`;
  when it dangles, render `title` and drop the link affordances.

## Contract: `grocery` v1

Owner: **Grocery List**. Writer: Meal Planner ("send to grocery list" inserts
rows).

```ts
const GROCERY_SCHEMA = [
  { name: "item",     col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "quantity", col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "category", col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "checked",  col_type: "integer" as const, nullable: false, default_val: "0" },
  { name: "source",   col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "added_ms", col_type: "integer" as const, nullable: false, default_val: "0" },
];
```

- `category`: lowercase aisle/section ("produce", "dairy"); empty = uncategorized.
- `source`: `""` for hand-added rows; a `recipes` row id for rows expanded from
  a recipe; `"meal_plan"` for plan rows without a recipe. Grocery List renders
  sourced rows with a small provenance hint but treats them as ordinary rows.
- Roles: Grocery List full CRUD. Meal Planner INSERTS only (never edits or
  deletes rows, never toggles `checked`), and skips inserting when an unchecked
  row with the same `item` and `source` already exists (re-sending a week is
  idempotent, while a re-buy of a checked-off item still goes through).

## Contract: `chores` v1

Owner: **Chore Chart**. No linked readers in wave 1 (the planned chore-RPG
variant is a different view over these same rows, which is the point).

```ts
const CHORES_SCHEMA = [
  { name: "chore",        col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "assignee",     col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "cadence",      col_type: "text"    as const, nullable: false, default_val: "weekly" },
  { name: "last_done_ms", col_type: "integer" as const, nullable: false, default_val: "0" },
  { name: "last_done_by", col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "streak",       col_type: "integer" as const, nullable: false, default_val: "0" },
  { name: "sort_order",   col_type: "integer" as const, nullable: false, default_val: "0" },
  { name: "notes",        col_type: "text"    as const, nullable: false, default_val: "" },
];
```

- `assignee`: a free-text household name, not a `user_id` — the people on a
  family chore chart are kids and housemates, not necessarily peers with
  accounts. Empty = anyone. Readers that colour-code a person MUST derive the
  channel from the name (a hash), never from arrival order, or two devices show
  the same person in different colours.
- `cadence`: `daily` | `weekly` | `monthly` | `once`. Readers tolerate free text
  and should fall back to `weekly`.
- **There is no `done` column, and adding one would be a bug.** Whether a chore
  is done is *derived*: it is done when `last_done_ms` falls in the same period
  as now (for `once`, when it is non-zero at all). Storing the flag would go
  stale the moment a period turned over with nobody looking, and nothing runs on
  a schedule inside a frame to correct it. Weeks run Monday→Sunday; compute the
  day number from the local calendar fields via `Date.UTC(y, m, d)` so the
  host's own offset cannot slide the boundary.
- `streak` counts consecutive completed periods: it advances only when the
  previous period was also done, and re-ticking inside the same period is a
  no-op rather than a second count.
- `last_done_by` is the display name of whoever ticked it, a snapshot like any
  other cross-reference text.
- Roles: Chore Chart full CRUD.

## Contract: `wishes` v1

Owner: **Gift List**. No linked readers in wave 1.

```ts
const WISHES_SCHEMA = [
  { name: "item",          col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "for_who",       col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "for_user_id",   col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "url",           col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "notes",         col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "claimed_by",    col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "claimed_by_id", col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "added_ms",      col_type: "integer" as const, nullable: false, default_val: "0" },
];
```

- **This contract carries a secret, and the secret is a SERVER concern.** A frame speaking
  `wishes` MUST strip `claimed_by` and `claimed_by_id` from the payload before sending it
  to the person the wish is for — not hide them in the UI. A frontend that receives the
  claim and declines to draw it has not kept the secret; it is one devtools panel away
  from ruining the surprise.
- Strip the fields entirely rather than blanking them, and send **no** substitute boolean.
  "Something on your list is claimed" is enough to spoil a one-item list, so a recipient's
  row must look identical whether or not anyone has claimed it.
- Identify the recipient by `for_user_id` when present (exact) and by a loosened name
  comparison otherwise (trim / lowercase / collapse spaces, plus a first-name match). Err
  toward hiding: wrongly hiding a claim from a bystander is a small confusion, wrongly
  showing one to the recipient is the single thing this contract exists to prevent.
- `for_who` is a free-text household name, like `chores.assignee`; colour-code it from a
  hash of the name so every device agrees.
- Only the holder of a claim may release it, or one relative could quietly take over
  another's gift with nobody told.
- Roles: Gift List full CRUD.

## The household kitchen set (worked example)

Three frames, each standing alone, composing when linked:

- **Recipe Box** owns `recipes` (local by default; graduation makes it a shared
  table others can bind).
- **Meal Planner** owns `meal_plan`, links `recipes` (recipe picker + per-day
  plan) and `grocery` (send a day or week's ingredients to the list).
- **Grocery List** owns `grocery` (the realtime shared list).

Set-up story the catalog should demonstrate: place all three in a family space;
graduate Recipe Box's table ("convert"); in Meal Planner, link recipes
("adopt", pick the same table) and link grocery after graduating Grocery List
the same way. Nothing breaks when a link is absent — the planner falls back to
freeform meals, the list is just a list.
