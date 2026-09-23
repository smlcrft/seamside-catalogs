# File Folder — next steps

Where this frame could grow:

- **File-type icons & thumbnails.** Map common extensions to Phosphor icons (image / pdf / zip / audio) and render small image previews inline.
- **Total-size cap.** Alongside per-file size and file-count limits, add an optional per-space total-bytes budget.
- **Uploader attribution.** If desired, record who uploaded each file (a row of a `file_folder` table naming the path). Today the list is read straight from the folder of the space.
- **Sort / search.** Sort by name/size/date and a filter box once lists get long.
- **Per-file expiry.** Optional auto-delete after N days.

## Uploads & downloads

**Downloads.** `fetch → Blob → object-URL → <a download>.click()`; the worker's `Content-Disposition` does not reach the page, so the name comes from the list.

**Uploads.** The file's bytes are the raw body, the name rides in `?name=`. A request reaches the worker whole up to 8 MiB (and a frame writes a file of the space at most 8 MiB) and is refused (413) past it, so the per-file limit tops out at 8 MB; a larger file would need chunked uploads.
