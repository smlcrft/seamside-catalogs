// ----------------------------------------------------------------------------------------
// Watercolor Studio — a collaborative, deterministic watercolor painting surface.
//
// Storage model (one sheet per session of the frame):
//   - The painting is files of the space, in a folder of its own under "Watercolor Studio/"
//     (sessionKv `sheet` names it; made at the first stroke): `strokes.json` is what the
//     frame keeps editing, `painting.png` the picture a person opens anywhere.
//   - strokes.json holds an ordered `strokes` array. Each stroke is a *vector* record — a
//     brush, a resolved pigment color, a dilution amount, a list of normalized [x,y,width]
//     points, and an integer `seed`. Every client replays the strokes through the same
//     seeded watercolor renderer, so the painting is identical on every peer while the wire
//     payload stays tiny. The page that made a change renders the PNG and hands it back.
//   - Prefs (title, paper, guide, sheet aspect) are this session's own key (sessionKv `prefs`).
//
// Auth model:
//   - Anonymous link visitors and Viewer-role members are read-only — they replay the
//     painting and receive live updates, but no /api/* mutation reaches them.
//   - Any sfi editor in the space can paint, lift pigment, and remove their own strokes.
//   - Owner-only: change title/paper/guide/aspect, clear the sheet, remove any stroke.
//
// Realtime: every successful mutation broadcasts a push to all viewers via pushToInstance.
// ----------------------------------------------------------------------------------------
import {
  log, parsePeerInfo, serveFileAtPath, serveHtmlShell, pushToInstance, onUiMessage,
  jsonReply, parseJsonBody, sanitizeText, sessionKv, spaceFiles,
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

type Prefs = { title: string; paper: string; guide: string; aspect: string };
const DEFAULT_PREFS: Prefs = {
  title: "Watercolor Studio", paper: "coldpress", guide: "none", aspect: "landscape",
};

// ----------------------------------------------------------------------------------------
// This session's prefs and sheet
// ----------------------------------------------------------------------------------------
async function getPrefs(): Promise<Prefs> {
  try { return { ...DEFAULT_PREFS, ...JSON.parse((await sessionKv.get("prefs"))?.value || "{}") }; }
  catch { return { ...DEFAULT_PREFS }; }
}

const FOLDER = "Watercolor Studio";
const STROKES = "strokes.json";
const PICTURE = "painting.png";
// strokes.json must fit in one file a frame may write.
const MAX_FILE_BYTES = 8 * 1024 * 1024 - 1024;

// The sheet's folder, or null before the first stroke. `make` picks a fresh one, named for
// the title (or "Painting"), beside any other session's.
async function sheetDir(make = false): Promise<string | null> {
  const kept = (await sessionKv.get("sheet"))?.value;
  if (kept) return kept;
  if (!make) return null;
  const { title } = await getPrefs();
  const base = (title !== DEFAULT_PREFS.title ? title : "Painting")
    .replace(/[\/\x00-\x1f]/g, " ").replace(/^[.\s]+/, "").trim().slice(0, 60) || "Painting";
  const taken = new Set((await spaceFiles.list(FOLDER).catch(() => [])).map((e) => e.name));
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base} ${i}`;
  const dir = `${FOLDER}/${name}`;
  await sessionKv.put("sheet", dir);
  return dir;
}

async function loadPainting(): Promise<Painting> {
  const dir = await sheetDir();
  const raw = dir ? await spaceFiles.read(`${dir}/${STROKES}`).catch(() => null) : null;
  if (!raw) return { strokes: [] };
  try {
    const parsed = JSON.parse(new TextDecoder().decode(raw));
    return { strokes: Array.isArray(parsed?.strokes) ? parsed.strokes : [] };
  } catch { return { strokes: [] }; }
}

// False when the sheet no longer fits in one file.
async function savePainting(p: Painting): Promise<boolean> {
  const text = JSON.stringify(p);
  if (text.length > MAX_FILE_BYTES) return false;
  await spaceFiles.write(`${await sheetDir(true)}/${STROKES}`, text);
  return true;
}

// Read-modify-write of the sheet, one at a time per space, so two strokes landing together
// both survive.
const locks = new Map<string, Promise<unknown>>();
function serial<T>(sfiId: string, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(sfiId) ?? Promise.resolve()).then(fn, fn);
  locks.set(sfiId, run.catch(() => {}));
  return run;
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
// Mutations — shared by the HTTP arms and the bus dispatcher. Role gates live here.
// ----------------------------------------------------------------------------------------
type MutPeer = ReturnType<typeof parsePeerInfo>;
type MutResult = { status: number; body: unknown };

function mutAddStroke(sfiId: string, v: any, peer: MutPeer): Promise<MutResult> {
  if (!peer.is_sfi_editor) return Promise.resolve({ status: 403, body: { error: "read-only" } });
  if (!v) return Promise.resolve({ status: 400, body: { error: "invalid JSON" } });
  const stroke = buildStroke(v, peer);
  if (!stroke) return Promise.resolve({ status: 400, body: { error: "invalid stroke" } });
  return serial(sfiId, async () => {
    const painting = await loadPainting();
    if (painting.strokes.length >= MAX_STROKES) return { status: 409, body: { error: "sheet full" } };
    painting.strokes.push(stroke);
    if (!(await savePainting(painting))) return { status: 409, body: { error: "sheet full" } };
    pushToInstance(sfiId, { type: "ws_add", sfi_id: sfiId, stroke, sheet: await sheetDir() });
    return { status: 200, body: { ok: true, stroke } };
  });
}

function mutDeleteStrokes(sfiId: string, v: { ids?: unknown } | null, peer: MutPeer): Promise<MutResult> {
  // Editors may remove their own strokes (undo); the owner may remove any.
  if (!peer.is_sfi_editor) return Promise.resolve({ status: 403, body: { error: "read-only" } });
  if (!v || !Array.isArray(v.ids)) return Promise.resolve({ status: 400, body: { error: "ids required" } });
  const idSet = new Set(v.ids.map(String));
  if (idSet.size === 0) return Promise.resolve({ status: 200, body: { ok: true, deleted: [] } });
  return serial(sfiId, async () => {
    const painting = await loadPainting();
    const deleted: string[] = [];
    painting.strokes = painting.strokes.filter((s) => {
      if (idSet.has(s.id) && (peer.is_owner || s.created_by_user_id === (peer.user_id || ""))) {
        deleted.push(s.id);
        return false;
      }
      return true;
    });
    if (deleted.length > 0) {
      await savePainting(painting);
      // An emptied sheet has no picture; any other is sent again by the page that undid.
      if (!painting.strokes.length) await spaceFiles.remove(`${await sheetDir()}/${PICTURE}`).catch(() => {});
      pushToInstance(sfiId, { type: "ws_delete", sfi_id: sfiId, ids: deleted });
    }
    return { status: 200, body: { ok: true, deleted } };
  });
}

// Clearing the sheet removes its files; the next stroke starts them again in the same folder.
function mutClear(sfiId: string, peer: MutPeer): Promise<MutResult> {
  if (!peer.is_owner) return Promise.resolve({ status: 403, body: { error: "owner only" } });
  return serial(sfiId, async () => {
    const dir = await sheetDir();
    if (dir) for (const f of [STROKES, PICTURE]) await spaceFiles.remove(`${dir}/${f}`).catch(() => {});
    pushToInstance(sfiId, { type: "ws_clear", sfi_id: sfiId });
    return { status: 200, body: { ok: true } };
  });
}

async function mutSettings(
  sfiId: string,
  v: { title?: unknown; paper?: unknown; guide?: unknown; aspect?: unknown } | null,
  peer: MutPeer,
): Promise<MutResult> {
  if (!peer.is_owner) return { status: 403, body: { error: "owner only" } };
  if (!v) return { status: 400, body: { error: "invalid JSON" } };
  const cur = await getPrefs();
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
  await sessionKv.put("prefs", JSON.stringify(next));
  pushToInstance(sfiId, { type: "ws_prefs", sfi_id: sfiId, prefs: next });
  return { status: 200, body: { ok: true, prefs: next } };
}

// The picture of the sheet, rendered by the page that made the last change. `last` is the
// id of the newest stroke it drew: a picture of an older sheet is refused.
function mutPicture(sfiId: string, last: string, bytes: Uint8Array, peer: MutPeer): Promise<MutResult> {
  if (!peer.is_sfi_editor) return Promise.resolve({ status: 403, body: { error: "read-only" } });
  const PNG = [0x89, 0x50, 0x4e, 0x47];
  if (bytes.length < 8 || PNG.some((b, i) => bytes[i] !== b)) return Promise.resolve({ status: 415, body: { error: "not a PNG" } });
  return serial(sfiId, async () => {
    const { strokes } = await loadPainting();
    const now = strokes.length ? strokes[strokes.length - 1].id : "";
    if (!now || now !== last) return { status: 409, body: { error: "the sheet has moved on" } };
    await spaceFiles.write(`${await sheetDir(true)}/${PICTURE}`, bytes);
    return { status: 200, body: { ok: true } };
  });
}

// ----------------------------------------------------------------------------------------
// BUS DISPATCHER — the frontend's write path (frame.busSend → BusUiToFrame → here).
// `peer` is the sender's platform-resolved identity, same shape as parsePeerInfo; the
// role gates live inside the mutation functions. Denials are logged, not answered.
// ----------------------------------------------------------------------------------------
onUiMessage(async (sfiId, data, peer) => {
  if (!sfiId || typeof data !== "object" || data === null) return;
  const d = data as Record<string, unknown>;
  const r =
    d.op === "stroke/add"      ? await mutAddStroke(sfiId, d, peer)
    : d.op === "stroke/delete" ? await mutDeleteStrokes(sfiId, d as { ids?: unknown }, peer)
    : d.op === "clear"         ? await mutClear(sfiId, peer)
    : d.op === "settings"      ? await mutSettings(sfiId, d as { title?: unknown }, peer)
    : null;
  if (r && r.status !== 200) log(`watercolor: bus op ${d.op} → ${r.status} (${JSON.stringify(r.body)})`);
});

// ----------------------------------------------------------------------------------------
// HANDLER
// ----------------------------------------------------------------------------------------
self.onNetworkRequest = async (replyPort, reqPath, method, _h, query, body, cookies) => {
  const peer = parsePeerInfo(query, cookies);
  const sfiId = peer.sfi_id;
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
    return jsonReply(replyPort, 200, {
      prefs: await getPrefs(),
      strokes: (await loadPainting()).strokes,
      sheet: await sheetDir(),
      can_edit: canEdit,
      is_owner: peer.is_owner,
      me: { user_id: peer.user_id, user_name: peer.user_name || "anon" },
    });
  }

  // The picture, for anyone who can see the painting.
  if (reqPath === "/api/picture" && method === "GET") {
    const dir = await sheetDir();
    const png = dir ? await spaceFiles.read(`${dir}/${PICTURE}`).catch(() => null) : null;
    if (!png) return jsonReply(replyPort, 404, { error: "no picture yet" });
    return replyPort.postMessage({ status: 200, body: png, contentType: "image/png" }, [png.buffer as ArrayBuffer]);
  }

  // ------- mutations require canEdit (sfi editor) -------
  if (reqPath.startsWith("/api/") && !canEdit) {
    return jsonReply(replyPort, 403, { error: "read-only" });
  }

  // HTTP arms kept for API compatibility (older viewers, scripted clients); the frame's
  // own UI writes over the bus (see the dispatcher above). Same functions, same gates.
  const arm =
    method !== "POST" ? null
    : reqPath === "/api/stroke/add"    ? () => mutAddStroke(sfiId, parseJsonBody<any>(body), peer)
    : reqPath === "/api/stroke/delete" ? () => mutDeleteStrokes(sfiId, parseJsonBody<{ ids?: unknown }>(body), peer)
    : reqPath === "/api/clear"         ? () => mutClear(sfiId, peer)
    : reqPath === "/api/settings"      ? () => mutSettings(sfiId, parseJsonBody<{ title?: unknown }>(body), peer)
    : reqPath === "/api/picture"       ? () => mutPicture(sfiId, String(query.last || ""), new Uint8Array(body), peer)
    : null;
  if (arm) {
    const r = await arm();
    return jsonReply(replyPort, r.status, r.body);
  }

  if (method === "GET") {
    return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url));
  }
  replyPort.postMessage({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Not found.", code: "NOT_FOUND" }) });
};

log("watercolor studio frame is up.");
