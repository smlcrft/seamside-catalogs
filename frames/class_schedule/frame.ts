// ----------------------------------------------------------------------------------------
// Class Schedule — the week, laid out.
//
// Design axes:
//   privacy:        privacy-public-view  — a roommate or study group reads the same week;
//                                           space editors set it.
//   data_storage:   storage-local        — LocalTable, no contract (docs/schema-contracts.md).
//   view_realtime:  view-collaborative    — every change pushes.
//   settings_scope: settings-per-sfi
//
// A TIMETABLE IS ONE ROW PER MEETING, not one row per class with a list of days. "Maths,
// Mon/Wed/Fri" sounds tidier until Wednesday's session moves room, or Friday's is cancelled
// for a week — then the tidy model has to grow exceptions. One row per meeting means the
// exception is just an edit. The cost is that adding a thrice-weekly class writes three
// rows, which the frontend hides by letting you tick several days at once.
//
// Times are MINUTES FROM MIDNIGHT, integers, in the timetable's own local reckoning. No
// timezone conversion happens anywhere: a 9am class is at 9am on the wall, and converting
// it through UTC would move it for the very roommate the frame is shared with.
// ----------------------------------------------------------------------------------------
import {
  log, serveFileAtPath, jsonReply, parseJsonBody, parsePeerInfo, onUiMessage,
  pushToInstance, sanitizeText, declareTables, ensureTables, table,
} from "@frame-core";

const CLASSES_SCHEMA = [
  { name: "title",     col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "day",       col_type: "integer" as const, nullable: false, default_val: "0" },   // 0 = Monday
  { name: "start_min", col_type: "integer" as const, nullable: false, default_val: "540" }, // 09:00
  { name: "end_min",   col_type: "integer" as const, nullable: false, default_val: "600" },
  { name: "place",     col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "note",      col_type: "text"    as const, nullable: false, default_val: "" },
];

declareTables([
  { key: "classes", title: "Classes", description: "Weekly class meetings for this placement.", local: true, schema: CLASSES_SCHEMA },
]);

type Peer = ReturnType<typeof parsePeerInfo>;
type WriteResult = { status: number; body: unknown };

const clampInt = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/** A meeting must start before it ends and fit inside a day. A zero-length block would
 * render as an invisible sliver you could never click to fix. */
function normalizeTimes(startRaw: unknown, endRaw: unknown): { start: number; end: number } {
  const start = clampInt(startRaw, 0, 1439, 540);
  let end = clampInt(endRaw, 0, 1440, start + 60);
  if (end <= start) end = Math.min(1440, start + 30);
  return { start, end };
}

async function readyTables(peer: Peer): Promise<boolean> {
  const quiet = { ...peer, is_owner: false } as Peer;
  let r = ensureTables(quiet);
  if (!r.byKey["classes"]) {
    try { await table("classes", peer.sfi_id).query({ limit: 1 }); } catch (e) { log(`class_schedule: ensure failed: ${e}`); }
    r = ensureTables(quiet);
  }
  return !!r.byKey["classes"];
}

async function listRows(sfiId: string) {
  const { rows } = await table("classes", sfiId).query({ limit: 1000 });
  return rows.map((r) => ({
    id: r._row_id,
    title: r.title,
    day: clampInt(r.day, 0, 6, 0),
    start_min: clampInt(r.start_min, 0, 1439, 540),
    end_min: clampInt(r.end_min, 1, 1440, 600),
    place: r.place,
    note: r.note,
  })).sort((a, b) => a.day - b.day || a.start_min - b.start_min);
}

function notify(sfiId: string) {
  pushToInstance(sfiId, { type: "schedule_changed" });
}

