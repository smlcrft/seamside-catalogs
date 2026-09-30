// ----------------------------------------------------------------------------------------
// Trip Planner — itineraries, packing lists, and trip costs, one trip at a time.
//
// Design axes:
//   privacy:        privacy-public-view  — non-members get a live read-only view;
//                                           space editors get the interactive planner.
//                                           The read-only itinerary is the showcase: a
//                                           share link is the trip's handout. The page
//                                           reads no table: everything comes from the
//                                           routes below, and every write is one of them.
//   data_storage:   the space's tables   — trips.table.jsonl plus trip_itinerary /
//                                           trip_packing / trip_expenses rows keyed by
//                                           trip_id, at the space's root: synced with it
//                                           and shared by every Trip Planner in the space.
//   view_realtime:  view-collaborative    — every write pushes `{ trip_planner: "trips" }`,
//                                           which says what to read again and never what
//                                           it holds, so every viewer refreshes live.
//
// The page has no network of its own, so the map's style, tiles, glyphs and sprites come
// through this worker from tiles.openfreemap.org (see /tiles/ below).
// ----------------------------------------------------------------------------------------
import type { Ctx } from "@frame-core";
import { declareTables, sanitizeText } from "@frame-core";

// ----- The space's tables (named for the trip, so no other frame's rows land in them) -----
const TRIPS = "trips";
const ITINERARY = "trip_itinerary";
const PACKING = "trip_packing";
const EXPENSES = "trip_expenses";

type Col = { name: string; col_type: "text" | "integer" | "real"; nullable: boolean; default_val: string };

const TABLES: Array<{ key: string; title: string; description: string; schema: Col[] }> = [
  {
    key: TRIPS, title: "Trips", description: "Trips planned in this space.",
    schema: [
      { name: "name",        col_type: "text",    nullable: false, default_val: "" },
      { name: "destination", col_type: "text",    nullable: false, default_val: "" },
      { name: "start_date",  col_type: "text",    nullable: false, default_val: "" },
      { name: "end_date",    col_type: "text",    nullable: false, default_val: "" },
      { name: "notes",       col_type: "text",    nullable: false, default_val: "" },
      { name: "created_ms",  col_type: "integer", nullable: false, default_val: "0" },
    ],
  },
  {
    key: ITINERARY, title: "Trip Itinerary", description: "Itinerary entries, keyed by trip.",
    schema: [
      { name: "trip_id",    col_type: "text",    nullable: false, default_val: "" },
      { name: "day_date",   col_type: "text",    nullable: false, default_val: "" },
      { name: "time",       col_type: "text",    nullable: false, default_val: "" },
      { name: "activity",   col_type: "text",    nullable: false, default_val: "" },
      { name: "location",   col_type: "text",    nullable: false, default_val: "" },
      { name: "sort_order", col_type: "integer", nullable: false, default_val: "0" },
      // Where the stop is on earth, looked up once from `location` and cached here.
      // `geo_q` records the exact string that was looked up, which distinguishes
      // "never tried" ("") from "tried and found nothing" (geo_q === location, lat/lon 0)
      // and tells us when the user edited the location and we owe it a fresh lookup.
      { name: "lat",        col_type: "real",    nullable: false, default_val: "0" },
      { name: "lon",        col_type: "real",    nullable: false, default_val: "0" },
      { name: "geo_q",      col_type: "text",    nullable: false, default_val: "" },
    ],
  },
  {
    key: PACKING, title: "Trip Packing", description: "Packing list items, keyed by trip.",
    schema: [
      { name: "trip_id",  col_type: "text",    nullable: false, default_val: "" },
      { name: "item",     col_type: "text",    nullable: false, default_val: "" },
      { name: "category", col_type: "text",    nullable: false, default_val: "general" },
      { name: "packed",   col_type: "integer", nullable: false, default_val: "0" },
    ],
  },
  {
    key: EXPENSES, title: "Trip Expenses", description: "Trip costs, keyed by trip.",
    schema: [
      { name: "trip_id",     col_type: "text", nullable: false, default_val: "" },
      { name: "description", col_type: "text", nullable: false, default_val: "" },
      { name: "amount",      col_type: "real", nullable: false, default_val: "0" },
      { name: "category",    col_type: "text", nullable: false, default_val: "other" },
      { name: "date",        col_type: "text", nullable: false, default_val: "" },
    ],
  },
];

