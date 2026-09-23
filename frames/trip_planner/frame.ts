// ----------------------------------------------------------------------------------------
// Trip Planner — itineraries, packing lists, and trip costs, one trip at a time.
//
// Design axes:
//   privacy:        privacy-public-view  — non-members get a live read-only view;
//                                           space editors get the interactive planner.
//                                           The read-only itinerary is the showcase: a
//                                           share link is the trip's handout.
//   data_storage:   the space's tables   — trips.table.jsonl plus trip_itinerary /
//                                           trip_packing / trip_expenses rows keyed by
//                                           trip_id, at the space's root: synced with it
//                                           and shared by every Trip Planner in the space.
//   view_realtime:  view-collaborative    — every mutation calls pushToInstance(sfi_id, …)
//                                           so every viewer refreshes live.
//
// The page has no network of its own, so the map's style, tiles, glyphs and sprites come
// through this worker from tiles.openfreemap.org (see /tiles/ below).
// ----------------------------------------------------------------------------------------
import {
  log, serveFileAtPath, jsonReply, parseJsonBody, parsePeerInfo, onUiMessage,
  pushToInstance, sanitizeText,
  declareTables, table,
} from "@frame-core";

// ----- The space's tables (named for the trip, so no other frame's rows land in them) -----
declareTables([
  {
    key: "trips", title: "Trips", description: "Trips planned in this space.",
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
    key: "trip_itinerary", title: "Trip Itinerary", description: "Itinerary entries, keyed by trip.",
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
    key: "trip_packing", title: "Trip Packing", description: "Packing list items, keyed by trip.",
    schema: [
      { name: "trip_id",  col_type: "text",    nullable: false, default_val: "" },
      { name: "item",     col_type: "text",    nullable: false, default_val: "" },
      { name: "category", col_type: "text",    nullable: false, default_val: "general" },
      { name: "packed",   col_type: "integer", nullable: false, default_val: "0" },
    ],
  },
  {
    key: "trip_expenses", title: "Trip Expenses", description: "Trip costs, keyed by trip.",
    schema: [
      { name: "trip_id",     col_type: "text", nullable: false, default_val: "" },
      { name: "description", col_type: "text", nullable: false, default_val: "" },
      { name: "amount",      col_type: "real", nullable: false, default_val: "0" },
      { name: "category",    col_type: "text", nullable: false, default_val: "other" },
      { name: "date",        col_type: "text", nullable: false, default_val: "" },
    ],
  },
]);

type Tbl = ReturnType<typeof table>;
type Peer = ReturnType<typeof parsePeerInfo>;


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

/** Geocode a stop in the background and push the refreshed trip when it lands. Never
 * awaited by a write: a slow lookup must not hold up saving the itinerary entry.
 *
 * `near` is the trip's destination, and it is what makes this useful rather than
 * surreal. A stop is named the way you'd say it out loud to someone already on the
 * trip — "Emerald Bay", "Pine Lodge" — and those names repeat all over the world, so a
 * bare lookup cheerfully returns the Emerald Bay in India. Asking within the trip's
 * destination first is the difference between a map of your holiday and a map of the
 * planet. If that finds nothing, we fall back to the bare name, because a trip can
 * legitimately include a stop far from its headline destination. */
function geocodeSoon(sfiId: string, rowId: string, location: string, itinerary: Tbl, near: string): void {
  const q = location.trim();
  if (!q) return;
  const scoped = near.trim() && !q.toLowerCase().includes(near.trim().toLowerCase())
    ? `${q}, ${near.trim()}`
    : q;
  (async () => {
    let [lat, lon] = await geocode(scoped);
    if (!lat && !lon && scoped !== q) [lat, lon] = await geocode(q);
    const row = await itinerary.get(rowId);
    if (!row || String(row.location ?? "").trim() !== q) return;   // edited while we waited
    await itinerary.upsert(rowId, { lat, lon, geo_q: q });
    notify(sfiId);
  })().catch(() => {});
}

