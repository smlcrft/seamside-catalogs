// ----------------------------------------------------------------------------------------
// Kanban Board — a drag-and-drop task board with channel-colored columns.
//
// Design axes:
//   privacy:        privacy-public-view  — non-members get a live read-only view;
//                                           space editors get the interactive board.
//   data_storage:   storage-graduating   — starts as LocalTables (encrypted at rest on
//                                           the host, zero ceremony); the OWNER can
//                                           graduate THIS placement's data to shared
//                                           SyncTables so other frames bind the same
//                                           rows. Other placements stay local. This is
//                                           the per-placement graduation pattern — see
//                                           docs/table-graduation.md in this repo.
//   view_realtime:  view-collaborative    — every mutation calls pushToInstance(sfi_id, …)
//                                           so all viewers of the placement refresh live;
//                                           graduated placements also refresh on foreign
//                                           writes via table onChange.
//   settings_scope: settings-per-sfi      — backend choice + bindings are keyed by sfi_id.
//
// Columns carry a channel (c1–c12) as their identity color; cards carry a title,
// an optional description, and an optional short label.
// ----------------------------------------------------------------------------------------
import {
  log, serveFileAtPath, jsonReply, parseJsonBody, parsePeerInfo, onUiMessage,
  pushToInstance, sanitizeText, loadJsonFile, saveJsonFile,
  declareTables, ensureTables, table,
} from "@frame-core";

// ----- Schemas (one source of truth for the local AND shared declarations) --------------
const COLUMNS_SCHEMA = [
  { name: "title",      col_type: "text" as const,    nullable: false, default_val: "" },
  { name: "channel",    col_type: "text" as const,    nullable: false, default_val: "c1" },
  { name: "sort_order", col_type: "integer" as const, nullable: false, default_val: "0" },
];
const CARDS_SCHEMA = [
  { name: "column_id",   col_type: "text" as const,    nullable: false, default_val: "" },
  { name: "title",       col_type: "text" as const,    nullable: false, default_val: "" },
  { name: "description", col_type: "text" as const,    nullable: false, default_val: "" },
  { name: "label",       col_type: "text" as const,    nullable: false, default_val: "" },
  { name: "sort_order",  col_type: "integer" as const, nullable: false, default_val: "0" },
  { name: "created_ms",  col_type: "integer" as const, nullable: false, default_val: "0" },
];

// ----- LocalTables (the install-time default: encrypted, per-placement, zero ceremony) --
declareTables([
  { key: "columns", title: "Kanban Columns", description: "Columns for this placement's kanban board.", local: true, schema: COLUMNS_SCHEMA },
  { key: "cards",   title: "Kanban Cards",   description: "Cards for this placement's kanban board.",   local: true, schema: CARDS_SCHEMA },
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
      key: "columns_shared", title: "Kanban Columns",
      description: "Columns of a shared kanban board. Create a new table, or pick the one other frames should read.",
      schema: COLUMNS_SCHEMA,
    },
    {
      key: "cards_shared", title: "Kanban Cards",
      description: "Cards of a shared kanban board. Create a new table, or pick the one other frames should read.",
      schema: CARDS_SCHEMA,
    },
  ]);
}

// ----- Per-placement settings: which backend this placement runs on ---------------------
// pending_graduation modes: "convert" copies this placement's local rows into the freshly
// bound shared tables; "adopt" just binds existing shared tables (no copy — the board
// shows whatever they contain). Local rows are untouched either way.
type Backend = "local" | "shared";
type GradMode = "convert" | "adopt";
type SfiSettings = { backend: Backend; pending_graduation?: GradMode };
const allSettings: Record<string, SfiSettings> = loadJsonFile(import.meta.url, "settings.json", {});
function getSettings(sfiId: string): SfiSettings {
  return { backend: "local", ...(allSettings[sfiId] ?? {}) };
}
function saveSettings(sfiId: string, s: SfiSettings): void {
  allSettings[sfiId] = s;
  saveJsonFile(import.meta.url, "settings.json", allSettings);
}

type Tbl = ReturnType<typeof table>;
type Peer = ReturnType<typeof parsePeerInfo>;

/** The placement's data tables, resolved through its backend choice. Same handle API
 * either way — everything below this line is backend-agnostic. */
function dataTables(sfiId: string, s: SfiSettings): { columns: Tbl; cards: Tbl } {
  const shared = s.backend === "shared";
  return {
    columns: table(shared ? "columns_shared" : "columns", sfiId),
    cards: table(shared ? "cards_shared" : "cards", sfiId),
  };
}

