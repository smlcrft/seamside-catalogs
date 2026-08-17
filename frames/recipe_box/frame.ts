// ----------------------------------------------------------------------------------------
// Recipe Box — the family recipe collection: store recipes, read them beautifully.
//
// Design axes:
//   privacy:        privacy-public-view  — non-members get a live read-only view;
//                                           space editors manage the collection.
//   data_storage:   storage-graduating   — starts as LocalTables (encrypted at rest on
//                                           the host, zero ceremony); the OWNER can
//                                           graduate THIS placement's recipes to a shared
//                                           SyncTable so other frames bind the same rows
//                                           (the Meal Planner's recipe picker). Other
//                                           placements stay local. This is the
//                                           per-placement graduation pattern — see
//                                           docs/table-graduation.md in this repo.
//   view_realtime:  view-collaborative    — every mutation calls pushToInstance(sfi_id, …)
//                                           so all viewers of the placement refresh live;
//                                           graduated placements also refresh on foreign
//                                           writes via table onChange.
//   settings_scope: settings-per-sfi      — backend choice + bindings are keyed by sfi_id.
//
// Recipe Box OWNS the `recipes` v1 contract (docs/schema-contracts.md): the schema below
// is the contract constant, declared verbatim. Linked frames read these rows; this frame
// has full CRUD.
// ----------------------------------------------------------------------------------------
import {
  log, serveFileAtPath, jsonReply, parseJsonBody, parsePeerInfo, onUiMessage,
  pushToInstance, sanitizeText, loadJsonFile, saveJsonFile,
  declareTables, ensureTables, table,
} from "@frame-core";
// Namespace import so features newer than the running host degrade to no-ops
// instead of failing the module load (0.2.6 hosts lack forgetBinding).
import * as frameCore from "@frame-core";

// ----- Schema (contract `recipes` v1 — one source of truth for local AND shared) --------
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

// ----- LocalTables (the install-time default: encrypted, per-placement, zero ceremony) --
declareTables([
  { key: "recipes", title: "Recipes", description: "Recipes for this placement's recipe box.", local: true, schema: RECIPES_SCHEMA },
]);

// Shared decls are registered LAZILY — declaring a synced table up-front would pop the
// owner's binding modal on frame start (the host refires bindings for every missing
// non-local decl). Only a placement that graduated (or is graduating) registers them.
let sharedDeclsRegistered = false;
function ensureSharedDecls(): void {
  if (sharedDeclsRegistered) return;
  sharedDeclsRegistered = true;
  declareTables([
    {
      key: "recipes_shared", title: "Recipes",
      description: "Recipes of a shared recipe box. Create a new table, or pick the one other frames should read.",
      schema: RECIPES_SCHEMA,
    },
  ]);
}

// ----- Per-placement settings: which backend this placement runs on ---------------------
// pending_graduation modes: "convert" copies this placement's local rows into the freshly
// bound shared table; "adopt" just binds an existing shared table (no copy — the box
// shows whatever it contains). Local rows are untouched either way.
type Backend = "local" | "shared";
type GradMode = "convert" | "adopt";
type SfiSettings = { backend: Backend; pending_graduation?: GradMode };
const allSettings: Record<string, SfiSettings> = loadJsonFile(import.meta.url, "settings.json", {});
function getSettings(sfiId: string): SfiSettings {
  return { backend: "local", ...(allSettings[sfiId] ?? {}) as Partial<SfiSettings> };
}
function saveSettings(sfiId: string, s: SfiSettings): void {
  allSettings[sfiId] = s;
  saveJsonFile(import.meta.url, "settings.json", allSettings);
}

type Tbl = ReturnType<typeof table>;
type Peer = ReturnType<typeof parsePeerInfo>;

/** The placement's data table, resolved through its backend choice. Same handle API
 * either way — everything below this line is backend-agnostic. */
function dataTable(sfiId: string, s: SfiSettings): Tbl {
  return table(s.backend === "shared" ? "recipes_shared" : "recipes", sfiId);
}

/** True when the shared binding exists for this placement (post-graduation). */
function sharedBound(sfiId: string): boolean {
  try { table("recipes_shared", sfiId); return true; } catch { return false; }
}

