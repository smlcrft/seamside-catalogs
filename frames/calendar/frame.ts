// ----------------------------------------------------------------------------------------
// Calendar — a simple shared calendar, one per placement (sfi_id).
//
// Design axes:
//   privacy:        privacy-public-view  — editors add/change events; everyone else gets a
//                                           read-only view. Whether a non-member can reach this
//                                           frame at all is the platform's call (public sharing on
//                                           the placement), never the frame's — if a request lands
//                                           here, the viewer is allowed to see the calendar.
//   data_storage:   storage-simple-files — the whole calendar lives in a single cal.json under a
//                                           per-sfi folder. No DB / SyncTable.
//   view_realtime:  view-collaborative   — every mutation calls pushToInstance so all viewers of
//                                           the placement refresh live.
//   settings_scope: settings-per-sfi     — everything is keyed by peer.sfi_id.
//
// Events are either one-time (a specific YYYY-MM-DD) or weekly-recurring (a set of weekdays,
// e.g. Mon/Wed/Fri). Recurrence is expanded for display on the frontend; the backend only stores.
// ----------------------------------------------------------------------------------------
import {
  log, jsonReply, parseJsonBody, parsePeerInfo, pushToInstance, onUiMessage,
  frameDataDir, serveFileAtPath, path,
} from "@frame-core";

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
                    // viewer's local zone. Empty = "floating" (all-day, or legacy events): no
                    // shift, shown as-is everywhere.
  dur: number;      // duration in minutes (0 = none); only meaningful for timed events
  color: string;    // "c1".."c12", or "" to inherit the space accent
  url: string;      // optional http(s)/mailto/tel link, or ""
  note: string;
  recur: Recur;     // null = one-time
};
type Settings = Record<string, never>;
type Cal = { settings: Settings; events: CalEvent[] };

const DEFAULT_CAL: Cal = { settings: {}, events: [] };

// Caps — keep disk + rendering bounded.
const MAX_EVENTS = 1000;
const MAX_TITLE = 140;
const MAX_NOTE = 1000;
const MAX_URL = 2048;