declareTables(TABLES);

// A new row starts from the defaults its schema declares.
const DEFAULTS: Record<string, Record<string, unknown>> = Object.fromEntries(TABLES.map((t) => [
  t.key,
  Object.fromEntries(t.schema.map((c) => [c.name, c.col_type === "text" ? c.default_val : Number(c.default_val)])),
]));

// ----- Rows -----------------------------------------------------------------------------
type Row = Record<string, unknown> & { id: string };

const rows = (ctx: Ctx, name: string) => ctx.table<Record<string, unknown>>(name);

/** Write a row over what it held (a new one from the schema's defaults), stamped. */
async function keep(ctx: Ctx, name: string, id: string | null, values: Record<string, unknown>): Promise<Row> {
  const was = id ? await rows(ctx, name).get(id) : null;
  const now = Date.now();
  return await rows(ctx, name).upsert({
    ...(was ?? { ...DEFAULTS[name], _created_at: now }),
    ...values,
    ...(id ? { id } : {}),
    _modified_at: now,
  });
}

function cmp(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a ?? "").localeCompare(String(b ?? ""));
}

/** Order by these columns, each ascending; `-name` descends. */
function by(...cols: string[]) {
  return (a: Row, b: Row) => {
    for (const c of cols) {
      const [name, dir] = c.startsWith("-") ? [c.slice(1), -1] : [c, 1];
      const d = cmp(a[name], b[name]);
      if (d) return dir * d;
    }
    return 0;
  };
}

const ofTrip = async (ctx: Ctx, name: string, tripId: string) =>
  (await rows(ctx, name).all()).filter((r) => r.trip_id === tripId);

/** The slot after the last entry of one trip's day. */
async function nextSlot(ctx: Ctx, tripId: string, dayDate: string): Promise<number> {
  let best: unknown = null;
  for (const r of await ofTrip(ctx, ITINERARY, tripId)) {
    if (r.day_date !== dayDate || r.sort_order === null || r.sort_order === undefined) continue;
    if (best === null || cmp(r.sort_order, best) > 0) best = r.sort_order;
  }
  return Number(best ?? -1) + 1;
}

// ----- Helpers --------------------------------------------------------------------------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** ISO day string or "" — bad dates degrade to unscheduled, never to garbage. */
function cleanDate(v: unknown): string {
  const s = sanitizeText(v, 10);
  return DATE_RE.test(s) ? s : "";
}

