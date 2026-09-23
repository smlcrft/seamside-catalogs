// ----------------------------------------------------------------------------------------
// Meal Planner — plan the week's meals; the planning end of the household kitchen set.
//
// Design axes:
//   privacy:        privacy-public-view  — non-members get a live read-only view;
//                                           space editors get the interactive planner.
//   data_storage:   the space's tables   — `meal_plan.table.jsonl` at the space's root.
//   contracts:      owns `meal_plan` v1; reads `recipes` v1 (picker + ingredient
//                                           expansion) and inserts into `grocery` v1
//                                           ("send to grocery list"). Every table is the
//                                           space's by name, so a Recipe Box and a Grocery
//                                           List in the same space share these rows with no
//                                           setup. See docs/schema-contracts.md.
//   view_realtime:  view-collaborative    — every mutation calls pushToInstance(sfi_id, …)
//                                           so every viewer refreshes live.
//
// With no recipes in the space the planner is freeform meal titles; with recipes each
// meal can point at a recipe row (title snapshotted per the contract), and a week's
// ingredients can be inserted into the grocery list, idempotently.
// ----------------------------------------------------------------------------------------
import {
  log, serveFileAtPath, jsonReply, parseJsonBody, parsePeerInfo, onUiMessage,
  pushToInstance, sanitizeText,
  declareTables, table,
} from "@frame-core";

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
declareTables([
  { key: "meal_plan", title: "Meal Plan", description: "Planned meals of this space's week planner.", schema: MEAL_PLAN_SCHEMA },
  { key: "recipes", title: "Recipes", description: "The recipe box of this space.", schema: RECIPES_SCHEMA },
  { key: "grocery", title: "Grocery List", description: "The grocery list of this space.", schema: GROCERY_SCHEMA },
]);

type Peer = ReturnType<typeof parsePeerInfo>;

