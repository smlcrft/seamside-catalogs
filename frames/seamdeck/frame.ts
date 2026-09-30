// ============================================================================
// Seamdeck — WORKER (backend). Owns all shared state and exposes it over
// /api/*. Never renders UI, and knows NO game rules: each game's pure sim
// (see frame.sim.ts → public/games/*-sim.js) turns a submitted turn payload
// into authoritative { points, summary }.
//
// STORAGE: one worker, on the keeper's device, serves every session of the
// frame, and every player's requests reach it, so plain worker memory —
// keyed by ctx.frame, the session — is already shared state for all players.
// Sessions/seats/turns/beacons live in memory — ephemeral by design. High
// scores are the one thing that should outlive a restart: the
// `seamdeck_scores` table in the space's frame data (`_fdata/`), a row per
// score, one board per space.
// A live update is ctx.push({ seamdeck: "state" }): it carries nothing, and
// every open page reads /api/state again.
//
// Player identity: anonymous link viewers are first-class players, but they
// have no stable server-side id, so the player token is a client-generated
// `client_id` (UUID) the frontend persists per-device and sends on every request.
// It is a secret: nothing hands it out. Everyone else knows a player by their
// `player_id`, the first 16 hex of its SHA-256, which the page computes too.
// A visitor writes no row at the door, so every act is a route here.
// ============================================================================
import type { Ctx, FrameTableDecl, PeerInfo } from "@frame-core";
import { declareTables, sanitizeText } from "@frame-core";
import { SIMS } from "./frame.sim.ts";