async function handleWrite(sfiId: string, op: string, v: Record<string, unknown> | null, peer: Peer): Promise<WriteResult> {
  if (!(await readyTables(peer))) return { status: 503, body: { error: "table not ready" } };
  if (!peer.is_sfi_editor) return { status: 403, body: { error: "editors only" } };
  const t = table("classes", sfiId);
  const ok = async (): Promise<WriteResult> => { notify(sfiId); return { status: 200, body: { ok: true } }; };

  if (op === "class") {
    const title = sanitizeText(v?.title, 120);
    if (!title) return { status: 400, body: { error: "name it" } };
    // One call, several days: the frontend lets you tick Mon/Wed/Fri and we write the
    // three meetings, so the tidy-looking model never has to exist.
    const daysIn = Array.isArray(v?.days) ? v!.days as unknown[] : [v?.day];
    const days = [...new Set(daysIn.map((d) => clampInt(d, 0, 6, 0)))];
    if (!days.length) return { status: 400, body: { error: "pick at least one day" } };
    const { start, end } = normalizeTimes(v?.start_min, v?.end_min);
    const place = sanitizeText(v?.place, 80);
    for (const day of days) {
      await t.upsert(null, { title, day, start_min: start, end_min: end, place, note: "" });
    }
    return ok();
  }

  if (op.startsWith("class/")) {
    const [id, action] = op.slice("class/".length).split("/");
    // Fetch once and keep it: the row is read three more times below, and re-fetching it
    // each time is both a round trip and three more places to forget the null check.
    const row = id ? await t.get(id) : null;
    if (!id || !row) return { status: 400, body: { error: "bad id" } };
    if (action === "delete") { await t.delete(id); return ok(); }
    if (action === "delete_all") {
      // Drop every meeting of the same class — "I dropped this course" is one action, not
      // three deletions with the same name.
      await t.deleteWhere({ title: String(row.title) });
      return ok();
    }
    if (action) return { status: 404, body: { error: "not found" } };

    const patch: Record<string, unknown> = {};
    if (v?.title !== undefined) { const s = sanitizeText(v.title, 120); if (s) patch.title = s; }
    if (v?.place !== undefined) patch.place = sanitizeText(v.place, 80);
    if (v?.note !== undefined) patch.note = sanitizeText(v.note, 200);
    if (v?.day !== undefined) patch.day = clampInt(v.day, 0, 6, 0);
    if (v?.start_min !== undefined || v?.end_min !== undefined) {
      const { start, end } = normalizeTimes(
        v?.start_min !== undefined ? v.start_min : row.start_min,
        v?.end_min !== undefined ? v.end_min : row.end_min,
      );
      patch.start_min = start; patch.end_min = end;
    }
    // Renaming renames the CLASS, not the one meeting you happened to click — same
    // reasoning as delete_all, and it matters more now that repeating is a tick away.
    if (v?.apply_all && typeof patch.title === "string") {
      const was = String(row.title);
      if (was && was !== patch.title) {
        const { rows } = await t.query({ limit: 1000 });
        for (const r of rows) {
          if (r._row_id !== id && String(r.title) === was) await t.upsert(r._row_id, { title: patch.title });
        }
      }
    }
    if (Object.keys(patch).length) await t.upsert(id, patch);
    return ok();
  }

  return { status: 404, body: { error: "not found" } };
}

onUiMessage(async (sfiId, data, peer) => {
  if (!sfiId || typeof data !== "object" || data === null) return;
  const d = data as Record<string, unknown>;
  if (typeof d.op !== "string") return;
  const r = await handleWrite(sfiId, d.op, d, peer);
  if (r.status !== 200) log(`class_schedule: bus op ${d.op} → ${r.status} (${JSON.stringify(r.body)})`);
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

  if (!(await readyTables(peer))) return jsonReply(replyPort, 503, { error: "table not ready" });

  if (reqPath === "/api/list" && method === "GET") {
    return jsonReply(replyPort, 200, { classes: await listRows(sfiId) });
  }

  return jsonReply(replyPort, 404, { error: "not found" });
};

log("Class Schedule frame is up and running!");
