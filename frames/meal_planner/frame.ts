// ----------------------------------------------------------------------------------------
// Meal Planner — plan the week's meals; the planning end of the household kitchen set.
//
// Design axes:
//   privacy:        privacy-public-view  — non-members get a live read-only view;
//                                           space editors get the interactive planner.
//   data_storage:   storage-graduating   — the plan starts as a LocalTable (encrypted at
//                                           rest on the host, zero ceremony); the OWNER can
//                                           graduate THIS placement's plan to a shared
//                                           SyncTable. See docs/table-graduation.md.
//   contracts:      owns `meal_plan` v1; LINKS `recipes` v1 (read-only picker + ingredient
//                                           expansion) and `grocery` v1 (insert-only "send
//                                           to grocery list"). Link units are adopt-only —
//                                           they bind another frame's shared table and own
//                                           no data. See docs/schema-contracts.md.
//   view_realtime:  view-collaborative    — every mutation calls pushToInstance(sfi_id, …)
//                                           so all viewers of the placement refresh live.
//   settings_scope: settings-per-sfi      — per-unit backend choice is keyed by sfi_id.
//
// Standalone the planner is freeform meal titles; with recipes linked each meal can point
// at a recipe row (title snapshotted per the contract); with grocery linked a week's
// ingredients can be inserted into the shared list, idempotently.
// ----------------------------------------------------------------------------------------
import {
  log, serveFileAtPath, jsonReply, parseJsonBody, parsePeerInfo, onUiMessage,
  pushToInstance, sanitizeText, loadJsonFile, saveJsonFile,
  declareTables, ensureTables, table,
} from "@frame-core";
// Namespace import so features newer than the running host degrade to no-ops
// instead of failing the module load (0.2.6 hosts lack forgetBinding).
import * as frameCore from "@frame-core";

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

// ----- LocalTables (the install-time default: encrypted, per-placement, zero ceremony) --
// Only the plan unit has a local table. The link units (recipes, grocery) own no data:
// they bind another frame's shared table or nothing at all.
declareTables([
  { key: "meals", title: "Meal Plan", description: "Planned meals for this placement's week planner.", local: true, schema: MEAL_PLAN_SCHEMA },
]);

// Shared decls are registered LAZILY, per unit — declaring a synced table up-front would
// pop the owner's binding modal on frame start (the host refires bindings for every
// missing non-local decl). Only a unit that graduated/linked (or is mid-flow) registers.
type Unit = "plan" | "recipes" | "grocery";
const UNIT_SHARED: Record<Unit, string> = {
  plan: "meals_shared", recipes: "recipes_shared", grocery: "grocery_shared",
};
const sharedDeclsRegistered = new Set<Unit>();
const SHARED_KEY: Record<Unit, string> = { plan: "meals_shared", recipes: "recipes_shared", grocery: "grocery_shared" };
function ensureSharedDecls(unit: Unit): void {
  if (sharedDeclsRegistered.has(unit)) return;
  sharedDeclsRegistered.add(unit);
  if (unit === "plan") {
    declareTables([{
      key: "meals_shared", title: "Meal Plan",
      description: "Planned meals of a shared week plan. Create a new table, or pick the one other frames should read.",
      schema: MEAL_PLAN_SCHEMA,
    }]);
  } else if (unit === "recipes") {
    declareTables([{
      key: "recipes_shared", title: "Recipes",
      description: "A shared recipes table owned by a recipe frame. Pick the table your recipes live in.",
      schema: RECIPES_SCHEMA,
    }]);
  } else {
    declareTables([{
      key: "grocery_shared", title: "Grocery List",
      description: "A shared grocery table owned by a grocery list frame. Pick the table your list lives in.",
      schema: GROCERY_SCHEMA,
    }]);
  }
}

