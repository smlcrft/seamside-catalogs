// ----------------------------------------------------------------------------------------
// Garden Plotter — visual layout of community garden plots on a soil-toned canvas.
// Plots are snap-to-grid rectangles assigned to a member (or a custom non-member name),
// tagged with the plant families growing in them, and stamped with when/at-what-stage
// they were planted. The frame fetches the past 7 days of weather from Open-Meteo (free,
// keyless) for the configured location and computes a per-plot natural stress level via
// a plant-profile lookup table. Stress is rendered as a radial gradient on each plot:
// vibrant green at the edges (low stress), soft yellow mid-band (avg), red at the center
// (high). Plots are the space's `garden_plots` table; a plot can be assigned to someone on
// a `members` list of the space (Member Manager's roster: `members.table.jsonl` or a
// subtype such as `club.members.table.jsonl`), the one this session is bound to
// (sessionKv `bound/members`). The garden's settings are this session's own (sessionKv
// `prefs`).
// ----------------------------------------------------------------------------------------
import {
  log, serveFileAtPath, pushToInstance, parsePeerInfo, onUiMessage,
  declareTables, table, sessionKv,
  jsonReply, parseJsonBody, sanitizeText, toIntOrNull, clampInt,
  wireTableChangeListener, serveHtmlShell
} from "@frame-core";

// ----- The space's tables -----------------------------------------------------------------
// PLOTS are this frame's own rows. The members list is Member Manager's roster (name, role
// read here): bound to one, plots can be assigned to real people; with none the planner
// works as well, plots just take typed-in names.

const PLOTS_SCHEMA = [
  { name: "name",                 col_type: "text"    as const, nullable: false },
  { name: "pos_json",             col_type: "text"    as const, nullable: false },
  { name: "assigned_member_id",   col_type: "text"    as const, nullable: true  },
  { name: "assigned_manual_name", col_type: "text"    as const, nullable: true  },
  { name: "plant_types_json",     col_type: "text"    as const, nullable: true  },
  // 0 = full shade, 50 = part shade, 100 = full sun. Multiplies the daily max UV
  // when computing per-plant stress so a shaded bed doesn't take the full sun hit.
  { name: "shade_pct",            col_type: "integer" as const, nullable: false, default_val: "100" },
  { name: "notes",                col_type: "text"    as const, nullable: true  },
];

declareTables([
  {
    key: "garden_plots", title: "Garden Plots",
    description: "Plots of this space's garden, with grid position/size, assignment, plant entries and sun exposure.",
    schema: PLOTS_SCHEMA,
  },
]);

// ----- Which members list: `members` or a subtype `<name>.members`, bound per session -----
const LIST_NAME = /^([a-z0-9][a-z0-9_-]*\.)*members$/;
const validList = (n: unknown): n is string => typeof n === "string" && n.length <= 64 && LIST_NAME.test(n);
async function boundList(): Promise<string | null> {
  const v = (await sessionKv.get("bound/members"))?.value;
  return validList(v) ? v : null;
}

type Tbl = ReturnType<typeof table>;
type PeerInfo = ReturnType<typeof parsePeerInfo>;

// ----- Plant profiles + stress lookup ---------------------------------------------------
// Each tuple is [low_ideal, high_ideal, low_extreme, high_extreme]. Inside the ideal band
// stress contribution is 0; between ideal and extreme it ramps linearly to 100.
// Temperature in °F, humidity %, rainfall in inches over 7 days, UV index.
type PlantKey =
  | "tomatoes" | "potatoes" | "beans" | "herbs" | "salad_greens"
  | "carrots"  | "peppers"  | "flowers" | "cabbage" | "succulents";

