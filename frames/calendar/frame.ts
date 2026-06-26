// ----------------------------------------------------------------------------------------
// Calendar — a simple shared calendar, one per placement (sfi_id).
//
// Design axes:
//   privacy:        privacy-public-view  — editors add/change events; members get a read-only
//                                           view. A per-instance "public" toggle decides whether
//                                           NON-members (anon link visitors, bookmark-only users)
//                                           may see the calendar at all, or get a "private" panel.
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
  log, jsonReply, parseJsonBody, parsePeerInfo, pushToInstance,
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
type Settings = { palette: string; isPublic: boolean };
type Cal = { settings: Settings; events: CalEvent[] };

const DEFAULT_CAL: Cal = { settings: { palette: "c1", isPublic: false }, events: [] };

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
  const settings: Settings = {
    palette: oneOf(s.settings?.palette, PALETTES, "c1"),
    isPublic: s.settings?.isPublic === true,
  };
  const eventsIn = Array.isArray(s.events) ? s.events.slice(0, MAX_EVENTS) : [];
  const events = eventsIn.map(sanitizeEvent).filter(Boolean) as CalEvent[];
  return { settings, events };
}

// ----- State for a peer (applies the read-side privacy gate) ----------------------------
function stateFor(peer: ReturnType<typeof parsePeerInfo>) {
  const cal = loadCal(peer.sfi_id);
  const me = {
    is_anon: peer.is_anon, is_sfi_member: peer.is_sfi_member,
    is_sfi_editor: peer.is_sfi_editor, is_owner: peer.is_owner,
    user_name: peer.user_name,
  };
  // Private + non-member → reveal nothing but the "this is private" signal and the accent.
  if (!cal.settings.isPublic && !peer.is_sfi_member) {
    return { me, private: true, settings: { palette: cal.settings.palette, isPublic: false }, events: [] };
  }
  return { me, private: false, settings: cal.settings, events: cal.events };
}

// ----- Networking -----------------------------------------------------------------------
self.onNetworkRequest = async function (replyPort, reqPath, method, headers, query, body, cookies) {
  const peer = parsePeerInfo(query, cookies);

  // Static assets — open to everyone (read-only viewers still need the shell).
  if (method === "GET" && !reqPath.startsWith("/api/")) {
    return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url), headers);
  }

  // Full calendar + identity in one round trip. The privacy gate lives in stateFor().
  if (reqPath === "/api/state" && method === "GET") {
    return jsonReply(replyPort, 200, stateFor(peer));
  }

  // Create or update one event — editors only. id present + known → update; else insert.
  if (reqPath === "/api/event" && method === "POST") {
    if (!peer.is_sfi_editor) return jsonReply(replyPort, 403, { error: "editors only" });
    const v = parseJsonBody<{ event?: any; by?: string }>(body) || {};
    const ev = sanitizeEvent(v.event);
    if (!ev) return jsonReply(replyPort, 400, { error: "invalid event" });
    const cal = loadCal(peer.sfi_id);
    const i = cal.events.findIndex((e) => e.id === ev.id);
    if (i >= 0) cal.events[i] = ev;
    else {
      if (cal.events.length >= MAX_EVENTS) return jsonReply(replyPort, 413, { error: "calendar is full" });
      cal.events.push(ev);
    }
    saveCal(peer.sfi_id, cal);
    pushToInstance(peer.sfi_id, { type: "cal_changed", by: str(v.by, 64) });
    return jsonReply(replyPort, 200, { ok: true, id: ev.id });
  }

  // Delete one event — editors only.
  if (reqPath === "/api/event_delete" && method === "POST") {
    if (!peer.is_sfi_editor) return jsonReply(replyPort, 403, { error: "editors only" });
    const v = parseJsonBody<{ id?: string; by?: string }>(body) || {};
    const id = String(v.id || "");
    const cal = loadCal(peer.sfi_id);
    const next = cal.events.filter((e) => e.id !== id);
    if (next.length !== cal.events.length) {
      cal.events = next;
      saveCal(peer.sfi_id, cal);
      pushToInstance(peer.sfi_id, { type: "cal_changed", by: str(v.by, 64) });
    }
    return jsonReply(replyPort, 200, { ok: true });
  }

  // Calendar settings (accent palette + public/private) — editors only.
  if (reqPath === "/api/settings" && method === "POST") {
    if (!peer.is_sfi_editor) return jsonReply(replyPort, 403, { error: "editors only" });
    const v = parseJsonBody<{ settings?: any; by?: string }>(body) || {};
    const cal = loadCal(peer.sfi_id);
    if (v.settings && typeof v.settings === "object") {
      if (v.settings.palette !== undefined) cal.settings.palette = oneOf(v.settings.palette, PALETTES, cal.settings.palette);
      if (v.settings.isPublic !== undefined) cal.settings.isPublic = v.settings.isPublic === true;
    }
    saveCal(peer.sfi_id, cal);
    pushToInstance(peer.sfi_id, { type: "cal_changed", by: str(v.by, 64) });
    return jsonReply(replyPort, 200, { ok: true, settings: cal.settings });
  }

  return jsonReply(replyPort, 404, { error: "not found" });
};

log("Calendar frame is up and running!");
