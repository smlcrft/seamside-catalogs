// ----------------------------------------------------------------------------------------
// Slideshow — a simple presentation maker and presenter, one per space (sfi_id).
//
// Design axes:
//   privacy:        privacy-public-view  — editors build/edit the deck; viewers and anonymous
//                                           link visitors get a read-only, browseable presentation.
//   data_storage:   storage-simple-files — the whole deck is one file of the space,
//                                           Slideshow/slides.json, its uploaded images beside it
//                                           in Slideshow/images/; the live present position is
//                                           this frame's key in the space's frameSettings.
//   view_realtime:  view-collaborative   — every save calls pushToInstance so all viewers of the
//                                           space refresh live; when "keep viewers in sync" is on,
//                                           each slide advance also pushes present_changed so every
//                                           viewer's presentation tracks the editor's current slide.
//   settings_scope: settings-per-sfi     — everything is keyed by peer.sfi_id.
// ----------------------------------------------------------------------------------------
import {
  log, jsonReply, parseJsonBody, parsePeerInfo, pushToInstance, onUiMessage,
  serveFileAtPath, contentType, extname, spaceFiles, frameSettings,
} from "@frame-core";

// ----- Deck shape -----------------------------------------------------------------------
// The deck is one JSON document. All element geometry (x/y/w/h) and font sizes are stored in
// LOGICAL pixels relative to a fixed slide canvas whose dimensions are derived from the show's
// aspect ratio (see ASPECTS in the frontend). The frontend renders that canvas at any size via
// a single CSS transform: scale(...), so every element stays precisely placed at any zoom.
type Show = { settings: Settings; slides: Slide[] };
type Settings = { background: string; aspect: string; syncPresent: boolean };
type Slide = { id: string; background: string; elements: SlideElement[] };
type SlideElement = {
  id: string;
  type: "text" | "image" | "shape";
  x: number; y: number; w: number; h: number;
  // text
  text?: string; style?: string; align?: string; color?: string; size?: number; weight?: number;
  // image
  imageId?: string; fit?: string;
  // shape
  shape?: string; fill?: string; radius?: number;
};

const DEFAULT_SHOW: Show = {
  settings: { background: "paper", aspect: "16:9", syncPresent: false },
  slides: [],
};

// Caps — keep the space's files and rendering bounded.
const MAX_SLIDES = 80;
const MAX_ELEMENTS = 40;
const MAX_TEXT = 4000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMG_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const KEEP_RECENT_IMG_MS = 5 * 60 * 1000; // don't GC images uploaded in the last 5 min

// ----- Files of the space ---------------------------------------------------------------
// Slideshow/slides.json          the deck
// Slideshow/images/<uuid>.<ext>  its uploaded images, named by the elements' imageId
const FOLDER = "Slideshow";
const SHOW_FILE = `${FOLDER}/slides.json`;
const IMAGES = `${FOLDER}/images`;

const ID_RE = /^[0-9a-fA-F-]{8,64}$/;

async function loadShow(): Promise<Show> {
  try {
    const raw = await spaceFiles.read(SHOW_FILE);
    return raw ? sanitizeShow(JSON.parse(new TextDecoder().decode(raw))) : structuredClone(DEFAULT_SHOW);
  } catch { return structuredClone(DEFAULT_SHOW); }
}
async function saveShow(show: Show): Promise<void> {
  await spaceFiles.write(SHOW_FILE, JSON.stringify(show, null, 2));
}

// The live shared present position. Kept apart from the deck so that frequent slide-advance
// writes never collide with editor deck saves or fire deck_changed refreshes. Late joiners
// read it via /api/state so they land on the slide the presenter is currently on.
type Present = { index: number };
async function loadPresent(sfiId: string): Promise<Present> {
  return { index: num(await frameSettings(sfiId).get<number>("slideshow_present"), 0, 0, MAX_SLIDES) };
}
async function savePresent(sfiId: string, index: number): Promise<void> {
  await frameSettings(sfiId).set("slideshow_present", index);
}

