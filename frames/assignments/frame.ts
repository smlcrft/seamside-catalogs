// ----------------------------------------------------------------------------------------
// Assignments — what's due, and where you stand.
//
// Design axes:
//   privacy:        privacy-public-view  — a study group sees the same board, through
//                                           GET /api/list; space editors add and tick,
//                                           every write a route here.
//   data_storage:   the space's tables   — `assignments.table.jsonl` (the work) and
//                                           `assignments_courses.table.jsonl`, in the space's
//                                           frame data folder `_fdata/`, synced with it. Named for this frame:
//                                           courses are its own data, not a contract other
//                                           frames share (see "When NOT to write a contract"
//                                           in docs/schema-contracts.md).
//   view_realtime:  view-collaborative    — every write pushes what to read again.
//   settings_scope: settings-per-sfi
//
// THE ARITHMETIC IS THE PRODUCT. Anyone can list due dates; the reason students keep this
// in a spreadsheet is the weighted grade, so it is computed HERE — one implementation, one
// set of rounding decisions — rather than in the frontend where an optimistic update could
// briefly show a number that was never true.
// ----------------------------------------------------------------------------------------
import type { Ctx } from "@frame-core";
import { sanitizeText } from "@frame-core";

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

type Row = Record<string, unknown> & { id: string };

const rows = (ctx: Ctx, name: string) => ctx.shared.table<Record<string, unknown>>(name);

/** What a new row holds before anything is said of it: the schema's own defaults. */
const defaultsOf = (schema: { name: string; col_type: string; default_val: string }[]) =>
  Object.fromEntries(schema.map((c) => [c.name, c.col_type === "text" ? c.default_val : Number(c.default_val)]));
const DEFAULTS: Record<string, Record<string, unknown>> = {
  [COURSES]: defaultsOf(COURSES_SCHEMA),
  [WORK]: defaultsOf(WORK_SCHEMA),
};

/** Write a row over what it held (a new one from the schema's defaults), stamped. */
async function keep(ctx: Ctx, name: string, id: string | null, values: Record<string, unknown>): Promise<Row> {
  const was = id ? await rows(ctx, name).get(id) : null;
  const now = Date.now();
  return await rows(ctx, name).upsert({
    ...(was ?? { ...DEFAULTS[name], _created_at: now }),
    ...values,
    ...(id ? { id } : {}),
    _modified_at: now,
  });
}

const bySortOrder = (a: Row, b: Row) =>
  (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) || (Number(a._created_at) || 0) - (Number(b._created_at) || 0);

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

