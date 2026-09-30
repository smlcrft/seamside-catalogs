// ----------------------------------------------------------------------------------------
// Space Radio — synced, shared web radio player for everyone in a space.
//
// Auth model: reads are open to every viewer who reaches the frame — whether a
// non-member can reach it at all is the platform's call (the space's tier, publishing
// the frame), never the frame's. A visitor gets a listen-along view: they see and
// hear what the space is playing but cannot touch the dial. Writes are editor-only,
// because the experience only makes sense for the group of people sitting in the space.
//
// Shared state per session: { station_id, playing, updated_by_name, updated_at }, the
// session's own `playstate` key. Any editor can flip it; every change pushes
// `{ space_radio: "playstate" }` so every open page reads again and the audio elements
// stay in lockstep.
//
// Per-user state (volume / mute) is kept in the browser (seamside.prefs) — it never
// travels through the backend and is not synced across viewers.
// ----------------------------------------------------------------------------------------
import type { Ctx } from "@frame-core";
import { sanitizeText } from "@frame-core";

// ----------------------------------------------------------------------------------------
// STATION CATALOG — embedded directly so a frame update can extend the list without any
// per-space state migration. `genre` and `country` are display hints only; the `id`
// is the wire identifier so renaming a station's display name is non-breaking.
// ----------------------------------------------------------------------------------------
type Station = {
  id: string;
  name: string;
  genre: string;
  country: string;
  url: string;
};