// ----- Viewer presence ------------------------------------------------------------------
// Editors see a live "N watching" count of read-only viewers. Viewers ping every 10s; a
// session is live until VIEWER_TTL_MS passes without one. In-memory only — a frame restart
// resets the count until the next round of pings. Every page pings, editors included, and
// each ping re-broadcasts a changed count, which is how a viewer going quiet (closing a tab
// sends no goodbye) is noticed: a worker has no instance to push to outside a request.
const VIEWER_TTL_MS = 25_000;
const _viewersBySfi = new Map<string, Map<string, number>>(); // sfi_id → session → lastSeen ms
const _lastPushedViewerCount = new Map<string, number>();
function viewerCount(sfiId: string): number {
  const m = _viewersBySfi.get(sfiId);
  if (!m) return 0;
  const now = Date.now();
  for (const [sid, t] of m) if (now - t > VIEWER_TTL_MS) m.delete(sid);
  return m.size;
}
function recordViewer(sfiId: string, session: string): void {
  let m = _viewersBySfi.get(sfiId);
  if (!m) { m = new Map(); _viewersBySfi.set(sfiId, m); }
  m.set(session, Date.now());
}
function broadcastViewerCount(sfiId: string): void {
  const count = viewerCount(sfiId);
  if (_lastPushedViewerCount.get(sfiId) === count) return;
  _lastPushedViewerCount.set(sfiId, count);
  pushToInstance(sfiId, { type: "viewers_changed", count });
}

// ----- Validation -----------------------------------------------------------------------
function num(v: unknown, def: number, lo: number, hi: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, n));
}
function str(v: unknown, max: number): string {
  return String(v ?? "").slice(0, max);
}
function oneOf(v: unknown, allowed: string[], def: string): string {
  const s = String(v ?? "");
  return allowed.includes(s) ? s : def;
}

function sanitizeElement(e: any): SlideElement | null {
  if (!e || typeof e !== "object") return null;
  const type = oneOf(e.type, ["text", "image", "shape"], "text") as SlideElement["type"];
  const id = ID_RE.test(String(e.id || "")) ? String(e.id) : crypto.randomUUID();
  const out: SlideElement = {
    id, type,
    x: num(e.x, 0, -2000, 4000), y: num(e.y, 0, -2000, 4000),
    w: num(e.w, 200, 4, 4000), h: num(e.h, 100, 4, 4000),
  };
  if (type === "text") {
    out.text = str(e.text, MAX_TEXT);
    out.style = oneOf(e.style, ["heading", "subheading", "body", "bullets", "caption"], "body");
    out.align = oneOf(e.align, ["left", "center", "right"], "left");
    out.color = oneOf(e.color, ["text", "secondary", "muted", "accent", "accentfg", "white"], "text");
    out.size = num(e.size, 32, 6, 400);
    out.weight = num(e.weight, 400, 300, 800);
  } else if (type === "image") {
    out.imageId = ID_RE.test(String(e.imageId || "")) ? String(e.imageId) : "";
    out.fit = oneOf(e.fit, ["contain", "cover"], "contain");
    out.radius = num(e.radius, 0, 0, 1000);
  } else {
    out.shape = oneOf(e.shape, ["rect", "ellipse", "line"], "rect");
    out.fill = oneOf(e.fill, ["accent", "accentmuted", "text", "muted", "white", "none"], "accent");
    out.radius = num(e.radius, 0, 0, 1000);
  }
  return out;
}

function sanitizeShow(raw: any): Show {
  const s = raw && typeof raw === "object" ? raw : {};
  // Legacy decks may still carry settings.palette from when the frame picked its own
  // accent; it is dropped here — the frame now follows the space channel color.
  const settings: Settings = {
    background: oneOf(s.settings?.background, ["paper","white","dark","accent","accentmuted"], "paper"),
    aspect: oneOf(s.settings?.aspect, ["16:9","4:3","1:1"], "16:9"),
    syncPresent: s.settings?.syncPresent === true,
  };
  const slidesIn = Array.isArray(s.slides) ? s.slides.slice(0, MAX_SLIDES) : [];
  const slides: Slide[] = slidesIn.map((sl: any) => {
    const id = ID_RE.test(String(sl?.id || "")) ? String(sl.id) : crypto.randomUUID();
    const elsIn = Array.isArray(sl?.elements) ? sl.elements.slice(0, MAX_ELEMENTS) : [];
    const elements = elsIn.map(sanitizeElement).filter(Boolean) as SlideElement[];
    return { id, background: oneOf(sl?.background, ["inherit","paper","white","dark","accent","accentmuted"], "inherit"), elements };
  });
  return { settings, slides };
}

