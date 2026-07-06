// ============================================================================
// Seamdeck — WORKER (backend). Owns all shared state and exposes it over
// /api/*. Never renders UI, and knows NO game rules: each game's pure sim
// (see frame.sim.ts → public/games/*-sim.js) turns a submitted turn payload
// into authoritative { points, summary }.
//
// STORAGE: no synctables. The worker runs ONCE (on the owner's device) and
// every viewer's requests are proxied to it, so plain worker memory is already
// shared state for all players. Sessions/seats/turns/beacons live in memory —
// they're ephemeral by design. High scores are the one thing that should
// outlive a restart, so they persist to data/high-scores.json.
// Live updates ride pushToInstance(sfi, { type: "state_changed" }) — the same
// event the frontend already subscribes to via useFramePush.
//
// Player identity: anonymous link viewers are first-class players, but they
// have no stable server-side id, so the player token is a client-generated
// `client_id` (UUID) the frontend persists per-device and sends on every request.
// ============================================================================
import {
  serveFileAtPath, jsonReply, parseJsonBody, parsePeerInfo, sanitizeText,
  pushToInstance, loadJsonFile, saveJsonFile,
} from "@frame-core";
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
  seat_no: number; display_name: string; initials: string | null; client_id: string;
  runs: { round_id: number; attempts: Attempt[] } | null;
  x: number | null; y: number | null; heading: number; note: string; // race beacon
};
type Session = {
  session_id: string; game_id: string; phase: "lobby" | "playing" | "results";
  round_id: number; turn_index: number; seed: number | null; deadline: number | null;
  started_at: number; seats: Seat[];
};
type Score = { initials: string; game_id: string; points: number; scored_at: number; client_id: string };

// Ephemeral: gone on worker restart, which is fine — games are one-more-go toys.
const sessionsBySfi: Record<string, Session[]> = {};
// Durable: the arcade high-score board survives restarts via data/.
const scoresBySfi: Record<string, Score[]> =
  loadJsonFile(import.meta.url, "high-scores.json", {} as Record<string, Score[]>);

function sessionsOf(sfi: string): Session[] {
  return sessionsBySfi[sfi] ?? (sessionsBySfi[sfi] = []);
}
function scoresOf(sfi: string): Score[] {
  return scoresBySfi[sfi] ?? (scoresBySfi[sfi] = []);
}
function saveScores() {
  saveJsonFile(import.meta.url, "high-scores.json", scoresBySfi);
}
function pushState(sfi: string) {
  pushToInstance(sfi, { type: "state_changed" });
}

function findSession(sfi: string, session_id: string): Session | null {
  return sessionsOf(sfi).find((s) => s.session_id === session_id) ?? null;
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
function playerName(body: any, peer: any): string {
  return sanitizeText(body?.display_name || peer.user_name || "Player", 24) || "Player";
}

// Flip a session to results and record each seat's best attempt on the
// high-score board (global per game — sessions compete). "???" placeholders
// carry the client_id until /api/initials fills them in.
function finishSession(sfi: string, session: Session) {
  session.phase = "results";
  const scores = scoresOf(sfi);
  for (const seat of session.seats) {
    const best = bestAttempt(attemptsOf(seat, session.round_id));
    if (best && best.points > 0) {
      scores.push({
        initials: seat.initials || "???", game_id: session.game_id,
        points: best.points, scored_at: Date.now(), client_id: seat.client_id,
      });
    }
  }
  // Prune: keep the 50 highest per game.
  const forGame = scores.filter((r) => r.game_id === session.game_id)
    .sort((a, b) => b.points - a.points);
  for (const extra of forGame.slice(50)) scores.splice(scores.indexOf(extra), 1);
  saveScores();
}

// Stand `client_id` up from every seat they hold (normally at most one), then
// settle each affected session: empty → GC; playing turn-game → resolve to
// results (rotation can't survive a leaver); playing race → their finish is no
// longer required, so the race may now be complete.
function standUpEverywhere(sfi: string, client_id: string) {
  const sessions = sessionsOf(sfi);
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
        finishSession(sfi, session);
      } else if (session.seats.every((s) => attemptsOf(s, session.round_id).length > 0)) {
        finishSession(sfi, session);
      }
    }
  }
}

