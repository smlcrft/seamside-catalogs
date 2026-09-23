# Shared-table schema contracts (frame sets)

How independent frames compose over the same rows: a **contract** is a named,
versioned column schema that more than one frame declares verbatim. One frame
*owns* the contract (it creates and broadly manages the rows); other frames
*link* to it (they bind the same shared table and make only the writes their
contract role documents). This is what makes a "set" of frames cheap: swap the
frame, keep the data.

The mechanics are Seamside v1's: a table is a file of the space
(`<name>.table.jsonl` at its root), shared by name by every frame in that space.
Two frames that name the same contract in one space are already working on the
same rows — there is no local twin and no graduation (v0's mechanism is kept for
the record in [table-graduation.md](table-graduation.md)).

**A contract may have several lists in one space.** A compound suffix is a subtype:
`members.table.jsonl`, `club.members.table.jsonl` and `choir.members.table.jsonl`
all speak `members`. A frame that speaks a contract with more than one natural list
(`members`, `wishes`) binds **one per session**: the table name, kept in the
session's own keys (`sessionKv` `bound/<contract>`), chosen by an editor from the
space's matching tables (or a new one) and always confirmed, never guessed. It
declares `"opens": ["<contract>.table.jsonl"]` so the space offers it on those files.
Companions agree by the person choosing the same list in each. Worked example:
`frames/member_manager` with `public/members_list.js`.

A contract adds only discipline: exact schemas, who writes what, and rules for
evolving them. The flip side: a table name is shared whether you meant it or not,
so a frame's private table must be named for the frame (`kanban_cards`, not
`cards`).

## When NOT to write a contract

A contract is a cost before it is a feature. It buys a real thing — swap the frame,
keep the data — but it is a promise every frame naming it must keep forever: the
schema only grows, every writer stays in its role, and any frame in the space
that names the table sees and can change its rows. Most frames should keep their
rows under a name of their own.

Share a table only when **two frames a person would genuinely place in the same
space need to act on the same rows**, and the second frame's job is not just to
show them differently. The household kitchen trio passes: you pick a recipe in
the planner and its ingredients land in the grocery list, which is a real flow
across three frames that people really do run side by side.

It fails when the "set" is actually one frame cut into pieces. A course list, an
assignment tracker and a semester dashboard sharing a `courses` table is three
installs and a frozen schema to arrive at what one assignment
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
- Reading a contract is cheaper than owning one, but it is not free — the reader
  is bound to the schema and must degrade when the owner is absent.

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

## Reading another frame's contract

A frame that consumes a contract it doesn't own declares the contract table by
its name, with the verbatim schema, and reads (or writes, as its role line
allows) whatever rows the space holds. When the owning frame is not in the
space the table is simply empty or absent, and the consumer degrades to its
standalone behaviour (the planner falls back to freeform meals) — never a
blocking waiting state. Rows another frame writes do not raise this frame's
`pushToInstance`; a consumer that must redraw live watches the table from the
page (`seamside.data.kv.watch('t/<contract>/', …)`) or re-reads on focus.

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
  { name: "best_streak",  col_type: "integer" as const, nullable: false, default_val: "0" },
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
- `best_streak` is the longest `streak` ever reached (append-only addition, 2026-09-23).
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
  { name: "claimed",       col_type: "integer" as const, nullable: false, default_val: "0" }, // appended 2026-09-23
];
```

- **Names (subtypes).** A `wishes` table is `wishes.table.jsonl` or any
  `<name>.wishes.table.jsonl` (`christmas.wishes`, `birthday-2026.wishes`): the name
  matches `/^([a-z0-9][a-z0-9_-]*\.)*wishes$/`. A space may hold several; each
  session of a frame speaking `wishes` binds one (Gift List: `sessionKv`
  `bound/wishes`, chosen and confirmed by an editor), so two sessions can hold two
  lists, and companions agree by the person choosing the same list in each.
- **Who claimed never enters the table; that something is claimed does (append-only addition, 2026-09-23).** A
  table is readable by every member of the space and syncs to their copies, so a name
  written there reaches the person the wish is for. The holder lives in Gift List's
  worker, `data/claims.json`, keyed by space and list (on the keeper's device, not
  synced, not served by the door — the door's `SRC` refuses `data/`), and
  `claimed_by` / `claimed_by_id` stay empty in the table; the columns stay in the
  schema so the contract does not change shape. `claimed` (0/1) is set on claim and
  cleared on release, so a claim outlives the loss of `data/` as "claimed by
  someone". **Accepted cost:** anyone who opens the table file — the person the wish
  is for included — can read *that* a wish is claimed, never by whom.
- A claim whose row says `claimed = 1` but whose holder is not known (data/ lost) is
  shown as "claimed" to everyone but the person it is for, and any editor may release
  it, since nobody can prove they hold it.
- **This contract carries a secret, and the secret is a SERVER concern.** A frame speaking
  `wishes` MUST strip `claimed_by` and `claimed_by_id` from the payload before sending it
  to the person the wish is for — not hide them in the UI. A frontend that receives the
  claim and declines to draw it has not kept the secret; it is one devtools panel away
  from ruining the surprise.
- Strip the fields (`claimed` included) entirely rather than blanking them, and send
  **no** substitute boolean. "Something on your list is claimed" is enough to spoil a one-item list, so a recipient's
  row must look identical whether or not anyone has claimed it.
- Identify the recipient by `for_user_id` when present (exact) and by a loosened name
  comparison otherwise (trim / lowercase / collapse spaces, plus a first-name match). Err
  toward hiding: wrongly hiding a claim from a bystander is a small confusion, wrongly
  showing one to the recipient is the single thing this contract exists to prevent.
- `for_who` is a free-text household name, like `chores.assignee`; colour-code it from a
  hash of the name so every device agrees.
- Only the holder of a claim may release it whenever the holder is known, or one
  relative could quietly take over another's gift with nobody told.
- Roles: Gift List full CRUD.

## The household kitchen set (worked example)

Three frames, each standing alone, composing when linked:

- **Recipe Box** owns `recipes`.
- **Meal Planner** owns `meal_plan`, reads `recipes` (recipe picker + per-day
  plan) and inserts into `grocery` (send a day or week's ingredients to the list).
- **Grocery List** owns `grocery` (the realtime shared list).

Set-up story the catalog demonstrates: place all three in one family space and
they compose at once — a recipe saved in Recipe Box is in the planner's picker,
and "send to grocery list" lands its ingredients on the open list. Nothing breaks
when one is absent — the planner falls back to freeform meals, the list is just a
list. (Tested end to end on Seamside v1.0.0, 2026-09-23.)
