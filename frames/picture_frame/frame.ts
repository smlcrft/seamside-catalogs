// ----------------------------------------------------------------------------------------
// Picture Frame — a digital picture frame, one display per session.
//
// Design axes:
//   privacy:        privacy-public-view  — editors curate the photos; Viewer-role members and
//                                          anonymous link visitors get a browseable read-only view.
//   data_storage:   the frame data folder — photo ROWS are `_fdata/photos.table.jsonl`; each
//                                          photo and its thumbnail are files beside it, under
//                                          `_fdata/photos/<photo_id>/`, named by the row (paths
//                                          within `_fdata`). Display state is this session's own keys.
//   view_realtime:  view-collaborative   — every mutation pushes what changed, and every open page
//                                          of the frame reads again as whoever it is.
//   settings_scope: photos per space, display per session — two frames in one space share
//                                          the photos and each keeps its own wall.
//
// The page reads no table and no file: every read and write is a route here, decided on
// ctx.peer, and pictures are served as bytes by /api/photo and /api/thumb.
//
// The shared display
// ------------------
// The frame is a wall display: there is exactly ONE current photo per session, and
// {mode, current_photo_id} in the session's keys IS the frame's display state. Restoring it on load
// is what makes the frame come back to the same photo after a restart — there is no separate
// "remember where I was" mechanism. Editors drive that state; everyone else browses locally in
// the frontend without persisting anything (see public/index.html).
//
// The slideshow clock
// -------------------
// A running slideshow's position is COMPUTED, not stored. We persist four values —
// slideshow_on, slideshow_secs, anchor_photo_id, anchor_ms — and every client derives which
// photo should be showing right now from them (see public/slideshow-clock.js). That means zero
// writes per tick, every device converges without talking to the others, and a restart lands
// where the show should be because position is a pure function of the clock.
//
// Three things re-anchor the show (anchor_photo_id := what is showing now, anchor_ms := now):
// an editor stepping to a photo by hand, an upload, and a delete. The latter two matter because
// changing the photo count shifts the modulus and the show would otherwise jump. Stopping the
// show writes the computed photo back into current_photo_id — the handoff from a derived
// position to a stored one.
// ----------------------------------------------------------------------------------------
import type { Ctx } from "@frame-core";
import { clampInt, declareTables, sanitizeText, toIntOrNull } from "@frame-core";

// ----- The shared photos table, in the frame data folder --------------------------------
const PHOTOS = "photos";
const SCHEMA: Array<{ name: string; col_type: "text" | "integer"; nullable: boolean; default_val: string }> = [
  { name: "name",       col_type: "text",    nullable: false, default_val: "" },          // original filename
  { name: "mime",       col_type: "text",    nullable: false, default_val: "image/jpeg" },
  { name: "size",       col_type: "integer", nullable: false, default_val: "0" },
  { name: "w",          col_type: "integer", nullable: false, default_val: "0" },         // natural dimensions, so the
  { name: "h",          col_type: "integer", nullable: false, default_val: "0" },         // grid reserves space up front
  { name: "sort_order", col_type: "integer", nullable: false, default_val: "0" },
  { name: "added_ms",   col_type: "integer", nullable: false, default_val: "0" },
  { name: "added_by",   col_type: "text",    nullable: false, default_val: "" },
  { name: "path",       col_type: "text",    nullable: false, default_val: "" },          // photos/<id>/<name>, within _fdata
  { name: "thumb_path", col_type: "text",    nullable: false, default_val: "" },          // its grid thumbnail, if any
];
declareTables([
  {
    key: PHOTOS,
    title: "Photos",
    description: "Photos on a picture frame; `path` and `thumb_path` are files in the frame data folder.",
    schema: SCHEMA,
  },
]);

// A new row starts from the schema's defaults, as rows written before always did.
const DEFAULTS: Record<string, unknown> = Object.fromEntries(
  SCHEMA.map((c) => [c.name, c.col_type === "integer" ? Number(c.default_val) : c.default_val]),
);

type Row = Record<string, unknown> & { id: string };
const photosOf = (ctx: Ctx) => ctx.shared.table<Record<string, unknown>>(PHOTOS);

/** Lay `values` over the row as it stands (or the defaults, for a new one), stamped. */
async function keep(ctx: Ctx, id: string | null, values: Record<string, unknown>): Promise<Row> {
  const was = id ? await photosOf(ctx).get(id) : null;
  const now = Date.now();
  return await photosOf(ctx).upsert({
    ...(was ?? { ...DEFAULTS, _created_at: now }),
    ...values,
    ...(id ? { id } : {}),
    _modified_at: now,
  });
}