const PLANT_TYPES: { key: PlantKey; label: string; icon: string }[] = [
  { key: "tomatoes",     label: "Tomatoes",      icon: "ph-circle"        },
  { key: "potatoes",     label: "Potatoes",      icon: "ph-egg"           },
  { key: "beans",        label: "Beans",         icon: "ph-grains"        },
  { key: "herbs",        label: "Herbs",         icon: "ph-leaf"          },
  { key: "salad_greens", label: "Salad Greens",  icon: "ph-plant"         },
  { key: "carrots",      label: "Carrots",       icon: "ph-carrot"        },
  { key: "peppers",      label: "Peppers",       icon: "ph-pepper"        },
  { key: "flowers",      label: "Flowers",       icon: "ph-flower"        },
  { key: "cabbage",      label: "Cabbage",       icon: "ph-tree-evergreen" },
  { key: "succulents",   label: "Succulents",    icon: "ph-cactus"        },
];

type PlantProfile = {
  temp:     [number, number, number, number];
  humidity: [number, number, number, number];
  rain:     [number, number, number, number];
  uv:       [number, number, number, number];
};

const PLANT_PROFILES: Record<PlantKey, PlantProfile> = {
  tomatoes:     { temp: [60, 85, 35, 100], humidity: [40, 70, 15, 95], rain: [0.5, 1.5, 0, 4.0], uv: [4, 9,  0, 12] },
  potatoes:     { temp: [55, 75, 30,  95], humidity: [50, 70, 20, 95], rain: [1.0, 2.0, 0, 5.0], uv: [3, 8,  0, 12] },
  beans:        { temp: [60, 80, 35, 100], humidity: [50, 70, 20, 95], rain: [1.0, 1.5, 0, 4.0], uv: [4, 9,  0, 12] },
  herbs:        { temp: [60, 80, 35, 100], humidity: [40, 60, 15, 90], rain: [0.5, 1.0, 0, 3.0], uv: [4, 9,  0, 12] },
  salad_greens: { temp: [50, 70, 25,  90], humidity: [50, 70, 20, 95], rain: [1.0, 1.5, 0, 4.0], uv: [3, 7,  0, 12] },
  carrots:      { temp: [55, 75, 30,  95], humidity: [50, 70, 20, 95], rain: [1.0, 1.5, 0, 4.0], uv: [3, 8,  0, 12] },
  peppers:      { temp: [65, 85, 40, 105], humidity: [50, 70, 20, 95], rain: [0.5, 1.5, 0, 4.0], uv: [5, 10, 0, 12] },
  flowers:      { temp: [55, 80, 25, 100], humidity: [40, 70, 15, 95], rain: [0.5, 1.5, 0, 4.0], uv: [4, 9,  0, 12] },
  cabbage:      { temp: [50, 70, 25,  90], humidity: [60, 80, 25, 95], rain: [1.0, 1.5, 0, 4.0], uv: [3, 7,  0, 12] },
  succulents:   { temp: [60, 90, 30, 110], humidity: [20, 50, 10, 80], rain: [0.0, 0.5, 0, 2.5], uv: [5, 11, 0, 12] },
};

const STAGE_KEYS = ["seed", "sprout", "juvenile", "adult"] as const;
type StageKey = typeof STAGE_KEYS[number];
const STAGE_LABEL: Record<StageKey, string> = {
  seed: "Seed", sprout: "Sprout / Seedling", juvenile: "Juvenile", adult: "Adult",
};
// Day-since-seeding offset where each stage typically starts. Used to derive likely current stage.
const STAGE_OFFSET_DAYS: Record<StageKey, number> = { seed: 0, sprout: 7, juvenile: 21, adult: 50 };
// Stress modifier — younger plants are more sensitive than mature ones.
const STAGE_STRESS_MOD: Record<StageKey, number> = { seed: 1.4, sprout: 1.2, juvenile: 1.0, adult: 0.8 };

function factorStress(value: number, ideal_lo: number, ideal_hi: number, ext_lo: number, ext_hi: number): number {
  if (value >= ideal_lo && value <= ideal_hi) return 0;
  if (value < ideal_lo) {
    const span = ideal_lo - ext_lo;
    if (span <= 0) return 100;
    return Math.max(0, Math.min(100, ((ideal_lo - value) / span) * 100));
  }
  const span = ext_hi - ideal_hi;
  if (span <= 0) return 100;
  return Math.max(0, Math.min(100, ((value - ideal_hi) / span) * 100));
}

