// ----------------------------------------------------------------------------------------
// Assignments — what's due, and where you stand.
//
// Design axes:
//   privacy:        privacy-public-view  — a study group sees the same board; space editors
//                                           add and tick.
//   data_storage:   the space's tables   — `assignments.table.jsonl` (the work) and
//                                           `assignments_courses.table.jsonl`, files at the
//                                           space's root, synced with it. Named for this frame:
//                                           courses are its own data, not a contract other
//                                           frames share (see "When NOT to write a contract"
//                                           in docs/schema-contracts.md).
//   view_realtime:  view-collaborative    — every write pushes.
//   settings_scope: settings-per-sfi
//
// THE ARITHMETIC IS THE PRODUCT. Anyone can list due dates; the reason students keep this
// in a spreadsheet is the weighted grade, so it is computed HERE — one implementation, one
// set of rounding decisions — rather than in the frontend where an optimistic update could
// briefly show a number that was never true.
// ----------------------------------------------------------------------------------------
import {
  log, serveFileAtPath, jsonReply, parseJsonBody, parsePeerInfo, onUiMessage,
  pushToInstance, sanitizeText, declareTables, ensureTables, table,
} from "@frame-core";

const COURSES = "assignments_courses";
const WORK = "assignments";

const COURSES_SCHEMA = [
  { name: "name",       col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "credits",    col_type: "real"    as const, nullable: false, default_val: "3" },
  { name: "sort_order", col_type: "integer" as const, nullable: false, default_val: "0" },
];

const WORK_SCHEMA = [
  { name: "course_id", col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "title",     col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "due",       col_type: "text"    as const, nullable: false, default_val: "" },   // yyyy-mm-dd, "" = no date
  { name: "weight",    col_type: "real"    as const, nullable: false, default_val: "0" },  // % of the course grade
  // How big a job it is: 1 tiny, 2 doable, 3 huge. Deliberately three t-shirt sizes and
  // not an hour estimate — students do not know the hours, and asking for them turns
  // adding an assignment into a planning exercise. Three is enough to sort by.
  { name: "size",      col_type: "integer" as const, nullable: false, default_val: "2" },
  { name: "earned",    col_type: "real"    as const, nullable: false, default_val: "-1" }, // -1 = not marked yet
  { name: "possible",  col_type: "real"    as const, nullable: false, default_val: "100" },
  { name: "done",      col_type: "integer" as const, nullable: false, default_val: "0" },
  { name: "added_ms",  col_type: "integer" as const, nullable: false, default_val: "0" },
];

declareTables([
  { key: COURSES, title: "Courses", description: "Courses tracked in this space.", local: true, schema: COURSES_SCHEMA },
  { key: WORK,    title: "Assignments", description: "Assignments for this space's courses.", local: true, schema: WORK_SCHEMA },
]);

type Peer = ReturnType<typeof parsePeerInfo>;
type WriteResult = { status: number; body: unknown };

/** yyyy-mm-dd from LOCAL calendar fields. Same rule as the habit tracker: a due date is
 * the day the student is living in, and deriving it by dividing a timestamp slides it a
 * day east of UTC. */
function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function validDue(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!s) return "";                      // undated work is legitimate — it just sorts last
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  // Round-trip so 2026-02-31 can't slide silently into March.
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return "";
  return s;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

// ----- The arithmetic ---------------------------------------------------------------------
// A course's grade SO FAR is the weighted average over the work that has actually been
// marked — not over everything assigned. Dividing by the full 100% would count unmarked
// work as zero and tell a student in week three that they are failing.
const LETTERS: [number, string, number][] = [
  [93, "A", 4.0], [90, "A-", 3.7], [87, "B+", 3.3], [83, "B", 3.0], [80, "B-", 2.7],
  [77, "C+", 2.3], [73, "C", 2.0], [70, "C-", 1.7], [67, "D+", 1.3], [63, "D", 1.0],
  [60, "D-", 0.7], [0, "F", 0.0],
];
function letterFor(pct: number): { letter: string; points: number } {
  for (const [floor, letter, points] of LETTERS) {
    if (pct >= floor) return { letter, points };
  }
  return { letter: "F", points: 0 };
}

