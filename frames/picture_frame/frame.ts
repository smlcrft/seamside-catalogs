// ----------------------------------------------------------------------------------------
// Picture Frame — a digital picture frame, one per placement (sfi_id).
//
// Design axes:
//   privacy:        privacy-public-view  — editors curate the photos; Viewer-role members and
//                                          anonymous link visitors get a browseable read-only view.
//   data_storage:   storage-local-db     — photo ROWS live in a per-placement LocalTable
//                                          (encrypted at rest, host-local, never synced); photo
//                                          BYTES live as files beside it. Display state lives in
//                                          the per-placement frameSettings key/value store.
//   view_realtime:  view-collaborative   — every mutation calls pushToInstance so all viewers of
//                                          the placement refresh live.
//   settings_scope: settings-per-sfi     — everything is keyed by peer.sfi_id.
//
// The shared display
// ------------------
// The frame is a wall display: there is exactly ONE current photo per placement, and
// {mode, current_photo_id} in frameSettings IS the frame's display state. Restoring it on load
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
import {
  log, jsonReply, parseJsonBody, parsePeerInfo, pushToInstance,
  sanitizeText, toIntOrNull, clampInt, frameDataDir, serveFileAtPath, path,
  declareTables, ensureTables, table, frameSettings,
} from "@frame-core";

// ----- LocalTable (per-placement — no sfi_id column needed) ------------------------------
declareTables([
  {
    key: "photos",
    title: "Picture Frame Photos",
    description: "Photos shown by this picture frame (image bytes live as files beside the table).",
    local: true,
    schema: [
      { name: "name",       col_type: "text",    nullable: false, default_val: "" },          // original filename
      { name: "mime",       col_type: "text",    nullable: false, default_val: "image/jpeg" },
      { name: "size",       col_type: "integer", nullable: false, default_val: "0" },
      { name: "w",          col_type: "integer", nullable: false, default_val: "0" },         // natural dimensions, so the
      { name: "h",          col_type: "integer", nullable: false, default_val: "0" },         // grid reserves space up front
      { name: "sort_order", col_type: "integer", nullable: false, default_val: "0" },
      { name: "added_ms",   col_type: "integer", nullable: false, default_val: "0" },
      { name: "added_by",   col_type: "text",    nullable: false, default_val: "" },
    ],
  },
]);

type Tbl = ReturnType<typeof table>;
type Settings = ReturnType<typeof frameSettings>;
type Peer = ReturnType<typeof parsePeerInfo>;
interface Tables { settings: Settings; photos: Tbl }

// ----- Caps -----------------------------------------------------------------------------
const MAX_PHOTOS = 300;
const MAX_BYTES = 25 * 1024 * 1024;   // per upload, AFTER the client's downscale
const MAX_THUMB_BYTES = 2 * 1024 * 1024;
const MIN_SECS = 3;
const MAX_SECS = 3600;
const DEFAULT_SECS = 15;
const MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

// ----- On-disk layout (image BYTES only; rows live in the LocalTable) --------------------
// data/photos/<sfi_slug>/<photo_id>          full image
// data/photos/<sfi_slug>/<photo_id>.thumb    480px downscale used by the grid
const PHOTOS_DIR = path.join(frameDataDir(import.meta.url), "photos");

function sfiSlug(sfiId: string): string {
  return (sfiId || "").replace(/[^a-zA-Z0-9_-]/g, "_") || "default";
}
function dirFor(sfiId: string): string { return path.join(PHOTOS_DIR, sfiSlug(sfiId)); }
function fullPath(sfiId: string, id: string): string { return path.join(dirFor(sfiId), id); }
function thumbPath(sfiId: string, id: string): string { return path.join(dirFor(sfiId), id + ".thumb"); }

const ID_RE = /^[0-9a-fA-F-]{8,64}$/;

// ----- Display state (frameSettings — one row per key, race-free) ------------------------
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