type WeatherSummary = {
  avg_temp: number;
  min_temp: number;
  max_temp: number;
  avg_humidity: number;
  total_rain_in: number;
  max_uv: number;
  days_used: number;
};

function currentStage(planted_at_ms: number | null, planted_stage: StageKey | null, now: number): StageKey {
  if (!planted_at_ms || !planted_stage) return "adult"; // unknown timing → assume mature (least stress)
  const elapsedDays = Math.max(0, (now - planted_at_ms) / 86400000);
  const totalDays = STAGE_OFFSET_DAYS[planted_stage] + elapsedDays;
  if (totalDays < STAGE_OFFSET_DAYS.sprout) return "seed";
  if (totalDays < STAGE_OFFSET_DAYS.juvenile) return "sprout";
  if (totalDays < STAGE_OFFSET_DAYS.adult) return "juvenile";
  return "adult";
}

function plantStress(plant: PlantKey, stage: StageKey, w: WeatherSummary): number {
  const p = PLANT_PROFILES[plant];
  if (!p) return 0;
  const fs = [
    factorStress(w.avg_temp,      p.temp[0],     p.temp[1],     p.temp[2],     p.temp[3]),
    factorStress(w.avg_humidity,  p.humidity[0], p.humidity[1], p.humidity[2], p.humidity[3]),
    factorStress(w.total_rain_in, p.rain[0],     p.rain[1],     p.rain[2],     p.rain[3]),
    factorStress(w.max_uv,        p.uv[0],       p.uv[1],       p.uv[2],       p.uv[3]),
  ];
  const worst = Math.max(...fs);
  return Math.max(0, Math.min(100, worst * STAGE_STRESS_MOD[stage]));
}

type PlantEntry = { plant_type: PlantKey; planted_at: number | null; planted_stage: StageKey | null };
type PerPlantStress = {
  plant: PlantKey;
  label: string;
  planted_at: number | null;
  planted_stage: StageKey | null;
  current_stage: StageKey;
  stress: number;
  stress_known: boolean;
};

function aggregateStress(per: PerPlantStress[]): { low: number; avg: number; high: number } | null {
  const known = per.filter((p) => p.stress_known);
  if (known.length === 0) return null;
  const vals = known.map((p) => p.stress);
  const sum = vals.reduce((a, b) => a + b, 0);
  return { low: Math.min(...vals), avg: sum / vals.length, high: Math.max(...vals) };
}

// Plot position/size (grid cells) is stored as a single JSON string in pos_json:
// {"x":0,"y":0,"w":3,"h":2}. Lets us keep the schema slim and lets future versions add
// rotation or shape hints without a new column.
type PlotPos = { x: number; y: number; w: number; h: number };

function parsePos(json: unknown, prefs: Prefs): PlotPos {
  let raw: { x?: unknown; y?: unknown; w?: unknown; h?: unknown } = {};
  if (typeof json === "string" && json) {
    try { const v = JSON.parse(json); if (v && typeof v === "object") raw = v; } catch { /* fall through */ }
  }
  const x = clampInt(Number(raw.x) || 0, 0, prefs.grid_cols - 1);
  const y = clampInt(Number(raw.y) || 0, 0, prefs.grid_rows - 1);
  const w = clampInt(Number(raw.w) || 1, 1, prefs.grid_cols - x);
  const h = clampInt(Number(raw.h) || 1, 1, prefs.grid_rows - y);
  return { x, y, w, h };
}

function serializePos(p: PlotPos): string {
  return JSON.stringify({ x: p.x, y: p.y, w: p.w, h: p.h });
}