/** True when BOTH shared bindings exist for this placement (post-graduation). */
function sharedBound(sfiId: string): boolean {
  try { table("columns_shared", sfiId); table("cards_shared", sfiId); return true; } catch { return false; }
}

/** ensureTables, but QUIET and with local tables awaited.
 * Quiet: is_owner stripped, so a missing shared binding never fires the owner's binding
 * modal from a passive path (once one placement graduates, the shared decls exist
 * worker-globally — a plain ensureTables(owner) would pop the picker on every OTHER
 * placement). Only the explicit graduate/waiting paths call ensureTables with owner
 * privilege. Awaited: a fresh placement's local self-ensure is async, so touch missing
 * local tables with a no-op query, then re-read. */
async function readyLocalTables(peer: Peer): Promise<boolean> {
  const quiet = { ...peer, is_owner: false } as Peer;
  let r = ensureTables(quiet);
  const missing = ["columns", "cards"].filter((k) => !r.byKey[k]);
  if (missing.length) {
    for (const k of missing) {
      try { await table(k, peer.sfi_id).query({ limit: 1 }); } catch (e) { log(`kanban: ensure "${k}" failed: ${e}`); }
    }
    r = ensureTables(quiet);
  }
  return !!(r.byKey["columns"] && r.byKey["cards"]);
}

// ----- Graduation: flip this placement to the freshly bound shared tables ---------------
// "convert" first copies the local rows in. Row ids are PRESERVED (upsert(localRowId, …)
// creates with that id), which keeps the cards.column_id references valid with no
// remapping and makes a rerun after a partial copy an idempotent overwrite.
// pending_graduation is only cleared after a full pass.
async function runGraduation(sfiId: string, settings: SfiSettings): Promise<void> {
  const mode = settings.pending_graduation!;
  let copied = "";
  if (mode === "convert") {
    const sharedColumns = table("columns_shared", sfiId);
    const sharedCards = table("cards_shared", sfiId);
    const { rows: cols } = await table("columns", sfiId).query({});
    for (const r of cols) {
      await sharedColumns.upsert(r._row_id, { title: r.title, channel: r.channel, sort_order: r.sort_order });
    }
    const { rows: cards } = await table("cards", sfiId).query({});
    for (const r of cards) {
      await sharedCards.upsert(r._row_id, {
        column_id: r.column_id, title: r.title, description: r.description,
        label: r.label, sort_order: r.sort_order, created_ms: r.created_ms,
      });
    }
    copied = ` (${cols.length} columns, ${cards.length} cards copied)`;
  }

  settings.backend = "shared";
  delete settings.pending_graduation;
  saveSettings(sfiId, settings);
  wireSharedListeners(sfiId);
  pushToInstance(sfiId, { type: "kanban_changed" });
  log(`kanban: placement ${sfiId} moved to shared tables (${mode})${copied}`);
}

// Foreign writes to a graduated placement's tables (another frame bound to the same
// table, a peer device) should refresh viewers just like our own writes do. Our own
// writes also fire this — the extra refresh is cheap and keeps the wiring simple.
const wiredShared = new Set<string>();
function wireSharedListeners(sfiId: string): void {
  if (wiredShared.has(sfiId)) return;
  wiredShared.add(sfiId);
  try {
    table("columns_shared", sfiId).onChange(() => notify(sfiId));
    table("cards_shared", sfiId).onChange(() => notify(sfiId));
  } catch {
    wiredShared.delete(sfiId); // not bound yet — rewired after graduation completes
  }
}

const CHANNEL_RE = /^c([1-9]|1[0-2])$/;
const SEED_COLUMNS: Array<[string, string]> = [
  ["To do", "c2"], ["In progress", "c4"], ["Done", "c5"],
];

// ----- Queries --------------------------------------------------------------------------
async function boardData(columns: Tbl, cards: Tbl) {
  const { rows: cols } = await columns.query({
    order_by: [{ col: "sort_order" }, { col: "_created_at" }],
  });
  const { rows: allCards } = await cards.query({
    order_by: [{ col: "sort_order" }, { col: "created_ms" }],
  });
  const byCol = new Map<string, Array<Record<string, unknown>>>();
  for (const c of allCards) {
    let bucket = byCol.get(c.column_id as string);
    if (!bucket) { bucket = []; byCol.set(c.column_id as string, bucket); }
    bucket.push({
      id: c._row_id, title: c.title, description: c.description,
      label: c.label, sort_order: c.sort_order,
    });
  }
  return cols.map((col) => ({
    id: col._row_id, title: col.title, channel: col.channel,
    sort_order: col.sort_order, cards: byCol.get(col._row_id) ?? [],
  }));
}

