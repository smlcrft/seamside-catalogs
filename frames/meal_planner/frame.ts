// ----------------------------------------------------------------------------------------
// Meal Planner — plan the week's meals; the planning end of the household kitchen set.
//
// Design axes:
//   privacy:        privacy-public-view  — non-members get a live read-only view;
//                                           space editors get the interactive planner.
//                                           The page reads the week from GET /api/week,
//                                           and every write is a route here.
//   data_storage:   the frame data folder — `_fdata/meal_plan.table.jsonl`.
//   contracts:      owns `meal_plan` v1; reads `recipes` v1 (picker + ingredient
//                                           expansion) and inserts into `grocery` v1
//                                           ("send to grocery list"). Every table is in
//                                           the space's frame data folder by name, so a Recipe Box and a Grocery
//                                           List in the same space share these rows with no
//                                           setup. See docs/schema-contracts.md.
//   view_realtime:  view-collaborative    — every plan write pushes `{ meal_planner: "week" }`,
//                                           which says what to read again and never what it
//                                           holds. A push reaches only this session's pages,
//                                           so a member's page also watches the tables.
//
// With no recipes in the space the planner is freeform meal titles; with recipes each
// meal can point at a recipe row (title snapshotted per the contract), and a week's
// ingredients can be inserted into the grocery list, idempotently.
// ----------------------------------------------------------------------------------------
import type { Ctx } from "@frame-core";
import { declareTables, sanitizeText } from "@frame-core";

// ----- Contract schemas (verbatim from docs/schema-contracts.md; never vary these) ------
const MEAL_PLAN_SCHEMA = [
  { name: "day_date",  col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "slot",      col_type: "text"    as const, nullable: false, default_val: "dinner" },
  { name: "title",     col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "recipe_id", col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "servings",  col_type: "integer" as const, nullable: false, default_val: "0" },
  { name: "notes",     col_type: "text"    as const, nullable: false, default_val: "" },
];
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
const GROCERY_SCHEMA = [
  { name: "item",     col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "quantity", col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "category", col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "checked",  col_type: "integer" as const, nullable: false, default_val: "0" },
  { name: "source",   col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "added_ms", col_type: "integer" as const, nullable: false, default_val: "0" },
];

// ----- The space's tables, by contract name -------------------------------------------
const MEALS = "meal_plan";
const RECIPES = "recipes";
const GROCERY = "grocery";
declareTables([
  { key: MEALS, title: "Meal Plan", description: "Planned meals of this space's week planner.", schema: MEAL_PLAN_SCHEMA },
  { key: RECIPES, title: "Recipes", description: "The recipe box of this space.", schema: RECIPES_SCHEMA },
  { key: GROCERY, title: "Grocery List", description: "The grocery list of this space.", schema: GROCERY_SCHEMA },
]);

// ----- Rows -----------------------------------------------------------------------------
type Row = Record<string, unknown> & { id: string };
type Column = { name: string; col_type: "text" | "integer"; default_val: string };

const rows = (ctx: Ctx, name: string) => ctx.shared.table<Record<string, unknown>>(name);

const defaultsOf = (schema: Column[]): Record<string, unknown> =>
  Object.fromEntries(schema.map((c) => [c.name, c.col_type === "integer" ? Number(c.default_val) : c.default_val]));
const DEFAULTS: Record<string, Record<string, unknown>> = {
  [MEALS]: defaultsOf(MEAL_PLAN_SCHEMA),
  [GROCERY]: defaultsOf(GROCERY_SCHEMA),
};

/** Write a row over what it held (a new one from the schema's defaults), stamped. */
async function keep(ctx: Ctx, name: string, id: string | null, values: Record<string, unknown>): Promise<Row> {
  const was = id ? await rows(ctx, name).get(id) : null;
  const now = Date.now();
  return await rows(ctx, name).upsert({
    ...(was ?? { ...DEFAULTS[name], _created_at: now }),
    ...values,
    ...(id ? { id } : {}),
    _modified_at: now,
  });
}

function cmp(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a ?? "").localeCompare(String(b ?? ""));
}

async function mealsIn(ctx: Ctx, days: string[]): Promise<Row[]> {
  const wanted = new Set(days);
  return (await rows(ctx, MEALS).all())
    .filter((m) => wanted.has(String(m.day_date)))
    .sort((a, b) => cmp(a.day_date, b.day_date) || cmp(a._created_at, b._created_at));
}

// What changed, never what it holds: each page reads again as whoever it is.
const tell = (ctx: Ctx) => ctx.push({ meal_planner: "week" });

const json = (v: unknown, status = 200) => Response.json(v, { status });

