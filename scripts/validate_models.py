#!/usr/bin/env python3
"""
Validate every published capability's curated model assignments against the
provider's LIVE models endpoint.

Model ids are the most volatile data in a capability: providers retire models
without warning, and a stale `models` assignment (or `pricing` key) ships a
recommendation that fails at request time. This script converts that silent
rot into a red build — run it on every catalog build and on a weekly cron.
See the Seamside app's design/ai-model-roles/README.md for the architecture.

For each `capabilities/*.json`:

1. No `models` block            → skipped (not an AI-model capability).
2. No `models_source`           → assignments can't be checked (e.g. a provider
                                  with a single fixed model and no list endpoint)
                                  → reported, not an error.
3. No API key in the env        → SKIPPED with a warning (exit 0), so local runs
                                  without secrets stay green. In CI, provide
                                  <NAME>_API_KEY secrets to make checks real.
4. Live list fetched            → every `models` assignment and every `pricing`
                                  key must be in the list, else FAIL (exit 1).

Also fails on `models` keys outside the known role vocabulary (quick /
standard / deep) — a typo'd role would otherwise silently never resolve.

API keys come from the environment: MISTRAL_API_KEY, OPENAI_API_KEY, ... —
uppercased capability name + `_API_KEY` (dashes → underscores).

Usage:
    python3 scripts/validate_models.py            # validate all capabilities
    python3 scripts/validate_models.py mistral    # validate one
Requires Python 3.9+ (stdlib only — urllib).
"""
import json
import os
import sys
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CAPS_DIR = REPO_ROOT / "capabilities"

# The app-owned role vocabulary (mirrors codegen/roles.rs in the Seamside app).
# Grows only when the app grows a new codegen path — bump this list alongside.
KNOWN_ROLES = {"quick", "standard", "deep"}

FETCH_TIMEOUT_S = 15


def api_key_env_var(cap_name: str) -> str:
    return cap_name.upper().replace("-", "_") + "_API_KEY"


def fetch_live_model_ids(cap: dict) -> list[str]:
    """Fetch the provider's live model list per the capability's models_source
    + auth config. Raises on any failure — the caller decides severity."""
    src = cap["models_source"]
    req = urllib.request.Request(src["url"])
    auth = cap.get("auth") or {}
    key = os.environ.get(api_key_env_var(cap["name"]))
    if auth.get("type") == "bearer":
        req.add_header("Authorization", f"Bearer {key}")
    elif auth.get("type") == "header":
        req.add_header(auth["header"], key or "")
    for h, v in (cap.get("headers") or {}).items():
        req.add_header(h, v)
    with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT_S) as resp:
        body = json.load(resp)
    items = body.get(src.get("list_path") or "data") or []
    value_key = src.get("value_key") or "id"
    ids = [item[value_key] for item in items if isinstance(item, dict) and value_key in item]
    prefixes = src.get("filter_prefixes") or []
    if prefixes:
        ids = [i for i in ids if any(i.startswith(p) for p in prefixes)]
    return ids


def validate_cap(path: Path) -> tuple[int, int]:
    """Validate one capability file. Returns (errors, skips)."""
    cap = json.loads(path.read_text())
    name = cap.get("name", path.stem)
    models: dict = cap.get("models") or {}
    pricing: dict = cap.get("pricing") or {}

    if not models:
        print(f"  - {name}: no models block — not an AI-model capability, skipping")
        return 0, 0

    errors = 0

    # Role-vocabulary check (works with no network / no key).
    for role in models:
        if role not in KNOWN_ROLES:
            print(f"  ✗ {name}: models key '{role}' is not a known role "
                  f"({', '.join(sorted(KNOWN_ROLES))}) — it would never resolve")
            errors += 1

    if not cap.get("models_source"):
        print(f"  - {name}: no models_source — assignments unverifiable "
              f"({', '.join(f'{r}={a if isinstance(a, str) else a.get('model')}' for r, a in sorted(models.items()))})")
        return errors, 0

    if not os.environ.get(api_key_env_var(name)):
        print(f"  ! {name}: {api_key_env_var(name)} not set — SKIPPING live check")
        return errors, 1

    try:
        live = set(fetch_live_model_ids(cap))
    except Exception as e:
        print(f"  ✗ {name}: failed to fetch live model list: {e}")
        return errors + 1, 0
    if not live:
        print(f"  ✗ {name}: live model list came back empty — check models_source config")
        return errors + 1, 0

    for role, assignment in sorted(models.items()):
        model_id = assignment if isinstance(assignment, str) else assignment.get("model", "")
        if model_id in live:
            print(f"  + {name}: {role} = {model_id} ✓")
        else:
            print(f"  ✗ {name}: {role} assignment '{model_id}' is NOT in the provider's live list — "
                  f"the provider retired it or the id is wrong. Update the assignment.")
            errors += 1

    for model_id in sorted(pricing):
        if model_id not in live:
            print(f"  ✗ {name}: pricing key '{model_id}' is NOT in the provider's live list")
            errors += 1

    return errors, 0


def main() -> int:
    only = set(sys.argv[1:])
    total_errors = 0
    total_skips = 0
    for path in sorted(CAPS_DIR.glob("*.json")):
        if path.name.startswith(("_", ".")):
            continue
        if only and path.stem not in only:
            continue
        e, s = validate_cap(path)
        total_errors += e
        total_skips += s
    suffix = f", {total_skips} skipped (no API key)" if total_skips else ""
    print(f"[validate-models] done — {total_errors} error(s){suffix}")
    return 1 if total_errors else 0


if __name__ == "__main__":
    sys.exit(main())
