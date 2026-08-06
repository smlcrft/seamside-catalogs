// ----------------------------------------------------------------------------------------
// CamJam — one member at a time shares a tiny webcam still with the placement.
//
// Design axes:
//   privacy:        privacy-space-users  — only space MEMBERS can share a camera. WATCHING
//                                          is not gated here at all: see below.
//   data_storage:   (none) + settings-per-sfi — the live still is deliberately EPHEMERAL:
//                                          it lives in a module-level Map on the host and is
//                                          never written to disk. Only the rung and the
//                                          title persist, in `frameSettings(sfi_id)`.
//   view_realtime:  view-collaborative   — every new still pushes a tick to all viewers.
//   settings_scope: settings-per-sfi     — each placement is its own independent feed.
//
// WHO CAN WATCH — the host's frame-sharing toggle, not a setting in here
//   Anyone who can load this frame may see the feed. That is not laxity: an anonymous or
//   bookmark-only viewer reaches this frame ONLY through the anon-sfi path, which the
//   host's own `public_sharing_enabled` flag live-gates (clearing it revokes on the next
//   auth resolution). Everyone else is a space member. So by the time a request lands
//   here, the platform has already answered "is this frame public?" — and re-asking it
//   with a second in-frame toggle would just mean two switches that both have to be on,
//   and a frame the owner has marked public that still shows nothing.
//
// CAMERA CONSENT
//   `permissions.camera` in frame.json only makes the iframe ELIGIBLE for `allow="camera"`;
//   each viewer answers the host's own consent prompt on their own device. This frame calls
//   `getUserMedia()` only when a member explicitly presses "share" — a viewer who never
//   shares never has their camera opened.
// ----------------------------------------------------------------------------------------
import {
  log, serveFileAtPath, jsonReply, parsePeerInfo, pushToInstance, onUiMessage,
  sanitizeText, toIntOrNull, frameSettings,
} from "@frame-core";

type Peer = ReturnType<typeof parsePeerInfo>;

// ----- The cadence ladder ----------------------------------------------------------------
// Interval and still width move TOGETHER, as one rung. They're the same trade seen from
// two ends — smoothness versus detail — so splitting them into two controls would only
// let the owner pick incoherent pairs. Fast rungs are for "is anyone at their desk";
// slow rungs are for "what's on the workbench". Measured on a webcam-like frame at q0.6,
// every rung lands within ~1.0-2.2 KB/s, so no rung is the expensive one and the choice
// really is just smooth vs. sharp. Keep it that way when editing: a rung whose bytes/sec
// falls far outside that band is a rung the owner would be punished or rewarded for
// picking, which is exactly the two-dial confusion this ladder exists to avoid.
const STEPS = [
  { ms:   500, w:   40 },
  { ms:  1000, w:   80 },
  { ms:  2000, w:  160 },
  { ms:  3000, w:  240 },
  { ms:  5000, w:  320 },
  { ms: 10000, w:  640 },
  { ms: 15000, w:  720 },
  { ms: 30000, w: 1280 },
  { ms: 60000, w: 1920 },
] as const;
type Step = typeof STEPS[number];
const DEFAULT_MS = 2000;

/** Resolve a stored or incoming interval to a rung. An unrecognised value falls back to
 *  the default instead of clamping, so nothing can land between rungs and invent a size. */
function stepFor(ms: unknown): Step {
  const n = toIntOrNull(ms);
  return STEPS.find((s) => s.ms === n) ?? STEPS.find((s) => s.ms === DEFAULT_MS)!;
}

// Ceiling on one still's base64 payload, derived from the rung's width. Aspect-agnostic
// (w², not w×h), so it holds for a portrait or square camera too. Measured headroom over
// a real q0.6 still is 5-38× — deliberately loose, because bouncing a legitimately
// detailed frame is a worse failure than admitting a fat one. It exists to bound a
// malformed or hostile sender and to keep the owner's rung enforceable, not to police
// ordinary variation. The floor keeps the two narrowest rungs from being effectively
// uncapped (w² is only 1.6 KB at 40px); the 1 MB ceiling keeps the two widest from
// being effectively unbounded (w² runs to 3.7 MB at 1920px, and a real 1920px still is
// ~70 KB, so 1 MB is still ~14× headroom).
const maxB64 = (w: number) => Math.min(1_048_576, Math.max(12_288, w * w));