const PALETTES = ["c1","c2","c3","c4","c5","c6","c7","c8","c9","c10","c11","c12"];
const ID_RE = /^[0-9a-fA-F-]{8,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const TZ_RE = /^[A-Za-z0-9_+\-/]{1,64}$/;   // IANA zone id shape ("Area/City", "UTC", "Etc/GMT+5")
const URL_RE = /^(https?:\/\/|mailto:|tel:)/i;

function todayIso(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}

// ----- Files on disk --------------------------------------------------------------------
// data/cals/<sfi_slug>/cal.json
const CALS_DIR = path.join(frameDataDir(import.meta.url), "cals");
function sfiSlug(sfiId: string): string {
  return (sfiId || "").replace(/[^a-zA-Z0-9_-]/g, "_") || "default";
}
function calDir(sfiId: string): string { return path.join(CALS_DIR, sfiSlug(sfiId)); }
function calFile(sfiId: string): string { return path.join(calDir(sfiId), "cal.json"); }

function loadCal(sfiId: string): Cal {
  try {
    const raw = Deno.readTextFileSync(calFile(sfiId));
    return sanitizeCal(JSON.parse(raw));
  } catch { return structuredClone(DEFAULT_CAL); }
}
function saveCal(sfiId: string, cal: Cal): void {
  Deno.mkdirSync(calDir(sfiId), { recursive: true });
  Deno.writeTextFileSync(calFile(sfiId), JSON.stringify(cal, null, 2));
}

// ----- Validation -----------------------------------------------------------------------
function str(v: unknown, max: number): string { return String(v ?? "").slice(0, max); }
function oneOf(v: unknown, allowed: string[], def: string): string {
  const s = String(v ?? ""); return allowed.includes(s) ? s : def;
}

function sanitizeRecur(v: any): Recur {
  if (!v || !Array.isArray(v.days)) return null;
  const days = [...new Set(
    v.days.map((d: unknown) => Number(d)).filter((d: number) => Number.isInteger(d) && d >= 0 && d <= 6),
  )].sort((a, b) => a - b) as number[];
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

function sanitizeCal(raw: any): Cal {
  const s = raw && typeof raw === "object" ? raw : {};
  // Legacy cal.json may carry settings.isPublic (the old frame-side gate) and
  // settings.palette (the old frame-picked accent); both are dropped here — the
  // frame follows the space channel now.
  const settings: Settings = {};
  const eventsIn = Array.isArray(s.events) ? s.events.slice(0, MAX_EVENTS) : [];
  const events = eventsIn.map(sanitizeEvent).filter(Boolean) as CalEvent[];
  return { settings, events };
}

// ----- State for a peer -----------------------------------------------------------------
// Reads are open to every viewer who reaches the frame; the identity flags only decide which
// controls the frontend renders. Writes are gated per-endpoint on is_sfi_editor below.
function stateFor(peer: ReturnType<typeof parsePeerInfo>) {
  const cal = loadCal(peer.sfi_id);
  const me = {
    is_anon: peer.is_anon, is_sfi_member: peer.is_sfi_member,
    is_sfi_editor: peer.is_sfi_editor, is_owner: peer.is_owner,
    user_name: peer.user_name, space_color: peer.space_color,
  };
  return { me, settings: cal.settings, events: cal.events };
}

// ----- Mutations ------------------------------------------------------------------------
// Shared by the HTTP arms and the bus dispatcher — the two entry points must never drift
// on validation or role gates. Role gates live here.
type MutPeer = ReturnType<typeof parsePeerInfo>;
type MutResult = { status: number; body: unknown };

// Create or update one event — editors only. id present + known → update; else insert.
function mutEvent(sfiId: string, v: { event?: any; by?: unknown }, peer: MutPeer): MutResult {
  if (!peer.is_sfi_editor) return { status: 403, body: { error: "editors only" } };
  const ev = sanitizeEvent(v.event);
  if (!ev) return { status: 400, body: { error: "invalid event" } };
  const cal = loadCal(sfiId);
  const i = cal.events.findIndex((e) => e.id === ev.id);
  if (i >= 0) cal.events[i] = ev;
  else {
    if (cal.events.length >= MAX_EVENTS) return { status: 413, body: { error: "calendar is full" } };
    cal.events.push(ev);
  }
  saveCal(sfiId, cal);
  pushToInstance(sfiId, { type: "cal_changed", by: str(v.by, 64) });
  return { status: 200, body: { ok: true, id: ev.id } };
}

// Delete one event — editors only.
function mutEventDelete(sfiId: string, v: { id?: unknown; by?: unknown }, peer: MutPeer): MutResult {
  if (!peer.is_sfi_editor) return { status: 403, body: { error: "editors only" } };
  const id = String(v.id || "");
  const cal = loadCal(sfiId);
  const next = cal.events.filter((e) => e.id !== id);
  if (next.length !== cal.events.length) {
    cal.events = next;
    saveCal(sfiId, cal);
    pushToInstance(sfiId, { type: "cal_changed", by: str(v.by, 64) });
  }
  return { status: 200, body: { ok: true } };
}

// ----- Bus dispatcher -------------------------------------------------------------------
// The frontend's write path (frame.busSend → BusUiToFrame → here). `peer` is the sender's
// platform-resolved identity, same shape as parsePeerInfo; the role gates live inside the
// mutation functions. Denials are logged, not answered — a legitimate client never sends
// a write it isn't allowed to make.
onUiMessage((sfiId, data, peer) => {
  if (!sfiId || typeof data !== "object" || data === null) return;
  const d = data as Record<string, unknown>;
  const r =
    d.op === "event"          ? mutEvent(sfiId, d, peer)
    : d.op === "event_delete" ? mutEventDelete(sfiId, d, peer)
    : null;
  if (r && r.status !== 200) log(`calendar: bus op ${d.op} → ${r.status} (${JSON.stringify(r.body)})`);
});

// ----- Networking -----------------------------------------------------------------------
self.onNetworkRequest = async function (replyPort, reqPath, method, headers, query, body, cookies) {
  const peer = parsePeerInfo(query, cookies);

  // Static assets — open to everyone (read-only viewers still need the shell).
  if (method === "GET" && !reqPath.startsWith("/api/")) {
    return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url), headers);
  }

  // Full calendar + identity in one round trip. Open to every viewer who reaches the frame.
  if (reqPath === "/api/state" && method === "GET") {
    return jsonReply(replyPort, 200, stateFor(peer));
  }

  // Writes — kept as HTTP arms for older viewers; same shared logic as the bus dispatcher.
  if (reqPath === "/api/event" && method === "POST") {
    const r = mutEvent(peer.sfi_id, parseJsonBody<{ event?: any; by?: unknown }>(body) || {}, peer);
    return jsonReply(replyPort, r.status, r.body);
  }
  if (reqPath === "/api/event_delete" && method === "POST") {
    const r = mutEventDelete(peer.sfi_id, parseJsonBody<{ id?: unknown; by?: unknown }>(body) || {}, peer);
    return jsonReply(replyPort, r.status, r.body);
  }

  return jsonReply(replyPort, 404, { error: "not found" });
};

log("Calendar frame is up and running!");