// ----- Caps -----------------------------------------------------------------------------
const MAX_PHOTOS = 300;
const MAX_BYTES = 8 * 1024 * 1024;    // per upload, AFTER the client's downscale; a request past 8 MiB never arrives
const MAX_THUMB_BYTES = 2 * 1024 * 1024;
const MIN_SECS = 3;
const MAX_SECS = 3600;
const DEFAULT_SECS = 15;
const MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

// ----- Files, beside the table: _fdata/photos/<photo_id>/<name> and its thumbnail ------
const FOLDER = PHOTOS;
function dirFor(id: string): string { return `${FOLDER}/${id}`; }
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
// The stored name says what the bytes are (the page may re-encode a photo as JPEG).
function fileName(name: string, mime: string): string {
  const stem = name.replace(/\.[^.]*$/, "") || "photo";
  const n = `${stem}.${EXT[mime]}`;
  return n.startsWith("thumbnail.") ? `photo-${n}` : n;
}
function sniffMime(b: Uint8Array): string {
  if (b[0] === 0x89) return "image/png";
  if (b[0] === 0x47) return "image/gif";
  if (b[0] === 0x52) return "image/webp";
  return "image/jpeg";
}
// A row may name only a file of its own photo's folder.
function fileOf(id: string, p: unknown): string | null {
  const s = String(p ?? "");
  return s.startsWith(dirFor(id) + "/") ? s : null;
}

// A photo's id is its row id (the table's own, base-36 and a dash), which also names its folder.
const ID_RE = /^[0-9A-Za-z_-]{8,64}$/;

// ----- Display state: this session's own keys, one per field, a JSON value each -----------
function settingsFor(ctx: Ctx) {
  const k = (key: string) => `display/${key}`;
  return {
    async get<T>(key: string): Promise<T | null> {
      const op = await ctx.kv.get(k(key));
      if (op?.value == null) return null;
      try { return JSON.parse(op.value) as T; } catch { return null; }
    },
    set: (key: string, value: unknown) => ctx.kv.put(k(key), JSON.stringify(value ?? null)),
  };
}
type Mode = "grid" | "single";
type Fit = "contain" | "cover";
interface Display {
  mode: Mode;
  current_photo_id: string;
  fit: Fit;
  slideshow_on: boolean;
  slideshow_secs: number;
  anchor_photo_id: string;
  anchor_ms: number;
}

async function getDisplay(ctx: Ctx): Promise<Display> {
  const s = settingsFor(ctx);
  const [mode, current, fit, on, secs, anchorId, anchorMs] = await Promise.all([
    s.get<string>("mode"),
    s.get<string>("current_photo_id"),
    s.get<string>("fit"),
    s.get<boolean>("slideshow_on"),
    s.get<number>("slideshow_secs"),
    s.get<string>("anchor_photo_id"),
    s.get<number>("anchor_ms"),
  ]);
  return {
    mode: mode === "single" ? "single" : "grid",
    current_photo_id: typeof current === "string" ? current : "",
    fit: fit === "cover" ? "cover" : "contain",
    slideshow_on: on === true,
    slideshow_secs: clampInt(Number(secs) || DEFAULT_SECS, MIN_SECS, MAX_SECS),
    anchor_photo_id: typeof anchorId === "string" ? anchorId : "",
    anchor_ms: Number(anchorMs) || 0,
  };
}

// Write only the keys present in `patch` — distinct keys are distinct rows, so concurrent
// writes to different fields never clobber one another.
async function setDisplay(ctx: Ctx, patch: Partial<Display>): Promise<void> {
  const s = settingsFor(ctx);
  await Promise.all((Object.keys(patch) as Array<keyof Display>).map((k) => s.set(k, patch[k])));
}

// ----- Photos ---------------------------------------------------------------------------
interface Photo {
  id: string; name: string; mime: string; size: number;
  w: number; h: number; added_ms: number; added_by: string;
}

const num = (v: unknown) => Number(v) || 0;

// ONE ordering for the whole frame — sort_order ascending, i.e. upload order. The grid and the
// slideshow both walk it, so "next photo" means the same thing everywhere.
async function photoRows(ctx: Ctx): Promise<Row[]> {
  return (await photosOf(ctx).all()).sort((a, b) =>
    num(a.sort_order) - num(b.sort_order) || num(a._created_at) - num(b._created_at) || a.id.localeCompare(b.id)
  );
}