async function body(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const v = JSON.parse(await request.text());
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

// ----- Dates & slots --------------------------------------------------------------------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isoDay = (d: Date): string =>
  d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
/** Snap any ISO date to its week's Monday (invalid/missing input snaps from today). */
function mondayOf(s: string): string {
  const d = DATE_RE.test(s) ? new Date(s + "T00:00:00") : new Date();
  if (Number.isNaN(d.getTime())) return mondayOf(isoDay(new Date()));
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return isoDay(d);
}
function addDays(s: string, n: number): string {
  const d = new Date(s + "T00:00:00");
  d.setDate(d.getDate() + n);
  return isoDay(d);
}
const weekDays = (start: string): string[] => Array.from({ length: 7 }, (_, i) => addDays(start, i));

// Canonical slots order the day; free text is tolerated (the contract's readers must
// tolerate it) and sorts after the canonical four.
function cleanSlot(v: unknown): string {
  return sanitizeText(v, 24).toLowerCase() || "dinner";
}
function cleanServings(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

// ----- Writes ---------------------------------------------------------------------------
// `op` is the API path with "/api/" stripped; `v` is the parsed payload.
async function write(ctx: Ctx, op: string, v: Record<string, unknown> | null): Promise<Response> {
  // Every op below mutates state and is editor-only. Non-members AND Viewer-role
  // members are rejected with the same gate (never gate writes on is_sfi_member —
  // Viewer-role members would slip through).
  if (!(ctx.peer.is_sfi_editor || ctx.peer.is_owner)) return json({ error: "editors only" }, 403);
  const recipes = rows(ctx, RECIPES);

  const ok = () => {
    tell(ctx);
    return json({ ok: true });
  };

  // --- Send ingredients to the space's grocery list -------------------------------------
  // Insert-only per the grocery contract: never edits, deletes, or toggles rows there.
  // Idempotent per the contract's rule: skip when an unchecked row with the same item and
  // source already exists (a re-buy of a checked-off item still goes through).
  if (op === "send_to_grocery") {
    const days = typeof v?.day_date === "string" && DATE_RE.test(v.day_date)
      ? [v.day_date]
      : typeof v?.week_start === "string" && DATE_RE.test(v.week_start)
        ? weekDays(v.week_start)
        : null;
    if (!days) return json({ error: "day_date or week_start required" }, 400);

    const listed = (item: unknown, source: unknown) => `${item}\u0000${source}`;
    const unchecked = new Set(
      (await rows(ctx, GROCERY).all()).filter((g) => Number(g.checked) === 0).map((g) => listed(g.item, g.source)),
    );
    const recipeCache = new Map<string, Row | null>();
    let sent = 0;
    for (const m of await mealsIn(ctx, days)) {
      const rid = String(m.recipe_id ?? "");
      if (!rid) continue; // freeform meals have nothing to expand
      if (!recipeCache.has(rid)) recipeCache.set(rid, await recipes.get(rid));
      const recipe = recipeCache.get(rid);
      if (!recipe) continue; // dangling reference — render-side it reads as broken, here it's skipped
      const lines = String(recipe.ingredients_lines ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
      for (const line of lines) {
        if (unchecked.has(listed(line, rid))) continue;
        await keep(ctx, GROCERY, null, {
          item: line, quantity: "", category: "", checked: 0, source: rid, added_ms: Date.now(),
        });
        unchecked.add(listed(line, rid));
        sent++;
      }
    }
    // The plan is as it was; a Grocery List in the space watches its own table.
    return json({ ok: true, sent });
  }

  // --- Meals ----------------------------------------------------------------------------
  // Shared field rules for create and patch. A recipe_id is only accepted when it
  // names a row of the space's recipes; the recipe's title is snapshotted into `title` per the
  // contract (an explicit title in the same payload overrides the snapshot).
  if (op === "meal") {
    const dayDate = typeof v?.day_date === "string" && DATE_RE.test(v.day_date) ? v.day_date : "";
    if (!dayDate) return json({ error: "day_date required" }, 400);
    let recipeId = "";
    let title = sanitizeText(v?.title, 200);
    if (typeof v?.recipe_id === "string" && v.recipe_id) {
      const r = await recipes.get(v.recipe_id);
      if (!r) return json({ error: "bad recipe" }, 400);
      recipeId = v.recipe_id;
      if (!title) title = sanitizeText(r.title, 200);
    }
    if (!title) return json({ error: "title required" }, 400);
    await keep(ctx, MEALS, null, {
      day_date: dayDate, slot: cleanSlot(v?.slot ?? "dinner"), title,
      recipe_id: recipeId, servings: cleanServings(v?.servings), notes: sanitizeText(v?.notes, 2000),
    });
    return ok();
  }

  if (op.startsWith("meal/")) {
    const [id, action] = op.slice("meal/".length).split("/");
    if (!id || !(await rows(ctx, MEALS).get(id))) return json({ error: "bad id" }, 400);
    if (action === "delete") {
      await rows(ctx, MEALS).delete(id);
      return ok();
    }
    if (action) return json({ error: "not found" }, 404);

    const patch: Record<string, unknown> = {};
    if (typeof v?.day_date === "string" && DATE_RE.test(v.day_date)) patch.day_date = v.day_date;
    if (v?.slot !== undefined) patch.slot = cleanSlot(v.slot);
    if (v?.recipe_id !== undefined) {
      if (typeof v.recipe_id === "string" && v.recipe_id) {
        const r = await recipes.get(v.recipe_id);
        if (!r) return json({ error: "bad recipe" }, 400);
        patch.recipe_id = v.recipe_id;
        // Changing the recipe re-snapshots its title, unless the same patch sets one.
        if (v?.title === undefined) patch.title = sanitizeText(r.title, 200);
      } else {
        patch.recipe_id = "";
      }
    }
    if (v?.title !== undefined) {
      const t = sanitizeText(v.title, 200);
      if (t) patch.title = t;
    }
    if (v?.servings !== undefined) patch.servings = cleanServings(v.servings);
    if (v?.notes !== undefined) patch.notes = sanitizeText(v.notes, 2000);
    if (Object.keys(patch).length > 0) await keep(ctx, MEALS, id, patch);
    return ok();
  }

  return json({ error: "not found" }, 404);
}

// ----- The week -------------------------------------------------------------------------
// `start` is any ISO date; the served week is always its Monday. No seeding — an empty
// week is an honest empty week.
async function week(ctx: Ctx, member: boolean, startParam: string): Promise<Response> {
  const start = mondayOf(startParam);
  const days = weekDays(start);
  const meals = await mealsIn(ctx, days);

  // The recipe index doubles as the picker source and the recipe_ok resolver: a meal's
  // link is ok iff the id still resolves (dangling references render their snapshot
  // title with the link affordance dropped, per the contract). A visitor off the roster
  // is handed only the recipes this week's meals name, which is all their page draws.
  const named = new Set(meals.map((m) => String(m.recipe_id ?? "")).filter(Boolean));
  const photoById = new Map<string, string>();
  const recipeIndex = (await rows(ctx, RECIPES).all())
    .filter((r) => member || named.has(r.id))
    .map((r) => {
      const photo = typeof r.photo === "string" && r.photo.startsWith("data:image/") ? r.photo : "";
      if (photo) photoById.set(r.id, photo);
      return {
        id: r.id, title: String(r.title ?? ""),
        servings: Number(r.servings) || 0, tags: String(r.tags ?? ""), photo,
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title));
  const recipeIds = new Set(recipeIndex.map((r) => r.id));

  return json({
    start, days,
    meals: meals.map((m) => ({
      id: m.id, day_date: m.day_date, slot: m.slot, title: m.title,
      recipe_id: m.recipe_id,
      recipe_ok: !!(m.recipe_id && recipeIds.has(m.recipe_id as string)),
      photo: (m.recipe_id && photoById.get(m.recipe_id as string)) || "",
      servings: m.servings, notes: m.notes,
    })),
    recipes: recipeIndex,
  });
}

// ----- Networking -----------------------------------------------------------------------
export default {
  async fetch(request: Request, ctx: Ctx): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const { method } = request;
    const editor = ctx.peer.is_sfi_editor || ctx.peer.is_owner;
    const member = editor || ctx.peer.is_sfi_member;

    // Static assets — open to everyone, including anon read-only viewers.
    if (method === "GET" && !pathname.startsWith("/api/")) return ctx.file(pathname);

    // Identity probe — drives which render mode the frontend shows.
    if (pathname === "/api/whoami" && method === "GET") {
      return json({
        is_anon:       ctx.peer.is_anon,
        is_sfi_member: member,
        is_sfi_editor: editor,
        is_owner:      ctx.peer.is_owner,
        user_id:       ctx.peer.user_id,
        user_name:     ctx.peer.user_name,
        space_color:   ctx.peer.space_color,
      });
    }

    if (pathname.startsWith("/api/") && (method === "POST" || method === "PUT")) {
      return write(ctx, pathname.slice("/api/".length), await body(request));
    }

    // Read — open to everyone (non-members get a read-only view of the plan).
    if (pathname === "/api/week" && method === "GET") return week(ctx, member, url.searchParams.get("start") ?? "");

    return json({ error: "not found" }, 404);
  },
};
