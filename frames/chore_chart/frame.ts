// ----------------------------------------------------------------------------------------
// Chore Chart — who does what around the house, and how it's going.
//
// Design axes:
//   privacy:        privacy-public-view  — non-members get a live read-only board;
//                                           space editors get the interactive one.
//   data_storage:   storage-graduating   — starts as a LocalTable (encrypted at rest on
//                                           the host, zero ceremony); the OWNER can
//                                           graduate THIS placement's data to a shared
//                                           SyncTable so other frames bind the same rows.
//                                           Other placements stay local. See
//                                           docs/table-graduation.md in this repo.
//   view_realtime:  view-collaborative    — every mutation calls pushToInstance(sfi_id, …)
//                                           so all viewers refresh live. Ticking a chore
//                                           off on the kitchen tablet lands on every
//                                           other device instantly.
//   settings_scope: settings-per-sfi      — backend choice + bindings are keyed by sfi_id.
//
// This frame OWNS the `chores` v1 contract (docs/schema-contracts.md). The chart is
// deliberately about the CURRENT turn of each chore rather than a growing history: a row
// carries when it was last done and how long a streak it is on, and the "done" state is
// DERIVED by comparing that timestamp's period to now. That is what lets a weekly chore
// come back by itself on Monday without anything having to run on a schedule — there is
// no cron in a frame, and a chart that needed one would silently rot on a sleeping device.
// ----------------------------------------------------------------------------------------
import {
  log, serveFileAtPath, jsonReply, parseJsonBody, parsePeerInfo, onUiMessage,
  pushToInstance, sanitizeText, loadJsonFile, saveJsonFile,
  declareTables, ensureTables, table,
} from "@frame-core";

// ----- Schema (the `chores` v1 contract — declared verbatim, one source of truth) -------
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

// ----- LocalTable (the install-time default: encrypted, per-placement, zero ceremony) ---
declareTables([
  { key: "chores", title: "Chore Chart", description: "Chores for this placement's chart.", local: true, schema: CHORES_SCHEMA },
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
      key: "chores_shared", title: "Chore Chart",
      description: "Chores of a shared chart. Create a new table, or pick the one other frames should read.",
      schema: CHORES_SCHEMA,
    },
  ]);
}

// ----- Per-placement settings: which backend this placement runs on ---------------------
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

function dataTable(sfiId: string, s: SfiSettings): Tbl {
  return table(s.backend === "shared" ? "chores_shared" : "chores", sfiId);
}

function sharedBound(sfiId: string): boolean {
  try { table("chores_shared", sfiId); return true; } catch { return false; }
}

/** ensureTables, but QUIET and with the local table awaited. See grocery_list for the
 * full reasoning: is_owner is stripped so a missing shared binding never fires the
 * owner's binding modal from a passive path. */
async function readyLocalTables(peer: Peer): Promise<boolean> {
  const quiet = { ...peer, is_owner: false } as Peer;
  let r = ensureTables(quiet);
  if (!r.byKey["chores"]) {
    try { await table("chores", peer.sfi_id).query({ limit: 1 }); } catch (e) { log(`chore_chart: ensure "chores" failed: ${e}`); }
    r = ensureTables(quiet);
  }
  return !!r.byKey["chores"];
}

// ----- Cadence: the whole clock of this frame -------------------------------------------
// A chore's turn is a PERIOD, and "done" means "done in the period we are in now". Two
// consecutive period indices mean the streak continues; a gap breaks it. Everything is
// computed in the host's local time, which is the family's wall clock — the point of a
// chore chart is "did this happen today", not "did this happen inside a UTC day".
const CADENCES = ["daily", "weekly", "monthly", "once"] as const;
type Cadence = typeof CADENCES[number];

function asCadence(v: unknown): Cadence {
  const s = String(v ?? "").toLowerCase();
  return (CADENCES as readonly string[]).includes(s) ? s as Cadence : "weekly";
}

/** The index of the period `ms` falls in, for a cadence. Consecutive turns differ by 1.
 * `once` has no periods — it is answered by last_done_ms alone. */
function periodIndex(ms: number, cadence: Cadence): number {
  const d = new Date(ms);
  if (cadence === "monthly") return d.getFullYear() * 12 + d.getMonth();
  // The day number for that CALENDAR date. Read the fields in local time (the family's
  // wall clock decides what "today" is), then count them with Date.UTC so the host's own
  // offset can't shift the result: a local-midnight timestamp east of UTC floors to the
  // previous day, which quietly slides every weekly boundary. DST is a non-issue here
  // because no wall-clock duration is ever divided.
  const day = Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
  if (cadence === "daily") return day;
  // Weeks run Monday→Sunday. Day 0 (1970-01-01) was a Thursday, so Mondays are the days
  // where day ≡ 4 (mod 7); adding 3 puts the division boundary exactly there.
  return Math.floor((day + 3) / 7);
}

function isDoneNow(row: { last_done_ms: number; cadence: Cadence }, now: number): boolean {
  if (!row.last_done_ms) return false;
  if (row.cadence === "once") return true;
  return periodIndex(row.last_done_ms, row.cadence) === periodIndex(now, row.cadence);
}