async function listPhotos(ctx: Ctx): Promise<Photo[]> {
  return (await photoRows(ctx)).slice(0, MAX_PHOTOS).map((r) => ({
    id: r.id,
    name: String(r.name ?? ""),
    mime: String(r.mime ?? "image/jpeg"),
    size: num(r.size),
    w: num(r.w),
    h: num(r.h),
    added_ms: num(r.added_ms),
    added_by: String(r.added_by ?? ""),
  }));
}

// Reduce an incoming filename to a safe basename (no path traversal, no control chars).
function safeName(raw: unknown): string {
  let n = String(raw ?? "").split(/[\\/]/).pop() || "";
  n = n.replace(/[\x00-\x1f]/g, "").replace(/^\.+/, "").trim();
  if (n.length > 200) n = n.slice(0, 200);
  return n || "photo";
}

// Magic-byte sniff, so a non-image renamed to .png is rejected server-side.
function looksLikeImage(b: Uint8Array): boolean {
  if (b.length < 12) return false;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true;   // PNG
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;                    // JPEG
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return true;                    // GIF
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&              // RIFF....WEBP
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return true;
  return false;
}

// Which photo is showing right now, as the BACKEND understands it. While the slideshow runs the
// position is derived by each client from the anchor, so this is only the paused/stored answer —
// used to keep current_photo_id pointing at something real.
function resolveCurrent(photos: Photo[], id: string): Photo | null {
  if (!photos.length) return null;
  return photos.find((p) => p.id === id) || photos[0];
}

// Re-anchor a running show so a changed photo count doesn't make it jump. `showing` is the photo
// the client says is on screen; we fall back to the stored current when it isn't usable.
async function reanchor(ctx: Ctx, photos: Photo[], showing: string, d: Display): Promise<void> {
  if (!d.slideshow_on) return;
  const at = resolveCurrent(photos, showing || d.current_photo_id);
  await setDisplay(ctx, { anchor_photo_id: at ? at.id : "", anchor_ms: Date.now() });
}