async function readAll(ctx: Ctx) {
  const crows = (await rows(ctx, COURSES).all()).sort(bySortOrder);
  const wrows = (await rows(ctx, WORK).all()).slice(0, 2000);

  const work: WorkRow[] = wrows.map((r) => ({
    id: r.id, course_id: String(r.course_id || ""), title: String(r.title || ""),
    due: String(r.due || ""), weight: Number(r.weight) || 0,
    size: clamp(Number(r.size) || 2, 1, 3),
    earned: Number(r.earned), possible: Number(r.possible) || 0,
    done: !!Number(r.done), added_ms: Number(r.added_ms) || 0,
  }));

  const byCourse: Record<string, WorkRow[]> = {};
  for (const w of work) (byCourse[w.course_id] ||= []).push(w);

  const courses = crows.map((c) => {
    const id = String(c.id);
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

const json = (v: unknown, status = 200) => Response.json(v, { status });

// `op` is the API path with "/api/" stripped.
async function handleWrite(ctx: Ctx, op: string, v: Record<string, unknown> | null): Promise<Response> {
  if (!(ctx.peer.is_sfi_editor || ctx.peer.is_owner)) return json({ error: "editors only" }, 403);
  const courses = rows(ctx, COURSES);
  const work = rows(ctx, WORK);

  // What changed, never what it holds: each page reads again as whoever it is.
  const ok = () => { ctx.push({ assignments: "board" }); return json({ ok: true }); };

  // --- Courses --------------------------------------------------------------------------
  if (op === "course") {
    const name = sanitizeText(v?.name, 100);
    if (!name) return json({ error: "name required" }, 400);
    const all = await courses.all();
    const next = all.length ? Math.max(...all.map((c) => Number(c.sort_order) || 0)) + 1 : 0;
    await keep(ctx, COURSES, null, { name, credits: clamp(Number(v?.credits) || 3, 0, 20), sort_order: next });
    return ok();
  }
  if (op.startsWith("course/")) {
    const [id, action] = op.slice("course/".length).split("/");
    if (!id || !(await courses.get(id))) return json({ error: "bad id" }, 400);
    if (action === "delete") {
      // Take the work with it — an assignment whose course is gone is invisible and would
      // silently keep counting toward nothing.
      for (const w of await work.all()) if (w.course_id === id) await work.delete(w.id);
      await courses.delete(id);
      return ok();
    }
    if (action) return json({ error: "not found" }, 404);
    const patch: Record<string, unknown> = {};
    if (v?.name !== undefined) { const n = sanitizeText(v.name, 100); if (n) patch.name = n; }
    if (v?.credits !== undefined) patch.credits = clamp(Number(v.credits) || 0, 0, 20);
    if (Object.keys(patch).length) await keep(ctx, COURSES, id, patch);
    return ok();
  }

  // --- Work -----------------------------------------------------------------------------
  if (op === "work") {
    const title = sanitizeText(v?.title, 200);
    if (!title) return json({ error: "title required" }, 400);
    const courseId = String(v?.course_id ?? "");
    if (!courseId || !(await courses.get(courseId))) return json({ error: "pick a course" }, 400);
    await keep(ctx, WORK, null, {
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
    if (!row) return json({ error: "bad id" }, 400);
    if (action === "delete") { await work.delete(id); return ok(); }
    if (action === "done") { await keep(ctx, WORK, id, { done: Number(v?.done) ? 1 : 0 }); return ok(); }
    if (action === "grade") {
      // A score of "" clears the mark back to ungraded rather than storing 0 — those mean
      // very different things to the average.
      const raw = String(v?.earned ?? "").trim();
      if (raw === "") { await keep(ctx, WORK, id, { earned: -1 }); return ok(); }
      const earned = Number(raw);
      if (!Number.isFinite(earned) || earned < 0) return json({ error: "bad score" }, 400);
      const patch: Record<string, unknown> = { earned, done: 1 };
      if (v?.possible !== undefined) patch.possible = clamp(Number(v.possible) || 0, 0, 100000);
      await keep(ctx, WORK, id, patch);
      return ok();
    }
    if (action) return json({ error: "not found" }, 404);
    const patch: Record<string, unknown> = {};
    if (v?.title !== undefined) { const t = sanitizeText(v.title, 200); if (t) patch.title = t; }
    if (v?.due !== undefined) patch.due = validDue(v.due);
    if (v?.weight !== undefined) patch.weight = clamp(Number(v.weight) || 0, 0, 100);
    if (v?.size !== undefined) patch.size = clamp(Math.round(Number(v.size) || 2), 1, 3);
    if (v?.course_id !== undefined && await courses.get(String(v.course_id))) patch.course_id = String(v.course_id);
    if (Object.keys(patch).length) await keep(ctx, WORK, id, patch);
    return ok();
  }

  return json({ error: "not found" }, 404);
}

async function body(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const v = JSON.parse(await request.text());
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

export default {
  async fetch(request: Request, ctx: Ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    const method = request.method;

    if (method === "GET" && !pathname.startsWith("/api/")) return ctx.file(pathname);

    if (pathname === "/api/whoami" && method === "GET") {
      const peer = ctx.peer;
      const editor = peer.is_sfi_editor || peer.is_owner;
      return json({
        is_anon:       peer.is_anon,
        is_sfi_member: editor || peer.is_sfi_member,
        is_sfi_editor: editor,
        is_owner:      peer.is_owner,
        user_id:       peer.user_id,
        user_name:     peer.user_name,
        space_color:   peer.space_color,
      });
    }

    if (pathname.startsWith("/api/") && (method === "POST" || method === "PUT")) {
      return handleWrite(ctx, pathname.slice("/api/".length), await body(request));
    }

    if (pathname === "/api/list" && method === "GET") return json(await readAll(ctx));

    return json({ error: "not found" }, 404);
  },
};
