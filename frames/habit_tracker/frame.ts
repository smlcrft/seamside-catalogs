// ----------------------------------------------------------------------------------------
// Habit Tracker — one line per habit, one square per day.
//
// Design axes:
//   privacy:        privacy-public-view  — non-members watch the grid; space editors mark.
//   data_storage:   storage-local        — LocalTables, no contract. Nothing else acts on
//                                           these rows (docs/schema-contracts.md, "When NOT
//                                           to write a contract").
//   view_realtime:  view-collaborative    — marking pushes, so a shared habit fills in on
//                                           everyone's grid at once.
//   settings_scope: settings-per-sfi
//
// A DAY IS A STRING, and that is deliberate. The chore chart learned the hard way that
// deriving a day number from a timestamp invites timezone bugs: a local-midnight value
// floors to the previous day anywhere east of UTC. Here a mark stores the calendar date it
// belongs to as `yyyy-mm-dd`, computed from local calendar fields, so a square means the
// day the person was living in and no arithmetic can slide it. Marks are sparse rows — one
// per completed day — rather than a field on the habit, so the row can't grow without
// bound and two devices marking different days never collide.
// ----------------------------------------------------------------------------------------
import {
  log, serveFileAtPath, jsonReply, parseJsonBody, parsePeerInfo, onUiMessage,
  pushToInstance, sanitizeText, declareTables, ensureTables, table,
} from "@frame-core";

const HABITS_SCHEMA = [
  { name: "name",       col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "sort_order", col_type: "integer" as const, nullable: false, default_val: "0" },
  { name: "created_ms", col_type: "integer" as const, nullable: false, default_val: "0" },
];

const MARKS_SCHEMA = [
  { name: "habit_id", col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "day",      col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "made_ms",  col_type: "integer" as const, nullable: false, default_val: "0" },
];

declareTables([
  { key: "habits", title: "Habits", description: "Habits tracked in this placement.", local: true, schema: HABITS_SCHEMA },
  { key: "marks",  title: "Habit marks", description: "One row per habit per completed day.", local: true, schema: MARKS_SCHEMA },
]);

type Peer = ReturnType<typeof parsePeerInfo>;
type WriteResult = { status: number; body: unknown };

const WINDOW_DAYS = 120;   // how much history the grid can ever show

/** `yyyy-mm-dd` for a timestamp, read in LOCAL calendar fields. Never derived by dividing
 * a timestamp — see the header note. */