// Remove image files no longer referenced by any element, sparing an upload not yet placed
// for a few minutes (it lands before the save that places it; once placed, it is spared no more).
const recentUploads = new Map<string, number>(); // image id → uploaded at
async function gcImages(show: Show): Promise<void> {
  const referenced = new Set<string>();
  for (const sl of show.slides) for (const el of sl.elements) if (el.imageId) referenced.add(el.imageId);
  for (const id of referenced) recentUploads.delete(id);
  const now = Date.now();
  for (const [id, at] of recentUploads) if (now - at > KEEP_RECENT_IMG_MS) recentUploads.delete(id);
  for (const e of await spaceFiles.list(IMAGES).catch(() => [])) {
    const id = e.name.replace(/\.[^.]+$/, "");
    if (e.dir || e.link || referenced.has(id) || recentUploads.has(id)) continue;
    await spaceFiles.remove(`${IMAGES}/${e.name}`).catch(() => { /* already gone */ });
  }
}

async function imageFile(id: string): Promise<string | null> {
  if (!ID_RE.test(id)) return null;
  const kid = (await spaceFiles.list(IMAGES).catch(() => []))
    .find((k) => !k.dir && k.name.replace(/\.[^.]+$/, "") === id);
  return kid ? kid.name : null;
}

// Light magic-byte sniff so a non-image renamed to .png is rejected server-side.
function looksLikeImage(buf: Uint8Array): boolean {
  if (buf.length < 12) return false;
  const b = buf;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true;              // PNG
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;                                // JPEG
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return true;                                // GIF
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&                          // RIFF....WEBP
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return true;
  return false;
}

async function stateFor(peer: ReturnType<typeof parsePeerInfo>) {
  return {
    me: {
      is_anon: peer.is_anon, is_sfi_member: peer.is_sfi_member,
      is_sfi_editor: peer.is_sfi_editor, is_owner: peer.is_owner,
      user_name: peer.user_name, space_color: peer.space_color,
    },
    show: await loadShow(),
    present: await loadPresent(peer.sfi_id),
    viewers: viewerCount(peer.sfi_id),
  };
}

// ----- Mutations ------------------------------------------------------------------------
// Shared by the HTTP arms and the bus dispatcher — same validation, same role gates,
// either entry point.
type MutPeer = ReturnType<typeof parsePeerInfo>;
type MutResult = { status: number; body: unknown };

// Save the whole deck — editors only. Last-write-wins; viewers refresh on the push.
async function mutSave(sfiId: string, v: { show?: any; by?: string } | null, peer: MutPeer): Promise<MutResult> {
  if (!peer.is_sfi_editor) return { status: 403, body: { error: "editors only" } };
  const show = sanitizeShow(v?.show);
  await saveShow(show);
  await gcImages(show);
  pushToInstance(sfiId, { type: "deck_changed", by: str(v?.by, 64) });
  return { status: 200, body: { ok: true } };
}

// Advance the live shared presentation — editors only (they are the presenters). The new
// index is persisted and pushed to EVERY viewer of the space: peers AND our own sibling
// devices both receive it via pushToInstance, so a follower's present view tracks the presenter.
async function mutPresent(sfiId: string, v: { index?: number; by?: string } | null, peer: MutPeer): Promise<MutResult> {
  if (!peer.is_sfi_editor) return { status: 403, body: { error: "editors only" } };
  const show = await loadShow();
  const index = num(v?.index, 0, 0, Math.max(0, show.slides.length - 1));
  await savePresent(sfiId, index);
  pushToInstance(sfiId, { type: "present_changed", index, by: str(v?.by, 64) });
  return { status: 200, body: { ok: true } };
}

// Presence ping — read-only viewers announce themselves so editors can see a live
// "N watching" count. Editors are never counted, but their pings sweep out quiet viewers;
// it only touches the in-memory viewer map (broadcastViewerCount pushes on change).
function mutViewerPing(sfiId: string, v: { by?: string } | null, peer: MutPeer): MutResult {
  const sid = str(v?.by, 64);
  if (!peer.is_sfi_editor && sid) recordViewer(sfiId, sid);
  broadcastViewerCount(sfiId);
  return { status: 200, body: { ok: true } };
}

