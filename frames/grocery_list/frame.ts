// ----------------------------------------------------------------------------------------
// Grocery List — the realtime shared family shopping list.
//
// Design axes:
//   privacy:        privacy-public-view  — non-members get a live read-only view;
//                                           space editors get the interactive list.
//   data_storage:   storage-graduating   — starts as a LocalTable (encrypted at rest on
//                                           the host, zero ceremony); the OWNER can
//                                           graduate THIS placement's data to a shared
//                                           SyncTable so other frames bind the same rows.
//                                           Other placements stay local. See
//                                           docs/table-graduation.md in this repo.
//   view_realtime:  view-collaborative    — every mutation calls pushToInstance(sfi_id, …)
//                                           so all viewers refresh live; graduated
//                                           placements also refresh on foreign writes via
//                                           table onChange. Checking an item off on one
//                                           device lands on every other one instantly.
//   settings_scope: settings-per-sfi      — backend choice + bindings are keyed by sfi_id.
//
// This frame OWNS the `grocery` v1 contract (docs/schema-contracts.md). Once a placement
// is graduated, the Meal Planner links the same shared table and inserts ingredient rows
// with a `source`; this frame renders those with a small provenance hint but treats them
// as ordinary rows (full CRUD stays here, per the contract's role lines).
// ----------------------------------------------------------------------------------------
import {
  log, serveFileAtPath, jsonReply, parseJsonBody, parsePeerInfo, onUiMessage,
  pushToInstance, sanitizeText, loadJsonFile, saveJsonFile,
  declareTables, ensureTables, table,
} from "@frame-core";
// Namespace import so features newer than the running host degrade to no-ops
// instead of failing the module load (0.2.6 hosts lack forgetBinding).
import * as frameCore from "@frame-core";

// ----- Schema (the `grocery` v1 contract — declared verbatim, one source of truth) ------
const GROCERY_SCHEMA = [
  { name: "item",     col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "quantity", col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "category", col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "checked",  col_type: "integer" as const, nullable: false, default_val: "0" },
  { name: "source",   col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "added_ms", col_type: "integer" as const, nullable: false, default_val: "0" },
];

// ----- LocalTable (the install-time default: encrypted, per-placement, zero ceremony) ---
declareTables([
  { key: "grocery", title: "Grocery List", description: "Shopping items for this placement's grocery list.", local: true, schema: GROCERY_SCHEMA },
]);

// Shared decl is registered LAZILY — declaring a synced table up-front would pop the
// owner's binding modal on frame start (the host refires bindings for every missing
// non-local decl). Only a placement that graduated (or is graduating) registers it.
let sharedDeclsRegistered = false;
function ensureSharedDecls(): void {
  if (sharedDeclsRegistered) return;
  sharedDeclsRegistered = true;
  declareTables([
    {
      key: "grocery_shared", title: "Grocery List",
      description: "Items of a shared grocery list. Create a new table, or pick the one other frames should read.",
      schema: GROCERY_SCHEMA,
    },
  ]);
}

// ----- Per-placement settings: which backend this placement runs on ---------------------
// pending_graduation modes: "convert" copies this placement's local rows into the freshly
// bound shared table; "adopt" just binds an existing shared table (no copy — the list
// shows whatever it contains). Local rows are untouched either way.
type Backend = "local" | "shared";
type GradMode = "convert" | "adopt";
type SfiSettings = { backend: Backend; pending_graduation?: GradMode };
const allSettings: Record<string, SfiSettings> = loadJsonFile(import.meta.url, "settings.json", {});
function getSettings(sfiId: string): SfiSettings {
  return allSettings[sfiId] ?? { backend: "local" };
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
  return table(s.backend === "shared" ? "grocery_shared" : "grocery", sfiId);
}

/** True when the shared binding exists for this placement (post-graduation). */
function sharedBound(sfiId: string): boolean {
  try { table("grocery_shared", sfiId); return true; } catch { return false; }
}

/** ensureTables, but QUIET and with the local table awaited.
 * Quiet: is_owner stripped, so a missing shared binding never fires the owner's binding
 * modal from a passive path (once one placement graduates, the shared decl exists
 * worker-globally — a plain ensureTables(owner) would pop the picker on every OTHER
 * placement). Only the explicit graduate/waiting paths call ensureTables with owner
 * privilege. Awaited: a fresh placement's local self-ensure is async, so touch the
 * missing local table with a no-op query, then re-read. */
async function readyLocalTables(peer: Peer): Promise<boolean> {
  const quiet = { ...peer, is_owner: false } as Peer;
  let r = ensureTables(quiet);
  if (!r.byKey["grocery"]) {
    try { await table("grocery", peer.sfi_id).query({ limit: 1 }); } catch (e) { log(`grocery_list: ensure "grocery" failed: ${e}`); }
    r = ensureTables(quiet);
  }
  return !!r.byKey["grocery"];
}

