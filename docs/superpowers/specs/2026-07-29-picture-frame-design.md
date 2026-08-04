# Picture Frame — design

A Seamside catalog frame that behaves like a digital picture frame hung in a space: a grid of
photos, tap one to fill the frame, tap again to return. Editors upload and delete; an optional
slideshow cycles the photos. Whatever the frame was displaying is what it displays after a
restart.

- **Directory:** `frames/picture_frame/`
- **Frame type:** `Tandem`
- **Design axes:** `privacy-public-view` · `storage-local-db` · `view-collaborative` · `settings-per-sfi`

## Decisions

Four choices set the shape of everything below.

**One shared display, not per-viewer browsing.** The frame is a wall display: there is exactly
one current photo, stored server-side, and every viewer of the placement sees it. This is what
makes "photo A survives a reboot" a property of the frame rather than of a device.

**Editors curate; everyone views.** Space editors upload and delete. Viewer-role members and
anonymous link visitors see the grid and can tap through photos. Writes gate on
`is_sfi_editor`, never on `is_sfi_member`.

**Editors drive the shared display; others browse locally.** An editor's navigation persists and
pushes to every viewer. A non-editor's navigation changes only their own screen and is not
persisted; when an editor changes the display, the non-editor snaps back to following it. A
stranger with a link can look around but cannot redecorate the wall.

**Slideshow is a property of the frame.** On/off and interval are editor-controlled, shared, and
persisted.

## Storage

Photo rows live in a LocalTable, photo bytes live on disk beside it, and per-placement display
state lives in `frameSettings`. This mirrors `outpost`, the newest convention in the catalog.
It gives ordering and counting for free, is encrypted at rest, and graduates to a SyncTable
later by deleting `local: true`.

Two alternatives were rejected. A flat-file manifest (`slideshow` / `file_folder` style) would
keep `app_version_min` at 0.1.7 but means rewriting the whole manifest on every change and
hand-rolling ordering — and the manual is explicit that per-placement scalar state belongs in
`frameSettings`, because a hand-rolled singleton row races concurrent writes into duplicates.
A SyncTable was rejected outright: rows would replicate to peers whose devices do not hold the
image bytes.

### `photos` LocalTable

One row per photo. Its `_row_id` is the photo id and also names its bytes on disk.

| column       | col_type | notes                                                            |
| ------------ | -------- | ---------------------------------------------------------------- |
| `name`       | text     | original filename — alt text and tooltip                         |
| `mime`       | text     | served as the response content-type                              |
| `size`       | integer  | bytes stored                                                     |
| `w`          | integer  | natural width, measured client-side                              |
| `h`          | integer  | natural height, measured client-side                             |
| `sort_order` | integer  | appended via `Number(await t.photos.max("sort_order") ?? -1) + 1` |
| `added_ms`   | integer  | upload time                                                      |
| `added_by`   | text     | `peer.user_name`                                                 |

`w`/`h` let the grid reserve space so it does not reflow as images arrive.

**One ordering everywhere:** `sort_order` ascending, i.e. upload order. The grid and the
slideshow use the same sequence, so "next photo" means one thing in the whole frame.

### Bytes on disk

```
data/photos/<sfi_slug>/<photo_id>          full image
data/photos/<sfi_slug>/<photo_id>.thumb    480px downscale for the grid
```

`sfi_slug` is `sfi_id` with non-`[A-Za-z0-9_-]` replaced by `_`, falling back to `default`.

The separate thumbnail is deliberate: a grid of forty photos pulling full-resolution bytes
through the frame bridge would crawl. The client already has each image on a canvas in order to
downscale it, so producing a second small copy costs almost nothing.

### Display state — `frameSettings(peer.sfi_id)`

| key                | type    | meaning                                        |
| ------------------ | ------- | ----------------------------------------------- |
| `mode`             | string  | `"grid"` or `"single"`                          |
| `current_photo_id` | string  | authoritative while the slideshow is paused     |
| `fit`              | string  | `"contain"` or `"cover"`                        |
| `slideshow_on`     | boolean | shared, editor-controlled                       |
| `slideshow_secs`   | integer | dwell per photo; clamped to 3–3600              |
| `anchor_photo_id`  | string  | the running show's reference photo              |
| `anchor_ms`        | integer | server-stamped reference time                   |

Defaults: `mode` `"grid"`, `fit` `"contain"`, `slideshow_on` false, `slideshow_secs` 15.

`{mode, current_photo_id}` **is** the frame's display state. Restoring it on load is what
satisfies the restart requirement — there is no separate "remember where I was" mechanism.

## Slideshow: a deterministic shared clock

The running slideshow position is computed, not stored. `public/slideshow-clock.js` exports one
pure function:

```js
photoAtTime(order, anchorId, anchorMs, secs, nowMs)
// → order[(indexOf(anchorId) + floor((nowMs - anchorMs) / (secs * 1000))) % order.length]
```

Every client derives the same answer from the same four stored values, so devices converge
without talking to each other and without a single tick being written to the database. A restart
lands where the show should be right now, because position is a pure function of the clock.

