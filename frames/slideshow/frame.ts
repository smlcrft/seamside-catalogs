// ----------------------------------------------------------------------------------------
// Slideshow — a simple presentation maker and presenter, one per session.
//
// Design axes:
//   privacy:        privacy-public-view  — editors build/edit the deck; viewers and anonymous
//                                           link visitors get a read-only, browseable presentation.
//   data_storage:   storage-simple-files — the whole deck is one file of the space,
//                                           Slideshow/slides.json, its uploaded images beside it
//                                           in Slideshow/images/; the live present position is
//                                           the `slideshow_present` row of __fc_settings.
//   view_realtime:  view-collaborative   — every save pushes what changed and every open page
//                                           reads again as whoever it is; when "keep viewers in
//                                           sync" is on, each slide advance pushes too, so every
//                                           viewer's presentation tracks the editor's current slide.
//   settings_scope: settings-per-session — everything is this session's.
//
// The page reads no table and no file: every read and write is a route here, decided on
// ctx.peer, and images are served as bytes by /api/image.
// ----------------------------------------------------------------------------------------
import type { Ctx } from "@frame-core";
import { contentType, extname } from "@frame-core";

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

async function loadShow(ctx: Ctx): Promise<Show> {
  try {
    const raw = await ctx.files.read(SHOW_FILE);
    return raw ? sanitizeShow(JSON.parse(new TextDecoder().decode(raw))) : structuredClone(DEFAULT_SHOW);
  } catch { return structuredClone(DEFAULT_SHOW); }
}
async function saveShow(ctx: Ctx, show: Show): Promise<void> {
  await ctx.files.write(SHOW_FILE, JSON.stringify(show, null, 2));
}

// The live shared present position. Kept apart from the deck so that frequent slide-advance
// writes never collide with editor deck saves or fire deck refreshes. Late joiners read it
// via /api/state so they land on the slide the presenter is currently on. A setting is a row
// of __fc_settings, its value JSON under `v`, stamped like every row.
const SETTINGS = "__fc_settings";
const PRESENT_KEY = "slideshow_present";
type Present = { index: number };
async function loadPresent(ctx: Ctx): Promise<Present> {
  const row = await ctx.table<{ v?: string }>(SETTINGS).get(PRESENT_KEY);
  let v: unknown = null;
  try { v = row?.v == null ? null : JSON.parse(String(row.v)); } catch { /* unreadable: from 0 */ }
  return { index: num(v, 0, 0, MAX_SLIDES) };
}
async function savePresent(ctx: Ctx, index: number): Promise<void> {
  const t = ctx.table<Record<string, unknown>>(SETTINGS);
  const was = await t.get(PRESENT_KEY);
  const now = Date.now();
  await t.upsert({ ...(was ?? { _created_at: now }), v: JSON.stringify(index), id: PRESENT_KEY, _modified_at: now });
}

// What changed, never what it holds: each page reads again as whoever it is.
const tell = (ctx: Ctx, what: "deck" | "present" | "viewers") => ctx.push({ slideshow: what });