// ----- Graduation: flip this placement to the freshly bound shared table ----------------
// "convert" first copies the local rows in. Row ids are PRESERVED (upsert(localRowId, …)
// creates with that id), which keeps external references to rows valid with no remapping
// and makes a rerun after a partial copy an idempotent overwrite. pending_graduation is
// only cleared after a full pass.
async function runGraduation(sfiId: string, settings: SfiSettings): Promise<void> {
  const mode = settings.pending_graduation!;
  let copied = "";
  if (mode === "convert") {
    const shared = table("grocery_shared", sfiId);
    const { rows } = await table("grocery", sfiId).query({});
    for (const r of rows) {
      await shared.upsert(r._row_id, {
        item: r.item, quantity: r.quantity, category: r.category,
        checked: r.checked, source: r.source, added_ms: r.added_ms,
      });
    }
    copied = ` (${rows.length} items copied)`;
  }

  settings.backend = "shared";
  delete settings.pending_graduation;
  saveSettings(sfiId, settings);
  wireSharedListeners(sfiId);
  notify(sfiId);
  log(`grocery_list: placement ${sfiId} moved to shared tables (${mode})${copied}`);
}

// Foreign writes to a graduated placement's table (the Meal Planner sending a week's
// ingredients, another frame bound to the same table, a peer device) should refresh
// viewers just like our own writes do. Our own writes also fire this — the extra refresh
// is cheap and keeps the wiring simple.
const wiredShared = new Set<string>();
function wireSharedListeners(sfiId: string): void {
  if (wiredShared.has(sfiId)) return;
  wiredShared.add(sfiId);
  try {
    table("grocery_shared", sfiId).onChange(() => notify(sfiId));
  } catch {
    wiredShared.delete(sfiId); // not bound yet — rewired after graduation completes
  }
}

// ----- Queries --------------------------------------------------------------------------
async function listRows(t: Tbl) {
  const { rows } = await t.query({
    order_by: [{ col: "category" }, { col: "added_ms" }],
  });
  return rows.map((r) => ({
    id: r._row_id, item: r.item, quantity: r.quantity, category: r.category,
    checked: r.checked, source: r.source, added_ms: r.added_ms,
  }));
}

function notify(sfiId: string) {
  pushToInstance(sfiId, { type: "grocery_changed" });
}

// ----- Writes ---------------------------------------------------------------------------
// One shared mutation path for BOTH transports: the bus dispatcher below (frame.busSend →
// onUiMessage, the primary write path) and the HTTP POST arm in onNetworkRequest (kept for
// older viewers whose framelib has no busSend). `op` is the API path with "api/" stripped
// (e.g. "item/<id>/delete"); `v` is the parsed payload. Role gates live here so the two
// entry points can never drift.
type WriteResult = { status: number; body: unknown };