async function nextSortOrder(t: Tbl): Promise<number> {
  return Number(await t.max("sort_order") ?? -1) + 1;
}

function notify(sfiId: string) {
  pushToInstance(sfiId, { type: "kanban_changed" });
}

// ----- Writes ---------------------------------------------------------------------------
// One shared mutation path for BOTH transports: the bus dispatcher below (frame.busSend →
// onUiMessage, the primary write path) and the HTTP POST arm in onNetworkRequest (kept for
// older viewers whose framelib has no busSend). `op` is the API path with "api/" stripped
// (e.g. "card/<id>/move"); `v` is the parsed payload. Role gates live here so the two
// entry points can never drift.
type WriteResult = { status: number; body: unknown };

async function handleWrite(sfiId: string, op: string, v: Record<string, unknown> | null, peer: Peer): Promise<WriteResult> {
  const settings = getSettings(sfiId);

  // Re-register the shared decls for placements that graduated or are mid-graduation
  // (decls don't survive worker restarts; bindings do).
  if (settings.backend === "shared" || settings.pending_graduation) ensureSharedDecls();

  // Finish a pending graduation the moment both shared bindings exist.
  if (settings.pending_graduation && sharedBound(sfiId)) {
    try { await runGraduation(sfiId, settings); } catch (e) { log(`kanban: graduation failed (will retry): ${e}`); }
  }

  // Graduated placement whose bindings are missing (fresh worker on a new host, or the
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
  const { columns, cards } = dataTables(sfiId, settings);

  // Every op below mutates state and is editor-only. Non-members AND Viewer-role
  // members are rejected with the same gate (never gate writes on is_sfi_member —
  // Viewer-role members would slip through).
  if (!peer.is_sfi_editor) return { status: 403, body: { error: "editors only" } };

  const ok = async (): Promise<WriteResult> => {
    notify(sfiId);
    return { status: 200, body: { columns: await boardData(columns, cards) } };
  };

  // --- Data backend (owner-only): per-placement graduation local → shared -------------
  if (op === "data/graduate") {
    if (!peer.is_owner) return { status: 403, body: { error: "owner only" } };
    if (settings.backend === "shared") return { status: 400, body: { error: "already shared" } };
    settings.pending_graduation = v?.mode === "adopt" ? "adopt" : "convert";
    saveSettings(sfiId, settings);
    ensureSharedDecls();
    ensureTables(peer); // fires the owner's binding modals (columns, then cards)
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

  // --- Columns --------------------------------------------------------------------------
  if (op === "column") {
    const title = sanitizeText(v?.title, 80) || "Untitled";
    const channelRaw = typeof v?.channel === "string" ? v.channel : "";
    const existing = (await columns.query({})).rows.length;
    const channel = CHANNEL_RE.test(channelRaw) ? channelRaw : `c${(existing % 12) + 1}`;
    await columns.upsert(null, { title, channel, sort_order: await nextSortOrder(columns) });
    return ok();
  }

  if (op === "columns/reorder") {
    const ids = Array.isArray(v?.ids) ? v.ids.filter((x): x is string => typeof x === "string" && !!x) : [];
    const { rows } = await columns.query({});
    const known = new Set(rows.map((r) => r._row_id));
    for (let i = 0; i < ids.length; i++) {
      if (known.has(ids[i])) await columns.upsert(ids[i], { sort_order: i });
    }
    return ok();
  }

  if (op.startsWith("column/")) {
    const [id, action] = op.slice("column/".length).split("/");
    if (!id || !(await columns.get(id))) return { status: 400, body: { error: "bad id" } };
    if (action === "delete") {
      await cards.deleteWhere({ column_id: id });
      await columns.delete(id);
      return ok();
    }
    if (action) return { status: 404, body: { error: "not found" } };
    if (v?.title !== undefined) {
      const title = sanitizeText(v.title, 80);
      if (title) await columns.upsert(id, { title });
    }
    if (typeof v?.channel === "string" && CHANNEL_RE.test(v.channel)) {
      await columns.upsert(id, { channel: v.channel });
    }
    return ok();
  }

  // --- Cards ----------------------------------------------------------------------------
  if (op === "card") {
    const columnId = typeof v?.column_id === "string" ? v.column_id : "";
    const title = sanitizeText(v?.title, 200);
    if (!title) return { status: 400, body: { error: "title required" } };
    if (!columnId || !(await columns.get(columnId))) return { status: 400, body: { error: "bad column" } };
    // "top" (the header +) slots the card first; "bottom" (the end-of-list zone)
    // appends. Orders are relative, so min-1 / max+1 need no renumbering.
    const { rows } = await cards.query({ where: { column_id: columnId } });
    const sortOrder = v?.position === "top"
      ? rows.reduce((m, r) => Math.min(m, Number(r.sort_order)), 1) - 1
      : rows.reduce((m, r) => Math.max(m, Number(r.sort_order)), -1) + 1;
    await cards.upsert(null, {
      column_id: columnId, title, description: "", label: "",
      sort_order: sortOrder, created_ms: Date.now(),
    });
    return ok();
  }

  if (op.startsWith("card/")) {
    const [id, action] = op.slice("card/".length).split("/");
    if (!id || !(await cards.get(id))) return { status: 400, body: { error: "bad id" } };

    if (action === "delete") {
      await cards.delete(id);
      return ok();
    }

    // Move: payload carries the target column and that column's full card order
    // (including the moved card) after the drop.
    if (action === "move") {
      const columnId = typeof v?.column_id === "string" ? v.column_id : "";
      if (!columnId || !(await columns.get(columnId))) return { status: 400, body: { error: "bad column" } };
      const ids = Array.isArray(v?.ids) ? v.ids.filter((x): x is string => typeof x === "string" && !!x) : [];
      await cards.upsert(id, { column_id: columnId });
      const { rows } = await cards.query({});
      const known = new Set(rows.map((r) => r._row_id));
      for (let i = 0; i < ids.length; i++) {
        if (known.has(ids[i])) await cards.upsert(ids[i], { sort_order: i });
      }
      return ok();
    }

    if (action) return { status: 404, body: { error: "not found" } };
    if (v?.title !== undefined) {
      const title = sanitizeText(v.title, 200);
      if (title) await cards.upsert(id, { title });
    }
    if (v?.description !== undefined) {
      await cards.upsert(id, { description: sanitizeText(v.description, 4000) });
    }
    if (v?.label !== undefined) {
      await cards.upsert(id, { label: sanitizeText(v.label, 24) });
    }
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
  if (r.status !== 200) log(`kanban: bus op ${d.op} → ${r.status} (${JSON.stringify(r.body)})`);
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

  // Finish a pending graduation the moment both shared bindings exist.
  if (settings.pending_graduation && sharedBound(sfiId)) {
    try { await runGraduation(sfiId, settings); } catch (e) { log(`kanban: graduation failed (will retry): ${e}`); }
  }
  // Mid-graduation and the picker was dismissed (or the app restarted): the owner's
  // next look at the board brings it back. Pending is an explicit owner-initiated
  // state, so the auto-refire is wanted here, unlike the quiet passive paths.
  if (settings.pending_graduation && peer.is_owner && !sharedBound(sfiId)
      && reqPath === "/api/board" && method === "GET") {
    ensureTables(peer);
  }

  // Graduated placement whose bindings are missing (fresh worker on a new host, or the
  // owner closed the picker mid-graduation recovery): every data route waits; the board
  // route re-fires the owner's binding modal so they can finish.
  if (settings.backend === "shared" && !sharedBound(sfiId)) {
    if (reqPath === "/api/board" && method === "GET") {
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
  const { columns, cards } = dataTables(sfiId, settings);

  // Read — open to everyone (non-members get a read-only view of this placement's board).
  if (reqPath === "/api/board" && method === "GET") {
    // First-open seeding: an editor's first look at an empty board lands the three
    // classic columns (no sample cards). Never seeded for read-only viewers — a GET
    // from a viewer must not mutate.
    if (peer.is_sfi_editor && settings.backend === "local"
        && (await columns.query({ limit: 1 })).rows.length === 0) {
      for (let i = 0; i < SEED_COLUMNS.length; i++) {
        await columns.upsert(null, {
          title: SEED_COLUMNS[i][0], channel: SEED_COLUMNS[i][1], sort_order: i,
        });
      }
    }
    return jsonReply(replyPort, 200, {
      columns: await boardData(columns, cards),
      storage: {
        backend: settings.backend,
        pending: !!settings.pending_graduation,
        can_manage: peer.is_owner,
      },
    });
  }

  return jsonReply(replyPort, 404, { error: "not found" });
};

log("Kanban Board frame is up and running!");