const STATIONS: Station[] = [
  // ----- Ambient / Background -----
  { id: "somafm-groovesalad",    name: "SomaFM — Groove Salad",          genre: "Ambient & Background", country: "US", url: "https://ice1.somafm.com/groovesalad-128-mp3" },
  { id: "somafm-dronezone",      name: "SomaFM — Drone Zone",            genre: "Ambient & Background", country: "US", url: "https://ice1.somafm.com/dronezone-128-mp3" },
  { id: "somafm-deepspaceone",   name: "SomaFM — Deep Space One",        genre: "Ambient & Background", country: "US", url: "https://ice1.somafm.com/deepspaceone-128-mp3" },
  { id: "somafm-spacestation",   name: "SomaFM — Space Station Soma",    genre: "Ambient & Background", country: "US", url: "https://ice1.somafm.com/spacestation-128-mp3" },
  { id: "somafm-missioncontrol", name: "SomaFM — Mission Control",       genre: "Ambient & Background", country: "US", url: "https://ice1.somafm.com/missioncontrol-128-mp3" },
  { id: "somafm-synphaera",      name: "SomaFM — Synphaera Radio",       genre: "Ambient & Background", country: "US", url: "https://ice1.somafm.com/synphaera-128-mp3" },
  { id: "somafm-beatblender",    name: "SomaFM — Beat Blender",          genre: "Ambient & Background", country: "US", url: "https://ice1.somafm.com/beatblender-128-mp3" },
  { id: "somafm-cliqhop",        name: "SomaFM — cliqhop idm",           genre: "Ambient & Background", country: "US", url: "https://ice1.somafm.com/cliqhop-128-mp3" },
  { id: "somafm-suburbsofgoa",   name: "SomaFM — Suburbs of Goa",        genre: "Ambient & Background", country: "US", url: "https://ice1.somafm.com/suburbsofgoa-128-mp3" },
  { id: "somafm-lush",           name: "SomaFM — Lush",                  genre: "Ambient & Background", country: "US", url: "https://ice1.somafm.com/lush-128-mp3" },
  { id: "somafm-thetrip",        name: "SomaFM — The Trip",              genre: "Ambient & Background", country: "US", url: "https://ice1.somafm.com/thetrip-128-mp3" },
  { id: "kcrw-eclectic24",       name: "KCRW Eclectic 24",               genre: "Ambient & Background", country: "US", url: "https://kcrw.streamguys1.com/kcrw_192k_mp3_e24" },
  { id: "rp-mellow",             name: "Radio Paradise — Mellow Mix",    genre: "Ambient & Background", country: "US", url: "https://stream.radioparadise.com/mellow-128" },

  // ----- Indie / Pop -----
  { id: "somafm-indiepop",       name: "SomaFM — Indie Pop Rocks!",      genre: "Indie & Pop",          country: "US", url: "https://ice1.somafm.com/indiepop-128-mp3" },
  { id: "somafm-poptron",        name: "SomaFM — PopTron (electropop)",  genre: "Indie & Pop",          country: "US", url: "https://ice1.somafm.com/poptron-128-mp3" },
  { id: "somafm-bagel",          name: "SomaFM — Bagel Radio",           genre: "Indie & Pop",          country: "US", url: "https://ice1.somafm.com/bagel-128-mp3" },
  { id: "kexp",                  name: "KEXP Seattle",                   genre: "Indie & Pop",          country: "US", url: "https://kexp-mp3-128.streamguys1.com/kexp128.mp3" },
  { id: "wfmu-freeform",         name: "WFMU Freeform",                  genre: "Indie & Pop",          country: "US", url: "https://stream0.wfmu.org/freeform-128k.mp3" },
  { id: "wfmu-ichiban",          name: "WFMU Rock 'n' Soul Ichiban",     genre: "Indie & Pop",          country: "US", url: "https://stream0.wfmu.org/ichiban-128k.mp3" },
  { id: "thecurrent",            name: "The Current (MPR)",              genre: "Indie & Pop",          country: "US", url: "https://current.stream.publicradio.org/current.mp3" },

  // ----- Rock / Classic / Americana -----
  { id: "rp-main",               name: "Radio Paradise — Main Mix",      genre: "Rock & Classic",       country: "US", url: "https://stream.radioparadise.com/aac-128" },
  { id: "rp-rock",               name: "Radio Paradise — Rock Mix",      genre: "Rock & Classic",       country: "US", url: "https://stream.radioparadise.com/rock-128" },
  { id: "somafm-u80s",           name: "SomaFM — Underground 80s",       genre: "Rock & Classic",       country: "US", url: "https://ice1.somafm.com/u80s-128-mp3" },
  { id: "somafm-seventies",      name: "SomaFM — Left Coast 70s",        genre: "Rock & Classic",       country: "US", url: "https://ice1.somafm.com/seventies-128-mp3" },
  { id: "somafm-bootliquor",     name: "SomaFM — Boot Liquor (Americana)", genre: "Rock & Classic",     country: "US", url: "https://ice1.somafm.com/bootliquor-128-mp3" },
  { id: "somafm-folkfwd",        name: "SomaFM — Folk Forward",          genre: "Rock & Classic",       country: "US", url: "https://ice1.somafm.com/folkfwd-128-mp3" },
  { id: "somafm-reggae",         name: "SomaFM — Heavyweight Reggae",    genre: "Rock & Classic",       country: "US", url: "https://ice1.somafm.com/reggae-128-mp3" },
  { id: "somafm-metaldetektor",  name: "SomaFM — Metal Detektor",        genre: "Rock & Classic",       country: "US", url: "https://ice1.somafm.com/metal-128-mp3" },

  // ----- Jazz -----
  { id: "wbgo",                  name: "WBGO Jazz 88.3 (Newark)",        genre: "Jazz",                 country: "US", url: "https://wbgo.streamguys1.com/wbgo128" },
  { id: "kcsm",                  name: "KCSM Jazz 91",                   genre: "Jazz",                 country: "US", url: "https://ice5.securenetsystems.net/KCSM" },
  { id: "somafm-sonicuniverse",  name: "SomaFM — Sonic Universe (jazz)", genre: "Jazz",                 country: "US", url: "https://ice1.somafm.com/sonicuniverse-128-mp3" },
  { id: "somafm-7soul",          name: "SomaFM — 7soul (rare grooves)",  genre: "Jazz",                 country: "US", url: "https://ice1.somafm.com/7soul-128-mp3" },
  { id: "swiss-jazz",            name: "Radio Swiss Jazz",               genre: "Jazz",                 country: "CH", url: "https://stream.srg-ssr.ch/m/rsj/mp3_128" },
  { id: "abc-jazz",              name: "ABC Jazz",                       genre: "Jazz",                 country: "AU", url: "https://live-radio01.mediahubaustralia.com/PJZW/mp3/" },

  // ----- Chiptune / Synthwave / Retro -----
  { id: "nightride",             name: "Nightride FM (synthwave)",       genre: "Chiptune & Synthwave", country: "EU", url: "https://stream.nightride.fm/nightride.mp3" },
  { id: "datawave",              name: "Datawave (cyberpunk)",           genre: "Chiptune & Synthwave", country: "EU", url: "https://stream.nightride.fm/datawave.mp3" },
  { id: "spacesynth",            name: "Spacesynth",                     genre: "Chiptune & Synthwave", country: "EU", url: "https://stream.nightride.fm/spacesynth.mp3" },
  { id: "darksynth",             name: "Darksynth",                      genre: "Chiptune & Synthwave", country: "EU", url: "https://stream.nightride.fm/darksynth.mp3" },
  { id: "horrorsynth",           name: "Horrorsynth",                    genre: "Chiptune & Synthwave", country: "EU", url: "https://stream.nightride.fm/horrorsynth.mp3" },
  { id: "rainwave-chiptune",     name: "Rainwave — Chiptune",            genre: "Chiptune & Synthwave", country: "US", url: "https://relay0.us.rainwave.cc/chiptune.mp3" },
  { id: "rainwave-ocremix",      name: "Rainwave — OCRemix",             genre: "Chiptune & Synthwave", country: "US", url: "https://relay0.us.rainwave.cc/ocremix.mp3" },
  { id: "somafm-defcon",         name: "SomaFM — DEF CON Radio",         genre: "Chiptune & Synthwave", country: "US", url: "https://ice1.somafm.com/defcon-128-mp3" },
  { id: "somafm-vaporwaves",     name: "SomaFM — Vaporwaves",            genre: "Chiptune & Synthwave", country: "US", url: "https://ice1.somafm.com/vaporwaves-128-mp3" },

  // ----- French -----
  { id: "fip",                   name: "FIP",                            genre: "French",               country: "FR", url: "https://icecast.radiofrance.fr/fip-midfi.mp3" },
  { id: "fip-rock",              name: "FIP Rock",                       genre: "French",               country: "FR", url: "https://icecast.radiofrance.fr/fiprock-midfi.mp3" },
  { id: "fip-jazz",              name: "FIP Jazz",                       genre: "French",               country: "FR", url: "https://icecast.radiofrance.fr/fipjazz-midfi.mp3" },
  { id: "fip-groove",            name: "FIP Groove",                     genre: "French",               country: "FR", url: "https://icecast.radiofrance.fr/fipgroove-midfi.mp3" },
  { id: "fip-electro",           name: "FIP Electro",                    genre: "French",               country: "FR", url: "https://icecast.radiofrance.fr/fipelectro-midfi.mp3" },
  { id: "fip-pop",               name: "FIP Pop",                        genre: "French",               country: "FR", url: "https://icecast.radiofrance.fr/fippop-midfi.mp3" },
  { id: "fip-reggae",            name: "FIP Reggae",                     genre: "French",               country: "FR", url: "https://icecast.radiofrance.fr/fipreggae-midfi.mp3" },
  { id: "fip-world",             name: "FIP Monde",                      genre: "French",               country: "FR", url: "https://icecast.radiofrance.fr/fipworld-midfi.mp3" },
  { id: "fip-nouveautes",        name: "FIP Nouveautés",                 genre: "French",               country: "FR", url: "https://icecast.radiofrance.fr/fipnouveautes-midfi.mp3" },
  { id: "france-inter",          name: "France Inter",                   genre: "French",               country: "FR", url: "https://icecast.radiofrance.fr/franceinter-midfi.mp3" },
  { id: "france-musique",        name: "France Musique",                 genre: "French",               country: "FR", url: "https://icecast.radiofrance.fr/francemusique-midfi.mp3" },

  // ----- Italian -----
  { id: "rai-radio1",            name: "RAI Radio 1",                    genre: "Italian",              country: "IT", url: "https://icestreaming.rai.it/1.mp3" },
  { id: "rai-radio2",            name: "RAI Radio 2",                    genre: "Italian",              country: "IT", url: "https://icestreaming.rai.it/2.mp3" },
  { id: "rai-radio3",            name: "RAI Radio 3",                    genre: "Italian",              country: "IT", url: "https://icestreaming.rai.it/3.mp3" },
  { id: "rai-tuttaitaliana",     name: "RAI Radio Tutta Italiana",       genre: "Italian",              country: "IT", url: "https://icestreaming.rai.it/12.mp3" },
  { id: "rai-classica",          name: "RAI Radio Classica",             genre: "Italian",              country: "IT", url: "https://icestreaming.rai.it/5.mp3" },

  // ----- Spanish / Latin -----
  { id: "rne-radio3",            name: "Radio 3 (RNE, España)",          genre: "Spanish & Latin",      country: "ES", url: "https://crtvecanalplus.rtve.es/canalplus/r3.mp3" },
  { id: "los40",                 name: "LOS40 (España)",                 genre: "Spanish & Latin",      country: "ES", url: "https://19493.live.streamtheworld.com/LOS40.mp3" },
  { id: "cadena100",             name: "Cadena 100 (España)",            genre: "Spanish & Latin",      country: "ES", url: "https://playerservices.streamtheworld.com/api/livestream-redirect/CADENA100.mp3" },
  { id: "kane-fm",               name: "Cadena Dial (España)",           genre: "Spanish & Latin",      country: "ES", url: "https://playerservices.streamtheworld.com/api/livestream-redirect/CADENADIAL.mp3" },

  // ----- Mexican -----
  { id: "reactor-105",           name: "Reactor 105 (CDMX)",             genre: "Mexican",              country: "MX", url: "https://playerservices.streamtheworld.com/api/livestream-redirect/XHRED_FM.mp3" },
  { id: "alfa-919",              name: "Alfa 91.3 (CDMX)",               genre: "Mexican",              country: "MX", url: "https://playerservices.streamtheworld.com/api/livestream-redirect/XHFAJ_FM.mp3" },
  { id: "los40-mexico",          name: "LOS40 México",                   genre: "Mexican",              country: "MX", url: "https://playerservices.streamtheworld.com/api/livestream-redirect/XHMM_FM.mp3" },

  // ----- Australian -----
  { id: "abc-triplej",           name: "Triple J",                       genre: "Australian",           country: "AU", url: "https://live-radio01.mediahubaustralia.com/2TJW/mp3/" },
  { id: "abc-doublej",           name: "Double J",                       genre: "Australian",           country: "AU", url: "https://live-radio01.mediahubaustralia.com/DJDW/mp3/" },
  { id: "abc-unearthed",         name: "triple j Unearthed",             genre: "Australian",           country: "AU", url: "https://live-radio01.mediahubaustralia.com/UNEW/mp3/" },
  { id: "abc-classic",           name: "ABC Classic",                    genre: "Australian",           country: "AU", url: "https://live-radio01.mediahubaustralia.com/2FMW/mp3/" },
  { id: "abc-country",           name: "ABC Country",                    genre: "Australian",           country: "AU", url: "https://live-radio01.mediahubaustralia.com/CRWW/mp3/" },

  // ----- New Zealand -----
  { id: "rnz-national",          name: "RNZ National",                   genre: "New Zealand",          country: "NZ", url: "https://radio-streams.rnz.co.nz/national.mp3" },
  { id: "rnz-concert",           name: "RNZ Concert",                    genre: "New Zealand",          country: "NZ", url: "https://radio-streams.rnz.co.nz/concert.mp3" },

  // ----- NPR & Public Radio -----
  { id: "npr",                   name: "NPR Program Stream",             genre: "NPR & Public",         country: "US", url: "https://npr-ice.streamguys1.com/live.mp3" },
  { id: "wnyc-fm",               name: "WNYC FM 93.9",                   genre: "NPR & Public",         country: "US", url: "https://fm939.wnyc.org/wnycfm.mp3" },
  { id: "wnyc-am",               name: "WNYC AM 820",                    genre: "NPR & Public",         country: "US", url: "https://am820.wnyc.org/wnycam.mp3" },
  { id: "kqed",                  name: "KQED 88.5 (San Francisco)",      genre: "NPR & Public",         country: "US", url: "https://streams2.kqed.org/kqedradio" },
  { id: "wbur",                  name: "WBUR (Boston)",                  genre: "NPR & Public",         country: "US", url: "https://audio.wbur.org/stream/live_mp3" },

  // ----- World / Eclectic -----
  { id: "rp-world",              name: "Radio Paradise — World/Etc",     genre: "World & Eclectic",     country: "US", url: "https://stream.radioparadise.com/world-etc-128" },
  { id: "swiss-classic",         name: "Radio Swiss Classic",            genre: "World & Eclectic",     country: "CH", url: "https://stream.srg-ssr.ch/m/rsc_de/mp3_128" },
  { id: "swiss-pop",             name: "Radio Swiss Pop",                genre: "World & Eclectic",     country: "CH", url: "https://stream.srg-ssr.ch/m/rsp/mp3_128" },
  { id: "somafm-secretagent",    name: "SomaFM — Secret Agent",          genre: "World & Eclectic",     country: "US", url: "https://ice1.somafm.com/secretagent-128-mp3" },
  { id: "somafm-illstreet",      name: "SomaFM — Illinois Street Lounge", genre: "World & Eclectic",    country: "US", url: "https://ice1.somafm.com/illstreet-128-mp3" },
  { id: "somafm-fluid",          name: "SomaFM — Fluid",                 genre: "World & Eclectic",     country: "US", url: "https://ice1.somafm.com/fluid-128-mp3" },
];

