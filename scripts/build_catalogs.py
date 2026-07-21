#!/usr/bin/env python3
"""
Build catalog manifests for seamside-catalogs.

Walks `frames/` and `capabilities/`, builds tarballs for frames (single-file
copies for capabilities) into `packages/`, computes sha256 of each package,
and emits `frames.json` / `capabilities.json` at the repo root. Those manifests
are what a Seamside client fetches when `catalog_urls_frames` /
`catalog_urls_capabilities` is configured.

Re-runnable. Idempotent: tarball entries are normalized (mtime=0, uid/gid=0,
empty uname/gname) so a rebuild with no source changes produces byte-identical
artifacts and a stable sha256.

Usage:
    python3 scripts/build_catalogs.py
"""
import base64
import binascii
import hashlib
import io
import json
import shutil
import sys
import tarfile
from datetime import datetime, timezone
from pathlib import Path

# Reproducible gzip. The Python stdlib `gzip`/`zlib` deflate output is NOT stable
# across zlib versions (it changed between 1.2.x and 1.3), so the same frame
# recompresses to different bytes — and a different sha256 — on another platform.
# Zopfli is a deterministic deflate implementation whose output does not depend on
# the host zlib, so rebuilding anywhere yields byte-identical .tar.gz files. The
# version is pinned in scripts/requirements.txt; see BUILD_CATALOGS.md.
try:
    import zopfli.gzip as zopfli_gzip
except ModuleNotFoundError:
    sys.exit(
        "ERROR: build_catalogs.py needs the 'zopfli' package for reproducible, "
        "platform-independent gzip output.\n"
        "Install the pinned build dependency:\n"
        "    python3 -m pip install -r scripts/requirements.txt\n"
        "See BUILD_CATALOGS.md → Reproducible packages."
    )

REPO_ROOT     = Path(__file__).resolve().parent.parent
FRAMES_DIR    = REPO_ROOT / "frames"
CAPS_DIR      = REPO_ROOT / "capabilities"
PACKAGES_DIR  = REPO_ROOT / "packages"
FRAMES_PKG    = PACKAGES_DIR / "frames"
CAPS_PKG      = PACKAGES_DIR / "capabilities"
FRAMES_OUT    = REPO_ROOT / "frames.json"
CAPS_OUT      = REPO_ROOT / "capabilities.json"

# Change this in one place when the hosting URL or branch changes.
BASE_URL = "https://raw.githubusercontent.com/smlcrft/seamside-catalogs/main"

# Catalog-level metadata (the wrapper around the items list). Add an optional
# "about_url" key here to point clients at an about page for the catalog — it is
# emitted verbatim into the manifest top-level when present (omitted when absent).
CATALOG_FRAMES = {
    "catalog_id":  "smallcraft_frames",
    "name":        "Small Craft Frames",
    "description": "Community frames published by Small Craft.",
    "about_url":   "https://github.com/smlcrft/seamside-catalogs",
}
CATALOG_CAPS = {
    "catalog_id":  "smallcraft_capabilities",
    "name":        "Small Craft Capabilities",
    "description": "Community capabilities published by Small Craft.",
    "about_url":   "https://github.com/smlcrft/seamside-catalogs",
}

# images_b64 validation ceilings (mirrors layer3_catalogs::validate_images_b64 in the app).
IMAGES_B64_MAX_COUNT = 3
IMAGES_B64_MAX_BYTES = 32 * 1024  # 32 KB decoded, per image


def validate_images_b64(meta: dict) -> str | None:
    """Return a human-readable error if a frame's optional `images_b64` is malformed,
    else None. Rules: at most IMAGES_B64_MAX_COUNT images, each decoding to under
    IMAGES_B64_MAX_BYTES bytes and carrying a JPEG `FF D8 FF` SOI marker. A
    `data:image/...;base64,` prefix is tolerated."""
    images = meta.get("images_b64")
    if images is None:
        return None
    if not isinstance(images, list):
        return "images_b64 must be a list of base64 strings"
    if len(images) > IMAGES_B64_MAX_COUNT:
        return f"{len(images)} images exceeds the maximum of {IMAGES_B64_MAX_COUNT}"
    for i, b64 in enumerate(images):
        if not isinstance(b64, str):
            return f"image {i} is not a string"
        payload = b64.split("base64,")[-1].strip()
        try:
            raw = base64.b64decode(payload, validate=True)
        except (binascii.Error, ValueError):
            return f"image {i} is not valid base64"
        if len(raw) >= IMAGES_B64_MAX_BYTES:
            return f"image {i} is {len(raw)} bytes, at/over the {IMAGES_B64_MAX_BYTES}-byte limit"
        if len(raw) < 3 or raw[0] != 0xFF or raw[1] != 0xD8 or raw[2] != 0xFF:
            return f"image {i} is not JPEG (missing FF D8 FF SOI marker)"
    return None

