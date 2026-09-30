// ----------------------------------------------------------------------------------------
// Habit Tracker — one line per habit, one square per day.
//
// Design axes:
//   privacy:        privacy-public-view  — non-members watch the grid; space editors mark.
//   data_storage:   the space's frame data — `habits` and `habit_marks`
//                                           (`_fdata/<name>.table.jsonl`), synced with the space. No
//                                           contract: nothing else acts on these rows
//                                           (docs/schema-contracts.md, "When NOT to write a
//                                           contract").
//   view_realtime:  view-collaborative    — every write pushes `{ habit_tracker: "habits" }`,
//                                           which says what to read again and never what
//                                           it holds, so a shared habit fills in on
//                                           everyone's grid at once.
//
// The page reads no table: the grid comes from GET /api/list, and every write is a route
// here, gated on who the door says is asking.
//
// A DAY IS A STRING, and that is deliberate. The chore chart learned the hard way that
// deriving a day number from a timestamp invites timezone bugs: a local-midnight value
// floors to the previous day anywhere east of UTC. Here a mark stores the calendar date it
// belongs to as `yyyy-mm-dd`, computed from local calendar fields, so a square means the
// day the person was living in and no arithmetic can slide it. Marks are sparse rows — one
// per completed day — rather than a field on the habit, so the row can't grow without
// bound and two devices marking different days never collide.
// ----------------------------------------------------------------------------------------
import type { Ctx } from "@frame-core";
import { sanitizeText, declareTables } from "@frame-core";

const HABITS = "habits";
const MARKS = "habit_marks";

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
  { key: HABITS, title: "Habits",      description: "Habits tracked in this space.", schema: HABITS_SCHEMA },
  { key: MARKS,  title: "Habit marks", description: "One row per habit per completed day.", schema: MARKS_SCHEMA },
]);

type Row = Record<string, unknown> & { id: string };
type Schema = typeof HABITS_SCHEMA;

const rows = (ctx: Ctx, name: string) => ctx.shared.table<Record<string, unknown>>(name);

const defaults = (schema: Schema) => Object.fromEntries(
  schema.map((c) => [c.name, c.col_type === "integer" ? Number(c.default_val) : c.default_val]),
);
const DEFAULTS: Record<string, Record<string, unknown>> = {
  [HABITS]: defaults(HABITS_SCHEMA),
  [MARKS]: defaults(MARKS_SCHEMA),
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

function cmp(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a ?? "").localeCompare(String(b ?? ""));
}

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

async function readAll(ctx: Ctx) {
  const hrows = (await rows(ctx, HABITS).all()).sort((a, b) => cmp(a.sort_order, b.sort_order));
  const mrows = (await rows(ctx, MARKS).all()).slice(0, 5000);
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
      id: h.id,
      name: h.name,
      sort_order: Number(h.sort_order) || 0,
      days: (byHabit[h.id] || []).sort(),
    })),
  };
}

const json = (v: unknown, status = 200) => Response.json(v, { status });

// deno-lint-ignore no-explicit-any
async function body(request: Request): Promise<Record<string, any> | null> {
  try {
    const v = JSON.parse(await request.text());
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

// `op` is the API path with the leading "/api/" stripped.
async function handleWrite(ctx: Ctx, op: string, v: Record<string, unknown> | null): Promise<Response> {
  if (!(ctx.peer.is_sfi_editor || ctx.peer.is_owner)) return json({ error: "editors only" }, 403);

  const habits = rows(ctx, HABITS);
  const marks = rows(ctx, MARKS);
  const today = dayString(Date.now());

  // What changed, never what it holds: each page reads again as whoever it is.
  const ok = async (): Promise<Response> => {
    ctx.push({ habit_tracker: "habits" });
    return json(await readAll(ctx));
  };

  if (op === "habit") {
    const name = sanitizeText(v?.name, 80);
    if (!name) return json({ error: "name required" }, 400);
    const all = await habits.all();
    const next = all.length ? Math.max(...all.map((h) => Number(h.sort_order) || 0)) + 1 : 0;
    await keep(ctx, HABITS, null, { name, sort_order: next, created_ms: Date.now() });
    return ok();
  }

  if (op.startsWith("habit/")) {
    const [id, action] = op.slice("habit/".length).split("/");
    if (!id || !(await habits.get(id))) return json({ error: "bad id" }, 400);
    if (action === "delete") {
      // Take the marks with it: an orphaned mark is invisible and would quietly come back
      // to life if a new habit were ever given the same row id.
      for (const m of await marks.all()) if (m.habit_id === id) await marks.delete(m.id);
      await habits.delete(id);
      return ok();
    }
    if (action) return json({ error: "not found" }, 404);
    if (v?.name !== undefined) {
      const name = sanitizeText(v.name, 80);
      if (name) await keep(ctx, HABITS, id, { name });
    }
    return ok();
  }

  // Toggle one day of one habit. Idempotent in both directions: marking a day already
  // marked is a no-op rather than a duplicate row, which matters because two devices can
  // tap the same square at once.
  if (op === "mark") {
    const hid = String(v?.habit_id ?? "");
    if (!hid || !(await habits.get(hid))) return json({ error: "bad habit" }, 400);
    const day = validDay(v?.day, today);
    if (!day) return json({ error: "bad day" }, 400);

    const found = (await marks.all()).filter((m) => m.habit_id === hid && m.day === day).slice(0, 2);
    const want = !!v?.done;
    if (want && found.length === 0) {
      await keep(ctx, MARKS, null, { habit_id: hid, day, made_ms: Date.now() });
    } else if (!want) {
      for (const r of found) await marks.delete(r.id);
    }
    return ok();
  }

  return json({ error: "not found" }, 404);
}

export default {
  async fetch(request: Request, ctx: Ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    const method = request.method;
    const editor = ctx.peer.is_sfi_editor || ctx.peer.is_owner;
    const member = editor || ctx.peer.is_sfi_member;

    if (method === "GET" && !pathname.startsWith("/api/")) return ctx.file(pathname);

    if (pathname === "/api/whoami" && method === "GET") {
      return json({
        is_anon:       ctx.peer.is_anon,
        is_sfi_member: member,
        is_sfi_editor: editor,
        is_owner:      ctx.peer.is_owner,
        user_id:       ctx.peer.user_id,
        user_name:     ctx.peer.user_name,
        space_color:   ctx.peer.space_color,
      });
    }

    if (pathname.startsWith("/api/") && (method === "POST" || method === "PUT")) {
      return handleWrite(ctx, pathname.slice("/api/".length), await body(request));
    }

    if (pathname === "/api/list" && method === "GET") return json(await readAll(ctx));

    return json({ error: "not found" }, 404);
  },
};