type WorkRow = {
  id: string; course_id: string; title: string; due: string;
  weight: number; earned: number; possible: number; done: boolean; added_ms: number; size: number;
};

function gradeCourse(work: WorkRow[]) {
  let wsum = 0, acc = 0, assigned = 0;
  for (const w of work) {
    assigned += w.weight;
    // earned < 0 means "not marked yet"; possible <= 0 would divide by zero.
    if (w.earned < 0 || w.possible <= 0 || w.weight <= 0) continue;
    wsum += w.weight;
    acc += w.weight * (w.earned / w.possible);
  }
  if (wsum <= 0) return { pct: null, graded_weight: 0, assigned_weight: assigned, letter: null, points: null };
  const pct = (acc / wsum) * 100;
  const { letter, points } = letterFor(pct);
  return { pct, graded_weight: wsum, assigned_weight: assigned, letter, points };
}

async function readyTables(peer: Peer): Promise<boolean> {
  const quiet = { ...peer, is_owner: false } as Peer;
  let r = ensureTables(quiet);
  for (const key of [COURSES, WORK]) {
    if (!r.byKey[key]) {
      try { await table(key, peer.sfi_id).query({ limit: 1 }); } catch (e) { log(`assignments: ensure "${key}" failed: ${e}`); }
      r = ensureTables(quiet);
    }
  }
  return !!r.byKey[COURSES] && !!r.byKey[WORK];
}

async function readAll(sfiId: string) {
  const { rows: crows } = await table(COURSES, sfiId).query({ order_by: [{ col: "sort_order" }] });
  const { rows: wrows } = await table(WORK, sfiId).query({ limit: 2000 });

  const work: WorkRow[] = wrows.map((r) => ({
    id: r._row_id, course_id: String(r.course_id || ""), title: String(r.title || ""),
    due: String(r.due || ""), weight: Number(r.weight) || 0,
    size: clamp(Number(r.size) || 2, 1, 3),
    earned: Number(r.earned), possible: Number(r.possible) || 0,
    done: !!Number(r.done), added_ms: Number(r.added_ms) || 0,
  }));

  const byCourse: Record<string, WorkRow[]> = {};
  for (const w of work) (byCourse[w.course_id] ||= []).push(w);

  const courses = crows.map((c) => {
    const id = String(c._row_id);
    const g = gradeCourse(byCourse[id] || []);
    return {
      id, name: c.name, credits: Number(c.credits) || 0,
      sort_order: Number(c.sort_order) || 0, ...g,
    };
  });

  // GPA counts only courses that HAVE a grade — an ungraded course would otherwise drag
  // the average toward zero from the first week of term.
  let qp = 0, creds = 0;
  for (const c of courses) {
    if (c.points === null || c.credits <= 0) continue;
    qp += c.points * c.credits;
    creds += c.credits;
  }
  return {
    today: todayStr(),
    courses,
    work,
    gpa: creds > 0 ? Number((qp / creds).toFixed(2)) : null,
    graded_credits: creds,
  };
}

function notify(sfiId: string) {
  pushToInstance(sfiId, { type: "assignments_changed" });
}