// ----- Map tiles ------------------------------------------------------------------------
// OpenFreeMap is free and unmetered, but every viewer's pan and zoom costs it requests, so
// what this worker fetched is kept a while in memory (shared by every space and viewer).
const TILE_HOST = "https://tiles.openfreemap.org/";
const TILE_TTL_MS = 6 * 60 * 60 * 1000;
const TILE_CACHE_MAX = 600;
const tileCache = new Map<string, { at: number; status: number; type: string; bytes: Uint8Array }>();

async function serveTile(
  replyPort: { postMessage(m: { status: number; body?: Uint8Array | string; contentType?: string; headers?: Record<string, string> }): void },
  path: string, query: Record<string, string>,
): Promise<void> {
  if (!/^[A-Za-z0-9_.@{}\-\/ %,]+$/.test(path) || path.includes("..")) {
    return replyPort.postMessage({ status: 400, body: "bad path", contentType: "text/plain" });
  }
  const qs = new URLSearchParams(query).toString();
  const key = path + (qs ? "?" + qs : "");
  const hit = tileCache.get(key);
  if (hit && Date.now() - hit.at < TILE_TTL_MS) {
    return replyPort.postMessage({ status: hit.status, body: hit.bytes, contentType: hit.type, headers: { "Cache-Control": "private, max-age=3600" } });
  }
  try {
    const res = await fetch(TILE_HOST + key, { headers: { "User-Agent": GEO_UA } });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const type = res.headers.get("content-type") ?? "application/octet-stream";
    // A tile past the data's edge is an honest 404 (maplibre draws nothing there); keep it too.
    if (res.ok || res.status === 404) {
      if (tileCache.size >= TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value!);
      tileCache.set(key, { at: Date.now(), status: res.status, type, bytes });
    }
    replyPort.postMessage({ status: res.status, body: bytes, contentType: type, headers: { "Cache-Control": "private, max-age=3600" } });
  } catch {
    replyPort.postMessage({ status: 502, body: "map tiles unreachable", contentType: "text/plain" });
  }
}

function notify(sfiId: string) {
  pushToInstance(sfiId, { type: "trip_changed" });
}

function dataTables(sfiId: string) {
  return {
    trips: table("trips", sfiId),
    itinerary: table("trip_itinerary", sfiId),
    packing: table("trip_packing", sfiId),
    expenses: table("trip_expenses", sfiId),
  };
}

// ----- Queries --------------------------------------------------------------------------
async function tripsList(sfiId: string) {
  const t = dataTables(sfiId);
  const { rows: trips } = await t.trips.query({
    order_by: [{ col: "start_date", dir: "desc" }, { col: "created_ms", dir: "desc" }],
  });
  const { rows: it } = await t.itinerary.query({});
  const { rows: pack } = await t.packing.query({});
  const { rows: exp } = await t.expenses.query({});

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
    id: r._row_id, name: r.name, destination: r.destination,
    start_date: r.start_date, end_date: r.end_date,
    days: days.get(r._row_id)?.size ?? 0,
    packed: packed.get(r._row_id)?.packed ?? 0,
    pack_total: packed.get(r._row_id)?.total ?? 0,
    expense_total: Math.round((totals.get(r._row_id) ?? 0) * 100) / 100,
  }));
}

async function tripDetail(sfiId: string, id: string) {
  const t = dataTables(sfiId);
  const trip = await t.trips.get(id);
  if (!trip) return null;
  const { rows: it } = await t.itinerary.query({
    where: { trip_id: id },
    order_by: [{ col: "day_date" }, { col: "sort_order" }, { col: "_created_at" }],
  });
  const { rows: pack } = await t.packing.query({
    where: { trip_id: id },
    order_by: [{ col: "category" }, { col: "item" }],
  });
  const { rows: exp } = await t.expenses.query({
    where: { trip_id: id },
    order_by: [{ col: "date" }, { col: "_created_at" }],
  });
  const total = Math.round(exp.reduce((n, r) => n + Number(r.amount), 0) * 100) / 100;
  return {
    trip: {
      id: trip._row_id, name: trip.name, destination: trip.destination,
      start_date: trip.start_date, end_date: trip.end_date, notes: trip.notes,
    },
    itinerary: it.map((r) => ({
      id: r._row_id, day_date: r.day_date, time: r.time,
      activity: r.activity, location: r.location, sort_order: r.sort_order,
      lat: Number(r.lat) || 0, lon: Number(r.lon) || 0,
    })),
    packing: pack.map((r) => ({
      id: r._row_id, item: r.item, category: r.category, packed: Number(r.packed) ? 1 : 0,
    })),
    expenses: exp.map((r) => ({
      id: r._row_id, description: r.description, amount: r.amount,
      category: r.category, date: r.date,
    })),
    total,
  };
}