# Path-components to drop from frame tarballs. `data/` is per-host runtime
# state that the installer preserves separately; the rest is OS clutter.
EXCLUDE_PATH_PARTS = {"data", ".DS_Store", "__pycache__", ".git"}

# Top-level frame subdirs that must NOT be checked into a catalog entry: `data/`
# is per-host runtime state and `_todos/` is author scratch — both are user- or
# author-specific. The build refuses to package a frame that carries either, so
# user-specific state can't leak into a published catalog entry. (A catalog
# frame ships only the code; the installer provisions `data/` per host.)
USER_SPECIFIC_DIRS = ("data", "_todos")


def find_user_specific_dirs(src_dir: Path) -> list[str]:
    """Names of disallowed user/author-specific subdirs present at the top level
    of a frame source dir (`data/`, `_todos/`). Empty list when the frame is clean."""
    return [name for name in USER_SPECIFIC_DIRS if (src_dir / name).is_dir()]


# ---------------------------------------------------------------------------
# helpers

def sha256_hex(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def normalize_tarinfo(tarinfo: tarfile.TarInfo) -> tarfile.TarInfo | None:
    """Filter + normalize entries for deterministic, clean tarballs."""
    parts = Path(tarinfo.name).parts
    if any(p in EXCLUDE_PATH_PARTS for p in parts):
        return None
    tarinfo.mtime = 0
    tarinfo.uid = 0
    tarinfo.gid = 0
    tarinfo.uname = ""
    tarinfo.gname = ""
    return tarinfo


def build_frame_tarball(src_dir: Path, dest_tar: Path) -> None:
    dest_tar.parent.mkdir(parents=True, exist_ok=True)
    if dest_tar.exists():
        dest_tar.unlink()
    # Tarball layout: a single top-level dir named after `src_dir.name`,
    # holding `frame.json`, `frame.ts`, `public/`, etc. The installer
    # flattens single-top-level-dir tarballs, so this is the conventional
    # shape.
    #
    # Deterministic build: write the tar to a buffer, then gzip it with Zopfli.
    # tar entries are already normalized (mtime=0, uid/gid=0) by normalize_tarinfo;
    # Zopfli emits a gzip stream with mtime=0 and no embedded filename, and — unlike
    # stdlib gzip — its deflate bytes don't vary with the host zlib version, so the
    # .tar.gz (and its sha256) is byte-identical on any machine that builds it.
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        tar.add(src_dir, arcname=src_dir.name, filter=normalize_tarinfo)
    raw_tar = buf.getvalue()
    dest_tar.write_bytes(zopfli_gzip.compress(raw_tar))


def stamp_iso_utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def pick_modified_at(meta: dict) -> str:
    return meta.get("modified_at") or meta.get("created_at") or stamp_iso_utc_now()


def normalize_permissions(perms: dict | None) -> dict:
    """Project a frame.json `permissions` block to the canonical {net, web, web_scripts}
    shape the manifest advertises. Missing lists default to []. The app compares this
    against the installed frame.json's permissions as SETS (order-insensitive), so the
    three keys are kept explicit only to make the advertised access unambiguous.
        net         → backend worker outbound fetch (host[:port])
        web         → frontend media/img/socket origins (https/wss)
        web_scripts → HIGH-RISK external script origins (https/wss)"""
    p = perms or {}
    def lst(key: str) -> list:
        v = p.get(key, [])
        return v if isinstance(v, list) else []
    return {"net": lst("net"), "web": lst("web"), "web_scripts": lst("web_scripts")}


# ---------------------------------------------------------------------------
# frames

def build_frames_manifest() -> tuple[int, int]:
    if not FRAMES_DIR.exists():
        print("[frames] no frames/ dir — skipping")
        return 0, 0
    items: list[dict] = []
    errors = 0
    for sub in sorted(FRAMES_DIR.iterdir()):
        if not sub.is_dir():
            continue
        if sub.name.startswith("_") or sub.name.startswith("."):
            continue
        frame_json_path = sub / "frame.json"
        if not frame_json_path.exists():
            print(f"  ! skipping {sub.name}: missing frame.json")
            continue
        try:
            meta = json.loads(frame_json_path.read_text())
        except json.JSONDecodeError as e:
            print(f"  ! skipping {sub.name}: invalid frame.json ({e})")
            continue

        leaked = find_user_specific_dirs(sub)
        if leaked:
            joined = ", ".join(f"{d}/" for d in leaked)
            print(f"  ✗ ERROR {sub.name}: contains user-specific folder(s) {joined} — "
                  f"catalog frames must not populate these (per-host runtime state / author "
                  f"scratch). Remove them from the source before publishing.")
            errors += 1
            continue

        img_err = validate_images_b64(meta)
        if img_err:
            print(f"  ✗ ERROR {sub.name}: images_b64 invalid — {img_err}")
            errors += 1
            continue

        tar_path = FRAMES_PKG / f"{sub.name}.tar.gz"
        build_frame_tarball(sub, tar_path)
        sha = sha256_hex(tar_path)
        url = f"{BASE_URL}/packages/frames/{sub.name}.tar.gz"
        item = {
            "kind":        "Frames",
            "id":          sub.name,
            "name":        meta.get("name", sub.name),
            "description": meta.get("description", ""),
            "icon":        meta.get("icon", ""),
            "modified_at": pick_modified_at(meta),
            "frame_preview": {
                "frame_type":              meta.get("frame_type", "Tandem"),
                "default_width_px":        meta.get("default_width_px", 0),
                "default_height_px":       meta.get("default_height_px", 0),
                "depends_on_capabilities": meta.get("depends_on_capabilities", []),
            },
            "capability_preview": None,
            # Advertise the frame's declared outside-resource access (net / web /
            # web_scripts) in the manifest so a client can show it to the user BEFORE
            # install — and verify it after: the app refuses the install if the packaged
            # frame.json's permissions don't match this. Sourced from the SAME frame.json
            # that's tarballed above, so manifest and package agree by construction.
            "permissions": normalize_permissions(meta.get("permissions")),
            "package_url":        url,
            "package_sha256":     sha,
        }
        # Optional minimum-Seamside-version gate (omitted when the frame.json doesn't set it).
        if meta.get("app_version_min"):
            item["app_version_min"] = meta["app_version_min"]
        items.append(item)
        print(f"  + {sub.name:30s}  {sha[:12]}…  ({tar_path.stat().st_size:>7} B)")

    manifest = {
        **CATALOG_FRAMES,
        "kind":  "Frames",
        "items": items,
    }
    FRAMES_OUT.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"[frames] wrote {FRAMES_OUT.name} with {len(items)} item(s)" + (f" — {errors} error(s)" if errors else ""))
    return len(items), errors