/** Positive amount rounded to cents, or null when unparseable. */
function cleanAmount(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

// What changed, never what it holds: each page reads again as whoever it is.
const tell = (ctx: Ctx) => ctx.push({ trip_planner: "trips" });

const json = (v: unknown, status = 200) => Response.json(v, { status });

// deno-lint-ignore no-explicit-any
async function body(request: Request): Promise<Record<string, any> | null> {
  try {
    const v = JSON.parse(await request.text());
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

// ----- Geocoding ------------------------------------------------------------------------
// Stops are written as free text ("Emerald Bay", "Pine Lodge"), so putting them on a map
// means one lookup per distinct string. Nominatim's usage policy is the constraint that
// shapes this code: it asks for an identifying User-Agent, at most one request per second,
// and no bulk use. So lookups are SERIALIZED through a single promise chain, spaced, and
// cached permanently in the row (`geo_q`) — a trip's handful of stops is looked up once
// each, ever, and editing a stop is the only thing that spends another request.
// Failure is never fatal: no coordinates just means no pin, and the itinerary still works.
const GEO_HOST = "https://nominatim.openstreetmap.org";
const GEO_UA = "Seamside Trip Planner frame (https://seamside.com; CC0 catalog frame)";
let geoChain: Promise<unknown> = Promise.resolve();
let geoLastMs = 0;

/** Look up one place string. Returns [lat, lon], or [0, 0] when nothing matched. */
function geocode(q: string): Promise<[number, number]> {
  const run = async (): Promise<[number, number]> => {
    const wait = 1100 - (Date.now() - geoLastMs);   // >= 1 req/sec, per their policy
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    geoLastMs = Date.now();
    try {
      const url = `${GEO_HOST}/search?q=${encodeURIComponent(q)}&format=json&limit=1`;
      const res = await fetch(url, { headers: { "User-Agent": GEO_UA, "Accept": "application/json" } });
      if (!res.ok) return [0, 0];
      const hits = await res.json();
      if (!Array.isArray(hits) || hits.length === 0) return [0, 0];
      const lat = Number(hits[0]?.lat), lon = Number(hits[0]?.lon);
      return Number.isFinite(lat) && Number.isFinite(lon) ? [lat, lon] : [0, 0];
    } catch {
      return [0, 0];   // offline, blocked, rate-limited: the stop simply has no pin
    }
  };
  const next = geoChain.then(run, run);
  geoChain = next.catch(() => {});
  return next as Promise<[number, number]>;
}

/** Geocode a stop in the background and push when it lands. Never awaited by a write:
 * a slow lookup must not hold up saving the itinerary entry. `ctx` names its session,
 * so it still acts for it after the request is answered.
 *
 * `near` is the trip's destination, and it is what makes this useful rather than
 * surreal. A stop is named the way you'd say it out loud to someone already on the
 * trip — "Emerald Bay", "Pine Lodge" — and those names repeat all over the world, so a
 * bare lookup cheerfully returns the Emerald Bay in India. Asking within the trip's
 * destination first is the difference between a map of your holiday and a map of the
 * planet. If that finds nothing, we fall back to the bare name, because a trip can
 * legitimately include a stop far from its headline destination. */
function geocodeSoon(ctx: Ctx, rowId: string, location: string, near: string): void {
  const q = location.trim();
  if (!q) return;
  const scoped = near.trim() && !q.toLowerCase().includes(near.trim().toLowerCase())
    ? `${q}, ${near.trim()}`
    : q;
  (async () => {
    let [lat, lon] = await geocode(scoped);
    if (!lat && !lon && scoped !== q) [lat, lon] = await geocode(q);
    const row = await rows(ctx, ITINERARY).get(rowId);
    if (!row || String(row.location ?? "").trim() !== q) return;   // edited while we waited
    await keep(ctx, ITINERARY, rowId, { lat, lon, geo_q: q });
    tell(ctx);
  })().catch(() => {});
}

// ----- Map tiles ------------------------------------------------------------------------
// OpenFreeMap is free and unmetered, but every viewer's pan and zoom costs it requests, so
// what this worker fetched is kept a while in memory (shared by every space and viewer).
const TILE_HOST = "https://tiles.openfreemap.org/";
const TILE_TTL_MS = 6 * 60 * 60 * 1000;
const TILE_CACHE_MAX = 600;
const tileCache = new Map<string, { at: number; status: number; type: string; bytes: Uint8Array<ArrayBuffer> }>();

const tileReply = (status: number, bytes: Uint8Array<ArrayBuffer>, type: string) =>
  new Response(bytes, { status, headers: { "content-type": type, "cache-control": "private, max-age=3600" } });

/** `search` is the request's own query, "?" included, or "". */
async function serveTile(path: string, search: string): Promise<Response> {
  if (!/^[A-Za-z0-9_.@{}\-\/ %,]+$/.test(path) || path.includes("..")) {
    return new Response("bad path", { status: 400, headers: { "content-type": "text/plain" } });
  }
  const key = path + search;
  const hit = tileCache.get(key);
  if (hit && Date.now() - hit.at < TILE_TTL_MS) return tileReply(hit.status, hit.bytes, hit.type);
  try {
    const res = await fetch(TILE_HOST + key, { headers: { "User-Agent": GEO_UA } });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const type = res.headers.get("content-type") ?? "application/octet-stream";
    // A tile past the data's edge is an honest 404 (maplibre draws nothing there); keep it too.
    if (res.ok || res.status === 404) {
      if (tileCache.size >= TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value!);
      tileCache.set(key, { at: Date.now(), status: res.status, type, bytes });
    }
    return tileReply(res.status, bytes, type);
  } catch {
    return new Response("map tiles unreachable", { status: 502, headers: { "content-type": "text/plain" } });
  }
}

// ----- Queries --------------------------------------------------------------------------
async function tripsList(ctx: Ctx) {
  const trips = (await rows(ctx, TRIPS).all()).sort(by("-start_date", "-created_ms"));
  const it = await rows(ctx, ITINERARY).all();
  const pack = await rows(ctx, PACKING).all();
  const exp = await rows(ctx, EXPENSES).all();

  const days = new Map<string, Set<string>>();
  for (const r of it) {
    if (!r.day_date) continue;
    let s = days.get(r.trip_id as string);
    if (!s) { s = new Set(); days.set(r.trip_id as string, s); }
    s.add(r.day_date as string);
  }
  const packed = new Map<string, { packed: number; total: number }>();
  for (const r of pack) {
    let p = packed.get(r.trip_id as string);
    if (!p) { p = { packed: 0, total: 0 }; packed.set(r.trip_id as string, p); }
    p.total++;
    if (Number(r.packed)) p.packed++;
  }
  const totals = new Map<string, number>();
  for (const r of exp) {
    totals.set(r.trip_id as string, (totals.get(r.trip_id as string) ?? 0) + Number(r.amount));
  }

  return trips.map((r) => ({
    id: r.id, name: r.name, destination: r.destination,
    start_date: r.start_date, end_date: r.end_date,
    days: days.get(r.id)?.size ?? 0,
    packed: packed.get(r.id)?.packed ?? 0,
    pack_total: packed.get(r.id)?.total ?? 0,
    expense_total: Math.round((totals.get(r.id) ?? 0) * 100) / 100,
  }));
}

async function tripDetail(ctx: Ctx, id: string) {
  const trip = await rows(ctx, TRIPS).get(id);
  if (!trip) return null;
  const it = (await ofTrip(ctx, ITINERARY, id)).sort(by("day_date", "sort_order", "_created_at"));
  const pack = (await ofTrip(ctx, PACKING, id)).sort(by("category", "item"));
  const exp = (await ofTrip(ctx, EXPENSES, id)).sort(by("date", "_created_at"));
  const total = Math.round(exp.reduce((n, r) => n + Number(r.amount), 0) * 100) / 100;
  return {
    trip: {
      id: trip.id, name: trip.name, destination: trip.destination,
      start_date: trip.start_date, end_date: trip.end_date, notes: trip.notes,
    },
    itinerary: it.map((r) => ({
      id: r.id, day_date: r.day_date, time: r.time,
      activity: r.activity, location: r.location, sort_order: r.sort_order,
      lat: Number(r.lat) || 0, lon: Number(r.lon) || 0,
    })),
    packing: pack.map((r) => ({
      id: r.id, item: r.item, category: r.category, packed: Number(r.packed) ? 1 : 0,
    })),
    expenses: exp.map((r) => ({
      id: r.id, description: r.description, amount: r.amount,
      category: r.category, date: r.date,
    })),
    total,
  };
}

// ----- Writes ---------------------------------------------------------------------------
// `op` is the API path with the leading "/api/" stripped; `v` is the parsed payload.
// deno-lint-ignore no-explicit-any
async function write(ctx: Ctx, op: string, v: Record<string, any> | null): Promise<Response> {
  // Every op below mutates state and is editor-only. Non-members AND Viewer-role
  // members are rejected with the same gate.
  if (!(ctx.peer.is_sfi_editor || ctx.peer.is_owner)) return json({ error: "editors only" }, 403);

  const ok = () => {
    tell(ctx);
    return json({ ok: true });
  };
  const tripId = typeof v?.trip_id === "string" ? v.trip_id : "";
  const isTrip = async (id: string) => !!id && !!(await rows(ctx, TRIPS).get(id));

  // --- Trips ----------------------------------------------------------------------------
  if (op === "trip") {
    const name = sanitizeText(v?.name, 120);
    if (!name) return json({ error: "name required" }, 400);
    await keep(ctx, TRIPS, null, {
      name,
      destination: sanitizeText(v?.destination, 120),
      start_date: cleanDate(v?.start_date),
      end_date: cleanDate(v?.end_date),
      notes: sanitizeText(v?.notes, 2000),
      created_ms: Date.now(),
    });
    return ok();
  }

  if (op.startsWith("trip/")) {
    const [id, action] = op.slice("trip/".length).split("/");
    if (!(await isTrip(id))) return json({ error: "bad id" }, 400);
    if (action === "delete") {
      for (const t of [ITINERARY, PACKING, EXPENSES]) {
        for (const r of await ofTrip(ctx, t, id)) await rows(ctx, t).delete(r.id);
      }
      await rows(ctx, TRIPS).delete(id);
      return ok();
    }
    if (action) return json({ error: "not found" }, 404);
    const patch: Record<string, unknown> = {};
    if (v?.name !== undefined) {
      const name = sanitizeText(v.name, 120);
      if (name) patch.name = name;
    }
    if (v?.destination !== undefined) patch.destination = sanitizeText(v.destination, 120);
    if (v?.start_date !== undefined) patch.start_date = cleanDate(v.start_date);
    if (v?.end_date !== undefined) patch.end_date = cleanDate(v.end_date);
    if (v?.notes !== undefined) patch.notes = sanitizeText(v.notes, 2000);
    if (Object.keys(patch).length) await keep(ctx, TRIPS, id, patch);
    return ok();
  }

  // --- Itinerary ------------------------------------------------------------------------
  if (op === "it") {
    if (!(await isTrip(tripId))) return json({ error: "bad trip" }, 400);
    const activity = sanitizeText(v?.activity, 200);
    if (!activity) return json({ error: "activity required" }, 400);
    const dayDate = cleanDate(v?.day_date);
    const location = sanitizeText(v?.location, 120);
    const row = await keep(ctx, ITINERARY, null, {
      trip_id: tripId, day_date: dayDate,
      time: sanitizeText(v?.time, 24), activity,
      location, sort_order: await nextSlot(ctx, tripId, dayDate),
    });
    if (location) {
      const trip = await rows(ctx, TRIPS).get(tripId);
      geocodeSoon(ctx, row.id, location, String(trip?.destination ?? ""));
    }
    return ok();
  }

  // Reorder within one day — carries that day's full ordered id list after the drop.
  if (op === "it/reorder") {
    if (!(await isTrip(tripId))) return json({ error: "bad trip" }, 400);
    const dayDate = cleanDate(v?.day_date);
    const ids = Array.isArray(v?.ids) ? v.ids.filter((x: unknown): x is string => typeof x === "string" && !!x) : [];
    // Only touch ids that actually live in this trip+day (never phantom-create).
    const known = new Set((await ofTrip(ctx, ITINERARY, tripId)).filter((r) => r.day_date === dayDate).map((r) => r.id));
    for (let i = 0; i < ids.length; i++) {
      if (known.has(ids[i])) await keep(ctx, ITINERARY, ids[i], { sort_order: i });
    }
    return ok();
  }

  if (op.startsWith("it/")) {
    const [id, action] = op.slice("it/".length).split("/");
    const row = id ? await rows(ctx, ITINERARY).get(id) : null;
    if (!row) return json({ error: "bad id" }, 400);
    if (action === "delete") {
      await rows(ctx, ITINERARY).delete(id);
      return ok();
    }
    if (action) return json({ error: "not found" }, 404);
    const patch: Record<string, unknown> = {};
    if (v?.day_date !== undefined) {
      // Moving to another day re-slots the entry at that day's end.
      const dayDate = cleanDate(v.day_date);
      if (dayDate !== row.day_date) {
        patch.day_date = dayDate;
        patch.sort_order = await nextSlot(ctx, String(row.trip_id ?? ""), dayDate);
      }
    }
    if (v?.time !== undefined) patch.time = sanitizeText(v.time, 24);
    if (v?.activity !== undefined) {
      const activity = sanitizeText(v.activity, 200);
      if (activity) patch.activity = activity;
    }
    let lookup = "";
    if (v?.location !== undefined) {
      const location = sanitizeText(v.location, 120);
      patch.location = location;
      // Only spend a lookup when the place actually changed. Clearing it clears the pin.
      if (!location) Object.assign(patch, { lat: 0, lon: 0, geo_q: "" });
      else if (String(row.geo_q ?? "") !== location) lookup = location;
    }
    if (Object.keys(patch).length) await keep(ctx, ITINERARY, id, patch);
    if (lookup) {
      const trip = await rows(ctx, TRIPS).get(String(row.trip_id ?? ""));
      geocodeSoon(ctx, id, lookup, String(trip?.destination ?? ""));
    }
    return ok();
  }

  // --- Packing --------------------------------------------------------------------------
  if (op === "pack") {
    if (!(await isTrip(tripId))) return json({ error: "bad trip" }, 400);
    const item = sanitizeText(v?.item, 120);
    if (!item) return json({ error: "item required" }, 400);
    await keep(ctx, PACKING, null, {
      trip_id: tripId, item,
      category: sanitizeText(v?.category, 40) || "general", packed: 0,
    });
    return ok();
  }

  if (op.startsWith("pack/")) {
    const [id, action] = op.slice("pack/".length).split("/");
    if (!id || !(await rows(ctx, PACKING).get(id))) return json({ error: "bad id" }, 400);
    if (action === "delete") {
      await rows(ctx, PACKING).delete(id);
      return ok();
    }
    if (action) return json({ error: "not found" }, 404);
    const patch: Record<string, unknown> = {};
    if (v?.item !== undefined) {
      const item = sanitizeText(v.item, 120);
      if (item) patch.item = item;
    }
    if (v?.category !== undefined) patch.category = sanitizeText(v.category, 40) || "general";
    if (v?.packed !== undefined) patch.packed = Number(v.packed) ? 1 : 0;
    if (Object.keys(patch).length) await keep(ctx, PACKING, id, patch);
    return ok();
  }

  // --- Expenses -------------------------------------------------------------------------
  if (op === "exp") {
    if (!(await isTrip(tripId))) return json({ error: "bad trip" }, 400);
    const description = sanitizeText(v?.description, 200);
    if (!description) return json({ error: "description required" }, 400);
    const amount = cleanAmount(v?.amount);
    if (amount === null) return json({ error: "bad amount" }, 400);
    await keep(ctx, EXPENSES, null, {
      trip_id: tripId, description, amount,
      category: sanitizeText(v?.category, 40) || "other", date: cleanDate(v?.date),
    });
    return ok();
  }

  if (op.startsWith("exp/")) {
    const [id, action] = op.slice("exp/".length).split("/");
    if (!id || !(await rows(ctx, EXPENSES).get(id))) return json({ error: "bad id" }, 400);
    if (action === "delete") {
      await rows(ctx, EXPENSES).delete(id);
      return ok();
    }
    if (action) return json({ error: "not found" }, 404);
    const patch: Record<string, unknown> = {};
    if (v?.description !== undefined) {
      const description = sanitizeText(v.description, 200);
      if (description) patch.description = description;
    }
    if (v?.amount !== undefined) {
      const amount = cleanAmount(v.amount);
      if (amount !== null) patch.amount = amount;
    }
    if (v?.category !== undefined) patch.category = sanitizeText(v.category, 40) || "other";
    if (v?.date !== undefined) patch.date = cleanDate(v.date);
    if (Object.keys(patch).length) await keep(ctx, EXPENSES, id, patch);
    return ok();
  }

  return json({ error: "not found" }, 404);
}

// ----- Networking -----------------------------------------------------------------------
export default {
  async fetch(request: Request, ctx: Ctx): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const editor = ctx.peer.is_sfi_editor || ctx.peer.is_owner;
    const member = editor || ctx.peer.is_sfi_member;

    // The map's tiles, style, glyphs and sprites, fetched here for the page (which has no
    // network). The page asks for every tiles.openfreemap.org URL as /tiles/<same path>.
    if (request.method === "GET" && pathname.startsWith("/tiles/")) {
      return serveTile(pathname.slice("/tiles/".length), url.search);
    }

    // Static assets — open to everyone, including anon read-only viewers.
    if (request.method === "GET" && !pathname.startsWith("/api/")) return ctx.file(pathname);

    // Identity probe — drives which render mode the page shows.
    if (pathname === "/api/whoami" && request.method === "GET") {
      return json({
        is_anon:       ctx.peer.is_anon,
        is_sfi_member: member,
        is_sfi_editor: editor,
        is_owner:      ctx.peer.is_owner,
        user_id:       ctx.peer.user_id,
        user_name:     ctx.peer.user_name,
        space_color:   ctx.peer.space_color,
      });
    }

    if (pathname.startsWith("/api/") && (request.method === "POST" || request.method === "PUT")) {
      return write(ctx, pathname.slice("/api/".length), await body(request));
    }

    // Reads — open to everyone (non-members get a read-only view of the space's trips).
    // No seeding, on purpose: a fresh space is an honest empty state, and a GET never
    // mutates.
    if (pathname === "/api/trips" && request.method === "GET") {
      return json({ trips: await tripsList(ctx) });
    }

    if (pathname === "/api/trip" && request.method === "GET") {
      const id = url.searchParams.get("id") ?? "";
      if (!id) return json({ error: "id required" }, 400);
      const detail = await tripDetail(ctx, id);
      if (!detail) return json({ error: "not found" }, 404);
      return json(detail);
    }

    return json({ error: "not found" }, 404);
  },
};