const STATION_INDEX = new Set(STATIONS.map((s) => s.id));

// ----------------------------------------------------------------------------------------
// PER-SESSION STATE — the session's `playstate` key (ctx.kv): station + playing + who
// last changed it. Two radios in one space play apart.
// ----------------------------------------------------------------------------------------
type Playstate = {
  station_id: string | null;
  playing: boolean;
  updated_at: number;
  updated_by_name: string;
};
const DEFAULT_PLAYSTATE: Playstate = {
  station_id: null,
  playing: false,
  updated_at: 0,
  updated_by_name: "",
};

async function getPlaystate(ctx: Ctx): Promise<Playstate> {
  let r: Partial<Playstate> = {};
  try { const op = await ctx.kv.get("playstate"); if (op?.value) r = JSON.parse(op.value); } catch { /* unreadable → default */ }
  return {
    station_id: r.station_id ?? DEFAULT_PLAYSTATE.station_id,
    playing: r.playing ?? DEFAULT_PLAYSTATE.playing,
    updated_at: r.updated_at ?? DEFAULT_PLAYSTATE.updated_at,
    updated_by_name: r.updated_by_name ?? DEFAULT_PLAYSTATE.updated_by_name,
  };
}
async function setPlaystate(ctx: Ctx, next: Playstate): Promise<void> {
  await ctx.kv.put("playstate", JSON.stringify(next));
}

