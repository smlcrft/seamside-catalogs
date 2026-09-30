// ----------------------------------------------------------------------------------------
// Focus Timer — one clock, shared by everyone in the space.
//
// Design axes:
//   privacy:        privacy-public-view  — non-members watch the same countdown; space
//                                           editors drive it.
//   data_storage:   storage-session      — deliberately NOT a table frame. A timer has one
//                                           state, not a collection of rows: there is
//                                           nothing to list, nothing another frame would
//                                           want to share. It is this session's own key
//                                           (`timer` in ctx.kv), which only this worker
//                                           reads, so two timers in one space run apart;
//                                           every page reads it through /api/state.
//   view_realtime:  view-collaborative    — every change pushes `{ focus_timer: "timer" }` so
//                                           all viewers re-read at once.
//   settings_scope: settings-per-session  — one timer per session of the frame.
//
// THE CLOCK RUNS NOWHERE. A frame has no scheduler, and a timer that depended on one would
// silently stop on a sleeping device and disagree with every other viewer. So the keeper's
// device stores only `ends_at_ms` — the wall-clock instant the session is over — and each client
// subtracts. Everyone agrees without anything ticking, a paused timer keeps whole seconds
// rather than a running deadline, and a device that slept through the end wakes up showing
// "done" instead of a stale number.
// ----------------------------------------------------------------------------------------
import type { Ctx } from "@frame-core";
import { sanitizeText } from "@frame-core";

const MIN_MINUTES = 1;
const MAX_MINUTES = 60;   // one full turn of the dial — the ring is a clock face
const MAX_LABEL = 80;

type Session = {
  duration_s: number;      // what the dial is set to
  ends_at_ms: number;      // 0 when not running; otherwise the instant it finishes
  paused_left_s: number;   // 0 unless paused, then the whole seconds still owed
  label: string;           // what this session is for
  started_by: string;      // display name of whoever pressed start
};

const DEFAULT_SESSION: Session = {
  duration_s: 25 * 60, ends_at_ms: 0, paused_left_s: 0, label: "", started_by: "",
};

async function getSession(ctx: Ctx): Promise<Session> {
  const op = await ctx.kv.get("timer");
  let saved: Partial<Session> = {};
  try { if (op?.value) saved = JSON.parse(op.value); } catch { /* a bad value reads as the default */ }
  return { ...DEFAULT_SESSION, ...saved };
}
async function saveSession(ctx: Ctx, s: Session): Promise<void> {
  await ctx.kv.put("timer", JSON.stringify(s));
}

type WriteResult = { status: number; body: unknown };

function clampMinutes(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 25;
  return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, n));
}

/** What the client needs to draw the dial. `now_ms` rides along so a device with a skewed
 * clock can correct against the host rather than showing its own idea of the time. */
function view(s: Session) {
  return { ...s, now_ms: Date.now(), max_minutes: MAX_MINUTES, min_minutes: MIN_MINUTES };
}

// What changed, never what it holds: each page reads again as whoever it is.
const notify = (ctx: Ctx) => ctx.push({ focus_timer: "timer" });

// ----- Writes ---------------------------------------------------------------------------
async function handleWrite(ctx: Ctx, op: string, v: Record<string, unknown> | null): Promise<WriteResult> {
  const peer = ctx.peer;
  // Driving the timer is a write like any other: a public viewer watches the countdown,
  // they don't start and stop the room's session. Never gate on is_sfi_member — a
  // Viewer-role member would slip through.
  if (!(peer.is_sfi_editor || peer.is_owner)) return { status: 403, body: { error: "editors only" } };

  const s = await getSession(ctx);
  const now = Date.now();
  const running = s.ends_at_ms > now;

  const ok = async (): Promise<WriteResult> => {
    await saveSession(ctx, s);
    notify(ctx);
    return { status: 200, body: { session: view(s) } };
  };

  // Turning the dial. Only meaningful while the clock is stopped — changing the length of
  // a session already under way would move a deadline other people are working to.
  if (op === "set") {
    if (running) return { status: 409, body: { error: "running" } };
    s.duration_s = clampMinutes(v?.minutes) * 60;
    s.paused_left_s = 0;   // a fresh dial setting replaces whatever was left over
    return await ok();
  }

  if (op === "start") {
    if (running) return { status: 409, body: { error: "already running" } };
    // Resume what was paused, else start a full session from the dial.
    const left = s.paused_left_s > 0 ? s.paused_left_s : s.duration_s;
    if (left <= 0) return { status: 400, body: { error: "nothing to run" } };
    s.ends_at_ms = now + left * 1000;
    s.paused_left_s = 0;
    // The keeper has no roster name; name them as the owner rather than leave it blank.
    s.started_by = sanitizeText(peer.user_name, 60) || (peer.is_owner ? "the owner" : "");
    return await ok();
  }

  if (op === "pause") {
    if (!running) return { status: 409, body: { error: "not running" } };
    // Keep whole seconds, not a deadline: a paused timer must not drift while it waits.
    s.paused_left_s = Math.max(1, Math.round((s.ends_at_ms - now) / 1000));
    s.ends_at_ms = 0;
    return await ok();
  }

  // Back to the top of the dial — also how you clear a finished session.
  if (op === "reset") {
    s.ends_at_ms = 0;
    s.paused_left_s = 0;
    s.started_by = "";
    return await ok();
  }

  if (op === "label") {
    s.label = sanitizeText(v?.label, MAX_LABEL);
    return await ok();
  }

  return { status: 404, body: { error: "not found" } };
}

// ----- Networking -----------------------------------------------------------------------
const json = (v: unknown, status = 200) => Response.json(v, { status });

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
    const peer = ctx.peer;

    if (method === "GET" && !pathname.startsWith("/api/")) return ctx.file(pathname);

    if (pathname === "/api/whoami" && method === "GET") {
      return json({
        is_anon:       peer.is_anon,
        is_sfi_member: peer.is_sfi_member,
        is_sfi_editor: peer.is_sfi_editor || peer.is_owner,
        is_owner:      peer.is_owner,
        user_id:       peer.user_id,
        user_name:     peer.user_name,
        space_color:   peer.space_color,
      });
    }

    if (pathname.startsWith("/api/") && (method === "POST" || method === "PUT")) {
      const r = await handleWrite(ctx, pathname.slice("/api/".length), await body(request));
      return json(r.body, r.status);
    }

    // Read — open to everyone, including anon viewers watching the room's countdown.
    if (pathname === "/api/state" && method === "GET") {
      return json({ session: view(await getSession(ctx)) });
    }

    return json({ error: "not found" }, 404);
  },
};