/** ensureTables, but QUIET and with the local table awaited.
 * Quiet: is_owner stripped, so a missing shared binding never fires the owner's binding
 * modal from a passive path (once one placement graduates, the shared decls exist
 * worker-globally — a plain ensureTables(owner) would pop the picker on every OTHER
 * placement). Only the explicit graduate/waiting paths call ensureTables with owner
 * privilege. Awaited: a fresh placement's local self-ensure is async, so touch a missing
 * local table with a no-op query, then re-read. */
async function readyLocalTables(peer: Peer): Promise<boolean> {
  const quiet = { ...peer, is_owner: false } as Peer;
  let r = ensureTables(quiet);
  if (!r.byKey["recipes"]) {
    try { await table("recipes", peer.sfi_id).query({ limit: 1 }); } catch (e) { log(`recipe_box: ensure "recipes" failed: ${e}`); }
    r = ensureTables(quiet);
  }
  return !!r.byKey["recipes"];
}

// ----- Graduation: flip this placement to the freshly bound shared table ----------------
// "convert" first copies the local rows in. Row ids are PRESERVED (upsert(localRowId, …)
// creates with that id), which keeps references from linked frames (meal_plan.recipe_id)
// stable and makes a rerun after a partial copy an idempotent overwrite.
// pending_graduation is only cleared after a full pass.
async function runGraduation(sfiId: string, settings: SfiSettings): Promise<void> {
  const mode = settings.pending_graduation!;
  let copied = "";
  if (mode === "convert") {
    const shared = table("recipes_shared", sfiId);
    const { rows } = await table("recipes", sfiId).query({});
    for (const r of rows) {
      await shared.upsert(r._row_id, {
        title: r.title, ingredients_lines: r.ingredients_lines, steps_lines: r.steps_lines,
        servings: r.servings, tags: r.tags, notes: r.notes, created_ms: r.created_ms,
        photo: r.photo ?? "",
      });
    }
    copied = ` (${rows.length} recipes copied)`;
  }

  settings.backend = "shared";
  delete settings.pending_graduation;
  saveSettings(sfiId, settings);
  wireSharedListeners(sfiId);
  pushToInstance(sfiId, { type: "recipes_changed" });
  log(`recipe_box: placement ${sfiId} moved to shared tables (${mode})${copied}`);
}

// Foreign writes to a graduated placement's table (another frame bound to the same
// table, a peer device) should refresh viewers just like our own writes do. Our own
// writes also fire this — the extra refresh is cheap and keeps the wiring simple.
const wiredShared = new Set<string>();
function wireSharedListeners(sfiId: string): void {
  if (wiredShared.has(sfiId)) return;
  wiredShared.add(sfiId);
  try {
    table("recipes_shared", sfiId).onChange(() => notify(sfiId));
  } catch {
    wiredShared.delete(sfiId); // not bound yet — rewired after graduation completes
  }
}

// ----- Field normalization --------------------------------------------------------------
/** Comma-separated lowercase tag list (contract format), each tag sanitized. */
function normalizeTags(v: unknown): string {
  if (typeof v !== "string") return "";
  const seen = new Set<string>();
  for (const part of v.split(",")) {
    const t = sanitizeText(part, 32).trim().toLowerCase();
    if (t) seen.add(t);
  }
  return [...seen].join(",");
}

/** Servings: a non-negative integer; anything else reads as 0 (= unspecified). */
function normalizeServings(v: unknown): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/** Photo per the contract: a small image data URI or empty. The frontend downscales
 * before sending; this is the backstop (type + size), never sanitizeText — a base64
 * payload is not prose. */
function normalizePhoto(v: unknown): string {
  if (typeof v !== "string" || v === "") return "";
  if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(v)) return "";
  return v.length <= 200_000 ? v : "";
}

// ----- Queries --------------------------------------------------------------------------
async function recipesData(recipes: Tbl) {
  const { rows } = await recipes.query({});
  return rows
    .map((r) => ({
      id: r._row_id, title: r.title, ingredients_lines: r.ingredients_lines,
      steps_lines: r.steps_lines, servings: r.servings, tags: r.tags,
      notes: r.notes, created_ms: r.created_ms, photo: r.photo ?? "",
    }))
    .sort((a, b) => String(a.title).localeCompare(String(b.title), undefined, { sensitivity: "base" }));
}