The rejected alternative was a backend `setInterval` per placement that advances and pushes.
It writes on every tick forever, and the worker has no list of placements at boot, so timers
would need lazy arming and idle-parking — real lifecycle complexity for a toggle.

**Drift.** The client schedules a timeout to the *next boundary* rather than a repeating
interval, so error cannot accumulate.

**Clock skew.** `/api/state` returns `server_ms`. The client computes
`skew = server_ms - Date.now()` once at load and adds it to `nowMs`, so a device with a sloppy
clock still shows the same photo as everyone else.

**Re-anchoring** sets `anchor_photo_id` to whatever is showing at that instant and `anchor_ms`
to now. Four events trigger it:

1. An editor manually steps to a photo while the show runs (restarts the dwell on that photo).
2. An upload — a new photo shifts the modulus and the show would otherwise jump.
3. A delete — same reason.
4. An interval change mid-show — otherwise the whole elapsed span gets re-divided by the new
   dwell and the position teleports.

**Stopping** the show writes the computed photo into `current_photo_id`. The client is the one
holding that computed value, so it sends it in the same `/api/settings` POST that clears
`slideshow_on`; the backend persists both together. This is the handoff from a derived position
back to a stored one, and it is why a paused frame has photo A sitting in the database exactly
as required.

## Backend — `frame.ts`

Static assets are served to everyone. `ensureTables(peer)` gates the API routes and is the only
auth gate on them; no hand-rolled member check wraps it.

| route                        | method | access | behavior                                                                                |
| ---------------------------- | ------ | ------ | --------------------------------------------------------------------------------------- |
| `/api/state`                 | GET    | all    | `me`, display settings, the ordered photo list, `can_edit`, and `server_ms`              |
| `/api/display`               | POST   | editor | persist `mode` / `current_photo_id`; re-anchor if the show is running; push               |
| `/api/settings`              | POST   | editor | persist `fit`, `slideshow_on`, `slideshow_secs`; on start, stamp the anchor server-side; on stop, persist the client-supplied `current_photo_id`; push |
| `/api/upload`                | POST   | editor | `?name=&mime=&w=&h=`, raw bytes; creates the row and writes the file                      |
| `/api/upload/<id>/thumb`     | POST   | editor | raw bytes; writes `<id>.thumb` beside the full image                                      |
| `/api/photo/<id>`            | GET    | all    | full image bytes                                                                          |
| `/api/thumb/<id>`            | GET    | all    | thumbnail bytes, falling back to the full image when absent                               |
| `/api/delete/<id>`           | POST   | editor | delete row + both files; fix up display state; re-anchor; push                            |

Every mutation calls `pushToInstance(peer.sfi_id, { type: "display_changed" })` or
`{ type: "photos_changed" }` as appropriate.

### Upload handling

Ordering mirrors `outpost`, which exists so a failed byte-write cannot strand a row:

1. Gate on `is_sfi_editor`.
2. Validate the extension and mime against the allowlist (PNG, JPEG, GIF, WebP).
3. Reject bodies over 25 MB (`413`) or empty (`400`).
4. Magic-byte sniff the buffer; a non-image renamed to `.png` is rejected `415`.
5. Reject when the placement already holds 300 photos (`409`).
6. **Insert the row first** — its `_row_id` names the file.
7. Write the bytes; on throw, delete the row and return `500`.

### Serving

`/api/photo/<id>` and `/api/thumb/<id>` respond with
`Cache-Control: private, max-age=31536000, immutable`. Photo ids are UUIDs and their content
never changes, so this is safe, and it makes both the grid and a looping slideshow essentially
free after first paint.

## Frontend — `public/index.html`

Preact + htm from `/lib/js/framelib.js`, `dyn/frame-prefs.css` for design tokens,
`applyChannel(document.body, peer.space_color)` on mount, `useFramePush` for the two events.

### Local override

Non-editors keep a local `{mode, photoId}` override in component state and render
`localOverride ?? sharedState`. Any incoming `display_changed` clears the override, so they snap
back to following the wall display. Editors have no override — their navigation POSTs directly.

### Grid mode

A responsive CSS grid of square thumbnails (`object-fit: cover`) sized with
`repeat(auto-fill, minmax(...))`, so it reads well from a 300×300 tile up to a wide display.
Tapping a thumbnail enters single mode.

Editors also get an "Add photos" button and a full-surface drop target for dragging files in
from the desktop, plus a per-thumbnail delete affordance on hover or long-press, confirmed via
`frame.confirm`. The empty state shows editors the drop zone and everyone else a quiet
"No photos yet."

### Single mode

The photo fills the frame tile — absolutely positioned at `inset: 0`, `object-fit` driven by the
`fit` setting, over a neutral backdrop. Clicking or tapping the photo returns to the grid.
Left/Right arrow keys and `‹` `›` edge affordances step between photos; Escape returns to the
grid.

Editor chrome is a small toolbar that fades after a few seconds without pointer movement — a
picture frame should not have buttons parked on top of the picture. It carries: delete this
photo, the `contain`/`cover` toggle, slideshow on/off, and the interval. Non-editors see no
chrome.

