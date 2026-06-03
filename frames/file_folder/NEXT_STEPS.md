# File Folder — next steps

Where this frame could grow:

- **File-type icons & thumbnails.** Map common extensions to Phosphor icons (image / pdf / zip / audio) and render small image previews inline.
- **Total-size cap.** Alongside per-file size and file-count limits, add an optional per-placement total-bytes budget.
- **Uploader attribution.** If desired, record who uploaded each file. Today nothing but the owner's sharing prefs is persisted (per the brief), so the list is derived purely from disk.
- **Sort / search.** Sort by name/size/date and a filter box once lists get long.
- **Per-file expiry.** Optional auto-delete after N days.

## Host notes — uploads & downloads

**Downloads (host change applied).** Downloading uses `fetch → Blob → object-URL →
<a download>.click()`. That requires `allow-downloads` on the frame iframe's `sandbox`.
It was added to every runtime frame-iframe site in the host app:
`os-space-layouts.ts`, `os-spaces-manager.ts` (×2), `os-bookmark-viewer.ts`, and
`components/mobile/MobileFrameViewer.svelte`. (The dev-only `os-test-rig.ts` iframes were
left as-is.) If the browser web-app (`../web-app`) ever sandboxes frame iframes, mirror the
token there too.

**Uploads (frame-side).** The file is sent as an in-memory `ArrayBuffer` body, not a `File`
object: WebKit reads `File`/`Blob` bodies asynchronously and the `axum://` custom-scheme
bridge captures the request before that read completes, so a `File` body arrives empty.
Sending already-resolved bytes avoids base64 inflation. If a future webview/bridge still
drops in-memory binary, the guaranteed fallback is base64-over-JSON (rides the same
string-body path every other frame's `frame.api` POST uses).
