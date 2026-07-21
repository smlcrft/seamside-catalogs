# Building the catalog manifests

This repo serves a public **Seamside catalog**. A catalog is a JSON file listing installable frames or capabilities; a Seamside client fetches it, displays the items, and downloads + verifies a package on install.

There are two manifests:

- [`frames.json`](frames.json) — one entry per directory under [`frames/`](frames/).
- [`capabilities.json`](capabilities.json) — one entry per JSON file under [`capabilities/`](capabilities/). Not yet emitted; appears the first time you put a capability JSON in [`capabilities/`](capabilities/).

Both manifests are **generated artifacts**. Edit the source in [`frames/`](frames/) / [`capabilities/`](capabilities/), then re-run the build.

## Quick start

```sh
python3 -m pip install -r scripts/requirements.txt   # one-time: installs Zopfli (see "Reproducible packages")
python3 scripts/build_catalogs.py
git add frames.json capabilities.json packages/ frames/ capabilities/
git commit -m "rebuild catalogs"
git push
```

The build depends on **Zopfli** (pinned in [`scripts/requirements.txt`](scripts/requirements.txt)); it exits with an install hint if the package is missing.

The build script:

1. Walks [`frames/`](frames/). For each subdirectory that has a `frame.json` and does not start with `_` or `.`:
   - **Rejects (excludes from the manifest + exits non-zero) any frame that carries a top-level `data/` or `_todos/` folder.** These are user- or author-specific — `data/` is per-host runtime state and `_todos/` is author scratch — and must never be checked into a catalog entry. A catalog frame ships only its code; the installer provisions `data/` per host. If the build stops here, delete the offending folder from the frame source and rebuild.
   - Builds a deterministic gzipped tarball at `packages/frames/<dir_id>.tar.gz`. Mtimes, uids, gids, and gzip header timestamps are all zeroed, and the gzip step uses **Zopfli** (not stdlib gzip) so the compressed bytes don't vary by platform — rebuilds with no source changes produce byte-identical artifacts and a stable sha256 **on any machine** (see [Reproducible packages](#reproducible-packages)).
   - Excludes `data/`, `.DS_Store`, `__pycache__`, and `.git` from each tarball. `data/` is per-host runtime state and is preserved separately by the Seamside installer.
   - Computes the sha256 of the tarball.
   - Reads `frame.json` and emits an entry in `frames.json` with `name`, `description`, `icon`, `modified_at`, the lightweight `frame_preview` (frame_type, default sizes, capability deps), a `package_url` pointing at the GitHub raw URL, and the recorded sha256.
2. Walks [`capabilities/`](capabilities/). For each `*.json` file (not starting with `_` or `.`):
   - Copies it as-is to `packages/capabilities/<name>.json` (capabilities ship as single JSON files, not tarballs).
   - Computes its sha256 and writes an entry in `capabilities.json` with a `capability_preview` carrying `kind` and method names.
   - **`modified_at` in the `capabilities.json` manifest is taken verbatim from the `modified_at` field of the source capability JSON** (the build does not stamp it with the build time). Bump `modified_at` in the capability JSON only when you ship an actual change you want existing installs to see. This is what ensures the Seamside app flags *only* genuinely-updated capabilities as "update available" — a no-op rebuild leaves every capability's `modified_at` unchanged, so users aren't nagged to re-install something that didn't change. (If the source JSON omits `modified_at`, the build falls back to its `created_at`, then to the build time — so always set `modified_at` explicitly to keep update detection deterministic.)
3. Writes `frames.json` / `capabilities.json` at the repo root.

## Hosting

The Seamside client can fetch the manifest from any HTTPS URL. The default URLs assume the repo is hosted on GitHub at `smlcrft/seamside-catalogs` and served via `raw.githubusercontent.com`:

- Manifest: `https://raw.githubusercontent.com/smlcrft/seamside-catalogs/main/frames.json`
- Package:  `https://raw.githubusercontent.com/smlcrft/seamside-catalogs/main/packages/frames/<dir_id>.tar.gz`

If you fork this repo to another host, change `BASE_URL` near the top of [`scripts/build_catalogs.py`](scripts/build_catalogs.py) and rebuild. Both the manifest URL and every embedded `package_url` are derived from that single constant.

A Seamside user installs the catalog by entering the `frames.json` URL into the **Caps panel → Catalogs → Frame catalog URLs** (comma-separated, multiple allowed). The client then fetches the manifest, surfaces every item under Conjure, and downloads the matching `.tar.gz` on install — verifying the recorded sha256 before extracting.

## Reproducible packages

Every package's integrity is a `sha256` of its `.tar.gz`, so the build must produce **byte-identical** tarballs from identical source — otherwise every rebuild rewrites unrelated packages and their hashes for no real change.

The tar layer is already normalized (entry `mtime`/`uid`/`gid` zeroed, sorted entries, `data/`·`.DS_Store`·`__pycache__`·`.git` excluded). The subtle part is the **gzip** layer: the Python stdlib `gzip`/`zlib` deflate output is **not stable across zlib versions** — it changed between zlib 1.2.x and 1.3, and passing explicit `compresslevel`/`memLevel`/`strategy` does not reproduce old output. So the same frame compressed on macOS (one zlib) vs Linux/CI (another zlib) yields different bytes and a different sha256, even though nothing in the frame changed.