// Bus dispatcher — the frontend's write path (frame.busSend → BusUiToFrame). `peer` is the
// sender's platform-resolved identity, same shape as parsePeerInfo; role gates live inside
// the mutation functions. Denials are logged, not answered.
onUiMessage(async (sfiId, data, peer) => {
  if (!sfiId || typeof data !== "object" || data === null) return;
  const d = data as Record<string, unknown>;
  const r =
    d.op === "save"          ? await mutSave(sfiId, d as { show?: any; by?: string }, peer)
    : d.op === "present"     ? await mutPresent(sfiId, d as { index?: number; by?: string }, peer)
    : d.op === "viewer_ping" ? mutViewerPing(sfiId, d as { by?: string }, peer)
    : null;
  if (r && r.status !== 200) log(`slideshow: bus op ${d.op} → ${r.status} (${JSON.stringify(r.body)})`);
});

// ----- Networking -----------------------------------------------------------------------
self.onNetworkRequest = async function (replyPort, reqPath, method, headers, query, body, cookies) {
  const peer = parsePeerInfo(query, cookies);

  // Static assets — open to everyone (read-only viewers still need the shell).
  if (method === "GET" && !reqPath.startsWith("/api/")) {
    return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url), headers);
  }

  // Full deck + identity in one round trip. Readable by everyone (public view).
  if (reqPath === "/api/state" && method === "GET") {
    return jsonReply(replyPort, 200, await stateFor(peer));
  }

  // HTTP arms kept for API compatibility (older viewers, web viewer fallback); the frame's
  // own UI writes over the bus (see the dispatcher above). Same functions, same gates.
  if (reqPath === "/api/save" && method === "POST") {
    const r = await mutSave(peer.sfi_id, parseJsonBody<{ show?: any; by?: string }>(body), peer);
    return jsonReply(replyPort, r.status, r.body);
  }

  if (reqPath === "/api/present" && method === "POST") {
    const r = await mutPresent(peer.sfi_id, parseJsonBody<{ index?: number; by?: string }>(body), peer);
    return jsonReply(replyPort, r.status, r.body);
  }

  if (reqPath === "/api/viewer_ping" && method === "POST") {
    const r = mutViewerPing(peer.sfi_id, parseJsonBody<{ by?: string }>(body), peer);
    return jsonReply(replyPort, r.status, r.body);
  }

  // Image upload — editors only. Bytes are the raw body; ext rides in ?ext=. Client resizes
  // down to <= 2048px and a reasonable byte size before sending; we re-check both here.
  if (reqPath === "/api/upload" && method === "POST") {
    if (!peer.is_sfi_editor) return jsonReply(replyPort, 403, { error: "editors only" });
    let ext = String(query.ext || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (ext === "jpeg") ext = "jpg";
    if (!IMG_EXTS.has(ext)) return jsonReply(replyPort, 400, { error: "unsupported image type" });
    if (body.byteLength === 0) return jsonReply(replyPort, 400, { error: "empty upload" });
    if (body.byteLength > MAX_IMAGE_BYTES) return jsonReply(replyPort, 413, { error: "image too large" });
    const bytes = new Uint8Array(body);
    if (!looksLikeImage(bytes)) return jsonReply(replyPort, 415, { error: "file is not an image" });
    const id = crypto.randomUUID();
    recentUploads.set(id, Date.now());
    await spaceFiles.write(`${IMAGES}/${id}.${ext}`, bytes);
    return jsonReply(replyPort, 200, { imageId: id });
  }

  // Image fetch — readable by everyone who can see the deck.
  if (reqPath.startsWith("/api/image/") && method === "GET") {
    const name = await imageFile(reqPath.slice("/api/image/".length));
    const buf = name ? await spaceFiles.read(`${IMAGES}/${name}`).catch(() => null) : null;
    if (!name || !buf) return jsonReply(replyPort, 404, { error: "not found" });
    const mime = contentType(extname(name)) || "application/octet-stream";
    return replyPort.postMessage({
      status: 200, body: buf, contentType: mime,
      headers: { "Cache-Control": "private, max-age=300" },
    }, [buf.buffer]);
  }

  return jsonReply(replyPort, 404, { error: "not found" });
};

log("Slideshow frame is up and running!");