function notify(sfiId: string) {
  pushToInstance(sfiId, { type: "recipes_changed" });
}

// ----- Writes ---------------------------------------------------------------------------
// One shared mutation path for BOTH transports: the bus dispatcher below (frame.busSend →
// onUiMessage, the primary write path) and the HTTP POST arm in onNetworkRequest (kept for
// older viewers whose framelib has no busSend). `op` is the API path with "api/" stripped
// (e.g. "recipe/<id>/delete"); `v` is the parsed payload. Role gates live here so the two
// entry points can never drift.
type WriteResult = { status: number; body: unknown };

async function handleWrite(sfiId: string, op: string, v: Record<string, unknown> | null, peer: Peer): Promise<WriteResult> {
  const settings = getSettings(sfiId);

  // Re-register the shared decls for placements that graduated or are mid-graduation
  // (decls don't survive worker restarts; bindings do).
  if (settings.backend === "shared" || settings.pending_graduation) ensureSharedDecls();

  // Finish a pending graduation the moment the shared binding exists.
  if (settings.pending_graduation && sharedBound(sfiId)) {
    try { await runGraduation(sfiId, settings); } catch (e) { log(`recipe_box: graduation failed (will retry): ${e}`); }
  }

  // Graduated placement whose binding is missing (fresh worker on a new host, or the
  // owner closed the picker mid-graduation recovery): every write waits.
  if (settings.backend === "shared" && !sharedBound(sfiId)) {
    return { status: 503, body: { error: "table not bound" } };
  }
  if (settings.backend === "shared") wireSharedListeners(sfiId);

  // The local table resolves with zero ceremony; awaiting keeps a fresh placement's first
  // request from racing the self-ensure. Quiet — see readyLocalTables.
  if (settings.backend === "local" && !(await readyLocalTables(peer))) {
    return { status: 503, body: { error: "table not ready" } };
  }
  const recipes = dataTable(sfiId, settings);

  // Every op below mutates state and is editor-only. Non-members AND Viewer-role
  // members are rejected with the same gate (never gate writes on is_sfi_member —
  // Viewer-role members would slip through).
  if (!peer.is_sfi_editor) return { status: 403, body: { error: "editors only" } };

  const ok = async (): Promise<WriteResult> => {
    notify(sfiId);
    return { status: 200, body: { recipes: await recipesData(recipes) } };
  };

  // --- Data backend (owner-only): per-placement graduation local → shared -------------
  if (op === "data/graduate") {
    if (!peer.is_owner) return { status: 403, body: { error: "owner only" } };
    if (settings.backend === "shared") {
      // Re-point: only "adopt" makes sense once shared. Forget the current binding(s)
      // so ensureTables re-fires the picker(s); pending "adopt" finishes on sight.
      if (v?.mode !== "adopt") return { status: 400, body: { error: "already shared" } };
      ensureSharedDecls();
      frameCore.forgetBinding?.("recipes_shared", sfiId);
      wiredShared.delete(sfiId);
    }
    settings.pending_graduation = v?.mode === "adopt" ? "adopt" : "convert";
    saveSettings(sfiId, settings);
    ensureSharedDecls();
    ensureTables(peer); // fires the owner's binding modal (the recipes table)
    notify(sfiId);
    return { status: 200, body: { waiting: true } };
  }
  if (op === "data/cancel_graduate") {
    if (!peer.is_owner) return { status: 403, body: { error: "owner only" } };
    delete settings.pending_graduation;
    saveSettings(sfiId, settings);
    notify(sfiId);
    return { status: 200, body: { ok: true } };
  }

  // --- Recipes --------------------------------------------------------------------------
  if (op === "recipe") {
    const title = sanitizeText(v?.title, 200);
    if (!title) return { status: 400, body: { error: "title required" } };
    await recipes.upsert(null, {
      title,
      ingredients_lines: sanitizeText(v?.ingredients_lines, 8000),
      steps_lines: sanitizeText(v?.steps_lines, 8000),
      servings: normalizeServings(v?.servings),
      tags: normalizeTags(v?.tags),
      notes: sanitizeText(v?.notes, 4000),
      created_ms: Date.now(),
      photo: normalizePhoto(v?.photo),
    });
    return ok();
  }

  if (op.startsWith("recipe/")) {
    const [id, action] = op.slice("recipe/".length).split("/");
    if (!id || !(await recipes.get(id))) return { status: 400, body: { error: "bad id" } };

    if (action === "delete") {
      await recipes.delete(id);
      return ok();
    }
    if (action) return { status: 404, body: { error: "not found" } };

    const patch: Record<string, unknown> = {};
    if (v?.title !== undefined) {
      const title = sanitizeText(v.title, 200);
      if (title) patch.title = title;
    }
    if (v?.ingredients_lines !== undefined) patch.ingredients_lines = sanitizeText(v.ingredients_lines, 8000);
    if (v?.steps_lines !== undefined) patch.steps_lines = sanitizeText(v.steps_lines, 8000);
    if (v?.servings !== undefined) patch.servings = normalizeServings(v.servings);
    if (v?.tags !== undefined) patch.tags = normalizeTags(v.tags);
    if (v?.notes !== undefined) patch.notes = sanitizeText(v.notes, 4000);
    if (v?.photo !== undefined) patch.photo = normalizePhoto(v.photo);
    if (Object.keys(patch).length) await recipes.upsert(id, patch);
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
  if (r.status !== 200) log(`recipe_box: bus op ${d.op} → ${r.status} (${JSON.stringify(r.body)})`);
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

  // Re-register the shared decls for placements that graduated or are mid-graduation
  // (decls don't survive worker restarts; bindings do).
  if (settings.backend === "shared" || settings.pending_graduation) ensureSharedDecls();

  // Finish a pending graduation the moment the shared binding exists.
  if (settings.pending_graduation && sharedBound(sfiId)) {
    try { await runGraduation(sfiId, settings); } catch (e) { log(`recipe_box: graduation failed (will retry): ${e}`); }
  }
  // Mid-graduation and the picker was dismissed (or the app restarted): the owner's
  // next look at the box brings it back. Pending is an explicit owner-initiated
  // state, so the auto-refire is wanted here, unlike the quiet passive paths.
  if (settings.pending_graduation && peer.is_owner && !sharedBound(sfiId)
      && reqPath === "/api/recipes" && method === "GET") {
    ensureTables(peer);
  }

  // Graduated placement whose binding is missing (fresh worker on a new host, or the
  // owner closed the picker mid-graduation recovery): every data route waits; the main
  // route re-fires the owner's binding modal so they can finish.
  if (settings.backend === "shared" && !sharedBound(sfiId)) {
    if (reqPath === "/api/recipes" && method === "GET") {
      if (peer.is_owner) ensureTables(peer);
      return jsonReply(replyPort, 200, {
        waiting_for_binding: true, is_owner: peer.is_owner,
        storage: { backend: settings.backend, pending: false, can_manage: peer.is_owner },
      });
    }
    return jsonReply(replyPort, 503, { error: "table not bound" });
  }
  if (settings.backend === "shared") wireSharedListeners(sfiId);

  // The local table resolves with zero ceremony; awaiting keeps a fresh placement's first
  // request from racing the self-ensure. Quiet — see readyLocalTables.
  if (settings.backend === "local" && !(await readyLocalTables(peer))) {
    return jsonReply(replyPort, 503, { error: "table not ready" });
  }
  const recipes = dataTable(sfiId, settings);

  // Read — open to everyone (non-members get a read-only view of this placement's
  // collection). Never seeded: an empty box renders its own empty state.
  if (reqPath === "/api/recipes" && method === "GET") {
    const r = ensureTables({ ...peer, is_owner: false } as Peer);
    return jsonReply(replyPort, 200, {
      recipes: await recipesData(recipes),
      storage: {
        backend: settings.backend,
        pending: !!settings.pending_graduation,
        can_manage: peer.is_owner,
        // bound shared table name(s) — app ≥ 0.2.7 supplies tableTitle; older hosts leave it unset
        table_titles: settings.backend === "shared" ? [r.byKey["recipes_shared"]?.tableTitle].filter((t): t is string => !!t) : [],
      },
    });
  }

  return jsonReply(replyPort, 404, { error: "not found" });
};

log("Recipe Box frame is up and running!");
