// ----------------------------------------------------------------------------------------
// CamJam — one member at a time shares a tiny webcam still with the space.
//
// Design axes:
//   privacy:        privacy-space-users  — only space MEMBERS can share a camera. WATCHING
//                                          is not gated here at all: see below.
//   data_storage:   (none) + settings-per-sfi — the live still is deliberately EPHEMERAL:
//                                          it lives in a module-level Map on the host and is
//                                          never written to disk. Only the rung and the
//                                          title persist: the title, which names the
//                                          feed for every frame and member, as a row of
//                                          the space's `_fdata/camjam_settings` table;
//                                          the rung, the owner's choice of what this
//                                          device sends, in the session's own `settings`.
//   view_realtime:  view-collaborative   — every new still pushes a tick to all viewers;
//                                          the tick says to read again and carries nothing.
//   settings_scope: settings-per-sfi     — each space is its own independent feed.
//
// WHO CAN WATCH — the space's own sharing, not a setting in here
//   Anyone who can load this frame may see the feed. That is not laxity: someone off the
//   roster reaches this frame only where the space lets strangers in and the frame is
//   published, and unpublishing it shuts them out. Everyone else is a space member. So by
//   the time a request lands here, the platform has already answered "is this frame
//   public?" — and re-asking it with a second in-frame toggle would just mean two switches
//   that both have to be on, and a published frame that still shows nothing.
//
// CAMERA CONSENT
//   `permissions.camera` in frame.json only makes the iframe ELIGIBLE for `allow="camera"`;
//   each viewer answers the browser's own consent prompt on their own device. This frame calls
//   `getUserMedia()` only when a member explicitly presses "share" — a viewer who never
//   shares never has their camera opened.
// ----------------------------------------------------------------------------------------
import type { Ctx } from "@frame-core";
import { sanitizeText, toIntOrNull } from "@frame-core";

