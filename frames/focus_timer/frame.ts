// ----------------------------------------------------------------------------------------
// Focus Timer — one clock, shared by everyone in the space.
//
// Design axes:
//   privacy:        privacy-public-view  — non-members watch the same countdown; space
//                                           editors drive it.
//   data_storage:   storage-none         — deliberately NOT a table frame. A timer has one
//                                           state, not a collection of rows: there is
//                                           nothing to list, nothing another frame would
//                                           want to bind, and nothing to graduate. State
//                                           lives in the per-placement settings file on the
//                                           host, so this frame has no data drawer at all
//                                           and its header rail carries only the role.
//   view_realtime:  view-collaborative    — every change calls pushToInstance(sfi_id, …) so
//                                           all viewers re-read at once.
//   settings_scope: settings-per-sfi      — keyed by sfi_id like every other placement.
//
// THE CLOCK RUNS NOWHERE. A frame has no scheduler, and a timer that depended on one would
// silently stop on a sleeping device and disagree with every other viewer. So the host
// stores only `ends_at_ms` — the wall-clock instant the session is over — and each client
// subtracts. Everyone agrees without anything ticking, a paused timer keeps whole seconds
// rather than a running deadline, and a device that slept through the end wakes up showing
// "done" instead of a stale number.
// ----------------------------------------------------------------------------------------
import {
  log, serveFileAtPath, jsonReply, parseJsonBody, parsePeerInfo, onUiMessage,
  pushToInstance, sanitizeText, loadJsonFile, saveJsonFile,
} from "@frame-core";

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

const allSessions: Record<string, Session> = loadJsonFile(import.meta.url, "sessions.json", {});
function getSession(sfiId: string): Session {
  return { ...DEFAULT_SESSION, ...(allSessions[sfiId] ?? {}) };
}
function saveSession(sfiId: string, s: Session): void {
  allSessions[sfiId] = s;
  saveJsonFile(import.meta.url, "sessions.json", allSessions);
}

type Peer = ReturnType<typeof parsePeerInfo>;
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

function notify(sfiId: string) {
  pushToInstance(sfiId, { type: "timer_changed" });
}

// ----- Writes ---------------------------------------------------------------------------
// One shared mutation path for BOTH transports: the bus dispatcher (frame.busSend →
// onUiMessage, the primary write path) and the HTTP POST arm kept for older viewers whose
// framelib has no busSend. Role gates live here so the two entry points can never drift.
async function handleWrite(sfiId: string, op: string, v: Record<string, unknown> | null, peer: Peer): Promise<WriteResult> {
  // Driving the timer is a write like any other: a public viewer watches the countdown,
  // they don't start and stop the room's session. Never gate on is_sfi_member — a
  // Viewer-role member would slip through.
  if (!peer.is_sfi_editor) return { status: 403, body: { error: "editors only" } };

  const s = getSession(sfiId);
  const now = Date.now();
  const running = s.ends_at_ms > now;

  const ok = (): WriteResult => {
    saveSession(sfiId, s);
    notify(sfiId);
    return { status: 200, body: { session: view(s) } };
  };

  // Turning the dial. Only meaningful while the clock is stopped — changing the length of
  // a session already under way would move a deadline other people are working to.
  if (op === "set") {
    if (running) return { status: 409, body: { error: "running" } };
    s.duration_s = clampMinutes(v?.minutes) * 60;
    s.paused_left_s = 0;   // a fresh dial setting replaces whatever was left over
    return ok();
  }

  if (op === "start") {
    if (running) return { status: 409, body: { error: "already running" } };
    // Resume what was paused, else start a full session from the dial.
    const left = s.paused_left_s > 0 ? s.paused_left_s : s.duration_s;
    if (left <= 0) return { status: 400, body: { error: "nothing to run" } };
    s.ends_at_ms = now + left * 1000;
    s.paused_left_s = 0;
    s.started_by = sanitizeText(peer.user_name, 60);
    return ok();
  }

  if (op === "pause") {
    if (!running) return { status: 409, body: { error: "not running" } };
    // Keep whole seconds, not a deadline: a paused timer must not drift while it waits.
    s.paused_left_s = Math.max(1, Math.round((s.ends_at_ms - now) / 1000));
    s.ends_at_ms = 0;
    return ok();
  }

  // Back to the top of the dial — also how you clear a finished session.
  if (op === "reset") {
    s.ends_at_ms = 0;
    s.paused_left_s = 0;
    s.started_by = "";
    return ok();
  }

  if (op === "label") {
    s.label = sanitizeText(v?.label, MAX_LABEL);
    return ok();
  }

  return { status: 404, body: { error: "not found" } };
}

// ----- Bus dispatcher — the frontend's write path (frame.busSend → BusUiToFrame) --------
onUiMessage(async (sfiId, data, peer) => {
  if (!sfiId || typeof data !== "object" || data === null) return;
  const d = data as Record<string, unknown>;
  if (typeof d.op !== "string") return;
  const r = await handleWrite(sfiId, d.op, d, peer);
  if (r.status !== 200) log(`focus_timer: bus op ${d.op} → ${r.status} (${JSON.stringify(r.body)})`);
});

// ----- Networking -----------------------------------------------------------------------
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

  // Read — open to everyone, including anon viewers watching the room's countdown.
  if (reqPath === "/api/state" && method === "GET") {
    return jsonReply(replyPort, 200, { session: view(getSession(sfiId)) });
  }

  return jsonReply(replyPort, 404, { error: "not found" });
};

log("Focus Timer frame is up and running!");
