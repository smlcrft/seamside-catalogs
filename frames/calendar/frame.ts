// ----------------------------------------------------------------------------------------
// Calendar — a simple shared calendar, one per space (sfi_id).
//
// Design axes:
//   privacy:        privacy-public-view  — editors add/change events; everyone else gets a
//                                           read-only view. Whether a non-member can reach this
//                                           frame at all is the platform's call (the space's tier
//                                           and whether the frame is published), never the frame's
//                                           — if a request lands here, the viewer may see it.
//   data_storage:   the space's table    — `_fdata/calendar.table.jsonl`, one row
//                                           per event (row id = event id): synced with the space
//                                           to every member, openable in any table tool. Two
//                                           editors changing different events never collide.
//   view_realtime:  view-collaborative   — every mutation pushes that the events changed, never
//                                           what they hold; each open page reads again.
//   settings_scope: settings-per-space   — the table is the space's; the frame keeps nothing else.
//
// Events are either one-time (a specific YYYY-MM-DD) or weekly-recurring (a set of weekdays,
// e.g. Mon/Wed/Fri). Recurrence is expanded for display on the frontend; the backend only stores.
// ----------------------------------------------------------------------------------------
import type { Ctx } from "@frame-core";

// ----- Calendar shape -------------------------------------------------------------------
// A recurring event never extends back before `start` (its creation day) and runs until `until`
// (inclusive) — or forever when `until` is "". `skip` is a set of source dates (the recurrence's
// own calendar days, authored-zone "YYYY-MM-DD") that have been individually removed — this is how
// "delete only this day" is represented without touching the rest of the series.
type Recur = { days: number[]; start: string; until: string; skip: string[] } | null;   // weekly on weekday indices (0 = Sun … 6 = Sat)
type CalEvent = {
  id: string;
  title: string;
  date: string;     // "YYYY-MM-DD" for one-time events; "" when recurring
  time: string;     // "HH:MM" (24h) or "" for an all-day entry
  tz: string;       // IANA zone the time/date was authored in (e.g. "America/New_York").
                    // Only meaningful for timed events — the frontend shifts them into each
                    // viewer's local zone. Empty = "floating" (all-day, or a row written without one): no
                    // shift, shown as-is everywhere.
  dur: number;      // duration in minutes (0 = none); only meaningful for timed events
  color: string;    // "c1".."c12", or "" to inherit the space accent
  url: string;      // optional http(s)/mailto/tel link, or ""
  note: string;
  recur: Recur;     // null = one-time
};
type Settings = Record<string, never>;

// Caps — keep disk + rendering bounded.
const MAX_EVENTS = 1000;
const MAX_TITLE = 140;
const MAX_NOTE = 1000;
const MAX_URL = 2048;

const PALETTES = ["c1","c2","c3","c4","c5","c6","c7","c8","c9","c10","c11","c12"];
const ID_RE = /^[0-9A-Za-z_-]{8,64}$/;   // a UUID from here, or a row id a table tool made
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const TZ_RE = /^[A-Za-z0-9_+\-/]{1,64}$/;   // IANA zone id shape ("Area/City", "UTC", "Etc/GMT+5")
const URL_RE = /^(https?:\/\/|mailto:|tel:)/i;

function todayIso(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}

// ----- The events table -----------------------------------------------------------------
const events = (ctx: Ctx) => ctx.shared.table<Record<string, unknown>>("calendar");

async function loadEvents(ctx: Ctx): Promise<CalEvent[]> {
  const rows = (await events(ctx).all())
    .sort((a, b) => (Number(a._created_at) || 0) - (Number(b._created_at) || 0));
  return rows.map((r) => sanitizeEvent(r)).filter(Boolean) as CalEvent[];
}
// Laid over what the row held, stamped when it was made and when it changed.
async function saveEvent(ctx: Ctx, ev: CalEvent): Promise<void> {
  const was = await events(ctx).get(ev.id);
  const now = Date.now();
  await events(ctx).upsert({ ...(was ?? { _created_at: now }), ...ev, _modified_at: now });
}

// ----- Validation -----------------------------------------------------------------------
function str(v: unknown, max: number): string { return String(v ?? "").slice(0, max); }
function oneOf(v: unknown, allowed: string[], def: string): string {
  const s = String(v ?? ""); return allowed.includes(s) ? s : def;
}

function sanitizeRecur(v: any): Recur {
  if (!v || !Array.isArray(v.days)) return null;
  const days = [...new Set<number>(
    v.days.map((d: unknown) => Number(d)).filter((d: number) => Number.isInteger(d) && d >= 0 && d <= 6),
  )].sort((a, b) => a - b);
  if (!days.length) return null;
  // start = the day the series begins (its creation day); recurrence never extends before it.
  const start = DATE_RE.test(String(v.start || "")) ? String(v.start) : todayIso();
  // until = inclusive end date; "" means "repeats forever". A backwards range collapses to forever.
  let until = DATE_RE.test(String(v.until || "")) ? String(v.until) : "";
  if (until && until < start) until = "";
  // skip = individually-removed occurrence dates ("delete only this day").
  const skip = Array.isArray(v.skip)
    ? [...new Set(v.skip.filter((s: unknown) => DATE_RE.test(String(s))).map(String))].slice(0, 1000) as string[]
    : [];
  return { days, start, until, skip };
}