// The round seed is drawn ONCE here and stored per session, so every client
// derives the identical course/target. This is the only randomness; sims are pure.
function drawSeed(): number {
  const u = new Uint32Array(1);
  crypto.getRandomValues(u);
  return u[0];
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
type Attempt = { points: number; summary: string; payload: unknown };
type Seat = {
  seat_no: number; display_name: string; initials: string | null; client_id: string; player_id: string;
  runs: { round_id: number; attempts: Attempt[] } | null;
  x: number | null; y: number | null; heading: number; note: string; // race beacon
};
type Session = {
  session_id: string; game_id: string; phase: "lobby" | "playing" | "results";
  round_id: number; turn_index: number; seed: number | null; deadline: number | null;
  started_at: number; seats: Seat[];
};

// Ephemeral: gone on worker restart, which is fine — games are one-more-go toys.
const sessionsByFrame: Record<string, Session[]> = {};
// Durable: the arcade high-score board is a table of the space's frame data.
const SCORES = "seamdeck_scores";
const SCORES_TABLE: FrameTableDecl & { schema: { name: string; col_type?: string; default_val?: string }[] } = {
  key: SCORES,
  title: "Seamdeck high scores",
  description: "The arcade board: each finished run's best, by game.",
  local: true,
  schema: [
    { name: "initials",  col_type: "text",    nullable: false, default_val: "???" },
    { name: "game_id",   col_type: "text",    nullable: false, default_val: "" },
    { name: "points",    col_type: "integer", nullable: false, default_val: "0" },
    { name: "scored_at", col_type: "integer", nullable: false, default_val: "0" },
    // the player's public id
    { name: "client_id", col_type: "text",    nullable: false, default_val: "" },
  ],
};
declareTables([SCORES_TABLE]);

type Score = {
  initials: string; game_id: string; points: number; scored_at: number; client_id: string;
  _created_at?: number; _modified_at?: number;
};
type ScoreRow = Score & { id: string };
const scores = (ctx: Ctx) => ctx.shared.table<Score>(SCORES);

// What a fresh row holds before anything is written over it.
const DEFAULTS: Record<string, unknown> = Object.fromEntries(
  SCORES_TABLE.schema.map((c) => [c.name, c.col_type === "integer" ? Number(c.default_val) : c.default_val]),
);

/** Write a score over what its row held (the defaults for a new one), stamped
 *  when it was made and when it changed. */
async function keep(ctx: Ctx, id: string | null, values: Partial<Score>) {
  const was = id ? await scores(ctx).get(id) : null;
  const now = Date.now();
  return await scores(ctx).upsert({
    ...(was ?? { ...DEFAULTS, _created_at: now }),
    ...values,
    ...(id ? { id } : {}),
    _modified_at: now,
  } as Score & { id?: string });
}

/** Every score, highest first. */
const byPoints = async (ctx: Ctx): Promise<ScoreRow[]> =>
  ((await scores(ctx).all()) as ScoreRow[]).sort((a, b) => Number(b.points) - Number(a.points));

// A client_id shaped like a public id is refused, so a public id never stands in for one.
const PUBLIC_ID = /^[0-9a-f]{16}$/;
// deno-lint-ignore no-explicit-any
function clientOf(b: any): string {
  const c = String(b?.client_id ?? "");
  return PUBLIC_ID.test(c) ? "" : c;
}
async function publicId(client_id: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(client_id)));
  return [...d.slice(0, 8)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function sessionsOf(frame: string): Session[] {
  return sessionsByFrame[frame] ?? (sessionsByFrame[frame] = []);
}
// Say only that something changed: each page reads the state again.
function pushState(ctx: Ctx) {
  ctx.push({ seamdeck: "state" });
}

function findSession(frame: string, session_id: string): Session | null {
  return sessionsOf(frame).find((s) => s.session_id === session_id) ?? null;
}
// A seat's attempts count only for the CURRENT round; older runs are stale.
function attemptsOf(seat: Seat, round_id: number): Attempt[] {
  return seat.runs && seat.runs.round_id === round_id ? seat.runs.attempts : [];
}
function bestAttempt(attempts: Attempt[]): Attempt | null {
  let best: Attempt | null = null;
  for (const a of attempts) if (!best || a.points > best.points) best = a;
  return best;
}
// deno-lint-ignore no-explicit-any
function playerName(body: any, peer: PeerInfo): string {
  return sanitizeText(body?.display_name || peer.user_name || "Player", 24) || "Player";
}

// Flip a session to results and record each seat's best attempt on the
// high-score board (global per game — sessions compete). "???" placeholders
// carry the player's public id until /api/initials fills them in.
async function finishSession(ctx: Ctx, session: Session) {
  session.phase = "results";
  for (const seat of session.seats) {
    const best = bestAttempt(attemptsOf(seat, session.round_id));
    if (best && best.points > 0) {
      await keep(ctx, null, {
        initials: seat.initials || "???", game_id: session.game_id,
        points: best.points, scored_at: Date.now(), client_id: seat.player_id,
      });
    }
  }
  // Prune: keep the 50 highest per game.
  const rows = (await byPoints(ctx)).filter((r) => r.game_id === session.game_id);
  for (const extra of rows.slice(50)) await scores(ctx).delete(extra.id);
}

// Stand `client_id` up from every seat they hold (normally at most one), then
// settle each affected session: empty → GC; playing turn-game → resolve to
// results (rotation can't survive a leaver); playing race → their finish is no
// longer required, so the race may now be complete.
async function standUpEverywhere(ctx: Ctx, client_id: string) {
  const sessions = sessionsOf(ctx.frame);
  for (const session of [...sessions]) {
    const idx = session.seats.findIndex((s) => s.client_id === client_id);
    if (idx === -1) continue;
    session.seats.splice(idx, 1);
    if (session.seats.length === 0) {
      sessions.splice(sessions.indexOf(session), 1);
      continue;
    }
    if (session.phase === "playing") {
      const sim = SIMS[session.game_id];
      if (!sim) continue;
      if (sim.mode === "turns") {
        await finishSession(ctx, session);
      } else if (session.seats.every((s) => attemptsOf(s, session.round_id).length > 0)) {
        await finishSession(ctx, session);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Writes — `POST /api/<op>`. Player identity is the body's client_id
// (anonymous link viewers are first-class players by design), so the per-op
// host/seat checks are the gates here.
// ---------------------------------------------------------------------------
type MutResult = { status: number; body: unknown };

// deno-lint-ignore no-explicit-any
async function handleWrite(ctx: Ctx, op: string, b: any): Promise<MutResult> {
  const { frame, peer } = ctx;
  // Open a NEW lobby for a game, seating the caller as host (seat 1). The
  // caller implicitly stands up from anywhere else — one seat per person.
  if (op === "create_session") {
    const game = String(b?.game_id ?? "");
    const client_id = clientOf(b);
    if (!game || !client_id) return { status: 400, body: { error: "game_id and client_id required" } };
    if (!SIMS[game]) return { status: 400, body: { error: "unknown game" } };
    if (sessionsOf(frame).length >= 12) return { status: 409, body: { error: "too many sessions" } };
    // A caller may name the session_id; one that omits it gets the minted id back.
    const requested = typeof b?.session_id === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(b.session_id)
      ? b.session_id : "";
    if (requested && findSession(frame, requested)) return { status: 409, body: { error: "session exists" } };
    await standUpEverywhere(ctx, client_id);
    const session: Session = {
      session_id: requested || crypto.randomUUID(), game_id: game, phase: "lobby",
      round_id: 0, turn_index: 0, seed: null, deadline: null, started_at: Date.now(),
      seats: [{
        seat_no: 1, display_name: playerName(b, peer), initials: null, client_id,
        player_id: await publicId(client_id), runs: null, x: null, y: null, heading: 0, note: "",
      }],
    };
    sessionsOf(frame).push(session);
    pushState(ctx);
    return { status: 200, body: { ok: true, session_id: session.session_id } };
  }

  // Claim a seat in a lobby (lowest free, or the requested one if open).
  if (op === "claim") {
    const client_id = clientOf(b);
    const session = findSession(frame, String(b?.session_id ?? ""));
    if (!client_id || !session) return { status: 400, body: { error: "client_id and session_id required" } };
    if (session.phase !== "lobby") return { status: 409, body: { error: "not in lobby" } };
    if (session.seats.some((s) => s.client_id === client_id)) return { status: 200, body: { ok: true, already: true } };
    if (session.seats.length >= 6) return { status: 409, body: { error: "lobby full" } };
    await standUpEverywhere(ctx, client_id); // can't GC this session — caller isn't in it
    const taken = new Set(session.seats.map((s) => s.seat_no));
    const requested = Number(b?.seat_no);
    let seat_no: number;
    if (Number.isInteger(requested) && requested >= 1 && requested <= 6 && !taken.has(requested)) {
      seat_no = requested;
    } else {
      seat_no = 1;
      while (taken.has(seat_no)) seat_no++;
    }
    session.seats.push({
      seat_no, display_name: playerName(b, peer), initials: null, client_id,
      player_id: await publicId(client_id), runs: null, x: null, y: null, heading: 0, note: "",
    });
    session.seats.sort((a, b2) => a.seat_no - b2.seat_no);
    pushState(ctx);
    return { status: 200, body: { ok: true, seat_no } };
  }

  // Stand up (from everywhere — a client holds at most one seat anyway).
  if (op === "leave") {
    const client_id = clientOf(b);
    if (!client_id) return { status: 400, body: { error: "client_id required" } };
    await standUpEverywhere(ctx, client_id);
    pushState(ctx);
    return { status: 200, body: { ok: true } };
  }

  // Start the round_id: host (lowest seat) only, lobby only. Bumps the round
  // (which makes every seat's previous runs stale), draws the shared seed;
  // race sessions get their force-resolve deadline.
  if (op === "start") {
    const client_id = clientOf(b);
    const session = findSession(frame, String(b?.session_id ?? ""));
    if (!session || session.phase !== "lobby") return { status: 409, body: { error: "not in lobby" } };
    if (!session.seats.length) return { status: 409, body: { error: "no players seated" } };
    if (session.seats[0].client_id !== client_id) return { status: 403, body: { error: "only the host can start" } };
    const sim = SIMS[session.game_id];
    session.phase = "playing";
    session.round_id += 1;
    session.turn_index = 0;
    session.seed = drawSeed();
    session.deadline = sim && sim.mode === "race" ? Date.now() + (sim.raceMs || 60000) + 20000 : null;
    for (const s of session.seats) { s.x = null; s.note = ""; }
    pushState(ctx);
    return { status: 200, body: { ok: true } };
  }

  // Submit a turn. TURNS mode: players rotate through the seats `attempts`
  // times. RACE mode: any seated player submits their finished run whenever
  // they cross the line (one per seat per round). Either way the worker
  // recomputes the authoritative result via the game's pure sim.
  if (op === "turn") {
    const client_id = clientOf(b);
    const session = findSession(frame, String(b?.session_id ?? ""));
    if (!client_id || !session) return { status: 400, body: { error: "client_id and session_id required" } };
    if (JSON.stringify(b?.payload ?? null).length > 16000) return { status: 400, body: { error: "payload too large" } };
    if (session.phase !== "playing") return { status: 409, body: { error: "not playing" } };
    const sim = SIMS[session.game_id];
    if (!sim) return { status: 409, body: { error: "unknown game" } };
    const mine = session.seats.find((s) => s.client_id === client_id);
    if (!mine) return { status: 403, body: { error: "not seated" } };
    const myAttempts = attemptsOf(mine, session.round_id);

    if (sim.mode === "race") {
      if (myAttempts.length >= 1) return { status: 200, body: { ok: true, duplicate: true } };
    } else {
      const n = session.seats.length;
      const attempt = Math.floor(session.turn_index / n);
      const active = session.seats[session.turn_index % n];
      if (attempt >= sim.attempts || !active) return { status: 409, body: { error: "no active seat" } };
      if (active.client_id !== client_id) return { status: 403, body: { error: "not your turn" } };
      if (myAttempts.length > attempt) return { status: 200, body: { ok: true, duplicate: true } };
    }

    const { points, summary } = sim.resolve(b?.payload, session.seed || 0);
    mine.runs = {
      round_id: session.round_id,
      attempts: [...myAttempts, { points, summary: sanitizeText(summary, 40) || "", payload: b?.payload ?? null }],
    };

    if (sim.mode === "race") {
      if (session.seats.every((s) => attemptsOf(s, session.round_id).length > 0)) {
        await finishSession(ctx, session);
      } else {
        // first finisher starts the clock for stragglers
        const cutoff = Date.now() + 30000;
        if (!session.deadline || session.deadline > cutoff) session.deadline = cutoff;
      }
    } else {
      session.turn_index += 1;
      if (session.turn_index >= session.seats.length * sim.attempts) await finishSession(ctx, session);
    }
    pushState(ctx);
    return { status: 200, body: { ok: true, points, summary } };
  }

  // Race-mode position beacon (and heartbeat). Racers post their live position
  // a few times a second; finished players and spectators post empty
  // heartbeats. Every beacon also checks the race deadline, so the session
  // force-resolves (unfinished seats = DNF) even if a straggler never submits.
  if (op === "beacon") {
    const client_id = clientOf(b);
    const session = findSession(frame, String(b?.session_id ?? ""));
    if (!session || session.phase !== "playing") return { status: 200, body: { ok: true, stale: true } };
    if (session.deadline && Date.now() > session.deadline) {
      await finishSession(ctx, session);
      pushState(ctx);
      return { status: 200, body: { ok: true, ended: true } };
    }
    if (Number.isFinite(Number(b?.x))) {
      const mine = session.seats.find((s) => s.client_id === client_id);
      if (mine) {
        mine.x = Number(b.x);
        mine.y = Number(b?.y) || 0;
        mine.heading = Number(b?.heading) || 0;
        mine.note = sanitizeText(String(b?.note ?? ""), 24) || "";
        pushState(ctx);
      }
    }
    return { status: 200, body: { ok: true } };
  }

  // Set the caller's arcade initials (1–3 chars). Updates their seat + relabels
  // their placeholder ("???") high-score rows for the given game.
  if (op === "initials") {
    const client_id = clientOf(b);
    const game = String(b?.game_id ?? "");
    const initials = String(b?.initials ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3);
    if (!client_id || !initials) return { status: 400, body: { error: "client_id and initials required" } };
    for (const session of sessionsOf(frame)) {
      const mine = session.seats.find((s) => s.client_id === client_id);
      if (mine) mine.initials = initials;
    }
    if (game) {
      const pid = await publicId(client_id);
      const rows = (await scores(ctx).all())
        .filter((r) => r.game_id === game && r.client_id === pid && r.initials === "???");
      for (const row of rows) await keep(ctx, row.id, { initials });
    }
    pushState(ctx);
    return { status: 200, body: { ok: true, initials } };
  }

  // Play again: host sends results → lobby, keeping seats. Old runs go stale
  // automatically when the next start bumps the round.
  if (op === "next") {
    const client_id = clientOf(b);
    const session = findSession(frame, String(b?.session_id ?? ""));
    if (!session || session.phase !== "results") return { status: 409, body: { error: "not in results" } };
    if (session.seats.length && session.seats[0].client_id !== client_id && !peer.is_owner) {
      return { status: 403, body: { error: "only the host can continue" } };
    }
    session.phase = "lobby";
    session.seed = null;
    session.turn_index = 0;
    session.deadline = null;
    pushState(ctx);
    return { status: 200, body: { ok: true } };
  }

  return { status: 405, body: { error: "method not allowed" } };
}

const json = (status: number, body: unknown) => Response.json(body, { status });

// deno-lint-ignore no-explicit-any
async function body(request: Request): Promise<any> {
  try {
    return JSON.parse(await request.text());
  } catch {
    return null;
  }
}

export default {
  async fetch(request: Request, ctx: Ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    const method = request.method;
    // Static assets.
    if (method === "GET" && !pathname.startsWith("/api/")) return ctx.file(pathname);

    const { frame, peer } = ctx;

    if (pathname === "/api/state" && method === "GET") {
      // Derive the wire shape the frontend + game cartridges consume: turns as
      // rows in rotation order, racers from beacon fields. Players by public id only.
      const sessions = sessionsOf(frame).map((s) => ({
        session_id: s.session_id, game_id: s.game_id, phase: s.phase,
        round_id: s.round_id, seed: s.seed, turn_index: s.turn_index, deadline: s.deadline,
        seats: s.seats.map((r) => ({
          seat_no: r.seat_no, player_id: r.player_id, display_name: r.display_name, initials: r.initials,
        })),
        turns: s.seats.flatMap((r) =>
          attemptsOf(r, s.round_id).map((a, i) => ({
            seat_no: r.seat_no, player_id: r.player_id,
            points: a.points, summary: a.summary, payload: a.payload ?? null, attempt: i,
          })))
          .sort((a, b) => (a.attempt - b.attempt) || (a.seat_no - b.seat_no)),
        racers: s.phase === "playing"
          ? s.seats.filter((r) => Number.isFinite(r.x)).map((r) => ({
              seat_no: r.seat_no, player_id: r.player_id,
              x: r.x, y: r.y, heading: r.heading, note: r.note,
            }))
          : [],
      }));
      // The board is handed over as initials, game and points, and nothing else of a row.
      const leaderboard = (await byPoints(ctx)).slice(0, 60)
        .map((r) => ({ initials: r.initials, game_id: r.game_id, points: r.points }));
      return json(200, {
        sessions, leaderboard,
        me: { is_owner: peer.is_owner, user_name: peer.user_name || "", space_color: peer.space_color ?? "" },
      });
    }

    if (pathname.startsWith("/api/") && method === "POST") {
      const r = await handleWrite(ctx, pathname.slice("/api/".length), await body(request));
      return json(r.status, r.body);
    }

    return json(405, { error: "method not allowed" });
  },
};