const isEditor = (ctx: Ctx) => ctx.peer.is_sfi_editor || ctx.peer.is_owner;

// ----------------------------------------------------------------------------------------
// MUTATION — set station and/or playing. Both fields are optional — omitted fields
// preserve the current value, so the UI can toggle just play/pause without re-sending the
// station id. An empty / null station_id explicitly clears the station and forces
// playing=false (you can't be "playing nothing").
// ----------------------------------------------------------------------------------------
type MutResult = { status: number; body: unknown };

async function mutSet(ctx: Ctx, v: { station_id?: unknown; playing?: unknown } | null): Promise<MutResult> {
  // Never gate writes on is_sfi_member — a Viewer-role member would slip through and be
  // able to change the station for everyone.
  if (!isEditor(ctx)) return { status: 403, body: { error: "editors only" } };
  const cur = await getPlaystate(ctx);

  let stationId: string | null = cur.station_id;
  if (Object.prototype.hasOwnProperty.call(v ?? {}, "station_id")) {
    const raw = v?.station_id;
    if (raw === null || raw === "") {
      stationId = null;
    } else {
      const sid = sanitizeText(raw, 80);
      if (!STATION_INDEX.has(sid)) return { status: 400, body: { error: "unknown station" } };
      stationId = sid;
    }
  }

  let playing = cur.playing;
  if (Object.prototype.hasOwnProperty.call(v ?? {}, "playing")) {
    playing = v?.playing === true;
  }
  if (!stationId) playing = false;

  const userName = sanitizeText(ctx.peer.user_name, 80) || "user";
  const next: Playstate = {
    station_id: stationId,
    playing,
    updated_at: Date.now(),
    updated_by_name: userName,
  };
  await setPlaystate(ctx, next);
  // What changed, never what it holds: each page reads again as whoever it is.
  ctx.push({ space_radio: "playstate" });
  return { status: 200, body: { ok: true, playstate: next } };
}

// ----------------------------------------------------------------------------------------
// HANDLER
// ----------------------------------------------------------------------------------------
const json = (v: unknown, status = 200) => Response.json(v, { status });

async function body(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const v = JSON.parse(await request.text());
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

export default {
  async fetch(request: Request, ctx: Ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    const method = request.method;
    const peer = ctx.peer;

    if (pathname === "/api/state" && method === "GET") {
      return json({
        stations: STATIONS,
        playstate: await getPlaystate(ctx),
        can_edit: isEditor(ctx),
        space_color: peer.space_color,
        me: { user_id: peer.user_id, user_name: peer.user_name, device_id: "" },
      });
    }

    if (pathname === "/api/set" && method === "POST") {
      const r = await mutSet(ctx, await body(request));
      return json(r.body, r.status);
    }

    // The UI shell and its files — served to everyone.
    if (method === "GET" && !pathname.startsWith("/api/")) return ctx.file(pathname);

    return json({ error: "Not found.", code: "NOT_FOUND" }, 404);
  },
};