// ----- Graduation: flip this placement to the freshly bound shared table ----------------
async function runGraduation(sfiId: string, settings: SfiSettings): Promise<void> {
  const mode = settings.pending_graduation!;
  let copied = "";
  if (mode === "convert") {
    const shared = table("chores_shared", sfiId);
    const { rows } = await table("chores", sfiId).query({});
    for (const r of rows) {
      await shared.upsert(r._row_id, {
        chore: r.chore, assignee: r.assignee, cadence: r.cadence,
        last_done_ms: r.last_done_ms, last_done_by: r.last_done_by,
        streak: r.streak, best_streak: r.best_streak, sort_order: r.sort_order, notes: r.notes,
      });
    }
    copied = ` (${rows.length} chores copied)`;
  }

  settings.backend = "shared";
  delete settings.pending_graduation;
  saveSettings(sfiId, settings);
  wireSharedListeners(sfiId);
  notify(sfiId);
  log(`chore_chart: placement ${sfiId} moved to shared tables (${mode})${copied}`);
}

const wiredShared = new Set<string>();
function wireSharedListeners(sfiId: string): void {
  if (wiredShared.has(sfiId)) return;
  wiredShared.add(sfiId);
  try {
    table("chores_shared", sfiId).onChange(() => notify(sfiId));
  } catch {
    wiredShared.delete(sfiId); // not bound yet — rewired after graduation completes
  }
}

// ----- Queries --------------------------------------------------------------------------
async function listRows(t: Tbl) {
  const { rows } = await t.query({ order_by: [{ col: "sort_order" }] });
  const now = Date.now();
  return rows.map((r) => {
    const cadence = asCadence(r.cadence);
    return {
      id: r._row_id,
      chore: r.chore,
      assignee: r.assignee,
      cadence,
      last_done_ms: Number(r.last_done_ms) || 0,
      last_done_by: r.last_done_by,
      streak: Number(r.streak) || 0,
      best_streak: Number(r.best_streak) || 0,
      sort_order: Number(r.sort_order) || 0,
      notes: r.notes,
      // Derived, never stored: storing it would go stale the moment the period turned
      // over with nobody looking.
      done: isDoneNow({ last_done_ms: Number(r.last_done_ms) || 0, cadence }, now),
    };
  });
}

/** Next sort_order — new chores land at the end of the board. */
async function nextOrder(t: Tbl): Promise<number> {
  const { rows } = await t.query({ order_by: [{ col: "sort_order", dir: "desc" }], limit: 1 });
  return rows.length ? (Number(rows[0].sort_order) || 0) + 1 : 0;
}

function notify(sfiId: string) {
  pushToInstance(sfiId, { type: "chores_changed" });
}

// ----- Writes ---------------------------------------------------------------------------
type WriteResult = { status: number; body: unknown };

