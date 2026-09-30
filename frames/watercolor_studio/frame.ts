// ----------------------------------------------------------------------------------------
// Watercolor Studio — a collaborative, deterministic watercolor painting surface.
//
// Storage model (one sheet per session of the frame):
//   - The painting is files of the space, in a folder of its own under "Watercolor Studio/"
//     (the session's key `sheet` names it; made at the first stroke): `strokes.json` is what
//     the frame keeps editing, `painting.png` the picture a person opens anywhere.
//   - strokes.json holds an ordered `strokes` array. Each stroke is a *vector* record — a
//     brush, a resolved pigment color, a dilution amount, a list of normalized [x,y,width]
//     points, and an integer `seed`. Every client replays the strokes through the same
//     seeded watercolor renderer, so the painting is identical on every peer while the wire
//     payload stays tiny. The page that made a change renders the PNG and hands it back.
//   - Prefs (title, paper, guide, sheet aspect) are this session's own `__fc_settings` row
//     `prefs`, its value JSON under `v`: owner-only, so never a key a collaborator writes.
//
// Auth model (decided on ctx.peer, who the door proved is asking):
//   - Anonymous link visitors and Viewer-role members are read-only — they replay the
//     painting and follow along, but no /api/* mutation reaches them.
//   - Any editor in the space can paint, lift pigment, and remove their own strokes.
//   - Owner-only: change title/paper/guide/aspect, clear the sheet, remove any stroke.
//
// Realtime: a push says what changed (`strokes` or `prefs`), never what it holds; every
// open page reads /api/state again as whoever it is.
// ----------------------------------------------------------------------------------------
import type { Ctx, PeerInfo } from "@frame-core";
import { log, parseJsonBody, sanitizeText } from "@frame-core";

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
const SETTINGS = "__fc_settings";

async function setPrefs(ctx: Ctx, prefs: Prefs) {
  const t = ctx.table<Record<string, unknown>>(SETTINGS);
  const was = await t.get("prefs"), now = Date.now();
  await t.upsert({ ...(was ?? { _created_at: now }), id: "prefs", v: JSON.stringify(prefs), _modified_at: now });
}

// A missing row is written on first read, from the `prefs` key an older copy kept or else
// the defaults, and the key goes: a key written at the door later is never taken up.
async function getPrefs(ctx: Ctx): Promise<Prefs> {
  const row = await ctx.table<Record<string, unknown>>(SETTINGS).get("prefs");
  if (row?.v != null) {
    try { return { ...DEFAULT_PREFS, ...JSON.parse(String(row.v)) }; } catch { return { ...DEFAULT_PREFS }; }
  }
  const old = await ctx.kv.get("prefs");
  let prefs = { ...DEFAULT_PREFS };
  try { prefs = { ...DEFAULT_PREFS, ...JSON.parse(old?.value || "{}") }; } catch { /* defaults */ }
  await setPrefs(ctx, prefs);
  if (old) await ctx.kv.del("prefs");
  return prefs;
}

const FOLDER = "Watercolor Studio";
const STROKES = "strokes.json";
const PICTURE = "painting.png";
// strokes.json must fit in one file a frame may write.
const MAX_FILE_BYTES = 8 * 1024 * 1024 - 1024;