async function handleWrite(sfiId: string, op: string, v: Record<string, unknown> | null, peer: Peer): Promise<WriteResult> {
  if (!(await readyTables(peer))) return { status: 503, body: { error: "tables not ready" } };
  if (!peer.is_sfi_editor) return { status: 403, body: { error: "editors only" } };
  const courses = table(COURSES, sfiId);
  const work = table(WORK, sfiId);

  const ok = async (): Promise<WriteResult> => { notify(sfiId); return { status: 200, body: { ok: true } }; };

  // --- Courses --------------------------------------------------------------------------
  if (op === "course") {
    const name = sanitizeText(v?.name, 100);
    if (!name) return { status: 400, body: { error: "name required" } };
    const { rows } = await courses.query({ order_by: [{ col: "sort_order", dir: "desc" }], limit: 1 });
    const next = rows.length ? (Number(rows[0].sort_order) || 0) + 1 : 0;
    await courses.upsert(null, { name, credits: clamp(Number(v?.credits) || 3, 0, 20), sort_order: next });
    return ok();
  }
  if (op.startsWith("course/")) {
    const [id, action] = op.slice("course/".length).split("/");
    if (!id || !(await courses.get(id))) return { status: 400, body: { error: "bad id" } };
    if (action === "delete") {
      // Take the work with it — an assignment whose course is gone is invisible and would
      // silently keep counting toward nothing.
      await work.deleteWhere({ course_id: id });
      await courses.delete(id);
      return ok();
    }
    if (action) return { status: 404, body: { error: "not found" } };
    const patch: Record<string, unknown> = {};
    if (v?.name !== undefined) { const n = sanitizeText(v.name, 100); if (n) patch.name = n; }
    if (v?.credits !== undefined) patch.credits = clamp(Number(v.credits) || 0, 0, 20);
    if (Object.keys(patch).length) await courses.upsert(id, patch);
    return ok();
  }

  // --- Work -----------------------------------------------------------------------------
  if (op === "work") {
    const title = sanitizeText(v?.title, 200);
    if (!title) return { status: 400, body: { error: "title required" } };
    const courseId = String(v?.course_id ?? "");
    if (!courseId || !(await courses.get(courseId))) return { status: 400, body: { error: "pick a course" } };
    await work.upsert(null, {
      course_id: courseId, title,
      due: validDue(v?.due),
      weight: clamp(Number(v?.weight) || 0, 0, 100),
      size: clamp(Math.round(Number(v?.size) || 2), 1, 3),
      earned: -1, possible: clamp(Number(v?.possible) || 100, 0, 100000),
      done: 0, added_ms: Date.now(),
    });
    return ok();
  }
  if (op.startsWith("work/")) {
    const [id, action] = op.slice("work/".length).split("/");
    const row = id ? await work.get(id) : null;
    if (!row) return { status: 400, body: { error: "bad id" } };
    if (action === "delete") { await work.delete(id); return ok(); }
    if (action === "done") { await work.upsert(id, { done: Number(v?.done) ? 1 : 0 }); return ok(); }
    if (action === "grade") {
      // A score of "" clears the mark back to ungraded rather than storing 0 — those mean
      // very different things to the average.
      const raw = String(v?.earned ?? "").trim();
      if (raw === "") { await work.upsert(id, { earned: -1 }); return ok(); }
      const earned = Number(raw);
      if (!Number.isFinite(earned) || earned < 0) return { status: 400, body: { error: "bad score" } };
      const patch: Record<string, unknown> = { earned, done: 1 };
      if (v?.possible !== undefined) patch.possible = clamp(Number(v.possible) || 0, 0, 100000);
      await work.upsert(id, patch);
      return ok();
    }
    if (action) return { status: 404, body: { error: "not found" } };
    const patch: Record<string, unknown> = {};
    if (v?.title !== undefined) { const t = sanitizeText(v.title, 200); if (t) patch.title = t; }
    if (v?.due !== undefined) patch.due = validDue(v.due);
    if (v?.weight !== undefined) patch.weight = clamp(Number(v.weight) || 0, 0, 100);
    if (v?.size !== undefined) patch.size = clamp(Math.round(Number(v.size) || 2), 1, 3);
    if (v?.course_id !== undefined && await courses.get(String(v.course_id))) patch.course_id = String(v.course_id);
    if (Object.keys(patch).length) await work.upsert(id, patch);
    return ok();
  }

  return { status: 404, body: { error: "not found" } };
}

onUiMessage(async (sfiId, data, peer) => {
  if (!sfiId || typeof data !== "object" || data === null) return;
  const d = data as Record<string, unknown>;
  if (typeof d.op !== "string") return;
  const r = await handleWrite(sfiId, d.op, d, peer);
  if (r.status !== 200) log(`assignments: bus op ${d.op} → ${r.status} (${JSON.stringify(r.body)})`);
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

log("Assignments frame is up and running!");