function serveBytes(buf: Uint8Array, mime: string): Response {
  return new Response(buf as Uint8Array<ArrayBuffer>, {
    headers: {
      "content-type": mime,
      // A photo id is never reused and a photo's bytes never change, so this is safe.
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}

const editor = (ctx: Ctx) => ctx.peer.is_sfi_editor || ctx.peer.is_owner;

async function stateFor(ctx: Ctx) {
  const peer = ctx.peer;
  const [display, photos] = await Promise.all([getDisplay(ctx), listPhotos(ctx)]);
  return {
    me: {
      is_anon: peer.is_anon, is_sfi_member: peer.is_sfi_member,
      is_sfi_editor: peer.is_sfi_editor, is_owner: peer.is_owner,
      user_name: peer.user_name, space_color: peer.space_color,
    },
    can_edit: editor(ctx),
    display,
    photos,
    // The clock reference. Clients compute (server_ms - their Date.now()) once and apply it, so a
    // device with a skewed clock still lands on the same slideshow photo as everyone else.
    server_ms: Date.now(),
  };
}

// What changed, never what it holds: each page reads again as whoever it is.
const tell = (ctx: Ctx, what: "display" | "photos") => ctx.push({ picture_frame: what });

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

// ----- Writes (editors only) --------------------------------------------------------------

// Set what the frame is displaying. This is the shared wall state: it persists and pushes
// to every viewer. Non-editors never reach here; they browse in local frontend state instead.
async function setShown(ctx: Ctx, v: Record<string, unknown>): Promise<Response> {
  const [d, photos] = await Promise.all([getDisplay(ctx), listPhotos(ctx)]);
  const patch: Partial<Display> = {};
  if (v.mode === "grid" || v.mode === "single") patch.mode = v.mode;
  if (typeof v.photo_id === "string" && v.photo_id) {
    const hit = photos.find((p) => p.id === v.photo_id);
    if (!hit) return refuse(404, "photo not found");
    patch.current_photo_id = hit.id;
    // Stepping by hand while the show runs restarts the dwell on the chosen photo.
    if (d.slideshow_on) { patch.anchor_photo_id = hit.id; patch.anchor_ms = Date.now(); }
  }
  if (Object.keys(patch).length) await setDisplay(ctx, patch);
  tell(ctx, "display");
  return json(await stateFor(ctx));
}

// Fit / slideshow settings.
async function setSettings(ctx: Ctx, v: Record<string, unknown>): Promise<Response> {
  const [d, photos] = await Promise.all([getDisplay(ctx), listPhotos(ctx)]);
  const patch: Partial<Display> = {};
  if (v.fit === "contain" || v.fit === "cover") patch.fit = v.fit;
  if (v.slideshow_secs !== undefined) {
    patch.slideshow_secs = clampInt(toIntOrNull(v.slideshow_secs) ?? DEFAULT_SECS, MIN_SECS, MAX_SECS);
  }

  if (v.slideshow_on !== undefined) {
    const on = v.slideshow_on === true;
    patch.slideshow_on = on;
    // The photo the client says is on screen right now — the pivot in both directions.
    const showing = resolveCurrent(photos, sanitizeText(v.current_photo_id, 64) || d.current_photo_id);
    if (on) {
      // Starting: anchor the show to what's already up, from this instant.
      patch.anchor_photo_id = showing ? showing.id : "";
      patch.anchor_ms = Date.now();
    } else if (showing) {
      // Stopping: the client holds the computed position, so it rides in on this same write.
      // Persisting it here is the handoff from a derived position back to a stored one.
      patch.current_photo_id = showing.id;
    }
  } else if (patch.slideshow_secs !== undefined && d.slideshow_on) {
    // Changing the interval mid-show would otherwise teleport the position, because the whole
    // elapsed span gets re-divided by the new dwell. Re-anchor to what's showing instead.
    const showing = resolveCurrent(photos, sanitizeText(v.current_photo_id, 64) || d.current_photo_id);
    patch.anchor_photo_id = showing ? showing.id : "";
    patch.anchor_ms = Date.now();
  }

  if (Object.keys(patch).length) await setDisplay(ctx, patch);
  tell(ctx, "display");
  return json(await stateFor(ctx));
}

// Delete a photo. Removes the row and both files, then repairs the display state so the
// frame is never left pointing at something that no longer exists.
async function remove(ctx: Ctx, id: string): Promise<Response> {
  if (!ID_RE.test(id)) return refuse(400, "bad id");
  if (!(await photosOf(ctx).get(id))) return refuse(404, "not found");

  const [before, d] = await Promise.all([listPhotos(ctx), getDisplay(ctx)]);
  const idx = before.findIndex((p) => p.id === id);

  await photosOf(ctx).delete(id);
  await ctx.shared.files.remove(dirFor(id)).catch(() => { /* already gone */ });

  const after = before.filter((p) => p.id !== id);
  const patch: Partial<Display> = {};
  if (!after.length) {
    // Nothing left to show — the grid (with its empty state) is the only sane resting place.
    patch.mode = "grid";
    patch.current_photo_id = "";
    patch.anchor_photo_id = "";
  } else if (d.current_photo_id === id) {
    // Advance to the next photo in order, wrapping past the end.
    patch.current_photo_id = after[idx % after.length].id;
  }
  // A removed photo shifts the modulus; re-anchor so a running show doesn't jump.
  if (d.slideshow_on) {
    patch.anchor_photo_id = after.length
      ? (patch.current_photo_id ?? resolveCurrent(after, d.current_photo_id)?.id ?? after[0].id)
      : "";
    patch.anchor_ms = Date.now();
  }
  await setDisplay(ctx, patch);

  tell(ctx, "photos");
  return json(await stateFor(ctx));
}

// Upload a photo. Bytes are the raw body; metadata rides in the query string.
// The client has already downscaled to <= 2560px and measured the natural dimensions.
async function upload(ctx: Ctx, query: URLSearchParams, buf: Uint8Array): Promise<Response> {
  const mime = sanitizeText(query.get("mime"), 120).toLowerCase();
  if (!MIMES.has(mime)) return refuse(400, "unsupported image type");
  if (buf.byteLength === 0) return refuse(400, "empty upload");
  if (buf.byteLength > MAX_BYTES) return refuse(413, `image exceeds ${MAX_BYTES / (1024 * 1024)} MB`);
  if (!looksLikeImage(buf)) return refuse(415, "file is not an image");

  const rows = await photoRows(ctx);
  if (rows.length >= MAX_PHOTOS) return refuse(409, `this frame holds at most ${MAX_PHOTOS} photos`);
  const photos = await listPhotos(ctx);

  // Row first — its id names the photo's folder — then the bytes, undoing the row if the
  // write fails, so a failed upload can never strand a row pointing at nothing.
  const sortOrder = rows.reduce((m, r) => Math.max(m, num(r.sort_order)), -1) + 1;
  const name = safeName(query.get("name"));
  const row = await keep(ctx, null, {
    name,
    mime,
    size: buf.byteLength,
    w: clampInt(toIntOrNull(query.get("w")) ?? 0, 0, 100_000),
    h: clampInt(toIntOrNull(query.get("h")) ?? 0, 0, 100_000),
    sort_order: sortOrder,
    added_ms: Date.now(),
    added_by: sanitizeText(ctx.peer.user_name, 64),
  });
  try {
    const file = `${dirFor(row.id)}/${fileName(name, mime)}`;
    await ctx.shared.files.write(file, buf);
    // `path` is relative to _fdata, the convention: a frame reaches it through ctx.shared.files.
    await keep(ctx, row.id, { path: file });
  } catch (e) {
    await ctx.shared.files.remove(dirFor(row.id)).catch(() => {});
    await photosOf(ctx).delete(row.id);
    return refuse(500, "failed to store photo: " + e);
  }

  // A new photo shifts the modulus; re-anchor so a running show doesn't jump.
  const d = await getDisplay(ctx);
  await reanchor(ctx, [...photos, { id: row.id } as Photo], "", d);

  tell(ctx, "photos");
  return json({ photo_id: row.id });
}

// Attach the grid thumbnail to a photo just uploaded.
async function uploadThumb(ctx: Ctx, id: string, buf: Uint8Array): Promise<Response> {
  if (!ID_RE.test(id)) return refuse(400, "bad id");
  if (buf.byteLength === 0 || buf.byteLength > MAX_THUMB_BYTES) return refuse(413, "bad thumbnail size");
  if (!looksLikeImage(buf)) return refuse(415, "file is not an image");
  if (!(await photosOf(ctx).get(id))) return refuse(404, "photo not found");
  try {
    const file = `${dirFor(id)}/thumbnail.${EXT[sniffMime(buf)]}`;
    await ctx.shared.files.write(file, buf);
    await keep(ctx, id, { thumb_path: file });
  } catch (e) {
    // A missing thumbnail is survivable — /api/thumb falls back to the full image.
    ctx.log("picture_frame: thumbnail write failed: " + e);
  }
  return json({ ok: true });
}

// ----- Reads (anyone who reaches the frame) ---------------------------------------------------

// Full image.
async function photo(ctx: Ctx, id: string): Promise<Response> {
  if (!ID_RE.test(id)) return refuse(400, "bad id");
  const row = await photosOf(ctx).get(id);
  if (!row) return refuse(404, "not found");
  const file = fileOf(id, row.path);
  const buf = file ? await ctx.shared.files.read(file).catch(() => null) : null;
  if (!buf) return refuse(404, "not found");
  return serveBytes(buf, String(row.mime || "application/octet-stream"));
}

// Grid thumbnail, falling back to the full image when it's absent (older rows, failed write).
async function thumb(ctx: Ctx, id: string): Promise<Response> {
  if (!ID_RE.test(id)) return refuse(400, "bad id");
  const row = await photosOf(ctx).get(id);
  if (!row) return refuse(404, "not found");
  const t = fileOf(id, row.thumb_path);
  let buf = t ? await ctx.shared.files.read(t).catch(() => null) : null;
  const mime = buf ? sniffMime(buf) : String(row.mime || "image/jpeg");
  if (!buf) {
    const file = fileOf(id, row.path);
    buf = file ? await ctx.shared.files.read(file).catch(() => null) : null;
  }
  if (!buf) return refuse(404, "not found");
  return serveBytes(buf, mime);
}

// ----- Networking -----------------------------------------------------------------------
const WRITES = [/^\/api\/display$/, /^\/api\/settings$/, /^\/api\/upload$/, /^\/api\/upload\/[^/]*\/thumb$/, /^\/api\/delete\//];

export default {
  async fetch(request: Request, ctx: Ctx): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    // Static assets — open to everyone (every tier needs the shell to render).
    if (!pathname.startsWith("/api/")) {
      if (method !== "GET") return refuse(404, "not found");
      return ctx.file(pathname);
    }

    if (method === "GET") {
      // Identity + display state + the whole photo list, in one round trip.
      if (pathname === "/api/state") return json(await stateFor(ctx));
      if (pathname.startsWith("/api/photo/")) return photo(ctx, pathname.slice("/api/photo/".length));
      if (pathname.startsWith("/api/thumb/")) return thumb(ctx, pathname.slice("/api/thumb/".length));
      return refuse(404, "not found");
    }

    if (method !== "POST" || !WRITES.some((re) => re.test(pathname))) return refuse(404, "not found");
    if (!editor(ctx)) return refuse(403, "editors only");

    if (pathname === "/api/display") return setShown(ctx, await body(request));
    if (pathname === "/api/settings") return setSettings(ctx, await body(request));
    if (pathname.startsWith("/api/delete/")) return remove(ctx, pathname.slice("/api/delete/".length));
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (pathname === "/api/upload") return upload(ctx, url.searchParams, bytes);
    return uploadThumb(ctx, pathname.slice("/api/upload/".length, -"/thumb".length), bytes);
  },
};
