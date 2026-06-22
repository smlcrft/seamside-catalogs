// ----------------------------------------------------------------------------------------
// Watercolor Studio — a collaborative, deterministic watercolor painting surface.
//
// Storage model:
//   - Per-placement prefs (title + paper + guide template + sheet aspect) in a single
//     prefs.json keyed by sfi_id.
//   - Per-placement painting (one JSON file per sfi_id) at {data_dir}/paintings/{sfi_id}.json.
//     The file holds an ordered `strokes` array. Each stroke is a *vector* record — a brush,
//     a resolved pigment color, a dilution amount, a list of normalized [x,y,width] points,
//     and an integer `seed`. The pixels are never stored: every client replays the strokes
//     through the same seeded watercolor renderer, so the painting is byte-identical on
//     every peer while the wire payload stays tiny.
//   - In-memory cache is the single source of truth; disk writes are throttled to ~1.5s.
//
// Auth model:
//   - Anonymous (FAT) viewers and Viewer-role members are read-only — they replay the
//     painting and receive live updates, but no /api/* mutation reaches them.
//   - Any sfi editor in the space can paint, lift pigment, and remove their own strokes.
//   - Owner-only: change title/paper/guide/aspect, clear the sheet, remove any stroke.
//
// Realtime: every successful mutation broadcasts a push to all viewers via pushToInstance.
// ----------------------------------------------------------------------------------------
import {
  log, parsePeerInfo, serveFileAtPath, serveHtmlShell, pushToInstance,
  jsonReply, parseJsonBody, sanitizeText,
  frameDataDir, loadJsonFile, saveJsonFile, mkdirSync, path,
} from "@frame-core";

// ----------------------------------------------------------------------------------------
// Types and constants
// ----------------------------------------------------------------------------------------
type BrushId = "wash" | "round" | "flat" | "dry" | "detail" | "lift";

// Each point: [x, y, w] — x/y normalized to the paper sheet (0..1), w is a per-point
// width factor (driven by stroke speed at draw time) kept so replay needs no timing data.
type Point = [number, number, number];

interface Stroke {
  id: string;
  brush: BrushId;
  pigment: string;   // "#rrggbb" — the mixed paint color (ignored for the "lift" brush)
  water: number;     // dilution 0..1 (more water → thinner, paler wash)
  points: Point[];
  seed: number;      // integer — drives the deterministic blob deformation
  created_at: number;
  created_by_user_id: string;
  created_by_user_name: string;
}

interface Painting { strokes: Stroke[]; }

const VALID_BRUSHES: ReadonlySet<BrushId> = new Set(
  ["wash", "round", "flat", "dry", "detail", "lift"] as BrushId[],
);
const VALID_PAPERS = new Set(["coldpress", "hotpress", "rough", "kraft", "dusk"]);
const VALID_GUIDES = new Set(["none", "pear", "teacup", "leaf", "mountain", "koi", "tulip"]);
const VALID_ASPECTS = new Set(["landscape", "portrait", "square"]);
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

const MAX_STROKES = 3000;
const MAX_POINTS_PER_STROKE = 2000;
const FLUSH_INTERVAL_MS = 1500;

type Prefs = { title: string; paper: string; guide: string; aspect: string };
const DEFAULT_PREFS: Prefs = {
  title: "Watercolor Studio", paper: "coldpress", guide: "none", aspect: "landscape",
};

// ----------------------------------------------------------------------------------------
// Per-placement prefs — one JSON file shared by all sfi_ids
// ----------------------------------------------------------------------------------------
const allPrefs: Record<string, Prefs> = loadJsonFile(import.meta.url, "prefs.json", {});

function getPrefs(sfiId: string): Prefs {
  return { ...DEFAULT_PREFS, ...(allPrefs[sfiId] ?? {}) };
}
function setPrefs(sfiId: string, next: Prefs): void {
  allPrefs[sfiId] = next;
  saveJsonFile(import.meta.url, "prefs.json", allPrefs);
}

// ----------------------------------------------------------------------------------------
// Per-placement painting persistence — one JSON file per sfi_id under data/paintings/
// ----------------------------------------------------------------------------------------
const DATA_DIR = frameDataDir(import.meta.url);
const PAINT_DIR = path.join(DATA_DIR, "paintings");
mkdirSync(PAINT_DIR, { recursive: true });

const cache = new Map<string, Painting>();
const dirty = new Set<string>();
const flushTimers = new Map<string, number>();

function fileFor(sfiId: string): string {
  const safe = sfiId.replace(/[^A-Za-z0-9_-]/g, "_");
  return path.join(PAINT_DIR, `${safe}.json`);
}