# ---------------------------------------------------------------------------
# capabilities

def build_caps_manifest() -> int:
    if not CAPS_DIR.exists():
        print("[capabilities] no capabilities/ dir — skipping")
        return 0
    items: list[dict] = []
    for src in sorted(CAPS_DIR.iterdir()):
        if not src.is_file() or src.suffix != ".json":
            continue
        if src.name.startswith("_") or src.name.startswith("."):
            continue
        try:
            meta = json.loads(src.read_text())
        except json.JSONDecodeError as e:
            print(f"  ! skipping {src.name}: invalid JSON ({e})")
            continue

        CAPS_PKG.mkdir(parents=True, exist_ok=True)
        dest = CAPS_PKG / src.name
        shutil.copyfile(src, dest)
        sha = sha256_hex(dest)
        url = f"{BASE_URL}/packages/capabilities/{src.name}"
        item = {
            "kind":        "Capabilities",
            "id":          meta.get("name", src.stem),
            "name":        meta.get("name", src.stem),
            "description": meta.get("description", ""),
            "icon":        meta.get("icon", ""),
            "modified_at": pick_modified_at(meta),
            "frame_preview": None,
            "capability_preview": {
                "kind":    str(meta.get("kind", "external_api")).lower(),
                "methods": [m.get("name", "") for m in meta.get("methods", []) if isinstance(m, dict)],
            },
            "package_url":    url,
            "package_sha256": sha,
        }
        # Optional minimum-Seamside-version gate (omitted when the capability JSON doesn't set it).
        if meta.get("app_version_min"):
            item["app_version_min"] = meta["app_version_min"]
        items.append(item)
        print(f"  + {src.name:30s}  {sha[:12]}…")

    if not items:
        print("[capabilities] no capabilities present — capabilities.json not written")
        return 0

    manifest = {
        **CATALOG_CAPS,
        "kind":  "Capabilities",
        "items": items,
    }
    CAPS_OUT.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"[capabilities] wrote {CAPS_OUT.name} with {len(items)} item(s)")
    return len(items)


# ---------------------------------------------------------------------------
# main

def main() -> int:
    print(f"[build-catalogs] root = {REPO_ROOT}")
    n_frames, frame_errors = build_frames_manifest()
    n_caps   = build_caps_manifest()
    suffix = f" — {frame_errors} validation error(s)" if frame_errors else ""
    print(f"[build-catalogs] done — {n_frames} frame(s), {n_caps} capability(ies){suffix}")
    # Non-zero exit on any validation failure so CI / the maintainer notices a frame that
    # was excluded from the manifest (e.g. images_b64 that violates the size/format limits).
    return 1 if frame_errors else 0


if __name__ == "__main__":
    sys.exit(main())
