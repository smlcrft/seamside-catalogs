// ----------------------------------------------------------------------------------------
// Chore Chart — who does what around the house, and how it's going.
//
// Design axes:
//   privacy:        privacy-public-view  — non-members get a live read-only board;
//                                           space editors get the interactive one. The page
//                                           reads no table: the board comes from
//                                           GET /api/list, and every write is a route here.
//   data_storage:   the space's table    — `_fdata/chores.table.jsonl`, frame data,
//                                           synced with the space; any frame in the space
//                                           that speaks `chores` works on the same rows.
//   view_realtime:  view-collaborative    — every write pushes `{ chore_chart: "chores" }`,
//                                           which says what to read again and never what
//                                           it holds. Ticking a chore off on the kitchen
//                                           tablet lands on every other device instantly.
//
// This frame OWNS the `chores` v1 contract (docs/schema-contracts.md). The chart is
// deliberately about the CURRENT turn of each chore rather than a growing history: a row
// carries when it was last done and how long a streak it is on, and the "done" state is
// DERIVED by comparing that timestamp's period to now. That is what lets a weekly chore
// come back by itself on Monday without anything having to run on a schedule — a chart
// that needed one would silently rot on a sleeping device.
// ----------------------------------------------------------------------------------------
import type { Ctx } from "@frame-core";
import { sanitizeText } from "@frame-core";

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
const CHORES = "chores";

type Row = Record<string, unknown> & { id: string };

const chores = (ctx: Ctx) => ctx.shared.table<Record<string, unknown>>(CHORES);

/** What a new row holds before anything is said of it: the schema's own defaults. */
const DEFAULTS: Record<string, unknown> = Object.fromEntries(
  CHORES_SCHEMA.map((c) => [c.name, c.col_type === "integer" ? Number(c.default_val) : c.default_val]),
);

/** Write a row over what it held (a new one from the schema's defaults), stamped. */
async function keep(ctx: Ctx, id: string | null, values: Record<string, unknown>): Promise<Row> {
  const was = id ? await chores(ctx).get(id) : null;
  const now = Date.now();
  return await chores(ctx).upsert({
    ...(was ?? { ...DEFAULTS, _created_at: now }),
    ...values,
    ...(id ? { id } : {}),
    _modified_at: now,
  });
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

// ----- Queries --------------------------------------------------------------------------
const cmp = (a: unknown, b: unknown) =>
  typeof a === "number" && typeof b === "number" ? a - b : String(a ?? "").localeCompare(String(b ?? ""));

async function listRows(ctx: Ctx) {
  const rows = (await chores(ctx).all()).sort((a, b) =>
    (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) || cmp(a._created_at, b._created_at));
  const now = Date.now();
  return rows.map((r) => {
    const cadence = asCadence(r.cadence);
    return {
      id: r.id,
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
async function nextOrder(ctx: Ctx): Promise<number> {
  const rows = await chores(ctx).all();
  return rows.length ? Math.max(...rows.map((r) => Number(r.sort_order) || 0)) + 1 : 0;
}

// What changed, never what it holds: each page reads again as whoever it is.
const tell = (ctx: Ctx) => ctx.push({ chore_chart: "chores" });

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

// ----- Writes ---------------------------------------------------------------------------
// `op` is the API path with the leading "/api/" stripped.
// deno-lint-ignore no-explicit-any
async function write(ctx: Ctx, op: string, v: Record<string, any> | null): Promise<Response> {
  // Every op below mutates state and is editor-only. Non-members AND Viewer-role members
  // are rejected with the same gate. Ticking a chore off is a write like any other: a
  // public viewer watches the chart, they don't do the dishes on someone else's behalf.
  if (!(ctx.peer.is_sfi_editor || ctx.peer.is_owner)) return json({ error: "editors only" }, 403);

  const ok = async () => {
    tell(ctx);
    return json({ chores: await listRows(ctx) });
  };

  // --- Chores ---------------------------------------------------------------------------
  if (op === "chore") {
    const chore = sanitizeText(v?.chore, 200);
    if (!chore) return json({ error: "chore required" }, 400);
    await keep(ctx, null, {
      chore,
      assignee: sanitizeText(v?.assignee, 60),
      cadence: asCadence(v?.cadence),
      last_done_ms: 0, last_done_by: "", streak: 0,
      sort_order: await nextOrder(ctx),
      notes: "",
    });
    return ok();
  }

  if (op.startsWith("chore/")) {
    const [id, action] = op.slice("chore/".length).split("/");
    const row = id ? await chores(ctx).get(id) : null;
    if (!row) return json({ error: "bad id" }, 400);

    if (action === "delete") {
      await chores(ctx).delete(id);
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
      await keep(ctx, id, {
        last_done_ms: now,
        last_done_by: sanitizeText(ctx.peer.user_name, 60),
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
      await keep(ctx, id, {
        last_done_ms: 0, last_done_by: "",
        streak: Math.max(0, (Number(row.streak) || 0) - 1),
      });
      return ok();
    }

    if (action) return json({ error: "not found" }, 404);

    const next: Record<string, unknown> = {};
    if (v?.chore !== undefined) {
      const chore = sanitizeText(v.chore, 200);
      if (chore) next.chore = chore;
    }
    if (v?.assignee !== undefined) next.assignee = sanitizeText(v.assignee, 60);
    if (v?.cadence !== undefined) next.cadence = asCadence(v.cadence);
    if (v?.notes !== undefined) next.notes = sanitizeText(v.notes, 500);
    if (Object.keys(next).length) await keep(ctx, id, next);
    return ok();
  }

  return json({ error: "not found" }, 404);
}

// ----- Networking -----------------------------------------------------------------------
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

    // Read — open to everyone (non-members get a read-only view of the chart).
    // No seeding: an empty chart is an honest empty chart.
    if (pathname === "/api/list" && request.method === "GET") return json({ chores: await listRows(ctx) });

    return json({ error: "not found" }, 404);
  },
};