function loadPainting(sfiId: string): Painting {
  const cached = cache.get(sfiId);
  if (cached) return cached;
  let painting: Painting;
  try {
    const raw = Deno.readTextFileSync(fileFor(sfiId));
    const parsed = JSON.parse(raw);
    painting = { strokes: Array.isArray(parsed?.strokes) ? parsed.strokes : [] };
  } catch {
    painting = { strokes: [] };
  }
  cache.set(sfiId, painting);
  return painting;
}

function markDirty(sfiId: string): void {
  dirty.add(sfiId);
  if (flushTimers.has(sfiId)) return;
  const handle = setTimeout(() => flush(sfiId), FLUSH_INTERVAL_MS);
  flushTimers.set(sfiId, handle);
}

function flush(sfiId: string): void {
  flushTimers.delete(sfiId);
  if (!dirty.has(sfiId)) return;
  const painting = cache.get(sfiId);
  if (!painting) return;
  try {
    Deno.writeTextFileSync(fileFor(sfiId), JSON.stringify(painting));
    dirty.delete(sfiId);
  } catch (e) {
    log(`watercolor: flush failed for ${sfiId}: ${e}`);
  }
}

// ----------------------------------------------------------------------------------------
// Validation / stroke construction
// ----------------------------------------------------------------------------------------
function newId(): string {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function validatePoints(raw: unknown): Point[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_POINTS_PER_STROKE) return null;
  const out: Point[] = [];
  for (const pt of raw) {
    if (!Array.isArray(pt) || pt.length < 2) return null;
    const x = Number(pt[0]);
    const y = Number(pt[1]);
    const w = Number(pt[2] ?? 1);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w)) return null;
    // Allow a little overflow past the sheet edge so strokes can run off the paper.
    out.push([clamp(x, -0.2, 1.2), clamp(y, -0.2, 1.2), clamp(w, 0.1, 4)]);
  }
  return out;
}

function buildStroke(input: any, peer: { user_id: string; user_name: string }): Stroke | null {
  const brushRaw = String(input?.brush ?? "");
  if (!(VALID_BRUSHES as Set<string>).has(brushRaw)) return null;
  const brush = brushRaw as BrushId;

  const pts = validatePoints(input?.points);
  if (!pts) return null;

  // Pigment is required for every brush except the clean-water lift, which carries none.
  let pigment = "#000000";
  if (brush !== "lift") {
    const p = String(input?.pigment ?? "");
    if (!HEX_RE.test(p)) return null;
    pigment = p.toLowerCase();
  }

  const water = clamp(Number(input?.water ?? 0.5), 0, 1);
  if (!Number.isFinite(water)) return null;

  let seed = Math.floor(Number(input?.seed));
  if (!Number.isFinite(seed)) seed = (Math.random() * 0x7fffffff) | 0;
  seed = ((seed % 0x7fffffff) + 0x7fffffff) % 0x7fffffff;

  return {
    id: newId(),
    brush,
    pigment,
    water,
    points: pts,
    seed,
    created_at: Date.now(),
    created_by_user_id: peer.user_id || "",
    created_by_user_name: sanitizeText(peer.user_name, 80) || "anon",
  };
}