// ----- Per-placement settings: one backend choice per unit ------------------------------
// plan:            "local" | "shared"  (full graduation: convert copies rows, adopt binds)
// recipes/grocery: "none"  | "shared"  (link units: adopt-only, nothing to convert)
type GradMode = "convert" | "adopt";
type UnitState = { backend: string; pending_graduation?: GradMode };
type SfiSettings = { plan: UnitState; recipes: UnitState; grocery: UnitState };
const allSettings: Record<string, Partial<SfiSettings>> = loadJsonFile(import.meta.url, "settings.json", {});
function getSettings(sfiId: string): SfiSettings {
  const s = allSettings[sfiId] ?? {};
  return {
    plan:    { backend: "local", ...(s.plan ?? {}) },
    recipes: { backend: "none",  ...(s.recipes ?? {}) },
    grocery: { backend: "none",  ...(s.grocery ?? {}) },
  };
}
function saveSettings(sfiId: string, s: SfiSettings): void {
  allSettings[sfiId] = s;
  saveJsonFile(import.meta.url, "settings.json", allSettings);
}

type Tbl = ReturnType<typeof table>;
type Peer = ReturnType<typeof parsePeerInfo>;

/** True when the unit's shared binding exists for this placement. */
function sharedBound(unit: Unit, sfiId: string): boolean {
  try { table(UNIT_SHARED[unit], sfiId); return true; } catch { return false; }
}

/** The plan's data table, resolved through its backend choice. Same handle API either
 * way — everything downstream is backend-agnostic. */
function mealsTable(sfiId: string, s: SfiSettings): Tbl {
  return table(s.plan.backend === "shared" ? "meals_shared" : "meals", sfiId);
}

/** A link unit's table when it is linked AND bound, else null. A linked table missing on
 * a fresh host degrades to the standalone behavior — never a blocking waiting state,
 * since the planner works without it (docs/schema-contracts.md, link units). */
function linkedTable(unit: "recipes" | "grocery", sfiId: string, s: SfiSettings): Tbl | null {
  if (s[unit].backend !== "shared" || !sharedBound(unit, sfiId)) return null;
  return table(UNIT_SHARED[unit], sfiId);
}

/** ensureTables, but QUIET and with the local table awaited.
 * Quiet: is_owner stripped, so a missing shared binding never fires the owner's binding
 * modal from a passive path (once any placement registers shared decls they exist
 * worker-globally — a plain ensureTables(owner) would pop the picker on every OTHER
 * placement). Only the explicit graduate/waiting paths call ensureTables with owner
 * privilege. Awaited: a fresh placement's local self-ensure is async, so touch the
 * missing local table with a no-op query, then re-read. */
async function readyLocalTables(peer: Peer): Promise<boolean> {
  const quiet = { ...peer, is_owner: false } as Peer;
  let r = ensureTables(quiet);
  if (!r.byKey["meals"]) {
    try { await table("meals", peer.sfi_id).query({ limit: 1 }); } catch (e) { log(`meal_planner: ensure "meals" failed: ${e}`); }
    r = ensureTables(quiet);
  }
  return !!r.byKey["meals"];
}

// ----- Graduation: flip a unit onto its freshly bound shared table ----------------------
// plan/convert first copies the local rows in, PRESERVING row ids (upsert(localRowId, …)
// creates under that id) so a rerun after a partial copy is an idempotent overwrite.
// Link units are adopt-only: nothing to copy, the data lives with the owning frame.
async function runGraduation(sfiId: string, settings: SfiSettings, unit: Unit): Promise<void> {
  const mode = settings[unit].pending_graduation!;
  let copied = "";
  if (unit === "plan" && mode === "convert") {
    const shared = table("meals_shared", sfiId);
    const { rows } = await table("meals", sfiId).query({});
    for (const r of rows) {
      await shared.upsert(r._row_id, {
        day_date: r.day_date, slot: r.slot, title: r.title,
        recipe_id: r.recipe_id, servings: r.servings, notes: r.notes,
      });
    }
    copied = ` (${rows.length} meals copied)`;
  }
  settings[unit].backend = "shared";
  delete settings[unit].pending_graduation;
  saveSettings(sfiId, settings);
  wireSharedListeners(sfiId, settings);
  notify(sfiId);
  log(`meal_planner: placement ${sfiId} unit "${unit}" moved to shared tables (${mode})${copied}`);
}