// ----- Preferences (this session's own) ---------------------------------------------------
type Prefs = {
  org_name: string;
  location: string;       // city name or zip; fed to Open-Meteo geocoding
  grid_cols: number;
  grid_rows: number;
  grid_px: number;
  owner_only_edit: boolean;
  allow_public_viewing: boolean;
};

const DEFAULT_PREFS: Prefs = {
  org_name: "Community Garden",
  location: "",
  grid_cols: 24,
  grid_rows: 16,
  grid_px: 32,
  owner_only_edit: false,
  allow_public_viewing: false,
};

async function getPrefs(): Promise<Prefs> {
  let p: Partial<Prefs> | null = null;
  try { p = JSON.parse((await sessionKv.get("prefs"))?.value ?? "null"); } catch { /* defaults */ }
  if (!p) return { ...DEFAULT_PREFS };
  const cols = Number.isFinite(Number(p.grid_cols)) ? Math.max(4, Math.min(80, Math.trunc(Number(p.grid_cols)))) : DEFAULT_PREFS.grid_cols;
  const rows = Number.isFinite(Number(p.grid_rows)) ? Math.max(4, Math.min(80, Math.trunc(Number(p.grid_rows)))) : DEFAULT_PREFS.grid_rows;
  const px = Number.isFinite(Number(p.grid_px)) ? Math.max(16, Math.min(80, Math.trunc(Number(p.grid_px)))) : DEFAULT_PREFS.grid_px;
  return {
    org_name: typeof p.org_name === "string" && p.org_name ? p.org_name : DEFAULT_PREFS.org_name,
    location: typeof p.location === "string" ? p.location : "",
    grid_cols: cols,
    grid_rows: rows,
    grid_px: px,
    owner_only_edit: !!p.owner_only_edit,
    allow_public_viewing: !!p.allow_public_viewing,
  };
}

async function setPrefs(next: Prefs): Promise<void> {
  await sessionKv.put("prefs", JSON.stringify(next));
}

// ----- Weather fetch + 30 min cache (per location) --------------------------------------
type WeatherCache = { summary: WeatherSummary; resolved_name: string; fetchedAt: number };
const weatherCache = new Map<string, WeatherCache>();
const WEATHER_TTL_MS = 30 * 60 * 1000;