// ----------------------------------------------------------------------------------------
// HANDLER
// ----------------------------------------------------------------------------------------
self.onNetworkRequest = async (replyPort, reqPath, method, _h, query, body, cookies) => {
  const peer = parsePeerInfo(query, cookies);
  const sfiId = peer.sfi_id;
  const isOwner = peer.is_owner;
  // Painting is a "write" action — Viewer-role members and anonymous viewers can watch
  // the painting build up but cannot lay down or lift pigment.
  const canEdit = peer.is_sfi_editor;

  // UI shell. The script is a separate ES module (`<script type="module">`) so it can
  // import /lib/js/framelib.js, so it is intentionally NOT inlined. CSS is inlined.
  if (reqPath === "/index.html" && method === "GET") {
    return serveHtmlShell(replyPort, new URL("./public/index.html", import.meta.url), {
      peer,
      inlineCss: ["index.css"],
    });
  }

  // Static assets (index.js/css) don't need an sfi and their requests don't carry ?sfi=.
  // Serve them before the sfi guard so anonymous viewers aren't 400'd out of the scripts.
  if (method === "GET" && !reqPath.startsWith("/api/")) {
    return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url));
  }

  if (!sfiId) return jsonReply(replyPort, 400, { error: "sfi_id missing" });

  if (reqPath === "/api/state" && method === "GET") {
    const painting = loadPainting(sfiId);
    return jsonReply(replyPort, 200, {
      prefs: getPrefs(sfiId),
      strokes: painting.strokes,
      can_edit: canEdit,
      is_owner: isOwner,
      me: { user_id: peer.user_id, user_name: peer.user_name || "anon" },
    });
  }

  // ------- mutations require canEdit (sfi editor) -------
  if (reqPath.startsWith("/api/") && !canEdit) {
    return jsonReply(replyPort, 403, { error: "read-only" });
  }

  if (reqPath === "/api/stroke/add" && method === "POST") {
    const v = parseJsonBody<any>(body);
    if (!v) return jsonReply(replyPort, 400, { error: "invalid JSON" });
    const painting = loadPainting(sfiId);
    if (painting.strokes.length >= MAX_STROKES) {
      return jsonReply(replyPort, 409, { error: "sheet full" });
    }
    const stroke = buildStroke(v, peer);
    if (!stroke) return jsonReply(replyPort, 400, { error: "invalid stroke" });
    painting.strokes.push(stroke);
    markDirty(sfiId);
    pushToInstance(sfiId, { type: "ws_add", sfi_id: sfiId, stroke });
    return jsonReply(replyPort, 200, { ok: true, stroke });
  }

  if (reqPath === "/api/stroke/delete" && method === "POST") {
    // Editors may remove their own strokes (undo); the owner may remove any.
    const v = parseJsonBody<{ ids?: unknown }>(body);
    if (!v || !Array.isArray(v.ids)) return jsonReply(replyPort, 400, { error: "ids required" });
    const idSet = new Set(v.ids.map(String));
    if (idSet.size === 0) return jsonReply(replyPort, 200, { ok: true, deleted: [] });
    const painting = loadPainting(sfiId);
    const deleted: string[] = [];
    painting.strokes = painting.strokes.filter((s) => {
      if (idSet.has(s.id) && (isOwner || s.created_by_user_id === (peer.user_id || ""))) {
        deleted.push(s.id);
        return false;
      }
      return true;
    });
    if (deleted.length > 0) {
      // Destructive — persist immediately so a removal can't be lost to the write throttle.
      markDirty(sfiId);
      flush(sfiId);
      pushToInstance(sfiId, { type: "ws_delete", sfi_id: sfiId, ids: deleted });
    }
    return jsonReply(replyPort, 200, { ok: true, deleted });
  }

  if (reqPath === "/api/clear" && method === "POST") {
    if (!isOwner) return jsonReply(replyPort, 403, { error: "owner only" });
    const painting = loadPainting(sfiId);
    painting.strokes = [];
    // Destructive — persist immediately so the clear can't be lost to the write throttle
    // (otherwise a torn-down worker reloads the old strokes and new work piles on top).
    markDirty(sfiId);
    flush(sfiId);
    pushToInstance(sfiId, { type: "ws_clear", sfi_id: sfiId });
    return jsonReply(replyPort, 200, { ok: true });
  }

  if (reqPath === "/api/settings" && method === "POST") {
    if (!isOwner) return jsonReply(replyPort, 403, { error: "owner only" });
    const v = parseJsonBody<{ title?: unknown; paper?: unknown; guide?: unknown; aspect?: unknown }>(body);
    if (!v) return jsonReply(replyPort, 400, { error: "invalid JSON" });
    const cur = getPrefs(sfiId);
    const title = sanitizeText(v.title, 80) || cur.title;
    const paperRaw = sanitizeText(v.paper, 16);
    const guideRaw = sanitizeText(v.guide, 16);
    const aspectRaw = sanitizeText(v.aspect, 16);
    const next: Prefs = {
      title,
      paper: VALID_PAPERS.has(paperRaw) ? paperRaw : cur.paper,
      guide: VALID_GUIDES.has(guideRaw) ? guideRaw : cur.guide,
      aspect: VALID_ASPECTS.has(aspectRaw) ? aspectRaw : cur.aspect,
    };
    setPrefs(sfiId, next);
    pushToInstance(sfiId, { type: "ws_prefs", sfi_id: sfiId, prefs: next });
    return jsonReply(replyPort, 200, { ok: true, prefs: next });
  }

  if (method === "GET") {
    return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url));
  }
  replyPort.postMessage({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Not found.", code: "NOT_FOUND" }) });
};

// Best-effort flush on shutdown so the latest stroke isn't lost.
self.addEventListener("beforeunload", () => {
  for (const sfi of [...dirty]) flush(sfi);
});

log(`watercolor studio frame is up. paintings_dir=${PAINT_DIR}`);