self.onNetworkRequest = async function (replyPort, reqPath, method, headers, query, body, cookies) {
  // Static assets.
  if (method === "GET" && !reqPath.startsWith("/api/")) {
    return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url), headers);
  }

  const peer = parsePeerInfo(query, cookies);
  const sfi = peer.sfi_id;

  if (reqPath === "/api/state" && method === "GET") {
    // Derive the wire shape the frontend + game cartridges consume: turns as
    // rows in rotation order, racers from beacon fields.
    const sessions = sessionsOf(sfi).map((s) => ({
      session_id: s.session_id, game_id: s.game_id, phase: s.phase,
      round_id: s.round_id, seed: s.seed, turn_index: s.turn_index, deadline: s.deadline,
      seats: s.seats.map((r) => ({
        seat_no: r.seat_no, client_id: r.client_id, display_name: r.display_name, initials: r.initials,
      })),
      turns: s.seats.flatMap((r) =>
        attemptsOf(r, s.round_id).map((a, i) => ({
          seat_no: r.seat_no, client_id: r.client_id,
          points: a.points, summary: a.summary, payload: a.payload ?? null, attempt: i,
        })))
        .sort((a, b) => (a.attempt - b.attempt) || (a.seat_no - b.seat_no)),
      racers: s.phase === "playing"
        ? s.seats.filter((r) => Number.isFinite(r.x)).map((r) => ({
            seat_no: r.seat_no, client_id: r.client_id,
            x: r.x, y: r.y, heading: r.heading, note: r.note,
          }))
        : [],
    }));
    const leaderboard = [...scoresOf(sfi)]
      .sort((a, b) => b.points - a.points)
      .slice(0, 60)
      .map((r) => ({ initials: r.initials, game_id: r.game_id, points: r.points }));
    return jsonReply(replyPort, 200, {
      sessions, leaderboard,
      me: { is_owner: peer.is_owner, user_name: peer.user_name || "", space_color: peer.space_color ?? "" },
    });
  }

  // Open a NEW lobby for a game, seating the caller as host (seat 1). The
  // caller implicitly stands up from anywhere else — one seat per person.
  if (reqPath === "/api/create_session" && method === "POST") {
    const b = parseJsonBody<any>(body);
    const game = String(b?.game_id ?? "");
    const client_id = String(b?.client_id ?? "");
    if (!game || !client_id) return jsonReply(replyPort, 400, { error: "game_id and client_id required" });
    if (!SIMS[game]) return jsonReply(replyPort, 400, { error: "unknown game" });
    if (sessionsOf(sfi).length >= 12) return jsonReply(replyPort, 409, { error: "too many sessions" });
    standUpEverywhere(sfi, client_id);
    const session: Session = {
      session_id: crypto.randomUUID(), game_id: game, phase: "lobby",
      round_id: 0, turn_index: 0, seed: null, deadline: null, started_at: Date.now(),
      seats: [{
        seat_no: 1, display_name: playerName(b, peer), initials: null, client_id,
        runs: null, x: null, y: null, heading: 0, note: "",
      }],
    };
    sessionsOf(sfi).push(session);
    pushState(sfi);
    return jsonReply(replyPort, 200, { ok: true, session_id: session.session_id });
  }

  // Claim a seat in a lobby (lowest free, or the requested one if open).
  if (reqPath === "/api/claim" && method === "POST") {
    const b = parseJsonBody<any>(body);
    const client_id = String(b?.client_id ?? "");
    const session = findSession(sfi, String(b?.session_id ?? ""));
    if (!client_id || !session) return jsonReply(replyPort, 400, { error: "client_id and session_id required" });
    if (session.phase !== "lobby") return jsonReply(replyPort, 409, { error: "not in lobby" });
    if (session.seats.some((s) => s.client_id === client_id)) return jsonReply(replyPort, 200, { ok: true, already: true });
    if (session.seats.length >= 6) return jsonReply(replyPort, 409, { error: "lobby full" });
    standUpEverywhere(sfi, client_id); // can't GC this session — caller isn't in it
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
      runs: null, x: null, y: null, heading: 0, note: "",
    });
    session.seats.sort((a, b2) => a.seat_no - b2.seat_no);
    pushState(sfi);
    return jsonReply(replyPort, 200, { ok: true, seat_no });
  }

  // Stand up (from everywhere — a client holds at most one seat anyway).
  if (reqPath === "/api/leave" && method === "POST") {
    const b = parseJsonBody<any>(body);
    const client_id = String(b?.client_id ?? "");
    if (!client_id) return jsonReply(replyPort, 400, { error: "client_id required" });
    standUpEverywhere(sfi, client_id);
    pushState(sfi);
    return jsonReply(replyPort, 200, { ok: true });
  }

  // Start the round_id: host (lowest seat) only, lobby only. Bumps the round
  // (which makes every seat's previous runs stale), draws the shared seed;
  // race sessions get their force-resolve deadline.
  if (reqPath === "/api/start" && method === "POST") {
    const b = parseJsonBody<any>(body);
    const client_id = String(b?.client_id ?? "");
    const session = findSession(sfi, String(b?.session_id ?? ""));
    if (!session || session.phase !== "lobby") return jsonReply(replyPort, 409, { error: "not in lobby" });
    if (!session.seats.length) return jsonReply(replyPort, 409, { error: "no players seated" });
    if (session.seats[0].client_id !== client_id) return jsonReply(replyPort, 403, { error: "only the host can start" });
    const sim = SIMS[session.game_id];
    session.phase = "playing";
    session.round_id += 1;
    session.turn_index = 0;
    session.seed = drawSeed();
    session.deadline = sim && sim.mode === "race" ? Date.now() + (sim.raceMs || 60000) + 20000 : null;
    for (const s of session.seats) { s.x = null; s.note = ""; }
    pushState(sfi);
    return jsonReply(replyPort, 200, { ok: true });
  }

  // Submit a turn. TURNS mode: players rotate through the seats `attempts`
  // times. RACE mode: any seated player submits their finished run whenever
  // they cross the line (one per seat per round). Either way the worker
  // recomputes the authoritative result via the game's pure sim.
  if (reqPath === "/api/turn" && method === "POST") {
    const b = parseJsonBody<any>(body);
    const client_id = String(b?.client_id ?? "");
    const session = findSession(sfi, String(b?.session_id ?? ""));
    if (!client_id || !session) return jsonReply(replyPort, 400, { error: "client_id and session_id required" });
    if (JSON.stringify(b?.payload ?? null).length > 16000) return jsonReply(replyPort, 400, { error: "payload too large" });
    if (session.phase !== "playing") return jsonReply(replyPort, 409, { error: "not playing" });
    const sim = SIMS[session.game_id];
    if (!sim) return jsonReply(replyPort, 409, { error: "unknown game" });
    const mine = session.seats.find((s) => s.client_id === client_id);
    if (!mine) return jsonReply(replyPort, 403, { error: "not seated" });
    const myAttempts = attemptsOf(mine, session.round_id);

    if (sim.mode === "race") {
      if (myAttempts.length >= 1) return jsonReply(replyPort, 200, { ok: true, duplicate: true });
    } else {
      const n = session.seats.length;
      const attempt = Math.floor(session.turn_index / n);
      const active = session.seats[session.turn_index % n];
      if (attempt >= sim.attempts || !active) return jsonReply(replyPort, 409, { error: "no active seat" });
      if (active.client_id !== client_id) return jsonReply(replyPort, 403, { error: "not your turn" });
      if (myAttempts.length > attempt) return jsonReply(replyPort, 200, { ok: true, duplicate: true });
    }

    const { points, summary } = sim.resolve(b?.payload, session.seed || 0);
    mine.runs = {
      round_id: session.round_id,
      attempts: [...myAttempts, { points, summary: sanitizeText(summary, 40) || "", payload: b?.payload ?? null }],
    };

    if (sim.mode === "race") {
      if (session.seats.every((s) => attemptsOf(s, session.round_id).length > 0)) {
        finishSession(sfi, session);
      } else {
        // first finisher starts the clock for stragglers
        const cutoff = Date.now() + 30000;
        if (!session.deadline || session.deadline > cutoff) session.deadline = cutoff;
      }
    } else {
      session.turn_index += 1;
      if (session.turn_index >= session.seats.length * sim.attempts) finishSession(sfi, session);
    }
    pushState(sfi);
    return jsonReply(replyPort, 200, { ok: true, points, summary });
  }

  // Race-mode position beacon (and heartbeat). Racers post their live position
  // a few times a second; finished players and spectators post empty
  // heartbeats. Every beacon also checks the race deadline, so the session
  // force-resolves (unfinished seats = DNF) even if a straggler never submits.
  if (reqPath === "/api/beacon" && method === "POST") {
    const b = parseJsonBody<any>(body);
    const client_id = String(b?.client_id ?? "");
    const session = findSession(sfi, String(b?.session_id ?? ""));
    if (!session || session.phase !== "playing") return jsonReply(replyPort, 200, { ok: true, stale: true });
    if (session.deadline && Date.now() > session.deadline) {
      finishSession(sfi, session);
      pushState(sfi);
      return jsonReply(replyPort, 200, { ok: true, ended: true });
    }
    if (Number.isFinite(Number(b?.x))) {
      const mine = session.seats.find((s) => s.client_id === client_id);
      if (mine) {
        mine.x = Number(b.x);
        mine.y = Number(b?.y) || 0;
        mine.heading = Number(b?.heading) || 0;
        mine.note = sanitizeText(String(b?.note ?? ""), 24) || "";
        pushState(sfi);
      }
    }
    return jsonReply(replyPort, 200, { ok: true });
  }

  // Set the caller's arcade initials (1–3 chars). Updates their seat + relabels
  // their placeholder ("???") high-score rows for the given game.
  if (reqPath === "/api/initials" && method === "POST") {
    const b = parseJsonBody<any>(body);
    const client_id = String(b?.client_id ?? "");
    const game = String(b?.game_id ?? "");
    const initials = String(b?.initials ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3);
    if (!client_id || !initials) return jsonReply(replyPort, 400, { error: "client_id and initials required" });
    for (const session of sessionsOf(sfi)) {
      const mine = session.seats.find((s) => s.client_id === client_id);
      if (mine) mine.initials = initials;
    }
    if (game) {
      for (const row of scoresOf(sfi)) {
        if (row.game_id === game && row.client_id === client_id && row.initials === "???") row.initials = initials;
      }
      saveScores();
    }
    pushState(sfi);
    return jsonReply(replyPort, 200, { ok: true, initials });
  }

  // Play again: host sends results → lobby, keeping seats. Old runs go stale
  // automatically when the next start bumps the round.
  if (reqPath === "/api/next" && method === "POST") {
    const b = parseJsonBody<any>(body);
    const client_id = String(b?.client_id ?? "");
    const session = findSession(sfi, String(b?.session_id ?? ""));
    if (!session || session.phase !== "results") return jsonReply(replyPort, 409, { error: "not in results" });
    if (session.seats.length && session.seats[0].client_id !== client_id && !peer.is_owner) {
      return jsonReply(replyPort, 403, { error: "only the host can continue" });
    }
    session.phase = "lobby";
    session.seed = null;
    session.turn_index = 0;
    session.deadline = null;
    pushState(sfi);
    return jsonReply(replyPort, 200, { ok: true });
  }

  return jsonReply(replyPort, 405, { error: "method not allowed" });
};