async function fetchWeatherSummary(location: string): Promise<{ summary: WeatherSummary; resolved_name: string } | null> {
  const cacheKey = location.trim().toLowerCase();
  if (!cacheKey) return null;
  const now = Date.now();
  const cached = weatherCache.get(cacheKey);
  if (cached && now - cached.fetchedAt < WEATHER_TTL_MS) {
    return { summary: cached.summary, resolved_name: cached.resolved_name };
  }
  try {
    // Geocode → lat/lon
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`;
    const geoRes = await fetch(geoUrl);
    if (!geoRes.ok) throw new Error(`geocoding failed: ${geoRes.status}`);
    const geoJson = await geoRes.json();
    const loc = geoJson.results?.[0];
    if (!loc) throw new Error(`location not found: "${location}"`);
    const { latitude, longitude, name, country, admin1 } = loc;
    // Past 7 days of daily aggregates.
    const params = new URLSearchParams({
      latitude: String(latitude),
      longitude: String(longitude),
      daily: "temperature_2m_max,temperature_2m_min,temperature_2m_mean,relative_humidity_2m_mean,precipitation_sum,uv_index_max",
      temperature_unit: "fahrenheit",
      precipitation_unit: "inch",
      timezone: "auto",
      past_days: "7",
      forecast_days: "1",
    });
    const wRes = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
    if (!wRes.ok) throw new Error(`weather failed: ${wRes.status}`);
    const wJson = await wRes.json();
    const daily = wJson.daily ?? {};
    const tMax: number[] = (daily.temperature_2m_max  ?? []).map(Number).filter(Number.isFinite);
    const tMin: number[] = (daily.temperature_2m_min  ?? []).map(Number).filter(Number.isFinite);
    const tMean: number[] = (daily.temperature_2m_mean ?? []).map(Number).filter(Number.isFinite);
    const rhMean: number[] = (daily.relative_humidity_2m_mean ?? []).map(Number).filter(Number.isFinite);
    const precip: number[] = (daily.precipitation_sum ?? []).map(Number).filter(Number.isFinite);
    const uv: number[] = (daily.uv_index_max ?? []).map(Number).filter(Number.isFinite);
    const last7 = (arr: number[]) => arr.slice(-8, -1); // last 7 days excluding today's forecast row
    const t7max = last7(tMax), t7min = last7(tMin), t7mean = last7(tMean);
    const rh7 = last7(rhMean), p7 = last7(precip), uv7 = last7(uv);
    const avg = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
    const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
    const summary: WeatherSummary = {
      avg_temp: avg(t7mean),
      min_temp: t7min.length ? Math.min(...t7min) : 0,
      max_temp: t7max.length ? Math.max(...t7max) : 0,
      avg_humidity: avg(rh7),
      total_rain_in: sum(p7),
      max_uv: uv7.length ? Math.max(...uv7) : 0,
      days_used: Math.min(t7mean.length, 7),
    };
    const resolved_name = admin1 ? `${name}, ${admin1}` : `${name}, ${country}`;
    weatherCache.set(cacheKey, { summary, resolved_name, fetchedAt: now });
    log(`weather fetched | ${resolved_name} | ${summary.days_used} days`);
    return { summary, resolved_name };
  } catch (e) {
    log(`weather fetch error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// ----- Helpers --------------------------------------------------------------------------
function canEdit(peer: ReturnType<typeof parsePeerInfo>, prefs: Prefs): boolean {
  // The gate is is_sfi_editor, never "not anonymous": a Viewer-role member is authenticated
  // and has frame access, and would otherwise have slipped straight through this.
  if (!peer.is_sfi_editor) return false;
  if (prefs.owner_only_edit) return peer.is_owner;
  return true;
}
// Snap shade input to one of three legal buckets (0/50/100). Anything else falls back
// to full sun so a corrupt or missing value never zeros out UV unintentionally.
function clampShade(v: number | null): number {
  if (v === null) return 100;
  if (v <= 25) return 0;
  if (v <= 75) return 50;
  return 100;
}
function parsePlantEntries(json: unknown): PlantEntry[] {
  if (typeof json !== "string" || !json) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const valid = new Set<string>(PLANT_TYPES.map((p) => p.key));
  const stages = new Set<string>(STAGE_KEYS as readonly string[]);
  const out: PlantEntry[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const pt = String(obj.plant_type ?? "");
    if (!valid.has(pt)) continue;
    const at = obj.planted_at;
    const stage = obj.planted_stage;
    out.push({
      plant_type: pt as PlantKey,
      planted_at: typeof at === "number" && Number.isFinite(at) ? Math.trunc(at) : null,
      planted_stage: typeof stage === "string" && stages.has(stage) ? (stage as StageKey) : null,
    });
  }
  return out;
}

function serializePlantEntries(entries: PlantEntry[]): string {
  return JSON.stringify(entries.map((e) => ({
    plant_type: e.plant_type,
    planted_at: e.planted_at,
    planted_stage: e.planted_stage,
  })));
}

type PlotRow = Record<string, unknown> & { _row_id: string; _created_at: number };

// ----- Writes -----------------------------------------------------------------------------
// ONE shared mutation path for both transports: the bus dispatcher below (frame.busSend →
// onUiMessage, the primary write path, because Android drops HTTP request bodies — see
// docs/tether-writes.md) and the HTTP POST arm in onNetworkRequest, kept for older viewers
// whose framelib has no busSend. `op` is the API path with "api/" stripped. Role gates live
// here so the two entry points can never drift.
type WriteResult = { status: number; body: unknown };

async function handleWrite(sfiId: string, op: string, v: Record<string, unknown> | null, peer: PeerInfo): Promise<WriteResult> {
  const prefs = await getPrefs();

  // --- Which members list (editors) ------------------------------------------------------
  if (op === "bind") {
    if (!peer.is_sfi_editor) return { status: 403, body: { error: "editors only" } };
    const name = v?.list;
    if (!validList(name)) return { status: 400, body: { error: "a members list is named members or <name>.members" } };
    await sessionKv.put("bound/members", name);
    pushToInstance(sfiId, { type: "settings_changed" });
    return { status: 200, body: { bound: name } };
  }

  // --- Garden settings (owner-only) ----------------------------------------------------
  if (op === "settings") {
    if (!peer.is_owner) return { status: 403, body: { error: "only the frame owner can change settings" } };
    if (!v) return { status: 400, body: { error: "invalid JSON" } };
    const org_name = sanitizeText(v.org_name, 120) || DEFAULT_PREFS.org_name;
    const location = sanitizeText(v.location, 120);
    const grid_cols = clampInt(Number(v.grid_cols) || DEFAULT_PREFS.grid_cols, 4, 80);
    const grid_rows = clampInt(Number(v.grid_rows) || DEFAULT_PREFS.grid_rows, 4, 80);
    const grid_px = clampInt(Number(v.grid_px) || DEFAULT_PREFS.grid_px, 16, 80);
    const next: Prefs = {
      org_name, location, grid_cols, grid_rows, grid_px,
      owner_only_edit: !!v.owner_only_edit,
      allow_public_viewing: !!v.allow_public_viewing,
    };
    await setPrefs(next);
    // Drop weather cache for any stale location so the next /api/state refreshes.
    weatherCache.clear();
    pushToInstance(sfiId, { type: "settings_changed" });
    return { status: 200, body: { prefs: next } };
  }

  // --- Plots ---------------------------------------------------------------------------
  // Everything below touches the garden itself and needs the edit right.
  if (!canEdit(peer, prefs)) return { status: 403, body: { error: "editing is restricted" } };
  const plots: Tbl = table("garden_plots", sfiId);

  if (op === "plot") {
    if (!v) return { status: 400, body: { error: "invalid JSON" } };
    // Plot names are optional — viewers fall back to a "Plot" placeholder. We still
    // sanitize and cap length to keep the row size bounded.
    const name = sanitizeText(v.name, 200);
    const pos = parsePos(serializePos({
      x: Number(v.pos_x) || 0, y: Number(v.pos_y) || 0,
      w: Number(v.width) || 1, h: Number(v.height) || 1,
    }), prefs);
    const shade_pct = clampShade(toIntOrNull(v.shade_pct));
    const memberId = sanitizeText(v.assigned_member_id, 100);
    const manualName = sanitizeText(v.assigned_manual_name, 200);
    // Each entry: { plant_type, planted_at?, planted_stage? }. We sanitize and keep only
    // the first occurrence of each plant_type so a plot can't list the same family twice.
    const plantsIn: unknown[] = Array.isArray(v.plants) ? v.plants : [];
    const validPlantSet = new Set(PLANT_TYPES.map((p) => p.key));
    const stagesSet = new Set<string>(STAGE_KEYS as readonly string[]);
    const seen = new Set<string>();
    const plants: PlantEntry[] = [];
    for (const item of plantsIn) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const pt = sanitizeText(o.plant_type, 40);
      if (!validPlantSet.has(pt as PlantKey) || seen.has(pt)) continue;
      seen.add(pt);
      const at = toIntOrNull(o.planted_at);
      const stageRaw = sanitizeText(o.planted_stage, 20);
      const stage: StageKey | null = stagesSet.has(stageRaw) ? (stageRaw as StageKey) : null;
      plants.push({ plant_type: pt as PlantKey, planted_at: at, planted_stage: stage });
    }
    const notes = sanitizeText(v.notes, 1000);
    const rowId = v.row_id ? String(v.row_id) : null;
    const { row_id } = await plots.upsert(rowId, {
      name,
      pos_json: serializePos(pos),
      assigned_member_id: memberId,
      assigned_manual_name: memberId ? "" : manualName,
      plant_types_json: serializePlantEntries(plants),
      shade_pct,
      notes,
    });
    return { status: 200, body: { row_id } };
  }

  if (op === "plot/move") {
    // Lightweight: just update geometry, used during drag/resize so we don't blow away
    // unrelated fields if something else changed concurrently.
    if (!v) return { status: 400, body: { error: "invalid JSON" } };
    const rowId = String(v.row_id ?? "");
    if (!rowId) return { status: 400, body: { error: "row_id required" } };
    const pos = parsePos(serializePos({
      x: Number(v.pos_x) || 0, y: Number(v.pos_y) || 0,
      w: Number(v.width) || 1, h: Number(v.height) || 1,
    }), prefs);
    await plots.upsert(rowId, { pos_json: serializePos(pos) });
    return { status: 200, body: { row_id: rowId } };
  }

  if (op === "plot/delete") {
    const rowId = String(v?.row_id ?? "");
    if (!rowId) return { status: 400, body: { error: "row_id required" } };
    await plots.delete(rowId);
    return { status: 200, body: { ok: true } };
  }

  return { status: 404, body: { error: "not found" } };
}

// ----- Bus dispatcher — the frontend's write path (frame.busSend → BusUiToFrame) --------
// Denials are logged, not answered — a legitimate client never sends a write it isn't
// allowed to make.
onUiMessage(async (sfiId, data, peer) => {
  if (!sfiId || typeof data !== "object" || data === null) return;
  const d = data as Record<string, unknown>;
  if (typeof d.op !== "string") return;
  const r = await handleWrite(sfiId, d.op, d, peer);
  if (r.status !== 200) log(`garden_planner: bus op ${d.op} → ${r.status} (${JSON.stringify(r.body)})`);
});

// ----- HTTP handler ---------------------------------------------------------------------
self.onNetworkRequest = async function (replyPort, reqPath, method, _headers, query, body, cookies) {
  const peer = parsePeerInfo(query, cookies);

  // Static assets are open to everyone and must never wait on a table.
  if (method === "GET" && !reqPath.startsWith("/api/") && reqPath !== "/index.html") {
    return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url));
  }

  wireTableChangeListener("garden_plots", peer.sfi_id, "plots_changed");
  const plots: Tbl = table("garden_plots", peer.sfi_id);
  const list = await boundList();
  const roster = async () => list ? (await table(list, peer.sfi_id).query({ limit: 1000 })).rows as Record<string, unknown>[] : [];
  const prefs = await getPrefs();
  const editable = canEdit(peer, prefs);
  const now = Date.now();

  if (reqPath === "/api/state" && method === "GET") {
    const weather = prefs.location ? await fetchWeatherSummary(prefs.location) : null;
    return jsonReply(replyPort, 200, {
      prefs,
      viewer: {
        user_name: peer.user_name || "anon",
        is_owner: peer.is_owner,
        is_anon: peer.is_anon,
      },
      can_edit: editable,
      bound: list,
      can_bind: peer.is_sfi_editor,
      plant_types: PLANT_TYPES,
      stages: STAGE_KEYS.map((k) => ({ key: k, label: STAGE_LABEL[k] })),
      weather: weather
        ? { resolved_name: weather.resolved_name, ...weather.summary }
        : null,
      now,
    });
  }

  if (reqPath === "/api/members" && method === "GET") {
    // No roster in the space is a normal state, not an error: plots take typed-in names.
    if (peer.is_anon) return jsonReply(replyPort, 200, { rows: [] });
    const rows = await roster();
    rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const slim = rows.map((r: Record<string, unknown>) => ({
      _row_id: r._row_id, name: r.name, role: r.role,
    }));
    return jsonReply(replyPort, 200, { rows: slim });
  }

  if (reqPath === "/api/plots" && method === "GET") {
    if (peer.is_anon && !prefs.allow_public_viewing) {
      return jsonReply(replyPort, 200, { rows: [], public_disabled: true });
    }
    const weather = prefs.location ? await fetchWeatherSummary(prefs.location) : null;
    const { rows } = await plots.query({ limit: 2000 }) as { rows: PlotRow[] };
    rows.sort((a, b) => Number(a._created_at) - Number(b._created_at));
    const memberRows = peer.is_anon ? [] : await roster();
    const memberById = new Map(memberRows.map((m) => [String(m._row_id), m]));

    const enriched = rows.map((r) => {
      const pos = parsePos(r.pos_json, prefs);
      const entries = parsePlantEntries(r.plant_types_json);
      const memberId = String(r.assigned_member_id ?? "");
      const member = memberId ? memberById.get(memberId) : undefined;
      const manualName = String(r.assigned_manual_name ?? "");
      const shade_pct = clampShade(toIntOrNull(r.shade_pct));
      // Shade attenuates UV: full shade (0) wipes UV out, part shade (50) halves it,
      // full sun (100) leaves UV untouched. Temperature/humidity/rain are kept as-is —
      // a shaded plot still feels the same air temp and rainfall.
      const localWeather: WeatherSummary | null = weather
        ? { ...weather.summary, max_uv: weather.summary.max_uv * (shade_pct / 100) }
        : null;
      const perPlant: PerPlantStress[] = entries.map((e) => {
        const label = PLANT_TYPES.find((p) => p.key === e.plant_type)?.label || e.plant_type;
        const known = !!(localWeather && e.planted_at && e.planted_stage);
        const cur = e.planted_at && e.planted_stage ? currentStage(e.planted_at, e.planted_stage, now) : "adult";
        return {
          plant: e.plant_type,
          label,
          planted_at: e.planted_at,
          planted_stage: e.planted_stage,
          current_stage: cur,
          stress: known ? plantStress(e.plant_type, cur, localWeather!) : 0,
          stress_known: known,
        };
      });
      const stress = aggregateStress(perPlant);
      const stress_known = !!stress;
      const base = {
        _row_id: r._row_id,
        name: r.name,
        pos_x: pos.x, pos_y: pos.y, width: pos.w, height: pos.h,
        shade_pct,
        per_plant: perPlant,
        stress,
        stress_known,
      };
      if (peer.is_anon) {
        return { ...base, assigned_label: "" };
      }
      return {
        ...base,
        assigned_member_id: memberId,
        assigned_member_name: member ? String(member.name) : "",
        assigned_manual_name: manualName,
        assigned_label: member ? String(member.name) : (manualName || ""),
        notes: String(r.notes ?? ""),
      };
    });

    return jsonReply(replyPort, 200, {
      rows: enriched,
      anon_view: peer.is_anon,
      weather_available: !!weather,
    });
  }

  // ----- Mutations -------------------------------------------------------------------
  // Every write goes through the ONE shared path below, whichever transport carried it.
  if (reqPath.startsWith("/api/") && method === "POST") {
    const r = await handleWrite(peer.sfi_id, reqPath.slice("/api/".length),
                                parseJsonBody<Record<string, unknown>>(body), peer);
    return jsonReply(replyPort, r.status, r.body);
  }

  if (method === "GET") {
    // The script is a separate ES module file (`<script type="module" src="./index.js">`)
    // so it can import /lib/js/framelib.js — inlineJs would flatten that to a non-module
    // <script>, which can't use ES module imports, so it's intentionally omitted here.
    if(reqPath == "/index.html") return serveHtmlShell(replyPort, new URL("./public/index.html", import.meta.url), {
      peer: undefined,
      inlineCss: ["index.css"],
    });
    return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url));
  }

  replyPort.postMessage({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Not found.", code: "NOT_FOUND" }) });
};

log("Garden Plotter frame is up and running.");