// ----- The cadence ladder ----------------------------------------------------------------
// Interval and still width move TOGETHER, as one rung. They're the same trade seen from
// two ends — smoothness versus detail — so splitting them into two controls would only
// let the owner pick incoherent pairs. Fast rungs are for "is anyone at their desk";
// slow rungs are for "what's on the workbench". The invariant that matters is FLATNESS, not
// any particular number: every rung should cost roughly the same bytes/sec, so no rung is the
// expensive one and the choice really is just smooth vs. sharp. Note the wire cost is the
// BASE64 payload, 4/3 the JPEG bytes. Measured at q0.6 on detailed 4:3 photos downscaled from
// a 1920px capture, the ladder runs ~3.5-5.8 KB/s at every rung. (That source is more detailed
// than a real webcam still, so the wide rungs are an upper bound — a real 1920px still is
// ~70 KB, not the ~240 KB the proxy gives; the narrow rungs are close to real, since
// downscaling flattens the difference.) Widening the fast half made the ladder FLATTER: the
// old fast rungs (40px@0.5s, 80px@1s, 160px@2s) were the cheap outliers at ~1.8-2.6 KB/s
// while the slow rungs already sat at 4-5.5. Keep it that way when editing — a rung whose
// bytes/sec falls far outside its
// neighbours' is a rung the owner would be punished or rewarded for picking, which is exactly
// the two-dial confusion this ladder exists to avoid.
const STEPS = [
  { ms:   500, w:  100 },
  { ms:  1000, w:  160 },
  { ms:  2000, w:  240 },
  { ms:  3000, w:  320 },
  { ms:  5000, w:  480 },
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
// ordinary variation. The floor keeps the narrowest rung from being effectively uncapped
// (w² is only 10 KB at 100px, under the 12 KB floor; every rung from 160px up clears it on
// its own). The 1 MB ceiling keeps the two widest from
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
const live = new Map<string, Live>();   // ctx.frame → that session's current broadcast

/** The session's live broadcast, or null if there is none / the sharer went quiet. */
function current(ctx: Ctx): Live | null {
  const l = live.get(ctx.frame);
  if (!l) return null;
  if (Date.now() - l.sent_ms > l.stale_ms) { live.delete(ctx.frame); return null; }
  return l;
}

// Says to read /api/state again, and nothing of what it holds.
const tick = (ctx: Ctx) => ctx.push({ camjam: "feed" });

// ----- Persisted prefs -------------------------------------------------------------------
// The rung and the title are the ONLY things this frame persists. Who may watch is
// deliberately not among them: that is the space's sharing (see WHO CAN WATCH above).
const DEFAULT_TITLE = "My CamJam Feed";
const KEY_INTERVAL = "camjam.interval_ms";
const KEY_TITLE = "camjam.title";
const MAX_TITLE = 80;

// One row per key, the value as JSON under `v`. The title describes the feed, so it is the
// space's, beside nothing else in its frame data; the rung is owner-only, so it stays in the
// session's own table, where no collaborator can write it at the door.
const settings = (ctx: Ctx, key: string) =>
  key === KEY_TITLE
    ? ctx.shared.table<Record<string, unknown>>("camjam_settings")
    : ctx.own.table<Record<string, unknown>>("settings");

async function setting(ctx: Ctx, key: string): Promise<unknown> {
  const row = await settings(ctx, key).get(key);
  if (row?.v == null) return null;
  try { return JSON.parse(String(row.v)); } catch { return null; }
}

/** Write a setting over its row, stamped when it was made and when it changed. */
async function setSetting(ctx: Ctx, key: string, value: unknown): Promise<void> {
  const was = await settings(ctx, key).get(key);
  const now = Date.now();
  await settings(ctx, key).upsert({ ...(was ?? { _created_at: now }), id: key, v: JSON.stringify(value), _modified_at: now });
}

async function readPrefs(ctx: Ctx): Promise<{ step: Step; title: string }> {
  const [ms, title] = await Promise.all([setting(ctx, KEY_INTERVAL), setting(ctx, KEY_TITLE)]);
  return { step: stepFor(ms), title: sanitizeText(title, MAX_TITLE) || DEFAULT_TITLE };
}

const json = (v: unknown, status = 200) => Response.json(v, { status });
const refuse = (status: number, error: string) => json({ error }, status);

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const v = JSON.parse(await request.text());
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

// ----- Writes ----------------------------------------------------------------------------
// Every write, the per-interval still included, is a route that decides on ctx.peer.
async function write(op: string, request: Request, ctx: Ctx): Promise<Response> {
  const peer = ctx.peer;
  const member = peer.is_sfi_member || peer.is_owner;
  const holder = current(ctx);

  // Claim (or TAKE OVER) the single share slot. Members only — Viewer-role members
  // included, since "any member may share their camera" is the point of the frame.
  if (op === "claim") {
    if (!member) return refuse(403, "only members can share");
    const seq = (holder?.seq ?? 0) + 1;
    const { step } = await readPrefs(ctx);
    live.set(ctx.frame, {
      user_id: peer.user_id || "",
      user_name: sanitizeText(peer.user_name, 80) || "someone",
      jpeg: "", sent_ms: Date.now(), seq,
      stale_ms: staleWindow(step.ms), max_b64: maxB64(step.w),
    });
    tick(ctx);
    return json({ ok: true });
  }

  // A still from the current holder. A sender who has been taken over is refused; their
  // own next /api/state read tells their UI to shut the camera off.
  if (op === "still") {
    if (!member) return refuse(403, "only members can share");
    if (!holder || holder.user_id !== (peer.user_id || "")) return refuse(409, "not sharing");
    const d = await body(request);
    const jpeg = typeof d.jpeg === "string" ? d.jpeg : "";
    if (!jpeg) return refuse(400, "jpeg required");
    if (jpeg.length > holder.max_b64) return refuse(413, "still too large");
    live.set(ctx.frame, { ...holder, jpeg, sent_ms: Date.now(), seq: holder.seq + 1 });
    tick(ctx);
    return json({ ok: true });
  }

  // Stop the feed — the holder ending their own share, or the owner cutting it.
  if (op === "stop") {
    if (!holder) return json({ ok: true });
    if (holder.user_id !== (peer.user_id || "") && !peer.is_owner) return refuse(403, "not yours to stop");
    live.delete(ctx.frame);
    tick(ctx);
    return json({ ok: true });
  }

  // Rename the feed. MEMBER-gated, not owner-gated: the title is a label on shared
  // furniture, in the same class as claiming the camera, and it edits in place in the
  // header rather than hiding in the owner's settings sheet. Blank resets to the default
  // at read time rather than being rejected, so clearing the field is a real gesture.
  if (op === "title") {
    if (!member) return refuse(403, "only members can rename the feed");
    await setSetting(ctx, KEY_TITLE, sanitizeText((await body(request)).title, MAX_TITLE));
    tick(ctx);
    return json({ ok: true });
  }

  // Owner-only settings.
  if (op === "settings") {
    if (!peer.is_owner) return refuse(403, "only the owner changes settings");
    const d = await body(request);
    if (d.interval_ms === undefined) return refuse(400, "interval_ms required");
    // Snapped to a rung on the way in, so the stored value is always on the ladder.
    const step = stepFor(d.interval_ms);
    await setSetting(ctx, KEY_INTERVAL, step.ms);
    // A live sharer's limits were sized from the OLD rung. Re-derive both, or moving to a
    // slower rung would evict them before their next still lands, and moving to a wider
    // one would bounce every still for being over the previous rung's cap.
    const h = current(ctx);
    if (h) {
      h.stale_ms = staleWindow(step.ms);
      h.max_b64 = maxB64(step.w);
    }
    tick(ctx);
    return json({ ok: true });
  }

  return refuse(404, "not found");
}

// ----- HTTP ------------------------------------------------------------------------------
export default {
  async fetch(request: Request, ctx: Ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    const peer = ctx.peer;

    // Static assets — open to everyone; the members-only gate is on the feed, not the shell.
    if (!pathname.startsWith("/api/")) {
      if (request.method !== "GET") return refuse(404, "not found");
      return ctx.file(pathname);
    }

    // The one read endpoint: identity + the rung + the current still. Re-fetched on every
    // tick, so it is deliberately small and self-contained. Reaching this at all means
    // the platform already admitted the caller (member, or a stranger to a published frame),
    // so the still is not gated again here — only SHARING is.
    if (pathname === "/api/state" && request.method === "GET") {
      const { step, title } = await readPrefs(ctx);
      const l = current(ctx);
      const member = peer.is_sfi_member || peer.is_owner;
      return json({
        is_sfi_member: member,
        is_owner: peer.is_owner,
        user_id: peer.user_id,
        user_name: peer.user_name,
        space_color: peer.space_color,
        can_share: member,
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

    if (request.method === "POST") return write(pathname.slice(5), request, ctx);
    return refuse(404, "not found");
  },
};