function dayString(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Accept a day only if it is a real calendar date, not in the future, and inside the
 * window the grid can show. A client picks the day (you may be filling in yesterday), so
 * it is an input from outside and gets checked like one. */
function validDay(v: unknown, todayStr: string): string | null {
  const s = String(v ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  // Round-trip guards against 2026-02-31 sliding silently into March.
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  if (s > todayStr) return null;
  const oldest = new Date();
  oldest.setDate(oldest.getDate() - WINDOW_DAYS);
  if (s < dayString(oldest.getTime())) return null;
  return s;
}

async function readyTables(peer: Peer): Promise<boolean> {
  const quiet = { ...peer, is_owner: false } as Peer;
  let r = ensureTables(quiet);
  for (const key of ["habits", "marks"]) {
    if (!r.byKey[key]) {
      try { await table(key, peer.sfi_id).query({ limit: 1 }); } catch (e) { log(`habit_tracker: ensure "${key}" failed: ${e}`); }
      r = ensureTables(quiet);
    }
  }
  return !!r.byKey["habits"] && !!r.byKey["marks"];
}

async function readAll(sfiId: string) {
  const { rows: hrows } = await table("habits", sfiId).query({ order_by: [{ col: "sort_order" }] });
  const { rows: mrows } = await table("marks", sfiId).query({ limit: 5000 });
  const oldest = new Date();
  oldest.setDate(oldest.getDate() - WINDOW_DAYS);
  const cutoff = dayString(oldest.getTime());

  const byHabit: Record<string, string[]> = {};
  for (const m of mrows) {
    const day = String(m.day || "");
    if (day < cutoff) continue;            // outside the window the grid can draw
    const hid = String(m.habit_id || "");
    (byHabit[hid] ||= []).push(day);
  }
  return {
    today: dayString(Date.now()),
    window_days: WINDOW_DAYS,
    habits: hrows.map((h) => ({
      id: h._row_id,
      name: h.name,
      sort_order: Number(h.sort_order) || 0,
      days: (byHabit[String(h._row_id)] || []).sort(),
    })),
  };
}

function notify(sfiId: string) {
  pushToInstance(sfiId, { type: "habits_changed" });
}

async function handleWrite(sfiId: string, op: string, v: Record<string, unknown> | null, peer: Peer): Promise<WriteResult> {
  if (!(await readyTables(peer))) return { status: 503, body: { error: "tables not ready" } };
  if (!peer.is_sfi_editor) return { status: 403, body: { error: "editors only" } };

  const habits = table("habits", sfiId);
  const marks = table("marks", sfiId);
  const today = dayString(Date.now());

  const ok = async (): Promise<WriteResult> => {
    notify(sfiId);
    return { status: 200, body: await readAll(sfiId) };
  };

  if (op === "habit") {
    const name = sanitizeText(v?.name, 80);
    if (!name) return { status: 400, body: { error: "name required" } };
    const { rows } = await habits.query({ order_by: [{ col: "sort_order", dir: "desc" }], limit: 1 });
    const next = rows.length ? (Number(rows[0].sort_order) || 0) + 1 : 0;
    await habits.upsert(null, { name, sort_order: next, created_ms: Date.now() });
    return ok();
  }

  if (op.startsWith("habit/")) {
    const [id, action] = op.slice("habit/".length).split("/");
    if (!id || !(await habits.get(id))) return { status: 400, body: { error: "bad id" } };
    if (action === "delete") {
      // Take the marks with it: an orphaned mark is invisible and would quietly come back
      // to life if a new habit were ever given the same row id.
      await marks.deleteWhere({ habit_id: id });
      await habits.delete(id);
      return ok();
    }
    if (action) return { status: 404, body: { error: "not found" } };
    if (v?.name !== undefined) {
      const name = sanitizeText(v.name, 80);
      if (name) await habits.upsert(id, { name });
    }
    return ok();
  }

  // Toggle one day of one habit. Idempotent in both directions: marking a day already
  // marked is a no-op rather than a duplicate row, which matters because two devices can
  // tap the same square at once.
  if (op === "mark") {
    const hid = String(v?.habit_id ?? "");
    if (!hid || !(await habits.get(hid))) return { status: 400, body: { error: "bad habit" } };
    const day = validDay(v?.day, today);
    if (!day) return { status: 400, body: { error: "bad day" } };

    const { rows } = await marks.query({ where: { habit_id: hid, day }, limit: 2 });
    const want = !!v?.done;
    if (want && rows.length === 0) {
      await marks.upsert(null, { habit_id: hid, day, made_ms: Date.now() });
    } else if (!want) {
      for (const r of rows) await marks.delete(String(r._row_id));
    }
    return ok();
  }

  return { status: 404, body: { error: "not found" } };
}

onUiMessage(async (sfiId, data, peer) => {
  if (!sfiId || typeof data !== "object" || data === null) return;
  const d = data as Record<string, unknown>;
  if (typeof d.op !== "string") return;
  const r = await handleWrite(sfiId, d.op, d, peer);
  if (r.status !== 200) log(`habit_tracker: bus op ${d.op} → ${r.status} (${JSON.stringify(r.body)})`);
});

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

  if (!(await readyTables(peer))) return jsonReply(replyPort, 503, { error: "tables not ready" });

  if (reqPath === "/api/list" && method === "GET") {
    return jsonReply(replyPort, 200, await readAll(sfiId));
  }

  return jsonReply(replyPort, 404, { error: "not found" });
};

log("Habit Tracker frame is up and running!");