// ----- Writes ---------------------------------------------------------------------------
// One shared mutation path for BOTH transports: the bus dispatcher below (frame.busSend →
// onUiMessage, the primary write path) and the HTTP POST arm in onNetworkRequest (kept for
// older viewers whose framelib has no busSend). `op` is the API path with "api/" stripped;
// `v` is the parsed payload. Role gates live here so the two entry points can never drift.
type WriteResult = { status: number; body: unknown };

async function handleWrite(sfiId: string, op: string, v: Record<string, unknown> | null, peer: Peer): Promise<WriteResult> {
  const { trips, itinerary, packing, expenses } = dataTables(sfiId);

  // Every op below mutates state and is editor-only. Non-members AND Viewer-role
  // members are rejected with the same gate (never gate writes on is_sfi_member —
  // Viewer-role members would slip through).
  if (!peer.is_sfi_editor) return { status: 403, body: { error: "editors only" } };

  const ok = (): WriteResult => {
    notify(sfiId);
    return { status: 200, body: { ok: true } };
  };
  const tripId = typeof v?.trip_id === "string" ? v.trip_id : "";

  // --- Trips ----------------------------------------------------------------------------
  if (op === "trip") {
    const name = sanitizeText(v?.name, 120);
    if (!name) return { status: 400, body: { error: "name required" } };
    await trips.upsert(null, {
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
    if (!id || !(await trips.get(id))) return { status: 400, body: { error: "bad id" } };
    if (action === "delete") {
      await itinerary.deleteWhere({ trip_id: id });
      await packing.deleteWhere({ trip_id: id });
      await expenses.deleteWhere({ trip_id: id });
      await trips.delete(id);
      return ok();
    }
    if (action) return { status: 404, body: { error: "not found" } };
    if (v?.name !== undefined) {
      const name = sanitizeText(v.name, 120);
      if (name) await trips.upsert(id, { name });
    }
    if (v?.destination !== undefined) await trips.upsert(id, { destination: sanitizeText(v.destination, 120) });
    if (v?.start_date !== undefined) await trips.upsert(id, { start_date: cleanDate(v.start_date) });
    if (v?.end_date !== undefined) await trips.upsert(id, { end_date: cleanDate(v.end_date) });
    if (v?.notes !== undefined) await trips.upsert(id, { notes: sanitizeText(v.notes, 2000) });
    return ok();
  }

  // --- Itinerary ------------------------------------------------------------------------
  if (op === "it") {
    if (!tripId || !(await trips.get(tripId))) return { status: 400, body: { error: "bad trip" } };
    const activity = sanitizeText(v?.activity, 200);
    if (!activity) return { status: 400, body: { error: "activity required" } };
    const dayDate = cleanDate(v?.day_date);
    const sortOrder = Number(await itinerary.max("sort_order", { trip_id: tripId, day_date: dayDate }) ?? -1) + 1;
    const location = sanitizeText(v?.location, 120);
    const { row_id: rowId } = await itinerary.upsert(null, {
      trip_id: tripId, day_date: dayDate,
      time: sanitizeText(v?.time, 24), activity,
      location, sort_order: sortOrder,
    });
    if (location && rowId) {
      const trip = await trips.get(tripId);
      geocodeSoon(sfiId, String(rowId), location, itinerary, String(trip?.destination ?? ""));
    }
    return ok();
  }

  // Reorder within one day — carries that day's full ordered id list after the drop.
  if (op === "it/reorder") {
    if (!tripId || !(await trips.get(tripId))) return { status: 400, body: { error: "bad trip" } };
    const dayDate = cleanDate(v?.day_date);
    const ids = Array.isArray(v?.ids) ? v.ids.filter((x): x is string => typeof x === "string" && !!x) : [];
    // Only touch ids that actually live in this trip+day (never phantom-create).
    const { rows } = await itinerary.query({ where: { trip_id: tripId, day_date: dayDate } });
    const known = new Set(rows.map((r) => r._row_id));
    for (let i = 0; i < ids.length; i++) {
      if (known.has(ids[i])) await itinerary.upsert(ids[i], { sort_order: i });
    }
    return ok();
  }

  if (op.startsWith("it/")) {
    const [id, action] = op.slice("it/".length).split("/");
    if (!id || !(await itinerary.get(id))) return { status: 400, body: { error: "bad id" } };
    if (action === "delete") {
      await itinerary.delete(id);
      return ok();
    }
    if (action) return { status: 404, body: { error: "not found" } };
    if (v?.day_date !== undefined) {
      // Moving to another day re-slots the entry at that day's end.
      const row = await itinerary.get(id);
      const dayDate = cleanDate(v.day_date);
      if (row && dayDate !== row.day_date) {
        const sortOrder = Number(await itinerary.max("sort_order", { trip_id: row.trip_id, day_date: dayDate }) ?? -1) + 1;
        await itinerary.upsert(id, { day_date: dayDate, sort_order: sortOrder });
      }
    }
    if (v?.time !== undefined) await itinerary.upsert(id, { time: sanitizeText(v.time, 24) });
    if (v?.activity !== undefined) {
      const activity = sanitizeText(v.activity, 200);
      if (activity) await itinerary.upsert(id, { activity });
    }
    if (v?.location !== undefined) {
      const location = sanitizeText(v.location, 120);
      const prev = await itinerary.get(id);
      await itinerary.upsert(id, { location });
      // Only spend a lookup when the place actually changed. Clearing it clears the pin.
      if (!location) {
        await itinerary.upsert(id, { lat: 0, lon: 0, geo_q: "" });
      } else if (String(prev?.geo_q ?? "") !== location) {
        const trip = await trips.get(String(prev?.trip_id ?? ""));
        geocodeSoon(sfiId, id, location, itinerary, String(trip?.destination ?? ""));
      }
    }
    return ok();
  }

  // --- Packing --------------------------------------------------------------------------
  if (op === "pack") {
    if (!tripId || !(await trips.get(tripId))) return { status: 400, body: { error: "bad trip" } };
    const item = sanitizeText(v?.item, 120);
    if (!item) return { status: 400, body: { error: "item required" } };
    await packing.upsert(null, {
      trip_id: tripId, item,
      category: sanitizeText(v?.category, 40) || "general", packed: 0,
    });
    return ok();
  }

  if (op.startsWith("pack/")) {
    const [id, action] = op.slice("pack/".length).split("/");
    if (!id || !(await packing.get(id))) return { status: 400, body: { error: "bad id" } };
    if (action === "delete") {
      await packing.delete(id);
      return ok();
    }
    if (action) return { status: 404, body: { error: "not found" } };
    if (v?.item !== undefined) {
      const item = sanitizeText(v.item, 120);
      if (item) await packing.upsert(id, { item });
    }
    if (v?.category !== undefined) await packing.upsert(id, { category: sanitizeText(v.category, 40) || "general" });
    if (v?.packed !== undefined) await packing.upsert(id, { packed: Number(v.packed) ? 1 : 0 });
    return ok();
  }

  // --- Expenses -------------------------------------------------------------------------
  if (op === "exp") {
    if (!tripId || !(await trips.get(tripId))) return { status: 400, body: { error: "bad trip" } };
    const description = sanitizeText(v?.description, 200);
    if (!description) return { status: 400, body: { error: "description required" } };
    const amount = cleanAmount(v?.amount);
    if (amount === null) return { status: 400, body: { error: "bad amount" } };
    await expenses.upsert(null, {
      trip_id: tripId, description, amount,
      category: sanitizeText(v?.category, 40) || "other", date: cleanDate(v?.date),
    });
    return ok();
  }

  if (op.startsWith("exp/")) {
    const [id, action] = op.slice("exp/".length).split("/");
    if (!id || !(await expenses.get(id))) return { status: 400, body: { error: "bad id" } };
    if (action === "delete") {
      await expenses.delete(id);
      return ok();
    }
    if (action) return { status: 404, body: { error: "not found" } };
    if (v?.description !== undefined) {
      const description = sanitizeText(v.description, 200);
      if (description) await expenses.upsert(id, { description });
    }
    if (v?.amount !== undefined) {
      const amount = cleanAmount(v.amount);
      if (amount !== null) await expenses.upsert(id, { amount });
    }
    if (v?.category !== undefined) await expenses.upsert(id, { category: sanitizeText(v.category, 40) || "other" });
    if (v?.date !== undefined) await expenses.upsert(id, { date: cleanDate(v.date) });
    return ok();
  }

  return { status: 404, body: { error: "not found" } };
}

// ----- Bus dispatcher — the frontend's write path (frame.busSend → BusUiToFrame) --------
// `peer` is the sender's platform-resolved identity, same shape as parsePeerInfo; the
// role gates live inside handleWrite. Denials are logged, not answered — a legitimate
// client never sends a write it isn't allowed to make.
onUiMessage(async (sfiId, data, peer) => {
  if (!sfiId || typeof data !== "object" || data === null) return;
  const d = data as Record<string, unknown>;
  if (typeof d.op !== "string") return;
  const r = await handleWrite(sfiId, d.op, d, peer);
  if (r.status !== 200) log(`trip_planner: bus op ${d.op} → ${r.status} (${JSON.stringify(r.body)})`);
});

// ----- Networking -----------------------------------------------------------------------
self.onNetworkRequest = async function (replyPort, reqPath, method, headers, query, body, cookies) {
  const peer = parsePeerInfo(query, cookies);
  const sfiId = peer.sfi_id;

  // The map's tiles, style, glyphs and sprites, fetched here for the page (which has no
  // network). The page rewrites every tiles.openfreemap.org URL to /tiles/<same path>.
  if (method === "GET" && reqPath.startsWith("/tiles/")) {
    return serveTile(replyPort, reqPath.slice("/tiles/".length), query);
  }

  // Static assets — open to everyone, including anon read-only viewers.
  if (method === "GET" && !reqPath.startsWith("/api/")) {
    return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url), headers);
  }

  // Identity probe — drives which render mode the frontend shows.
  if (reqPath === "/api/whoami" && method === "GET") {
    return jsonReply(replyPort, 200, {
      is_anon:       peer.is_anon,
      is_sfi_member: peer.is_sfi_member,
      is_sfi_editor: peer.is_sfi_editor,
      is_owner:      peer.is_owner,
      user_id:       peer.user_id,
      user_name:     peer.user_name,
      space_color:   peer.space_color,
    });
  }

  // Writes — the HTTP arm of the shared write path (see handleWrite above).
  if (reqPath.startsWith("/api/") && (method === "POST" || method === "PUT")) {
    const r = await handleWrite(sfiId, reqPath.slice("/api/".length), parseJsonBody<Record<string, unknown>>(body), peer);
    return jsonReply(replyPort, r.status, r.body);
  }

  // Reads — open to everyone (non-members get a read-only view of the space's trips).
  // No seeding, on purpose: a fresh space is an honest empty state, and a GET never
  // mutates.
  if (reqPath === "/api/trips" && method === "GET") {
    return jsonReply(replyPort, 200, { trips: await tripsList(sfiId) });
  }

  if (reqPath === "/api/trip" && method === "GET") {
    const id = typeof query?.id === "string" ? query.id : "";
    if (!id) return jsonReply(replyPort, 400, { error: "id required" });
    const detail = await tripDetail(sfiId, id);
    if (!detail) return jsonReply(replyPort, 404, { error: "not found" });
    return jsonReply(replyPort, 200, detail);
  }

  return jsonReply(replyPort, 404, { error: "not found" });
};

log("Trip Planner frame is up and running!");