function notify(sfiId: string) {
  pushToInstance(sfiId, { type: "plan_changed" });
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
// One shared mutation path for BOTH transports: the bus dispatcher below (frame.busSend →
// onUiMessage, the primary write path) and the HTTP POST arm in onNetworkRequest (kept for
// older viewers whose framelib has no busSend). `op` is the API path with "api/" stripped;
// `v` is the parsed payload. Role gates live here so the two entry points can never drift.
type WriteResult = { status: number; body: unknown };

async function handleWrite(sfiId: string, op: string, v: Record<string, unknown> | null, peer: Peer): Promise<WriteResult> {
  const meals = table("meal_plan", sfiId);
  const recipes = table("recipes", sfiId);

  // Every op below mutates state and is editor-only. Non-members AND Viewer-role
  // members are rejected with the same gate (never gate writes on is_sfi_member —
  // Viewer-role members would slip through).
  if (!peer.is_sfi_editor) return { status: 403, body: { error: "editors only" } };

  const ok = (): WriteResult => {
    notify(sfiId);
    return { status: 200, body: { ok: true } };
  };

  // --- Send ingredients to the space's grocery list -------------------------------------
  // Insert-only per the grocery contract: never edits, deletes, or toggles rows there.
  // Idempotent per the contract's rule: skip when an unchecked row with the same item and
  // source already exists (a re-buy of a checked-off item still goes through).
  if (op === "send_to_grocery") {
    const grocery = table("grocery", sfiId);
    const days = typeof v?.day_date === "string" && DATE_RE.test(v.day_date)
      ? [v.day_date]
      : typeof v?.week_start === "string" && DATE_RE.test(v.week_start)
        ? weekDays(v.week_start)
        : null;
    if (!days) return { status: 400, body: { error: "day_date or week_start required" } };

    const { rows } = await meals.query({ where: { day_date: { in: days } } });
    const recipeCache = new Map<string, Record<string, unknown> | null>();
    let sent = 0;
    for (const m of rows) {
      const rid = m.recipe_id as string;
      if (!rid) continue; // freeform meals have nothing to expand
      if (!recipeCache.has(rid)) recipeCache.set(rid, await recipes.get(rid));
      const recipe = recipeCache.get(rid);
      if (!recipe) continue; // dangling reference — render-side it reads as broken, here it's skipped
      const lines = String(recipe.ingredients_lines ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
      for (const line of lines) {
        const dup = await grocery.query({ where: { item: line, source: rid, checked: 0 }, limit: 1 });
        if (dup.rows.length > 0) continue;
        await grocery.upsert(null, {
          item: line, quantity: "", category: "", checked: 0, source: rid, added_ms: Date.now(),
        });
        sent++;
      }
    }
    // Fire-and-forget over the bus; the push carries the count so the sender can show a
    // transient "sent n items" note. Every other viewer just refreshes — a Grocery List
    // in the space hears its own push type, since a push reaches every frame there.
    pushToInstance(sfiId, { type: "plan_changed", sent });
    if (sent) pushToInstance(sfiId, { type: "grocery_changed" });
    return { status: 200, body: { ok: true, sent } };
  }

  // --- Meals ----------------------------------------------------------------------------
  // Shared field rules for create and patch. A recipe_id is only accepted when it
  // names a row of the space's recipes; the recipe's title is snapshotted into `title` per the
  // contract (an explicit title in the same payload overrides the snapshot).
  if (op === "meal") {
    const dayDate = typeof v?.day_date === "string" && DATE_RE.test(v.day_date) ? v.day_date : "";
    if (!dayDate) return { status: 400, body: { error: "day_date required" } };
    let recipeId = "";
    let title = sanitizeText(v?.title, 200);
    if (typeof v?.recipe_id === "string" && v.recipe_id) {
      const r = await recipes.get(v.recipe_id);
      if (!r) return { status: 400, body: { error: "bad recipe" } };
      recipeId = v.recipe_id;
      if (!title) title = sanitizeText(r.title, 200);
    }
    if (!title) return { status: 400, body: { error: "title required" } };
    await meals.upsert(null, {
      day_date: dayDate, slot: cleanSlot(v?.slot ?? "dinner"), title,
      recipe_id: recipeId, servings: cleanServings(v?.servings), notes: sanitizeText(v?.notes, 2000),
    });
    return ok();
  }

  if (op.startsWith("meal/")) {
    const [id, action] = op.slice("meal/".length).split("/");
    if (!id || !(await meals.get(id))) return { status: 400, body: { error: "bad id" } };
    if (action === "delete") {
      await meals.delete(id);
      return ok();
    }
    if (action) return { status: 404, body: { error: "not found" } };

    const patch: Record<string, unknown> = {};
    if (typeof v?.day_date === "string" && DATE_RE.test(v.day_date)) patch.day_date = v.day_date;
    if (v?.slot !== undefined) patch.slot = cleanSlot(v.slot);
    if (v?.recipe_id !== undefined) {
      if (typeof v.recipe_id === "string" && v.recipe_id) {
        const r = await recipes.get(v.recipe_id);
        if (!r) return { status: 400, body: { error: "bad recipe" } };
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
    if (Object.keys(patch).length > 0) await meals.upsert(id, patch);
    return ok();
  }

  return { status: 404, body: { error: "not found" } };
}

// ----- Bus dispatcher — the frontend's write path (frame.busSend → BusUiToFrame) --------
// `peer` is the sender's platform-resolved identity, same shape as parsePeerInfo; the
// role gates live inside handleWrite. Denials are logged, not answered — a legitimate
// client never sends a write it isn't allowed to make.
onUiMessage(async (sfiId, data, peer) => {
  if (!sfiId || typeof data !== "object" || data === null) return;
  const d = data as Record<string, unknown>;
  if (typeof d.op !== "string") return;
  const r = await handleWrite(sfiId, d.op, d, peer);
  if (r.status !== 200) log(`meal_planner: bus op ${d.op} → ${r.status} (${JSON.stringify(r.body)})`);
});

// ----- Networking -----------------------------------------------------------------------
self.onNetworkRequest = async function (replyPort, reqPath, method, headers, query, body, cookies) {
  const peer = parsePeerInfo(query, cookies);
  const sfiId = peer.sfi_id;

  // Static assets — open to everyone, including anon read-only viewers.
  if (method === "GET" && !reqPath.startsWith("/api/")) {
    return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url), headers);
  }

  // Identity probe — drives which render mode the frontend shows.
  if (reqPath === "/api/whoami" && method === "GET") {
    return jsonReply(replyPort, 200, {
      is_anon:       peer.is_anon,
      is_sfi_member: peer.is_sfi_member,
      is_sfi_editor: peer.is_sfi_editor,
      is_owner:      peer.is_owner,
      user_id:       peer.user_id,
      user_name:     peer.user_name,
      space_color:   peer.space_color,
    });
  }

  // Writes — the HTTP arm of the shared write path (see handleWrite above).
  if (reqPath.startsWith("/api/") && (method === "POST" || method === "PUT")) {
    const r = await handleWrite(sfiId, reqPath.slice("/api/".length), parseJsonBody<Record<string, unknown>>(body), peer);
    return jsonReply(replyPort, r.status, r.body);
  }

  // Read — open to everyone (non-members get a read-only view of the plan).
  // `start` is any ISO date; the served week is always its Monday. No seeding — an empty
  // week is an honest empty week.
  if (reqPath === "/api/week" && method === "GET") {
    const start = mondayOf(typeof query.start === "string" ? query.start : "");
    const days = weekDays(start);
    const meals = table("meal_plan", sfiId);

    const { rows } = await meals.query({
      where: { day_date: { in: days } },
      order_by: [{ col: "day_date" }, { col: "_created_at" }],
    });

    // The recipe index doubles as the picker source and the recipe_ok resolver: a meal's
    // link is ok iff the id still resolves (dangling references render their snapshot
    // title with the link affordance dropped, per the contract).
    const photoById = new Map<string, string>();
    const recipeIndex = (await table("recipes", sfiId).query({})).rows
      .map((r) => {
        const photo = typeof r.photo === "string" && r.photo.startsWith("data:image/") ? r.photo : "";
        if (photo) photoById.set(r._row_id, photo);
        return {
          id: r._row_id, title: String(r.title ?? ""),
          servings: Number(r.servings) || 0, tags: String(r.tags ?? ""), photo,
        };
      })
      .sort((a, b) => a.title.localeCompare(b.title));
    const recipeIds = new Set(recipeIndex.map((r) => r.id));

    return jsonReply(replyPort, 200, {
      start, days,
      meals: rows.map((m) => ({
        id: m._row_id, day_date: m.day_date, slot: m.slot, title: m.title,
        recipe_id: m.recipe_id,
        recipe_ok: !!(m.recipe_id && recipeIds.has(m.recipe_id as string)),
        photo: (m.recipe_id && photoById.get(m.recipe_id as string)) || "",
        servings: m.servings, notes: m.notes,
      })),
      recipes: recipeIndex,
    });
  }

  return jsonReply(replyPort, 404, { error: "not found" });
};

log("Meal Planner frame is up and running!");