The `fit` toggle is included rather than hardcoded because frame tiles are arbitrary aspect
ratios, and whether a portrait photo letterboxes or crops is a per-frame taste call.

### Upload pipeline

Per file, sequentially, with an "uploading 7 of 20" counter so a large drop does not slam the
bridge:

1. Decode with `createImageBitmap(file, { imageOrientation: "from-image" })` so EXIF rotation is
   applied — phone photos must not land sideways — falling back to a plain `<img>` decode on
   older webviews. Measure natural `w`/`h`.
2. Downscale so the longest edge is ≤ 2560px and re-encode JPEG at q0.85 — **unless** the
   original is already within limits and is a PNG, GIF, or WebP, in which case the original
   bytes are sent untouched. This preserves transparency and animation, and follows the rule
   `slideshow` already uses.
3. Produce a second 480px copy as the thumbnail, as PNG when the source is PNG so transparency
   does not turn black in the grid, otherwise JPEG.
4. `POST /api/upload` with the bytes as an **`ArrayBuffer`**, then the thumb to
   `/api/upload/<id>/thumb`.

The `ArrayBuffer` is load-bearing. WebKit reads `File`/`Blob` bodies asynchronously and the
`axum://` bridge captures the request before that read completes, so a `File` body arrives
empty. This is recorded in `slideshow`'s notes and must not be "simplified" back to a `File`.

After a successful mutation the handler self-refreshes its own view rather than waiting on the
push; the push is the mechanism for *other* viewers.

## Edge cases

| situation                                            | behavior                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------ |
| Deleting the currently-displayed photo                | advance to the next in `sort_order`, wrapping past the end; fall back to grid only when no photos remain |
| `current_photo_id` names a photo that is gone         | fall back to the first photo, or grid mode when the frame is empty         |
| `anchor_photo_id` not present in the order            | anchor index resolves to 0, never −1 (handled inside `photoAtTime`)        |
| Row exists but bytes are missing on disk              | `404`; the client renders a broken-photo placeholder with a "remove" affordance for editors, rather than a blank frame with no way out |
| Slideshow on with an empty frame                      | `photoAtTime` returns null; the empty state renders and no timer is scheduled |
| Slideshow on with exactly one photo                   | that photo displays; no timer is scheduled                                |
| A file in a batch fails validation                    | per-file error toast; the remaining files continue uploading              |
| Tables not yet ready (`503`)                          | `frame.apiSafe` plus the `WAITING` sentinel                               |

## Testing

`public/slideshow-clock.js` is a standalone pure module, tested with `deno test` and
`jsr:@std/assert`, following the `frames/seamdeck/tests/*.test.ts` pattern. It holds the only
non-obvious logic in the frame and is fully deterministic:

- an anchor at `t = 0` returns the anchor photo
- crossing one interval boundary advances exactly one photo
- the index wraps correctly past the end of the list
- an unknown `anchor_photo_id` degrades to index 0 instead of going negative
- an empty order returns null and never throws
- a large elapsed time — the frame left running for days — still lands in range; this is the
  modulus case a naive implementation gets wrong
- skew correction shifts the result by the expected number of photos

The remainder of the frame is I/O against framecore and the filesystem, which this repo verifies
by running the frame rather than by mocking. No harness is invented for it.

## `frame.json`

```json
{
    "name": "Picture Frame",
    "description": "A digital picture frame for a space. Space editors drop photos in — by clicking Add or dragging them from the desktop — and everyone placed in the space sees them as a grid of thumbnails; tap one and it fills the frame, tap again to go back. Turn on slideshow mode and the frame cycles through the photos at an interval you choose. There is one shared display: whatever an editor puts up is what every viewer sees, and the frame remembers exactly what it was showing, so a restarted frame or a rebooted machine comes back to the same photo. Viewer-role members and anonymous link visitors can browse the photos on their own screen without changing what the frame displays for anyone else. Photos live in a per-placement encrypted LocalTable with their bytes stored beside it on the host; nothing leaves the device.",
    "frame_type": "Tandem",
    "permissions": { "net": [], "web": [], "web_scripts": [] },
    "created_at": "2026-07-29T00:00:00Z",
    "modified_at": "2026-07-29T00:00:00Z",
    "app_version_min": "0.1.12",
    "depends_on_capabilities": [],
    "default_width_px": 640,
    "default_height_px": 480,
    "licensed_under_cc0": true,
    "attribution_log": []
}
```

All three permission arrays are empty — every resource the frame loads is same-origin.
`app_version_min` is `0.1.12` because the frame declares LocalTables, and `frameSettings` counts
as one.

Shipping also requires running `python3 scripts/build_catalogs.py` and committing `frames.json`
alongside `packages/frames/picture_frame.tar.gz`.

## Out of scope for v1

To `NEXT_STEPS.md`: captions, drag-to-reorder, shuffle, albums or folders, OS-level
`requestFullscreen()` (the `slideshow` frame already demonstrates the pattern), per-photo `fit`
override, and cross-fade transitions between slideshow photos.