function sanitizeUrl(v: unknown): string {
  const s = String(v ?? "").trim().slice(0, MAX_URL);
  return URL_RE.test(s) ? s : "";
}

function sanitizeEvent(e: any): CalEvent | null {
  if (!e || typeof e !== "object") return null;
  const title = str(e.title, MAX_TITLE).trim();
  if (!title) return null;   // a titleless event is meaningless — drop it
  const id = ID_RE.test(String(e.id || "")) ? String(e.id) : crypto.randomUUID();
  const recur = sanitizeRecur(e.recur);
  const date = !recur && DATE_RE.test(String(e.date || "")) ? String(e.date) : "";
  // A one-time event must carry a valid date; if it lost its date, drop it.
  if (!recur && !date) return null;
  const time = TIME_RE.test(String(e.time || "")) ? String(e.time) : "";
  // A zone only matters for timed events; drop it for all-day so they stay floating.
  const tz = time && TZ_RE.test(String(e.tz || "")) ? String(e.tz) : "";
  // Duration only applies to timed events; clamp to a single day.
  let dur = 0;
  if (time) { const n = Number(e.dur); if (Number.isInteger(n) && n > 0) dur = Math.min(n, 1440); }
  const color = oneOf(e.color, PALETTES, "");
  const url = sanitizeUrl(e.url);
  return { id, title, date, time, tz, dur, color, url, note: str(e.note, MAX_NOTE), recur };
}

// ----- State for a peer -----------------------------------------------------------------
// Reads are open to every viewer who reaches the frame; the identity flags only decide which
// controls the frontend renders. Writes are gated per-endpoint on the editor rung below.
async function stateFor(ctx: Ctx) {
  const peer = ctx.peer;
  const list = await loadEvents(ctx);
  const me = {
    is_anon: peer.is_anon, is_sfi_member: peer.is_sfi_member,
    is_sfi_editor: peer.is_sfi_editor, is_owner: peer.is_owner,
    user_name: peer.user_name, space_color: peer.space_color,
  };
  const settings: Settings = {};
  return { me, settings, events: list };
}

// ----- Mutations ------------------------------------------------------------------------
const json = (v: unknown, status = 200) => Response.json(v, { status });
const isEditor = (ctx: Ctx) => ctx.peer.is_sfi_editor || ctx.peer.is_owner;

// What changed, never what it holds: each page reads again as whoever it is.
const tell = (ctx: Ctx) => ctx.push({ calendar: "events" });

// deno-lint-ignore no-explicit-any
async function body(request: Request): Promise<any> {
  try {
    const v = JSON.parse(await request.text());
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

// Create or update one event — editors only. id present + known → update; else insert.
// deno-lint-ignore no-explicit-any
async function mutEvent(ctx: Ctx, v: { event?: any }): Promise<Response> {
  if (!isEditor(ctx)) return json({ error: "editors only" }, 403);
  const ev = sanitizeEvent(v.event);
  if (!ev) return json({ error: "invalid event" }, 400);
  if (!(await events(ctx).get(ev.id)) && (await loadEvents(ctx)).length >= MAX_EVENTS) {
    return json({ error: "calendar is full" }, 413);
  }
  await saveEvent(ctx, ev);
  tell(ctx);
  return json({ ok: true, id: ev.id });
}

// Delete one event — editors only.
async function mutEventDelete(ctx: Ctx, v: { id?: unknown }): Promise<Response> {
  if (!isEditor(ctx)) return json({ error: "editors only" }, 403);
  const id = String(v.id || "");
  if (ID_RE.test(id) && await events(ctx).get(id)) {
    await events(ctx).delete(id);
    tell(ctx);
  }
  return json({ ok: true });
}

// ----- Networking -----------------------------------------------------------------------
export default {
  async fetch(request: Request, ctx: Ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    const method = request.method;

    // Static assets — open to everyone (read-only viewers still need the shell).
    if (method === "GET" && !pathname.startsWith("/api/")) return ctx.file(pathname);

    // Full calendar + identity in one round trip. Open to every viewer who reaches the frame.
    if (pathname === "/api/state" && method === "GET") return json(await stateFor(ctx));

    if (pathname === "/api/event" && method === "POST") return mutEvent(ctx, await body(request));
    if (pathname === "/api/event_delete" && method === "POST") return mutEventDelete(ctx, await body(request));

    return json({ error: "not found" }, 404);
  },
};