async function getDisplay(t: Tables): Promise<Display> {
  const [mode, current, fit, on, secs, anchorId, anchorMs] = await Promise.all([
    t.settings.get<string>("mode"),
    t.settings.get<string>("current_photo_id"),
    t.settings.get<string>("fit"),
    t.settings.get<boolean>("slideshow_on"),
    t.settings.get<number>("slideshow_secs"),
    t.settings.get<string>("anchor_photo_id"),
    t.settings.get<number>("anchor_ms"),
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
async function setDisplay(t: Tables, patch: Partial<Display>): Promise<void> {
  await Promise.all(
    (Object.keys(patch) as Array<keyof Display>).map((k) => t.settings.set(k, patch[k])),
  );
}

// ----- Photos ---------------------------------------------------------------------------
interface Photo {
  id: string; name: string; mime: string; size: number;
  w: number; h: number; added_ms: number; added_by: string;
}

// ONE ordering for the whole frame — sort_order ascending, i.e. upload order. The grid and the
// slideshow both walk it, so "next photo" means the same thing everywhere.
async function listPhotos(t: Tables): Promise<Photo[]> {
  const { rows } = await t.photos.query({
    order_by: [{ col: "sort_order", dir: "asc" }],
    limit: MAX_PHOTOS,
  });
  return rows.map((r: any) => ({
    id: r._row_id,
    name: String(r.name ?? ""),
    mime: String(r.mime ?? "image/jpeg"),
    size: Number(r.size) || 0,
    w: Number(r.w) || 0,
    h: Number(r.h) || 0,
    added_ms: Number(r.added_ms) || 0,
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
async function reanchor(t: Tables, photos: Photo[], showing: string, d: Display): Promise<void> {
  if (!d.slideshow_on) return;
  const at = resolveCurrent(photos, showing || d.current_photo_id);
  await setDisplay(t, { anchor_photo_id: at ? at.id : "", anchor_ms: Date.now() });
}

function serveBytes(replyPort: any, buf: Uint8Array, mime: string) {
  return replyPort.postMessage({
    status: 200,
    body: buf,
    contentType: mime,
    // Photo ids are UUIDs and a photo's bytes never change, so this is safe — and it makes both
    // the grid and a looping slideshow essentially free after first paint.
    headers: { "Cache-Control": "private, max-age=31536000, immutable" },
  }, [buf.buffer]);
}

async function stateFor(t: Tables, peer: Peer) {
  const [display, photos] = await Promise.all([getDisplay(t), listPhotos(t)]);
  return {
    me: {
      is_anon: peer.is_anon, is_sfi_member: peer.is_sfi_member,
      is_sfi_editor: peer.is_sfi_editor, is_owner: peer.is_owner,
      user_name: peer.user_name, space_color: peer.space_color,
    },
    can_edit: peer.is_sfi_editor,
    display,
    photos,
    // The clock reference. Clients compute (server_ms - their Date.now()) once and apply it, so a
    // device with a skewed clock still lands on the same slideshow photo as everyone else.
    server_ms: Date.now(),
  };
}

// ----- Networking -----------------------------------------------------------------------
self.onNetworkRequest = async function (replyPort, reqPath, method, headers, query, body, cookies) {
  const peer = parsePeerInfo(query, cookies);

  // Static assets — open to everyone (every tier needs the shell to render).
  if (method === "GET" && !reqPath.startsWith("/api/")) {
    return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url), headers);
  }

  // Local tables are always ready; the gate stays so a future graduation to synced tables
  // needs no code change here. ensureTables IS the auth gate — no hand-rolled member check.
  const ready = ensureTables(peer);
  if (!ready.ready) return jsonReply(replyPort, 503, { error: "table not bound" });
  const t: Tables = { settings: frameSettings(peer.sfi_id), photos: table("photos", peer.sfi_id) };

  // Identity + display state + the whole photo list, in one round trip.
  if (reqPath === "/api/state" && method === "GET") {
    return jsonReply(replyPort, 200, await stateFor(t, peer));
  }

  // Set what the frame is displaying — editors only. This is the shared wall state: it persists
  // and pushes to every viewer. Non-editors never reach here; they browse in local frontend
  // state instead.
  if (reqPath === "/api/display" && method === "POST") {
    if (!peer.is_sfi_editor) return jsonReply(replyPort, 403, { error: "editors only" });
    const v = parseJsonBody<{ mode?: string; photo_id?: string }>(body) || {};
    const [d, photos] = await Promise.all([getDisplay(t), listPhotos(t)]);

    const patch: Partial<Display> = {};
    if (v.mode === "grid" || v.mode === "single") patch.mode = v.mode;
    if (typeof v.photo_id === "string" && v.photo_id) {
      const hit = photos.find((p) => p.id === v.photo_id);
      if (!hit) return jsonReply(replyPort, 404, { error: "photo not found" });
      patch.current_photo_id = hit.id;
      // Stepping by hand while the show runs restarts the dwell on the chosen photo.
      if (d.slideshow_on) { patch.anchor_photo_id = hit.id; patch.anchor_ms = Date.now(); }
    }
    if (Object.keys(patch).length) await setDisplay(t, patch);
    pushToInstance(peer.sfi_id, { type: "display_changed" });
    return jsonReply(replyPort, 200, await stateFor(t, peer));
  }

  // Fit / slideshow settings — editors only.
  if (reqPath === "/api/settings" && method === "POST") {
    if (!peer.is_sfi_editor) return jsonReply(replyPort, 403, { error: "editors only" });
    const v = parseJsonBody<{
      fit?: string; slideshow_on?: boolean; slideshow_secs?: number; current_photo_id?: string;
    }>(body) || {};
    const [d, photos] = await Promise.all([getDisplay(t), listPhotos(t)]);

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
        // Stopping: the client holds the computed position, so it rides in on this same POST.
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

    if (Object.keys(patch).length) await setDisplay(t, patch);
    pushToInstance(peer.sfi_id, { type: "display_changed" });
    return jsonReply(replyPort, 200, await stateFor(t, peer));
  }

  // Upload a photo — editors only. Bytes are the raw body; metadata rides in the query string.
  // The client has already downscaled to <= 2560px and measured the natural dimensions.
  if (reqPath === "/api/upload" && method === "POST") {
    if (!peer.is_sfi_editor) return jsonReply(replyPort, 403, { error: "editors only" });

    const mime = sanitizeText(query.mime, 120).toLowerCase();
    if (!MIMES.has(mime)) return jsonReply(replyPort, 400, { error: "unsupported image type" });
    if (body.byteLength === 0) return jsonReply(replyPort, 400, { error: "empty upload" });
    if (body.byteLength > MAX_BYTES) {
      return jsonReply(replyPort, 413, { error: `image exceeds ${MAX_BYTES / (1024 * 1024)} MB` });
    }
    const bytes = new Uint8Array(body);
    if (!looksLikeImage(bytes)) return jsonReply(replyPort, 415, { error: "file is not an image" });

    const photos = await listPhotos(t);
    if (photos.length >= MAX_PHOTOS) {
      return jsonReply(replyPort, 409, { error: `this frame holds at most ${MAX_PHOTOS} photos` });
    }

    // Row first — its _row_id names the file on disk — then the bytes, undoing the row if the
    // write fails, so a failed upload can never strand a row pointing at nothing.
    const sortOrder = Number(await t.photos.max("sort_order") ?? -1) + 1;
    const { row_id } = await t.photos.upsert(null, {
      name: safeName(query.name),
      mime,
      size: body.byteLength,
      w: clampInt(toIntOrNull(query.w) ?? 0, 0, 100_000),
      h: clampInt(toIntOrNull(query.h) ?? 0, 0, 100_000),
      sort_order: sortOrder,
      added_ms: Date.now(),
      added_by: sanitizeText(peer.user_name, 64),
    });
    try {
      Deno.mkdirSync(dirFor(peer.sfi_id), { recursive: true });
      Deno.writeFileSync(fullPath(peer.sfi_id, row_id), bytes);
    } catch (e) {
      await t.photos.delete(row_id);
      return jsonReply(replyPort, 500, { error: "failed to store photo: " + e });
    }

    // A new photo shifts the modulus; re-anchor so a running show doesn't jump.
    const d = await getDisplay(t);
    await reanchor(t, [...photos, { id: row_id } as Photo], "", d);

    pushToInstance(peer.sfi_id, { type: "photos_changed" });
    return jsonReply(replyPort, 200, { photo_id: row_id });
  }

  // Attach the grid thumbnail to a photo just uploaded — editors only.
  if (reqPath.startsWith("/api/upload/") && reqPath.endsWith("/thumb") && method === "POST") {
    if (!peer.is_sfi_editor) return jsonReply(replyPort, 403, { error: "editors only" });
    const id = reqPath.slice("/api/upload/".length, -"/thumb".length);
    if (!ID_RE.test(id)) return jsonReply(replyPort, 400, { error: "bad id" });
    if (body.byteLength === 0 || body.byteLength > MAX_THUMB_BYTES) {
      return jsonReply(replyPort, 413, { error: "bad thumbnail size" });
    }
    const bytes = new Uint8Array(body);
    if (!looksLikeImage(bytes)) return jsonReply(replyPort, 415, { error: "file is not an image" });
    if (!(await t.photos.get(id))) return jsonReply(replyPort, 404, { error: "photo not found" });
    try {
      Deno.mkdirSync(dirFor(peer.sfi_id), { recursive: true });
      Deno.writeFileSync(thumbPath(peer.sfi_id, id), bytes);
    } catch (e) {
      // A missing thumbnail is survivable — /api/thumb falls back to the full image.
      log("picture_frame: thumbnail write failed: " + e);
    }
    return jsonReply(replyPort, 200, { ok: true });
  }

  // Full image — readable by anyone who can see the frame.
  if (reqPath.startsWith("/api/photo/") && method === "GET") {
    const id = reqPath.slice("/api/photo/".length);
    if (!ID_RE.test(id)) return jsonReply(replyPort, 400, { error: "bad id" });
    const row = await t.photos.get(id);
    if (!row) return jsonReply(replyPort, 404, { error: "not found" });
    let buf: Uint8Array;
    try { buf = Deno.readFileSync(fullPath(peer.sfi_id, id)); }
    catch { return jsonReply(replyPort, 404, { error: "not found" }); }
    return serveBytes(replyPort, buf, String(row.mime || "application/octet-stream"));
  }

  // Grid thumbnail, falling back to the full image when it's absent (older rows, failed write).
  if (reqPath.startsWith("/api/thumb/") && method === "GET") {
    const id = reqPath.slice("/api/thumb/".length);
    if (!ID_RE.test(id)) return jsonReply(replyPort, 400, { error: "bad id" });
    const row = await t.photos.get(id);
    if (!row) return jsonReply(replyPort, 404, { error: "not found" });
    let buf: Uint8Array | null = null;
    let mime = "image/jpeg";
    try { buf = Deno.readFileSync(thumbPath(peer.sfi_id, id)); }
    catch {
      try { buf = Deno.readFileSync(fullPath(peer.sfi_id, id)); mime = String(row.mime || mime); }
      catch { return jsonReply(replyPort, 404, { error: "not found" }); }
    }
    return serveBytes(replyPort, buf, mime);
  }

  // Delete a photo — editors only. Removes the row and both files, then repairs the display
  // state so the frame is never left pointing at something that no longer exists.
  if (reqPath.startsWith("/api/delete/") && method === "POST") {
    if (!peer.is_sfi_editor) return jsonReply(replyPort, 403, { error: "editors only" });
    const id = reqPath.slice("/api/delete/".length);
    if (!ID_RE.test(id)) return jsonReply(replyPort, 400, { error: "bad id" });
    if (!(await t.photos.get(id))) return jsonReply(replyPort, 404, { error: "not found" });

    const [before, d] = await Promise.all([listPhotos(t), getDisplay(t)]);
    const idx = before.findIndex((p) => p.id === id);

    await t.photos.delete(id);
    try { Deno.removeSync(fullPath(peer.sfi_id, id)); } catch { /* already gone */ }
    try { Deno.removeSync(thumbPath(peer.sfi_id, id)); } catch { /* never had one */ }

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
    await setDisplay(t, patch);

    pushToInstance(peer.sfi_id, { type: "photos_changed" });
    return jsonReply(replyPort, 200, await stateFor(t, peer));
  }

  return jsonReply(replyPort, 404, { error: "not found" });
};

log("Picture Frame frame is up and running!");
