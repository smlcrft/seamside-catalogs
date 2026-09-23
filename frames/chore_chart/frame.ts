// ----------------------------------------------------------------------------------------
// Chore Chart — who does what around the house, and how it's going.
//
// Design axes:
//   privacy:        privacy-public-view  — non-members get a live read-only board;
//                                           space editors get the interactive one.
//   data_storage:   the space's table    — `chores.table.jsonl` at the space's root,
//                                           synced with the space; any frame in the space
//                                           that speaks `chores` works on the same rows.
//   view_realtime:  view-collaborative    — every mutation calls pushToInstance(sfi_id, …)
//                                           so all viewers refresh live. Ticking a chore
//                                           off on the kitchen tablet lands on every
//                                           other device instantly.
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
  pushToInstance, sanitizeText,
  declareTables, table,
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

// ----- The space's `chores` table (the contract name) ---------------------------------
declareTables([
  { key: "chores", title: "Chore Chart", description: "The chores of this space.", schema: CHORES_SCHEMA },
]);

type Tbl = ReturnType<typeof table>;
type Peer = ReturnType<typeof parsePeerInfo>;

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
  const t = table("chores", sfiId);

  // Every op below mutates state and is editor-only. Non-members AND Viewer-role members
  // are rejected with the same gate (never gate writes on is_sfi_member — Viewer-role
  // members would slip through). Ticking a chore off is a write like any other: a public
  // viewer watches the chart, they don't do the dishes on someone else's behalf.
  if (!peer.is_sfi_editor) return { status: 403, body: { error: "editors only" } };

  const ok = async (): Promise<WriteResult> => {
    notify(sfiId);
    return { status: 200, body: { chores: await listRows(t) } };
  };

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

  // Read — open to everyone (non-members get a read-only view of the chart).
  // No seeding: an empty chart is an honest empty chart.
  if (reqPath === "/api/list" && method === "GET") {
    return jsonReply(replyPort, 200, {
      chores: await listRows(table("chores", sfiId)),
    });
  }

  return jsonReply(replyPort, 404, { error: "not found" });
};

log("Chore Chart frame is up and running!");