// A sharer whose tab closed without a "stop" simply stops sending, so the slot has to free
// itself. The window MUST scale with the cadence — a fixed one would evict a sharer on the
// 60s rung between every still. Recorded on the holder so `current()` stays synchronous.
const staleWindow = (ms: number) => Math.max(15_000, ms * 3 + 5000);

// ----- Ephemeral live state (memory only — never persisted) ------------------------------
type Live = {
  user_id: string;
  user_name: string;
  jpeg: string;     // base64 JPEG bytes, no `data:` prefix; "" until the first still lands
  sent_ms: number;  // host clock; only ever exposed to viewers as an AGE, never a timestamp
  seq: number;
  stale_ms: number; // silence after which this holder loses the slot (rung-derived)
  max_b64: number;  // biggest still this holder may send (rung-derived)
};
const live = new Map<string, Live>();   // sfi_id → the placement's current broadcast

/** The placement's live broadcast, or null if there is none / the sharer went quiet. */
function current(sfiId: string): Live | null {
  const l = live.get(sfiId);
  if (!l) return null;
  if (Date.now() - l.sent_ms > l.stale_ms) { live.delete(sfiId); return null; }
  return l;
}

function tick(sfiId: string, seq: number): void {
  pushToInstance(sfiId, { type: "cam_tick", seq });
}

// ----- Persisted prefs (per placement) ---------------------------------------------------
// The rung and the title are the ONLY things this frame persists. Who may watch is
// deliberately not among them: an anonymous or bookmark-only viewer can only reach this
// frame through the anon-sfi path, which the host's own frame-sharing toggle
// (`public_sharing_enabled`) already live-gates. A second in-frame switch behind that one
// would only give the owner two things to turn on, and a way to have a "public" frame
// nobody can see.
const DEFAULT_TITLE = "My CamJam Feed";
const MAX_TITLE = 80;

async function readPrefs(sfiId: string): Promise<{ step: Step; title: string }> {
  const s = frameSettings(sfiId);
  const [ms, title] = await Promise.all([
    s.get<number>("interval_ms"),
    s.get<string>("title"),
  ]);
  return { step: stepFor(ms), title: sanitizeText(title, MAX_TITLE) || DEFAULT_TITLE };
}