// ----- Viewer presence ------------------------------------------------------------------
// Editors see a live "N watching" count of read-only viewers. Viewers ping every 10s; a
// page is live until VIEWER_TTL_MS passes without one. In-memory only — a frame restart
// resets the count until the next round of pings. Every page pings, editors included, and
// each ping re-broadcasts a changed count, which is how a viewer going quiet (closing a tab
// sends no goodbye) is noticed.
const VIEWER_TTL_MS = 25_000;
const _viewersBySession = new Map<string, Map<string, number>>(); // ctx.frame → page → lastSeen ms
const _lastPushedViewerCount = new Map<string, number>();
function viewerCount(frame: string): number {
  const m = _viewersBySession.get(frame);
  if (!m) return 0;
  const now = Date.now();
  for (const [sid, t] of m) if (now - t > VIEWER_TTL_MS) m.delete(sid);
  return m.size;
}
function recordViewer(frame: string, page: string): void {
  let m = _viewersBySession.get(frame);
  if (!m) { m = new Map(); _viewersBySession.set(frame, m); }
  m.set(page, Date.now());
}
function broadcastViewerCount(ctx: Ctx): void {
  const count = viewerCount(ctx.frame);
  if (_lastPushedViewerCount.get(ctx.frame) === count) return;
  _lastPushedViewerCount.set(ctx.frame, count);
  tell(ctx, "viewers");
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

// deno-lint-ignore no-explicit-any
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

// deno-lint-ignore no-explicit-any
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
  // deno-lint-ignore no-explicit-any
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
async function gcImages(ctx: Ctx, show: Show): Promise<void> {
  const referenced = new Set<string>();
  for (const sl of show.slides) for (const el of sl.elements) if (el.imageId) referenced.add(el.imageId);
  for (const id of referenced) recentUploads.delete(id);
  const now = Date.now();
  for (const [id, at] of recentUploads) if (now - at > KEEP_RECENT_IMG_MS) recentUploads.delete(id);
  for (const e of await ctx.files.list(IMAGES).catch(() => [])) {
    const id = e.name.replace(/\.[^.]+$/, "");
    if (e.dir || referenced.has(id) || recentUploads.has(id)) continue;
    await ctx.files.remove(`${IMAGES}/${e.name}`).catch(() => { /* already gone */ });
  }
}

async function imageFile(ctx: Ctx, id: string): Promise<string | null> {
  if (!ID_RE.test(id)) return null;
  const kid = (await ctx.files.list(IMAGES).catch(() => []))
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

const isEditor = (ctx: Ctx) => ctx.peer.is_sfi_editor || ctx.peer.is_owner;

async function stateFor(ctx: Ctx) {
  const peer = ctx.peer;
  return {
    me: {
      is_anon: peer.is_anon, is_sfi_member: peer.is_sfi_member,
      is_sfi_editor: isEditor(ctx), is_owner: peer.is_owner,
      user_name: peer.user_name, space_color: peer.space_color,
    },
    show: await loadShow(ctx),
    present: await loadPresent(ctx),
    viewers: viewerCount(ctx.frame),
  };
}

const json = (v: unknown, status = 200) => Response.json(v, { status });
const refuse = (status: number, error: string) => json({ error }, status);

// deno-lint-ignore no-explicit-any
async function body(request: Request): Promise<any> {
  try {
    const v = JSON.parse(await request.text());
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

// ----- Mutations ------------------------------------------------------------------------
// Save the whole deck — editors only. Last-write-wins; everyone else reads again on the push.
// deno-lint-ignore no-explicit-any
async function save(ctx: Ctx, v: { show?: any } | null): Promise<Response> {
  if (!isEditor(ctx)) return refuse(403, "editors only");
  const show = sanitizeShow(v?.show);
  await saveShow(ctx, show);
  await gcImages(ctx, show);
  tell(ctx, "deck");
  return json({ ok: true });
}

// Advance the live shared presentation — editors only (they are the presenters). The new
// index is kept and every open page of the session is told, so a follower's present view
// tracks the presenter.
async function present(ctx: Ctx, v: { index?: number } | null): Promise<Response> {
  if (!isEditor(ctx)) return refuse(403, "editors only");
  const show = await loadShow(ctx);
  const index = num(v?.index, 0, 0, Math.max(0, show.slides.length - 1));
  await savePresent(ctx, index);
  tell(ctx, "present");
  return json({ ok: true });
}

// Presence ping — read-only viewers announce themselves so editors can see a live
// "N watching" count. Editors are never counted, but their pings sweep out quiet viewers;
// it only touches the in-memory viewer map (broadcastViewerCount pushes on change).
function viewerPing(ctx: Ctx, v: { by?: string } | null): Response {
  const page = str(v?.by, 64);
  if (!isEditor(ctx) && page) recordViewer(ctx.frame, page);
  broadcastViewerCount(ctx);
  return json({ ok: true });
}

// Image upload — editors only. Bytes are the raw body; ext rides in ?ext=. Client resizes
// down to <= 2048px and a reasonable byte size before sending; we re-check both here.
async function upload(ctx: Ctx, query: URLSearchParams, bytes: Uint8Array): Promise<Response> {
  if (!isEditor(ctx)) return refuse(403, "editors only");
  let ext = String(query.get("ext") || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (ext === "jpeg") ext = "jpg";
  if (!IMG_EXTS.has(ext)) return refuse(400, "unsupported image type");
  if (bytes.byteLength === 0) return refuse(400, "empty upload");
  if (bytes.byteLength > MAX_IMAGE_BYTES) return refuse(413, "image too large");
  if (!looksLikeImage(bytes)) return refuse(415, "file is not an image");
  const id = crypto.randomUUID();
  recentUploads.set(id, Date.now());
  await ctx.files.write(`${IMAGES}/${id}.${ext}`, bytes);
  return json({ imageId: id });
}

// Image fetch — readable by everyone who can see the deck.
async function image(ctx: Ctx, id: string): Promise<Response> {
  const name = await imageFile(ctx, id);
  const buf = name ? await ctx.files.read(`${IMAGES}/${name}`).catch(() => null) : null;
  if (!name || !buf) return refuse(404, "not found");
  return new Response(buf as Uint8Array<ArrayBuffer>, {
    headers: {
      "content-type": contentType(extname(name)) || "application/octet-stream",
      "cache-control": "private, max-age=300",
    },
  });
}

// ----- Networking -----------------------------------------------------------------------
export default {
  async fetch(request: Request, ctx: Ctx): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    // Static assets — open to everyone (read-only viewers still need the shell).
    if (method === "GET" && !pathname.startsWith("/api/")) return ctx.file(pathname);

    // Full deck + identity in one round trip. Readable by everyone (public view).
    if (pathname === "/api/state" && method === "GET") return json(await stateFor(ctx));
    if (pathname.startsWith("/api/image/") && method === "GET") return image(ctx, pathname.slice("/api/image/".length));

    if (method === "POST") {
      if (pathname === "/api/save") return save(ctx, await body(request));
      if (pathname === "/api/present") return present(ctx, await body(request));
      if (pathname === "/api/viewer_ping") return viewerPing(ctx, await body(request));
      if (pathname === "/api/upload") return upload(ctx, url.searchParams, new Uint8Array(await request.arrayBuffer()));
    }

    return refuse(404, "not found");
  },
};