async function handleWrite(sfiId: string, op: string, v: Record<string, unknown> | null, peer: Peer): Promise<WriteResult> {
  const settings = getSettings(sfiId);

  // Re-register the shared decl for placements that graduated or are mid-graduation
  // (decls don't survive worker restarts; bindings do).
  if (settings.backend === "shared" || settings.pending_graduation) ensureSharedDecls();

  // Finish a pending graduation the moment the shared binding exists.
  if (settings.pending_graduation && sharedBound(sfiId)) {
    try { await runGraduation(sfiId, settings); } catch (e) { log(`grocery_list: graduation failed (will retry): ${e}`); }
  }

  // Graduated placement whose binding is missing (fresh worker on a new host, or the
  // owner closed the picker mid-graduation recovery): every write waits.
  if (settings.backend === "shared" && !sharedBound(sfiId)) {
    return { status: 503, body: { error: "table not bound" } };
  }
  if (settings.backend === "shared") wireSharedListeners(sfiId);

  // Local tables resolve with zero ceremony; awaiting keeps a fresh placement's first
  // request from racing the self-ensure. Quiet — see readyLocalTables.
  if (settings.backend === "local" && !(await readyLocalTables(peer))) {
    return { status: 503, body: { error: "table not ready" } };
  }
  const t = dataTable(sfiId, settings);

  // Every op below mutates state and is editor-only. Non-members AND Viewer-role
  // members are rejected with the same gate (never gate writes on is_sfi_member —
  // Viewer-role members would slip through).
  if (!peer.is_sfi_editor) return { status: 403, body: { error: "editors only" } };

  const ok = async (): Promise<WriteResult> => {
    notify(sfiId);
    return { status: 200, body: { items: await listRows(t) } };
  };

  // --- Data backend (owner-only): per-placement graduation local → shared -------------
  if (op === "data/graduate") {
    if (!peer.is_owner) return { status: 403, body: { error: "owner only" } };
    if (settings.backend === "shared") {
      // Re-point: only "adopt" makes sense once shared. Forget the current binding(s)
      // so ensureTables re-fires the picker(s); pending "adopt" finishes on sight.
      if (v?.mode !== "adopt") return { status: 400, body: { error: "already shared" } };
      ensureSharedDecls();
      frameCore.forgetBinding?.("grocery_shared", sfiId);
      wiredShared.delete(sfiId);
    }
    settings.pending_graduation = v?.mode === "adopt" ? "adopt" : "convert";
    saveSettings(sfiId, settings);
    ensureSharedDecls();
    ensureTables(peer); // fires the owner's binding modal (the grocery table)
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

  // --- Items ----------------------------------------------------------------------------
  if (op === "item") {
    const item = sanitizeText(v?.item, 200);
    if (!item) return { status: 400, body: { error: "item required" } };
    await t.upsert(null, {
      item,
      quantity: sanitizeText(v?.quantity, 40),
      category: sanitizeText(v?.category, 40).toLowerCase(),
      checked: 0, source: "", added_ms: Date.now(),
    });
    return ok();
  }

  if (op.startsWith("item/")) {
    const [id, action] = op.slice("item/".length).split("/");
    if (!id || !(await t.get(id))) return { status: 400, body: { error: "bad id" } };
    if (action === "delete") {
      await t.delete(id);
      return ok();
    }
    if (action) return { status: 404, body: { error: "not found" } };
    if (v?.item !== undefined) {
      const item = sanitizeText(v.item, 200);
      if (item) await t.upsert(id, { item });
    }
    if (v?.quantity !== undefined) {
      await t.upsert(id, { quantity: sanitizeText(v.quantity, 40) });
    }
    if (v?.category !== undefined) {
      await t.upsert(id, { category: sanitizeText(v.category, 40).toLowerCase() });
    }
    if (v?.checked !== undefined) {
      await t.upsert(id, { checked: Number(v.checked) ? 1 : 0 });
    }
    return ok();
  }

  // The "clear bought" sweep — delete every checked row in one pass.
  if (op === "clear_checked") {
    await t.deleteWhere({ checked: 1 });
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
  if (r.status !== 200) log(`grocery_list: bus op ${d.op} → ${r.status} (${JSON.stringify(r.body)})`);
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

  // Re-register the shared decl for placements that graduated or are mid-graduation
  // (decls don't survive worker restarts; bindings do).
  if (settings.backend === "shared" || settings.pending_graduation) ensureSharedDecls();

  // Finish a pending graduation the moment the shared binding exists.
  if (settings.pending_graduation && sharedBound(sfiId)) {
    try { await runGraduation(sfiId, settings); } catch (e) { log(`grocery_list: graduation failed (will retry): ${e}`); }
  }
  // Mid-graduation and the picker was dismissed (or the app restarted): the owner's
  // next look at the list brings it back. Pending is an explicit owner-initiated
  // state, so the auto-refire is wanted here, unlike the quiet passive paths.
  if (settings.pending_graduation && peer.is_owner && !sharedBound(sfiId)
      && reqPath === "/api/list" && method === "GET") {
    ensureTables(peer);
  }

  // Graduated placement whose binding is missing (fresh worker on a new host, or the
  // owner closed the picker mid-graduation recovery): every data route waits; the list
  // route re-fires the owner's binding modal so they can finish.
  if (settings.backend === "shared" && !sharedBound(sfiId)) {
    if (reqPath === "/api/list" && method === "GET") {
      if (peer.is_owner) ensureTables(peer);
      return jsonReply(replyPort, 200, {
        waiting_for_binding: true, is_owner: peer.is_owner,
        storage: { backend: settings.backend, pending: false, can_manage: peer.is_owner },
      });
    }
    return jsonReply(replyPort, 503, { error: "table not bound" });
  }
  if (settings.backend === "shared") wireSharedListeners(sfiId);

  // Local tables resolve with zero ceremony; awaiting keeps a fresh placement's first
  // request from racing the self-ensure. Quiet — see readyLocalTables.
  if (settings.backend === "local" && !(await readyLocalTables(peer))) {
    return jsonReply(replyPort, 503, { error: "table not ready" });
  }

  // Read — open to everyone (non-members get a read-only view of this placement's list).
  // No seeding: an empty grocery list is an honest empty list.
  if (reqPath === "/api/list" && method === "GET") {
    const r = ensureTables({ ...peer, is_owner: false } as Peer);
    return jsonReply(replyPort, 200, {
      items: await listRows(dataTable(sfiId, settings)),
      storage: {
        backend: settings.backend,
        pending: !!settings.pending_graduation,
        can_manage: peer.is_owner,
        // bound shared table name(s) — app ≥ 0.2.7 supplies tableTitle; older hosts leave it unset
        table_titles: settings.backend === "shared" ? [r.byKey["grocery_shared"]?.tableTitle].filter((t): t is string => !!t) : [],
      },
    });
  }

  return jsonReply(replyPort, 404, { error: "not found" });
};

log("Grocery List frame is up and running!");