/** Finish any pending graduation whose shared binding has appeared. */
async function completePending(sfiId: string, settings: SfiSettings): Promise<void> {
  for (const unit of ["plan", "recipes", "grocery"] as Unit[]) {
    if (settings[unit].backend === "shared" || settings[unit].pending_graduation) ensureSharedDecls(unit);
    if (settings[unit].pending_graduation && sharedBound(unit, sfiId)) {
      try { await runGraduation(sfiId, settings, unit); } catch (e) { log(`meal_planner: graduation of "${unit}" failed (will retry): ${e}`); }
    }
  }
}

// Foreign writes to bound shared tables (the owning frame, another frame on the same
// table, a peer device) should refresh viewers just like our own writes do. The plan and
// recipes feed the view; grocery is insert-only from our side and never rendered here.
const wiredShared = new Set<string>();
function wireSharedListeners(sfiId: string, settings: SfiSettings): void {
  for (const unit of ["plan", "recipes"] as Unit[]) {
    const k = sfiId + ":" + unit;
    if (wiredShared.has(k) || settings[unit].backend !== "shared") continue;
    wiredShared.add(k);
    try {
      table(UNIT_SHARED[unit], sfiId).onChange(() => notify(sfiId));
    } catch {
      wiredShared.delete(k); // not bound yet — rewired after graduation completes
    }
  }
}

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
  const settings = getSettings(sfiId);

  // Re-register shared decls (decls don't survive worker restarts; bindings and settings
  // do) and finish any pending graduation whose binding has appeared.
  await completePending(sfiId, settings);

  // Graduated plan whose binding is missing (fresh worker on a new host, or the owner
  // closed the picker mid-recovery): every write waits. Link units never block — they
  // degrade to standalone instead (see linkedTable).
  if (settings.plan.backend === "shared" && !sharedBound("plan", sfiId)) {
    return { status: 503, body: { error: "table not bound" } };
  }
  wireSharedListeners(sfiId, settings);

  // Local tables resolve with zero ceremony; awaiting keeps a fresh placement's first
  // request from racing the self-ensure. Quiet — see readyLocalTables.
  if (settings.plan.backend === "local" && !(await readyLocalTables(peer))) {
    return { status: 503, body: { error: "table not ready" } };
  }
  const meals = mealsTable(sfiId, settings);

  // Every op below mutates state and is editor-only. Non-members AND Viewer-role
  // members are rejected with the same gate (never gate writes on is_sfi_member —
  // Viewer-role members would slip through).
  if (!peer.is_sfi_editor) return { status: 403, body: { error: "editors only" } };

  const ok = (): WriteResult => {
    notify(sfiId);
    return { status: 200, body: { ok: true } };
  };

  // --- Data backend (owner-only): per-unit graduation / linking -------------------------
  // plan takes both modes (convert copies, adopt binds). The link units are adopt-only:
  // there is no local twin to convert — the data lives with the owning frame.
  if (op === "data/graduate") {
    if (!peer.is_owner) return { status: 403, body: { error: "owner only" } };
    const unit = v?.unit as Unit;
    if (unit !== "plan" && unit !== "recipes" && unit !== "grocery") return { status: 400, body: { error: "bad unit" } };
    const mode: GradMode = v?.mode === "adopt" ? "adopt" : "convert";
    if (unit !== "plan" && mode !== "adopt") return { status: 400, body: { error: "link units adopt only" } };
    if (settings[unit].backend === "shared") {
      // Re-point: only "adopt" once shared. Forget the unit's binding so ensureTables
      // re-fires its picker; pending "adopt" finishes on sight.
      if (mode !== "adopt") return { status: 400, body: { error: "already shared" } };
      ensureSharedDecls(unit);
      frameCore.forgetBinding?.(SHARED_KEY[unit], sfiId);
    }
    settings[unit].pending_graduation = mode;
    saveSettings(sfiId, settings);
    ensureSharedDecls(unit);
    ensureTables(peer); // fires the owner's binding modal for the missing shared table
    notify(sfiId);
    return { status: 200, body: { waiting: true } };
  }
  if (op === "data/cancel_graduate") {
    if (!peer.is_owner) return { status: 403, body: { error: "owner only" } };
    const unit = v?.unit as Unit;
    if (unit !== "plan" && unit !== "recipes" && unit !== "grocery") return { status: 400, body: { error: "bad unit" } };
    delete settings[unit].pending_graduation;
    saveSettings(sfiId, settings);
    return ok();
  }
  if (op === "data/unlink") {
    if (!peer.is_owner) return { status: 403, body: { error: "owner only" } };
    const unit = v?.unit as Unit;
    if (unit !== "recipes" && unit !== "grocery") return { status: 400, body: { error: "link units only" } };
    settings[unit].backend = "none";
    delete settings[unit].pending_graduation;
    saveSettings(sfiId, settings);
    // Drop the platform binding too, so a later re-link re-fires the picker instead of
    // silently reusing whatever table was bound before.
    frameCore.forgetBinding?.(SHARED_KEY[unit], sfiId);
    return ok();
  }

  // --- Send ingredients to the linked grocery list --------------------------------------
  // Insert-only per the grocery contract: never edits, deletes, or toggles rows there.
  // Idempotent per the contract's rule: skip when an unchecked row with the same item and
  // source already exists (a re-buy of a checked-off item still goes through).
  if (op === "send_to_grocery") {
    const grocery = linkedTable("grocery", sfiId, settings);
    if (!grocery) return { status: 400, body: { error: "grocery not linked" } };
    const recipes = linkedTable("recipes", sfiId, settings);
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
      if (!rid || !recipes) continue; // freeform meals are skipped; no recipes link = nothing to expand
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
    // transient "sent n items" note. Every other viewer just refreshes.
    pushToInstance(sfiId, { type: "plan_changed", sent });
    return { status: 200, body: { ok: true, sent } };
  }

  // --- Meals ----------------------------------------------------------------------------
  // Shared field rules for create and patch. A recipe_id is only accepted when the
  // recipes link resolves; the recipe's title is snapshotted into `title` per the
  // contract (an explicit title in the same payload overrides the snapshot).
  if (op === "meal") {
    const dayDate = typeof v?.day_date === "string" && DATE_RE.test(v.day_date) ? v.day_date : "";
    if (!dayDate) return { status: 400, body: { error: "day_date required" } };
    const recipes = linkedTable("recipes", sfiId, settings);
    let recipeId = "";
    let title = sanitizeText(v?.title, 200);
    if (typeof v?.recipe_id === "string" && v.recipe_id && recipes) {
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
      const recipes = linkedTable("recipes", sfiId, settings);
      if (typeof v.recipe_id === "string" && v.recipe_id && recipes) {
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

  const settings = getSettings(sfiId);

  // Re-register shared decls and finish any pending graduation whose binding appeared
  // (decls don't survive worker restarts; bindings and settings do).
  await completePending(sfiId, settings);

  // Mid-graduation and the picker was dismissed (or the app restarted): the owner's next
  // look at the week brings it back. Pending is an explicit owner-initiated state, so the
  // auto-refire is wanted here, unlike the quiet passive paths. Covers link adopts too.
  const anyPendingUnbound = (["plan", "recipes", "grocery"] as Unit[])
    .some((u) => settings[u].pending_graduation && !sharedBound(u, sfiId));
  if (anyPendingUnbound && peer.is_owner && reqPath === "/api/week" && method === "GET") {
    ensureTables(peer);
  }

  // Graduated plan whose binding is missing: the week route reports the waiting state
  // (and re-fires the owner's picker); other data routes wait. Link units never block.
  if (settings.plan.backend === "shared" && !sharedBound("plan", sfiId)) {
    if (reqPath === "/api/week" && method === "GET") {
      if (peer.is_owner) ensureTables(peer);
      return jsonReply(replyPort, 200, {
        waiting_for_binding: true, is_owner: peer.is_owner,
        storage: { backend: settings.plan.backend, pending: false, can_manage: peer.is_owner },
      });
    }
    return jsonReply(replyPort, 503, { error: "table not bound" });
  }
  wireSharedListeners(sfiId, settings);

  // Local tables resolve with zero ceremony; awaiting keeps a fresh placement's first
  // request from racing the self-ensure. Quiet — see readyLocalTables.
  if (settings.plan.backend === "local" && !(await readyLocalTables(peer))) {
    return jsonReply(replyPort, 503, { error: "table not ready" });
  }

  // Read — open to everyone (non-members get a read-only view of this placement's plan).
  // `start` is any ISO date; the served week is always its Monday. No seeding — an empty
  // week is an honest empty week.
  if (reqPath === "/api/week" && method === "GET") {
    const start = mondayOf(typeof query.start === "string" ? query.start : "");
    const days = weekDays(start);
    const meals = mealsTable(sfiId, settings);
    const recipes = linkedTable("recipes", sfiId, settings);
    const grocery = linkedTable("grocery", sfiId, settings);

    const { rows } = await meals.query({
      where: { day_date: { in: days } },
      order_by: [{ col: "day_date" }, { col: "_created_at" }],
    });

    // The recipe index doubles as the picker source and the recipe_ok resolver: a meal's
    // link is ok iff recipes are linked and the id still resolves (dangling references
    // render their snapshot title with the link affordance dropped, per the contract).
    let recipeIndex: Array<{ id: string; title: string; servings: number; tags: string; photo: string }> | null = null;
    let recipeIds: Set<string> | null = null;
    const photoById = new Map<string, string>();
    if (recipes) {
      const rr = await recipes.query({});
      recipeIndex = rr.rows
        .map((r) => {
          const photo = typeof r.photo === "string" && r.photo.startsWith("data:image/") ? r.photo : "";
          if (photo) photoById.set(r._row_id, photo);
          return {
            id: r._row_id, title: String(r.title ?? ""),
            servings: Number(r.servings) || 0, tags: String(r.tags ?? ""), photo,
          };
        })
        .sort((a, b) => a.title.localeCompare(b.title));
      recipeIds = new Set(recipeIndex.map((r) => r.id));
    }

    return jsonReply(replyPort, 200, {
      start, days,
      meals: rows.map((m) => ({
        id: m._row_id, day_date: m.day_date, slot: m.slot, title: m.title,
        recipe_id: m.recipe_id,
        recipe_ok: !!(m.recipe_id && recipeIds && recipeIds.has(m.recipe_id as string)),
        photo: (m.recipe_id && photoById.get(m.recipe_id as string)) || "",
        servings: m.servings, notes: m.notes,
      })),
      storage: {
        backend: settings.plan.backend,
        pending: !!settings.plan.pending_graduation,
        can_manage: peer.is_owner,
        // bound shared table name per unit — app ≥ 0.2.7 supplies tableTitle; older hosts leave it unset
        table_titles: (() => {
          const r = ensureTables({ ...peer, is_owner: false } as Peer);
          const t = (unit: Unit) => (settings[unit].backend === "shared" ? r.byKey[SHARED_KEY[unit]]?.tableTitle : undefined) ?? null;
          return { plan: t("plan"), recipes: t("recipes"), grocery: t("grocery") };
        })(),
      },
      links: { recipes: !!recipes, grocery: !!grocery },
      link_pending: {
        recipes: !!settings.recipes.pending_graduation,
        grocery: !!settings.grocery.pending_graduation,
      },
      ...(recipeIndex ? { recipes: recipeIndex } : {}),
    });
  }

  return jsonReply(replyPort, 404, { error: "not found" });
};

log("Meal Planner frame is up and running!");