// The sheet's folder, or null before the first stroke. `make` picks a fresh one, named for
// the title (or "Painting"), beside any other session's.
async function sheetDir(ctx: Ctx, make = false): Promise<string | null> {
  const kept = (await ctx.kv.get("sheet"))?.value;
  if (kept) return kept;
  if (!make) return null;
  const { title } = await getPrefs(ctx);
  const base = (title !== DEFAULT_PREFS.title ? title : "Painting")
    .replace(/[\/\x00-\x1f]/g, " ").replace(/^[.\s]+/, "").trim().slice(0, 60) || "Painting";
  const taken = new Set((await ctx.files.list(FOLDER).catch(() => [])).map((e) => e.name));
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base} ${i}`;
  const dir = `${FOLDER}/${name}`;
  await ctx.kv.put("sheet", dir);
  return dir;
}

async function loadPainting(ctx: Ctx): Promise<Painting> {
  const dir = await sheetDir(ctx);
  const raw = dir ? await ctx.files.read(`${dir}/${STROKES}`).catch(() => null) : null;
  if (!raw) return { strokes: [] };
  try {
    const parsed = JSON.parse(new TextDecoder().decode(raw));
    return { strokes: Array.isArray(parsed?.strokes) ? parsed.strokes : [] };
  } catch { return { strokes: [] }; }
}

// False when the sheet no longer fits in one file.
async function savePainting(ctx: Ctx, p: Painting): Promise<boolean> {
  const text = JSON.stringify(p);
  if (text.length > MAX_FILE_BYTES) return false;
  await ctx.files.write(`${await sheetDir(ctx, true)}/${STROKES}`, text);
  return true;
}

// Read-modify-write of the sheet, one at a time per session, so two strokes landing
// together both survive.
const locks = new Map<string, Promise<unknown>>();
function serial<T>(ctx: Ctx, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(ctx.frame) ?? Promise.resolve()).then(fn, fn);
  locks.set(ctx.frame, run.catch(() => {}));
  return run;
}

// What changed, never what it holds: each page reads again as whoever it is.
const tell = (ctx: Ctx, what: "strokes" | "prefs") => ctx.push({ watercolor_studio: what });

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

// deno-lint-ignore no-explicit-any
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
// Mutations. Role gates live here.
// ----------------------------------------------------------------------------------------
type MutResult = { status: number; body: unknown };
const isEditor = (peer: PeerInfo) => peer.is_sfi_editor || peer.is_owner;

// deno-lint-ignore no-explicit-any
function mutAddStroke(ctx: Ctx, v: any): Promise<MutResult> {
  if (!isEditor(ctx.peer)) return Promise.resolve({ status: 403, body: { error: "read-only" } });
  if (!v) return Promise.resolve({ status: 400, body: { error: "invalid JSON" } });
  const stroke = buildStroke(v, ctx.peer);
  if (!stroke) return Promise.resolve({ status: 400, body: { error: "invalid stroke" } });
  return serial(ctx, async () => {
    const painting = await loadPainting(ctx);
    if (painting.strokes.length >= MAX_STROKES) return { status: 409, body: { error: "sheet full" } };
    painting.strokes.push(stroke);
    if (!(await savePainting(ctx, painting))) return { status: 409, body: { error: "sheet full" } };
    tell(ctx, "strokes");
    return { status: 200, body: { ok: true, stroke } };
  });
}

function mutDeleteStrokes(ctx: Ctx, v: { ids?: unknown } | null): Promise<MutResult> {
  // Editors may remove their own strokes (undo); the owner may remove any.
  const peer = ctx.peer;
  if (!isEditor(peer)) return Promise.resolve({ status: 403, body: { error: "read-only" } });
  if (!v || !Array.isArray(v.ids)) return Promise.resolve({ status: 400, body: { error: "ids required" } });
  const idSet = new Set(v.ids.map(String));
  if (idSet.size === 0) return Promise.resolve({ status: 200, body: { ok: true, deleted: [] } });
  return serial(ctx, async () => {
    const painting = await loadPainting(ctx);
    const deleted: string[] = [];
    painting.strokes = painting.strokes.filter((s) => {
      if (idSet.has(s.id) && (peer.is_owner || s.created_by_user_id === (peer.user_id || ""))) {
        deleted.push(s.id);
        return false;
      }
      return true;
    });
    if (deleted.length > 0) {
      await savePainting(ctx, painting);
      // An emptied sheet has no picture; any other is sent again by the page that undid.
      if (!painting.strokes.length) await ctx.files.remove(`${await sheetDir(ctx)}/${PICTURE}`).catch(() => {});
      tell(ctx, "strokes");
    }
    return { status: 200, body: { ok: true, deleted } };
  });
}

// Clearing the sheet removes its files; the next stroke starts them again in the same folder.
function mutClear(ctx: Ctx): Promise<MutResult> {
  if (!ctx.peer.is_owner) return Promise.resolve({ status: 403, body: { error: "owner only" } });
  return serial(ctx, async () => {
    const dir = await sheetDir(ctx);
    if (dir) for (const f of [STROKES, PICTURE]) await ctx.files.remove(`${dir}/${f}`).catch(() => {});
    tell(ctx, "strokes");
    return { status: 200, body: { ok: true } };
  });
}

async function mutSettings(
  ctx: Ctx,
  v: { title?: unknown; paper?: unknown; guide?: unknown; aspect?: unknown } | null,
): Promise<MutResult> {
  if (!ctx.peer.is_owner) return { status: 403, body: { error: "owner only" } };
  if (!v) return { status: 400, body: { error: "invalid JSON" } };
  const cur = await getPrefs(ctx);
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
  await setPrefs(ctx, next);
  tell(ctx, "prefs");
  return { status: 200, body: { ok: true, prefs: next } };
}

// The picture of the sheet, rendered by the page that made the last change. `last` is the
// id of the newest stroke it drew: a picture of an older sheet is refused.
function mutPicture(ctx: Ctx, last: string, bytes: Uint8Array): Promise<MutResult> {
  if (!isEditor(ctx.peer)) return Promise.resolve({ status: 403, body: { error: "read-only" } });
  const PNG = [0x89, 0x50, 0x4e, 0x47];
  if (bytes.length < 8 || PNG.some((b, i) => bytes[i] !== b)) return Promise.resolve({ status: 415, body: { error: "not a PNG" } });
  return serial(ctx, async () => {
    const { strokes } = await loadPainting(ctx);
    const now = strokes.length ? strokes[strokes.length - 1].id : "";
    if (!now || now !== last) return { status: 409, body: { error: "the sheet has moved on" } };
    await ctx.files.write(`${await sheetDir(ctx, true)}/${PICTURE}`, bytes);
    return { status: 200, body: { ok: true } };
  });
}

// ----------------------------------------------------------------------------------------
// HANDLER
// ----------------------------------------------------------------------------------------
const json = (v: unknown, status = 200) => Response.json(v, { status });

export default {
  async fetch(request: Request, ctx: Ctx): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;
    const peer = ctx.peer;
    // Painting is a "write" action — Viewer-role members and anonymous viewers can watch
    // the painting build up but cannot lay down or lift pigment.
    const canEdit = isEditor(peer);

    if (!pathname.startsWith("/api/")) {
      if (method !== "GET") return json({ error: "Not found.", code: "NOT_FOUND" }, 404);
      return ctx.file(pathname);
    }

    if (pathname === "/api/state" && method === "GET") {
      return json({
        prefs: await getPrefs(ctx),
        strokes: (await loadPainting(ctx)).strokes,
        sheet: await sheetDir(ctx),
        can_edit: canEdit,
        is_owner: peer.is_owner,
        color: peer.space_color,
        me: { user_id: peer.user_id, user_name: peer.user_name || "anon" },
      });
    }

    // The picture, for anyone who can see the painting.
    if (pathname === "/api/picture" && method === "GET") {
      const dir = await sheetDir(ctx);
      const png = dir ? await ctx.files.read(`${dir}/${PICTURE}`).catch(() => null) : null;
      if (!png) return json({ error: "no picture yet" }, 404);
      return new Response(png as Uint8Array<ArrayBuffer>, { headers: { "content-type": "image/png" } });
    }

    // ------- mutations require canEdit (editor) -------
    if (!canEdit) return json({ error: "read-only" }, 403);

    const arm =
      method !== "POST" ? null
      : pathname === "/api/stroke/add"    ? async () => mutAddStroke(ctx, parseJsonBody(await request.arrayBuffer()))
      : pathname === "/api/stroke/delete" ? async () => mutDeleteStrokes(ctx, parseJsonBody<{ ids?: unknown }>(await request.arrayBuffer()))
      : pathname === "/api/clear"         ? () => mutClear(ctx)
      : pathname === "/api/settings"      ? async () => mutSettings(ctx, parseJsonBody<{ title?: unknown }>(await request.arrayBuffer()))
      : pathname === "/api/picture"       ? async () => mutPicture(ctx, url.searchParams.get("last") || "", new Uint8Array(await request.arrayBuffer()))
      : null;
    if (arm) {
      const r = await arm();
      return json(r.body, r.status);
    }
    return json({ error: "Not found.", code: "NOT_FOUND" }, 404);
  },
};

log("watercolor studio frame is up.");