To make the artifact independent of the host toolchain, the build compresses with **[Zopfli](https://github.com/google/zopfli)** — a deterministic, from-scratch deflate whose output depends only on the input, not on the platform's zlib. It also compresses slightly smaller than zlib. The dependency is pinned in [`scripts/requirements.txt`](scripts/requirements.txt) (`zopfli==0.4.3`); pinning the version keeps the bytes stable over time as well as across machines. `build_catalogs.py` hard-errors (rather than silently falling back to stdlib gzip) if Zopfli isn't installed, so a rebuild can't accidentally reintroduce platform-dependent output.

If you ever bump the pinned Zopfli version and its output differs, that's a one-time rebuild of every package; commit it deliberately.

## Manifest schema (wire format)

The build script emits this shape — it mirrors the `WireCatalogManifest` struct that the Seamside client deserializes (see `tauri-app/src-tauri/src/layer3_catalogs.rs` and `protocol.rs` in the Seamside app repo).

```jsonc
{
  "catalog_id":  "smallcraft_frames",        // stable id; rename = new catalog from the client's POV
  "name":        "Small Craft Frames",
  "description": "Community frames published by Small Craft.",
  "kind":        "Frames",                // "Frames" | "Capabilities"
  "about_url":   "https://.../about",     // OPTIONAL — about page for the catalog (omitted when unset)
  "items": [
    {
      "kind":            "Frames",                       // matches the catalog kind
      "id":              "garden_gnome",                 // dir_id for frames, capability name for caps
      "name":            "Garden Gnome",
      "description":     "...",
      "icon":            "",                             // ph-* phosphor icon name, or empty
      "modified_at":     "2026-05-19T01:55:00Z",         // RFC 3339; drives "update available" detection
      "frame_preview": {                                 // null for capabilities
        "frame_type":               "Tandem",            // "Tandem" (the frame *type* — shared Deno worker — not the old product name) | "Solo" | "Hosted" | "Proxy"
        "default_width_px":         560,
        "default_height_px":        640,
        "depends_on_capabilities":  []
      },
      "capability_preview": null,                        // populated only for capability items
      "permissions": {                                   // frame's declared outside-resource access (frames only)
        "net":         [],                               //   backend worker fetch — host[:port]
        "web":         ["https://tiles.example.com"],    //   frontend media/img/socket — https/wss origins
        "web_scripts": []                                //   HIGH-RISK external scripts — https/wss origins
      },
      "package_url":     "https://.../packages/frames/garden_gnome.tar.gz",
      "package_sha256":  "<64-char hex>",                // required when package_url is set
      "app_version_min": "0.1.7"                         // OPTIONAL — min Seamside version to install/update (omitted when unset)
    }
  ]
}
```

Capability items use `capability_preview` instead:

```jsonc
{
  "frame_preview": null,
  "capability_preview": {
    "kind":    "external_api",
    "methods": ["search", "summarize"]
  },
  "package_url":    "https://.../packages/capabilities/some_cap.json",
  "package_sha256": "<64-char hex>"
}
```

## Optional source fields

These are read from the source `frame.json` / capability JSON and surfaced into the manifest. All are optional and backward-compatible: older Seamside clients that don't know them ignore them, and a source file that omits them simply has the field omitted from the manifest.

- **`app_version_min`** (frame.json **and** capability JSON) — minimum Seamside app version (semver, e.g. `"0.1.7"`) required to install or update the item. The client compares it against its running version and, when the running app is older, disables the install/update affordance and shows a "requires vX.Y.Z+" badge instead of installing something it can't run correctly. Set this whenever a frame/cap depends on a feature added in a specific Seamside release. The build copies it verbatim into each manifest item.
- **`images_b64`** (frame.json only) — an optional array of base64-encoded **JPEG** preview images. The build **validates** every frame and rejects (excludes from the manifest + exits non-zero) any that violate: at most **3** images, each under **32 KB** decoded, each a real JPEG (`FF D8 FF` SOI marker). A `data:image/jpeg;base64,…` prefix is tolerated. These are not emitted into the manifest items — they travel inside the frame package — but the build is where they're verified.
- **`about_url`** (catalog-level, not per-item) — set it on the catalog metadata (the `CATALOG_FRAMES` / `CATALOG_CAPS` dict in [`scripts/build_catalogs.py`](scripts/build_catalogs.py)) to point users at an about page for the whole catalog. Emitted at the manifest top level when set, omitted otherwise.
- **`permissions`** (frame.json only) — the frame's declared outside-resource access (`net` / `web` / `web_scripts`). The build copies it verbatim into each frame's manifest item (always, normalized to the three keys) **from the same `frame.json` that gets tarballed**, so the manifest and the package agree by construction. This serves two purposes in the client: it lets the UI show a frame's access **before** the user installs/places it (and on update, only the newly-added domains), and the app **strictly verifies it at install** — the installed `frame.json`'s permissions must equal what the manifest advertised. The check is **default-deny**: a manifest item that omits `permissions` means the frame may request **no** outside access at all, so any frame that needs net/web/web_scripts **must** advertise it (the build does this automatically — just keep `permissions` in `frame.json`). On mismatch the app doesn't fail the download; it installs the frame but **blocks it from running** (stamps `permissions_mismatch`) until a corrected catalog version is published. Because the build derives manifest + tarball from one source, a normal rebuild keeps them in sync; never hand-edit `permissions` in `frames.json` (edit `frame.json` and rebuild, or the strict gate will block the frame). See the Seamside manual's `s24_layer3_catalogs` for the install-side gate.

## Adding a new frame

1. Drop a directory under [`frames/`](frames/) containing at minimum `frame.json` and whatever code the frame needs (`frame.ts`, `public/`, etc.). Frame-authoring conventions live in the Seamside app's [`MANUAL_FRAMEGEN_CONTEXT.md`](https://github.com/smlcrft/seamside/blob/main/tauri-app/src-tauri/chassis/bundled_catalogs/frames/MANUAL_FRAMEGEN_CONTEXT.md).
2. Set `name`, `description`, `modified_at`, optional `default_width_px` / `default_height_px`, `permissions` (`net` / `web` / `web_scripts` — the build copies these into the manifest and the app verifies them at install), and `depends_on_capabilities` in `frame.json`. Bump `modified_at` whenever you ship a change you want existing installs to see as "update available".
3. Run `python3 scripts/build_catalogs.py`.
4. Commit `frames.json`, the new `frames/<dir_id>/`, and `packages/frames/<dir_id>.tar.gz`.

Names starting with `_` or `.` are skipped, so prefix any work-in-progress dirs with `_` to keep them out of the manifest.

## Adding a new capability

1. Drop `capabilities/<name>.json` describing the capability (same shape used in the Seamside app's `chassis/bundled_catalogs/capabilities/`).
2. Run `python3 scripts/build_catalogs.py`.
3. Commit `capabilities.json`, `capabilities/<name>.json`, and `packages/capabilities/<name>.json`.

### AI-model capabilities: `models` + `models_source`

An AI capability does **not** enumerate models in its settings (enumerations rot). It
declares two blocks — the app synthesizes the per-role model dropdowns from them (see the
Seamside app's `design/ai-model-roles/README.md`):

- **`models`** — curated, *tested* default model per codegen role (`quick` / `standard` /
  `deep`). The only place a model id must be correct. Values are a model-id string, or
  `{ "model": "...", "params": { ... } }` when the assignment needs request params.
- **`models_source`** — where the live selectable list comes from: `{ "url", "list_path",
  "value_key", "label_key", "filter_prefixes" }` (one declaration, all roles share it).
  Omit it for providers with no models endpoint (e.g. a single fixed model).

Capabilities using this shape need `app_version_min` ≥ `0.1.10`.

**Validation:** `python3 scripts/validate_models.py` checks every `models` assignment
(and every `pricing` key) against the provider's live models endpoint — export
`<NAME>_API_KEY` env vars to enable the live checks. CI runs it on every push and weekly
(`.github/workflows/validate-models.yml`; keys via repo secrets), so a provider retiring
a model turns into a red build instead of silent rot. Run it after editing any `models`
block.

## Updating an existing frame or capability

Edit the source in place, bump `modified_at` in the `frame.json` / capability JSON, re-run the build, commit. The client uses `modified_at` against the locally-installed copy's `modified_at` to decide whether to show an update affordance.

## What gets committed

- ✅ Sources: [`frames/`](frames/), [`capabilities/`](capabilities/).
- ✅ Generated manifests: `frames.json`, `capabilities.json`.
- ✅ Generated packages: `packages/frames/*.tar.gz`, `packages/capabilities/*.json`. These are what `package_url` points at, so they MUST be checked in (or hosted somewhere else — see "Hosting").
- ❌ Per-host runtime state: any `data/` subdir inside a frame.
- ❌ Author scratch: any `_todos/` subdir inside a frame.

`data/` and `_todos/` are user/author-specific and must not be checked into a catalog entry. The build does more than skip them — it **stops** (non-zero exit) on any frame that carries one, so a leaked runtime/scratch folder can't ship inside a published package. Delete the folder from the frame source and rebuild.

The build is deterministic, so a rebuild with no source changes produces no `git diff` — if you see one, something in the source actually changed (or the build script itself).

## Renaming or removing items

- **Renaming a `dir_id`**: this is a catalog-level rename. Existing installs won't auto-migrate — they'll just see the old item disappear and the new one appear. If preservation matters, keep the old `dir_id`.
- **Removing**: delete the source dir/file and the corresponding `packages/<...>` artifact, then rebuild. Existing installs will keep working but won't see updates and can't be reinstalled.

## Requirements

- Python 3.9+ (stdlib only — `tarfile`, `gzip`, `hashlib`, `json`, `pathlib`). No external packages.
