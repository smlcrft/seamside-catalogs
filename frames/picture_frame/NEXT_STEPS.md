# Picture Frame — next steps

Where this frame could grow:

- **Captions.** A short caption per photo, shown in single mode and fading with the rest of the
  chrome. One `caption` column on the `photos` table plus an `Editable` in the toolbar.
- **Drag-to-reorder.** The frame has exactly one ordering (`sort_order` ascending, i.e. upload
  order) and both the grid and the slideshow walk it. Pointer drag-and-drop on the grid cells
  would let editors curate the sequence; the column is already there to write to.
- **Shuffle.** A `shuffle` setting that permutes the order with a seed stored beside the anchor.
  It has to be a stored seed rather than a live `Math.random()`, or the clients would each
  compute a different "current" photo and the shared display would come apart.
- **Albums.** A grouping column plus a picker, so one placement can hold several sets and the
  slideshow can be scoped to one of them.
- **OS-level fullscreen.** Single mode fills the frame tile today. `slideshow`'s present mode
  shows the pattern for going further: attempt `requestFullscreen()` on the document and fall
  back to `position: fixed; inset: 0` when the sandboxed iframe isn't granted it.
- **Per-photo fit.** `fit` (`contain` / `cover`) is currently one setting for the whole frame.
  A per-photo override would matter most for mixed portrait/landscape sets.
- **Transitions.** A cross-fade between slideshow photos. The next photo's id is a pure function
  of the clock, so it can be preloaded well before the boundary.

## Host notes

**The shared display.** `{mode, current_photo_id}` in `frameSettings` IS the frame's display
state — restoring it on load is what brings the frame back to the same photo after a restart, and
there is no separate "remember where I was" mechanism to keep in sync with it. Editors drive that
state; Viewer-role members and anonymous visitors browse in local frontend state that is cleared
whenever a `display_changed` push arrives, so they rejoin the wall instead of drifting from it.

**The slideshow clock.** A running show's position is computed, never stored: the backend keeps
`slideshow_on`, `slideshow_secs`, `anchor_photo_id`, and `anchor_ms`, and every client derives the
current photo from them via `public/slideshow-clock.js`. That means no writes per tick, and every
device converges without talking to the others. Three things re-anchor the show — an editor
stepping by hand, an upload, and a delete — because changing the photo count shifts the modulus
and the show would otherwise jump. Changing the interval mid-show re-anchors for the same reason:
the elapsed span would otherwise be re-divided by the new dwell and teleport the position.
Stopping the show writes the computed photo back into `current_photo_id`; the client sends that
value on the same POST that clears `slideshow_on`, because the client is what holds it.

`/api/state` returns `server_ms`. Clients compute their skew against it once at load and apply it
to every clock read, so a device with a wrong clock still lands on the same photo as everyone
else. The frontend schedules a timeout to the *next boundary* rather than a repeating interval,
recomputing the delay from the anchor each time, so error can't accumulate over a long show.

`slideshow-clock.js` is pure and dependency-free precisely so it can be tested directly —
see `tests/slideshow-clock.test.ts` (`deno test tests/`). It holds the only non-obvious logic in
the frame; everything else is I/O.

**Uploads & images.** Modeled on `file_folder` and `slideshow`. The client decodes each file with
`createImageBitmap(file, { imageOrientation: "from-image" })` so EXIF rotation is applied, then
downscales the longest edge to ≤ 2560px and re-encodes JPEG q0.85 — **except** when the original
is already within limits and is a PNG, GIF, or WebP, which go up untouched because a canvas
round-trip would cost transparency and animation. A second 480px copy is uploaded as the grid
thumbnail (PNG when the source is PNG, so transparency doesn't turn black).

Bytes are sent as an in-memory `ArrayBuffer`, **not** a `File`: WebKit reads `File`/`Blob` bodies
asynchronously and the `axum://` custom-scheme bridge captures the request before that read
finishes, so a `File` body arrives empty. Don't "simplify" this back.

The backend re-checks the mime, byte size, and a magic-byte signature before writing, and inserts
the row *before* the file so a failed byte-write can be undone rather than stranding a row that
points at nothing.

**Image storage.** Full images live at `data/photos/<sfi_slug>/<photo_id>` with thumbnails at
`<photo_id>.thumb` beside them. Both are served with a long `immutable` cache header — photo ids
are UUIDs and a photo's bytes never change — which is what keeps a looping slideshow from
re-fetching over the bridge. A missing thumbnail falls back to the full image, so a failed thumb
write degrades quietly rather than leaving a hole in the grid. Deleting a photo removes the row
and both files, then repairs the display state so the frame is never left pointing at something
that no longer exists.
