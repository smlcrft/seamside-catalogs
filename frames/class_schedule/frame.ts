// ----------------------------------------------------------------------------------------
// Class Schedule — the week, laid out.
//
// Design axes:
//   privacy:        privacy-public-view  — a roommate or study group reads the same week;
//                                           space editors set it. The page reads no table:
//                                           the week comes from GET /api/list, and every
//                                           write is a route here, decided on ctx.peer.
//   data_storage:   the space's table   — `_fdata/class_schedule.table.jsonl`, frame data,
//                                           synced with it; no contract (docs/schema-contracts.md).
//   view_realtime:  view-collaborative    — every change pushes `{ class_schedule: "classes" }`,
//                                           which says what to read again, never what it holds.
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
import type { Ctx } from "@frame-core";
import { declareTables, sanitizeText } from "@frame-core";

const TABLE = "class_schedule";

const CLASSES_SCHEMA = [
  { name: "title",     col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "day",       col_type: "integer" as const, nullable: false, default_val: "0" },   // 0 = Monday
  { name: "start_min", col_type: "integer" as const, nullable: false, default_val: "540" }, // 09:00
  { name: "end_min",   col_type: "integer" as const, nullable: false, default_val: "600" },
  { name: "place",     col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "note",      col_type: "text"    as const, nullable: false, default_val: "" },
];

declareTables([
  { key: TABLE, title: "Classes", description: "Weekly class meetings for this space.", local: true, schema: CLASSES_SCHEMA },
]);

type Row = Record<string, unknown> & { id: string };

const classes = (ctx: Ctx) => ctx.shared.table<Record<string, unknown>>(TABLE);

const DEFAULTS: Record<string, unknown> = Object.fromEntries(
  CLASSES_SCHEMA.map((c) => [c.name, c.col_type === "integer" ? Number(c.default_val) : c.default_val]),
);

/** Write a row over what it held (a new one from the schema's defaults), stamped. */
async function keep(ctx: Ctx, id: string | null, values: Record<string, unknown>): Promise<Row> {
  const was = id ? await classes(ctx).get(id) : null;
  const now = Date.now();
  return await classes(ctx).upsert({
    ...(was ?? { ...DEFAULTS, _created_at: now }),
    ...values,
    ...(id ? { id } : {}),
    _modified_at: now,
  });
}

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

async function listRows(ctx: Ctx) {
  return (await classes(ctx).all()).map((r) => ({
    id: r.id,
    title: r.title,
    day: clampInt(r.day, 0, 6, 0),
    start_min: clampInt(r.start_min, 0, 1439, 540),
    end_min: clampInt(r.end_min, 1, 1440, 600),
    place: r.place,
    note: r.note,
  })).sort((a, b) => a.day - b.day || a.start_min - b.start_min);
}

// What changed, never what it holds: each page reads again as whoever it is.
const tell = (ctx: Ctx) => ctx.push({ class_schedule: "classes" });

const json = (v: unknown, status = 200) => Response.json(v, { status });

async function body(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const v = JSON.parse(await request.text());
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

// `op` is the API path with the leading "/api/" stripped.
async function write(ctx: Ctx, op: string, v: Record<string, unknown> | null): Promise<Response> {
  if (!(ctx.peer.is_sfi_editor || ctx.peer.is_owner)) return json({ error: "editors only" }, 403);
  const ok = () => { tell(ctx); return json({ ok: true }); };

  if (op === "class") {
    const title = sanitizeText(v?.title, 120);
    if (!title) return json({ error: "name it" }, 400);
    // One call, several days: the frontend lets you tick Mon/Wed/Fri and we write the
    // three meetings, so the tidy-looking model never has to exist.
    const daysIn = Array.isArray(v?.days) ? v!.days as unknown[] : [v?.day];
    const days = [...new Set(daysIn.map((d) => clampInt(d, 0, 6, 0)))];
    if (!days.length) return json({ error: "pick at least one day" }, 400);
    const { start, end } = normalizeTimes(v?.start_min, v?.end_min);
    const place = sanitizeText(v?.place, 80);
    for (const day of days) {
      await keep(ctx, null, { title, day, start_min: start, end_min: end, place, note: "" });
    }
    return ok();
  }

  if (op.startsWith("class/")) {
    const [id, action] = op.slice("class/".length).split("/");
    // Fetch once and keep it: the row is read three more times below, and re-fetching it
    // each time is both a round trip and three more places to forget the null check.
    const row = id ? await classes(ctx).get(id) : null;
    if (!id || !row) return json({ error: "bad id" }, 400);
    if (action === "delete") { await classes(ctx).delete(id); return ok(); }
    if (action === "delete_all") {
      // Drop every meeting of the same class — "I dropped this course" is one action, not
      // three deletions with the same name.
      for (const r of await classes(ctx).all()) {
        if (String(r.title) === String(row.title)) await classes(ctx).delete(r.id);
      }
      return ok();
    }
    if (action) return json({ error: "not found" }, 404);

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
        for (const r of await classes(ctx).all()) {
          if (r.id !== id && String(r.title) === was) await keep(ctx, r.id, { title: patch.title });
        }
      }
    }
    if (Object.keys(patch).length) await keep(ctx, id, patch);
    return ok();
  }

  return json({ error: "not found" }, 404);
}

export default {
  async fetch(request: Request, ctx: Ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    const editor = ctx.peer.is_sfi_editor || ctx.peer.is_owner;
    const member = editor || ctx.peer.is_sfi_member;

    if (request.method === "GET" && !pathname.startsWith("/api/")) return ctx.file(pathname);

    if (pathname === "/api/whoami" && request.method === "GET") {
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

    if (pathname.startsWith("/api/") && (request.method === "POST" || request.method === "PUT")) {
      return write(ctx, pathname.slice("/api/".length), await body(request));
    }

    // Read — open to everyone who reaches the frame.
    if (pathname === "/api/list" && request.method === "GET") return json({ classes: await listRows(ctx) });

    return json({ error: "not found" }, 404);
  },
};