async function handleWrite(sfiId: string, op: string, v: Record<string, unknown> | null, peer: Peer): Promise<WriteResult> {
  const settings = getSettings(sfiId);

  if (settings.backend === "shared" || settings.pending_graduation) ensureSharedDecls();

  if (settings.pending_graduation && sharedBound(sfiId)) {
    try { await runGraduation(sfiId, settings); } catch (e) { log(`chore_chart: graduation failed (will retry): ${e}`); }
  }

  if (settings.backend === "shared" && !sharedBound(sfiId)) {
    return { status: 503, body: { error: "table not bound" } };
  }
  if (settings.backend === "shared") wireSharedListeners(sfiId);

  if (settings.backend === "local" && !(await readyLocalTables(peer))) {
    return { status: 503, body: { error: "table not ready" } };
  }
  const t = dataTable(sfiId, settings);

  // Every op below mutates state and is editor-only. Non-members AND Viewer-role members
  // are rejected with the same gate (never gate writes on is_sfi_member — Viewer-role
  // members would slip through). Ticking a chore off is a write like any other: a public
  // viewer watches the chart, they don't do the dishes on someone else's behalf.
  if (!peer.is_sfi_editor) return { status: 403, body: { error: "editors only" } };

  const ok = async (): Promise<WriteResult> => {
    notify(sfiId);
    return { status: 200, body: { chores: await listRows(t) } };
  };

  // --- Data backend (owner-only): per-placement graduation local → shared -------------
  if (op === "data/graduate") {
    if (!peer.is_owner) return { status: 403, body: { error: "owner only" } };
    if (settings.backend === "shared") return { status: 400, body: { error: "already shared" } };
    settings.pending_graduation = v?.mode === "adopt" ? "adopt" : "convert";
    saveSettings(sfiId, settings);
    ensureSharedDecls();
    ensureTables(peer); // fires the owner's binding modal (the chores table)
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

  // --- Chores ---------------------------------------------------------------------------
  if (op === "chore") {
    const chore = sanitizeText(v?.chore, 200);
    if (!chore) return { status: 400, body: { error: "chore required" } };
    await t.upsert(null, {
      chore,
      assignee: sanitizeText(v?.assignee, 60),
      cadence: asCadence(v?.cadence),
      last_done_ms: 0, last_done_by: "", streak: 0,
      sort_order: await nextOrder(t),
      notes: "",
    });
    return ok();
  }

  if (op.startsWith("chore/")) {
    const [id, action] = op.slice("chore/".length).split("/");
    const row = id ? await t.get(id) : null;
    if (!row) return { status: 400, body: { error: "bad id" } };

    if (action === "delete") {
      await t.delete(id);
      return ok();
    }

    // Tick it off for this turn. The streak advances only when the PREVIOUS turn was
    // also done — otherwise it restarts at 1. Doing it twice in the same period is a
    // no-op rather than a double count, so a second tap can't inflate a streak.
    if (action === "done") {
      const cadence = asCadence(row.cadence);
      const last = Number(row.last_done_ms) || 0;
      const now = Date.now();
      if (isDoneNow({ last_done_ms: last, cadence }, now)) return ok();
      const continued = cadence !== "once" && last > 0
        && periodIndex(last, cadence) === periodIndex(now, cadence) - 1;
      const streak = continued ? (Number(row.streak) || 0) + 1 : 1;
      await t.upsert(id, {
        last_done_ms: now,
        last_done_by: sanitizeText(peer.user_name, 60),
        streak,
        // the record only ever goes up — undoing a mis-tap gives back the streak, but a
        // run that actually happened stays on the card
        best_streak: Math.max(Number(row.best_streak) || 0, streak),
      });
      return ok();
    }

    // Undo a tick — the mis-tap escape hatch. It gives back the streak it granted
    // rather than trying to reconstruct the previous timestamp, which the row does not
    // carry: this chore is simply not done this turn any more.
    if (action === "undo") {
      if (!Number(row.last_done_ms)) return ok();
      await t.upsert(id, {
        last_done_ms: 0, last_done_by: "",
        streak: Math.max(0, (Number(row.streak) || 0) - 1),
      });
      return ok();
    }

    if (action) return { status: 404, body: { error: "not found" } };

    if (v?.chore !== undefined) {
      const chore = sanitizeText(v.chore, 200);
      if (chore) await t.upsert(id, { chore });
    }
    if (v?.assignee !== undefined) await t.upsert(id, { assignee: sanitizeText(v.assignee, 60) });
    if (v?.cadence !== undefined) await t.upsert(id, { cadence: asCadence(v.cadence) });
    if (v?.notes !== undefined) await t.upsert(id, { notes: sanitizeText(v.notes, 500) });
    return ok();
  }

  return { status: 404, body: { error: "not found" } };
}

// ----- Bus dispatcher — the frontend's write path (frame.busSend → BusUiToFrame) --------
onUiMessage(async (sfiId, data, peer) => {
  if (!sfiId || typeof data !== "object" || data === null) return;
  const d = data as Record<string, unknown>;
  if (typeof d.op !== "string") return;
  const r = await handleWrite(sfiId, d.op, d, peer);
  if (r.status !== 200) log(`chore_chart: bus op ${d.op} → ${r.status} (${JSON.stringify(r.body)})`);
});

// ----- Networking -----------------------------------------------------------------------
self.onNetworkRequest = async function (replyPort, reqPath, method, headers, query, body, cookies) {
  const peer = parsePeerInfo(query, cookies);
  const sfiId = peer.sfi_id;

  if (method === "GET" && !reqPath.startsWith("/api/")) {
    return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url), headers);
  }

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

  if (reqPath.startsWith("/api/") && (method === "POST" || method === "PUT")) {
    const r = await handleWrite(sfiId, reqPath.slice("/api/".length), parseJsonBody<Record<string, unknown>>(body), peer);
    return jsonReply(replyPort, r.status, r.body);
  }

  const settings = getSettings(sfiId);

  if (settings.backend === "shared" || settings.pending_graduation) ensureSharedDecls();

  if (settings.pending_graduation && sharedBound(sfiId)) {
    try { await runGraduation(sfiId, settings); } catch (e) { log(`chore_chart: graduation failed (will retry): ${e}`); }
  }
  if (settings.pending_graduation && peer.is_owner && !sharedBound(sfiId)
      && reqPath === "/api/list" && method === "GET") {
    ensureTables(peer);
  }

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

  if (settings.backend === "local" && !(await readyLocalTables(peer))) {
    return jsonReply(replyPort, 503, { error: "table not ready" });
  }

  // Read — open to everyone (non-members get a read-only view of this placement's chart).
  // No seeding: an empty chart is an honest empty chart.
  if (reqPath === "/api/list" && method === "GET") {
    return jsonReply(replyPort, 200, {
      chores: await listRows(dataTable(sfiId, settings)),
      storage: {
        backend: settings.backend,
        pending: !!settings.pending_graduation,
        can_manage: peer.is_owner,
      },
    });
  }

  return jsonReply(replyPort, 404, { error: "not found" });
};

log("Chore Chart frame is up and running!");