// ----- UI writes (BusUiToFrame — the still-frame path) -----------------------------------
// Reads stay on HTTP GETs; every write arrives here so it works on Android too, and so the
// per-second still never rides an HTTP body.
onUiMessage(async (sfiId, data, peer: Peer) => {
  if (!sfiId || typeof data !== "object" || data === null) return;
  const d = data as Record<string, unknown>;
  const holder = current(sfiId);

  // Claim (or TAKE OVER) the single share slot. Members only — Viewer-role members
  // included, since "any member may share their camera" is the point of the frame.
  if (d.op === "claim") {
    if (!peer.is_sfi_member) return;
    const seq = (holder?.seq ?? 0) + 1;
    const { step } = await readPrefs(sfiId);
    live.set(sfiId, {
      user_id: peer.user_id || "",
      user_name: sanitizeText(peer.user_name, 80) || "someone",
      jpeg: "", sent_ms: Date.now(), seq,
      stale_ms: staleWindow(step.ms), max_b64: maxB64(step.w),
    });
    return tick(sfiId, seq);
  }

  // A still from the current holder. A sender who has been taken over is silently
  // dropped here; their own next /api/state read tells their UI to shut the camera off.
  if (d.op === "f") {
    if (!peer.is_sfi_member || !holder || holder.user_id !== (peer.user_id || "")) return;
    const jpeg = typeof d.jpeg === "string" ? d.jpeg : "";
    if (!jpeg || jpeg.length > holder.max_b64) return;
    const seq = holder.seq + 1;
    live.set(sfiId, { ...holder, jpeg, sent_ms: Date.now(), seq });
    return tick(sfiId, seq);
  }

  // Stop the feed — the holder ending their own share, or the owner cutting it.
  if (d.op === "stop") {
    if (!holder) return;
    if (holder.user_id !== (peer.user_id || "") && !peer.is_owner) return;
    live.delete(sfiId);
    return tick(sfiId, holder.seq + 1);
  }

  // Rename the placement. MEMBER-gated, not owner-gated: the title is a label on shared
  // furniture, in the same class as claiming the camera, and it edits in place in the
  // header rather than hiding in the owner's settings sheet. Blank resets to the default
  // at read time rather than being rejected, so clearing the field is a real gesture.
  if (d.op === "title") {
    if (!peer.is_sfi_member) return;
    await frameSettings(sfiId).set("title", sanitizeText(d.title, MAX_TITLE));
    return tick(sfiId, current(sfiId)?.seq ?? 0);
  }

  // Owner-only placement settings.
  if (d.op === "settings") {
    if (!peer.is_owner) return;
    // Snapped to a rung on the way in, so the stored value is always on the ladder.
    if (d.interval_ms === undefined) return;
    await frameSettings(sfiId).set("interval_ms", stepFor(d.interval_ms).ms);
    // A live sharer's limits were sized from the OLD rung. Re-derive both, or moving to a
    // slower rung would evict them before their next still lands, and moving to a wider
    // one would bounce every still for being over the previous rung's cap.
    const h = current(sfiId);
    if (h) {
      const { step } = await readPrefs(sfiId);
      h.stale_ms = staleWindow(step.ms);
      h.max_b64 = maxB64(step.w);
    }
    return tick(sfiId, h?.seq ?? 0);
  }
});

// ----- HTTP ------------------------------------------------------------------------------
self.onNetworkRequest = async function (replyPort, reqPath, method, headers, query, _body, cookies) {
  const peer = parsePeerInfo(query, cookies);

  // Static assets — open to everyone; the members-only gate is on the feed, not the shell.
  if (method === "GET" && !reqPath.startsWith("/api/")) {
    return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url), headers);
  }

  // The one read endpoint: identity + the rung + the current still. Re-fetched on every
  // cam_tick, so it is deliberately small and self-contained. Reaching this at all means
  // the platform already admitted the caller (member, or anon via the host's live-gated
  // frame-sharing toggle), so the still is not gated again here — only SHARING is.
  if (reqPath === "/api/state" && method === "GET") {
    const { step, title } = await readPrefs(peer.sfi_id);
    const l = current(peer.sfi_id);
    return jsonReply(replyPort, 200, {
      is_sfi_member: peer.is_sfi_member,
      is_owner: peer.is_owner,
      user_id: peer.user_id,
      user_name: peer.user_name,
      space_color: peer.space_color,
      can_share: peer.is_sfi_member,
      title,
      // The rung, resolved host-side: the frontend never derives a width from an
      // interval, so the two can't drift apart across app versions.
      interval_ms: step.ms,
      still_w: step.w,
      // Only the owner's picker needs the whole ladder; every other viewer would carry
      // it on every tick for nothing. Undefined keys drop out of the JSON.
      steps: peer.is_owner ? STEPS : undefined,
      // `age_ms` rather than a wall-clock stamp: the viewer anchors it against its own
      // clock on arrival, so the "live-ness" caption can't be thrown off by clock skew.
      live: l
        ? { user_name: l.user_name, is_me: l.user_id === (peer.user_id || ""), jpeg: l.jpeg, age_ms: Date.now() - l.sent_ms, seq: l.seq }
        : null,
    });
  }

  return jsonReply(replyPort, 404, { error: "not found" });
};

log("CamJam frame is up and running!");
