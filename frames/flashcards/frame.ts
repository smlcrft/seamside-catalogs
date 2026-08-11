// ----------------------------------------------------------------------------------------
// Flashcards — a shared deck, a private schedule.
//
// Design axes:
//   privacy:        privacy-space-users  — anyone in the space can study; space editors
//                                           write the cards.
//   data_storage:   storage-local        — LocalTables, no contract. Nothing else acts on
//                                           these rows (docs/schema-contracts.md).
//   view_realtime:  view-collaborative    — deck and card edits push, so a group building a
//                                           deck together sees it grow. Reviews do NOT push
//                                           (see below).
//   settings_scope: settings-per-sfi
//
// THE SPLIT THAT MAKES THIS WORTH BUILDING: cards are shared, scheduling is personal. A
// study group writes one deck between them, and every member gets their own intervals —
// your card does not become "easy" because a classmate found it easy. That is why review
// state is a separate table keyed by user_id rather than columns on the card, and why a
// review never pushes: nobody else's screen should change because you answered something.
//
// SM-2 is implemented here rather than in the frontend. It is the whole product: a subtly
// wrong easiness factor does not throw an error, it quietly teaches you the wrong things at
// the wrong time, and you would not notice for weeks.
// ----------------------------------------------------------------------------------------
import {
  log, serveFileAtPath, jsonReply, parseJsonBody, parsePeerInfo, onUiMessage,
  pushToInstance, sanitizeText, declareTables, ensureTables, table,
} from "@frame-core";

const DECKS_SCHEMA = [
  { name: "name",       col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "sort_order", col_type: "integer" as const, nullable: false, default_val: "0" },
];

const CARDS_SCHEMA = [
  { name: "deck_id",  col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "front",    col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "back",     col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "added_ms", col_type: "integer" as const, nullable: false, default_val: "0" },
];

// One row per card PER PERSON. Keyed by user_id, never merged into the card.
const REVIEWS_SCHEMA = [
  { name: "card_id", col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "user_id", col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "reps",    col_type: "integer" as const, nullable: false, default_val: "0" },
  { name: "ef",      col_type: "real"    as const, nullable: false, default_val: "2.5" },
  { name: "ivl",     col_type: "integer" as const, nullable: false, default_val: "0" },
  { name: "due",     col_type: "text"    as const, nullable: false, default_val: "" },   // yyyy-mm-dd
  { name: "seen_ms", col_type: "integer" as const, nullable: false, default_val: "0" },
];

declareTables([
  { key: "decks",   title: "Decks",   description: "Card decks in this placement.", local: true, schema: DECKS_SCHEMA },
  { key: "cards",   title: "Cards",   description: "Cards belonging to this placement's decks.", local: true, schema: CARDS_SCHEMA },
  { key: "reviews", title: "Review progress", description: "Each person's spaced-repetition state, one row per card per person.", local: true, schema: REVIEWS_SCHEMA },
]);

type Peer = ReturnType<typeof parsePeerInfo>;
type WriteResult = { status: number; body: unknown };

function dayStr(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** Add whole days to a yyyy-mm-dd, stepping the calendar rather than adding milliseconds —
 * 86400000 is wrong across a DST boundary and a scheduler that drifts a day is worse than
 * one that is obviously broken. */
function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + n);
  return dayStr(d.getTime());
}

// ----- SM-2 ------------------------------------------------------------------------------
// The classic algorithm, kept literal so it can be checked against the published one.
//   q < 3  → the answer was a failure: repetitions reset, the card comes back tomorrow.
//            The easiness factor is still updated, so repeatedly failing a card makes it
//            permanently harder and it will stay in circulation.
//   q >= 3 → 1st success: 1 day. 2nd: 6 days. After that: previous interval × EF.
//   EF' = EF + (0.1 − (5−q)(0.08 + (5−q)0.02)), never below 1.3.
export type Sched = { reps: number; ef: number; ivl: number };

function sm2(prev: Sched, q: number): Sched {
  const quality = Math.max(0, Math.min(5, Math.round(q)));
  let ef = prev.ef + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  if (ef < 1.3) ef = 1.3;
  // Keep EF to two places: it is multiplied repeatedly, and letting float dust accumulate
  // makes intervals irreproducible between devices.
  ef = Math.round(ef * 100) / 100;

  if (quality < 3) return { reps: 0, ef, ivl: 1 };
  const reps = prev.reps + 1;
  const ivl = reps === 1 ? 1 : reps === 2 ? 6 : Math.max(1, Math.round(prev.ivl * ef));
  return { reps, ef, ivl };
}

// One deliberate departure from the published algorithm, kept OUTSIDE sm2 so that
// function stays literally checkable against the paper.
//
// Vanilla SM-2 gives every first success an interval of 1 day, whatever the answer. On a
// brand-new card that renders all four buttons as "tomorrow", which teaches the user
// nothing and makes the choice feel pointless — the one thing the answer row exists to
// avoid. So a first success answered "easy" graduates straight to 4 days, which is what
// Anki does with the same algorithm and the same reasoning. Everything after the first
// success is untouched SM-2.
const EASY_FIRST_INTERVAL = 4;

function schedule(prev: Sched, q: number): Sched {
  const next = sm2(prev, q);
  if (prev.reps === 0 && q >= 5 && next.reps === 1) return { ...next, ivl: EASY_FIRST_INTERVAL };
  return next;
}

async function readyTables(peer: Peer): Promise<boolean> {
  const quiet = { ...peer, is_owner: false } as Peer;
  let r = ensureTables(quiet);
  for (const key of ["decks", "cards", "reviews"]) {
    if (!r.byKey[key]) {
      try { await table(key, peer.sfi_id).query({ limit: 1 }); } catch (e) { log(`flashcards: ensure "${key}" failed: ${e}`); }
      r = ensureTables(quiet);
    }
  }
  return !!r.byKey["decks"] && !!r.byKey["cards"] && !!r.byKey["reviews"];
}

/** Everything the viewer needs, with THEIR schedule folded in. A card with no review row
 * is new and therefore due — that is how a fresh deck presents itself. */
async function readAll(sfiId: string, peer: Peer) {
  const today = dayStr(Date.now());
  const { rows: drows } = await table("decks", sfiId).query({ order_by: [{ col: "sort_order" }] });
  const { rows: crows } = await table("cards", sfiId).query({ limit: 5000 });
  const { rows: rrows } = await table("reviews", sfiId).query({ limit: 20000 });

  const mine: Record<string, { reps: number; ef: number; ivl: number; due: string }> = {};
  const uid = String(peer.user_id ?? "");
  for (const r of rrows) {
    if (String(r.user_id) !== uid) continue;      // somebody else's schedule is not ours to see
    mine[String(r.card_id)] = {
      reps: Number(r.reps) || 0, ef: Number(r.ef) || 2.5,
      ivl: Number(r.ivl) || 0, due: String(r.due || ""),
    };
  }

  const cards = crows.map((c) => {
    const id = String(c._row_id);
    const s = mine[id];
    const prev: Sched = { reps: s ? s.reps : 0, ef: s ? s.ef : 2.5, ivl: s ? s.ivl : 0 };
    return {
      id, deck_id: String(c.deck_id || ""), front: c.front, back: c.back,
      added_ms: Number(c.added_ms) || 0,
      reps: prev.reps, ef: prev.ef, ivl: prev.ivl,
      due: s ? s.due : "",
      is_new: !s,
      due_now: !s || !s.due || s.due <= today,
      // What each answer will cost, computed by the SAME sm2 the review uses. The
      // frontend must never re-implement the schedule to label its own buttons — two
      // implementations drift, and the number on the button would stop being true.
      preview: { again: schedule(prev, 1).ivl, hard: schedule(prev, 3).ivl, good: schedule(prev, 4).ivl, easy: schedule(prev, 5).ivl },
    };
  });

  const byDeck: Record<string, typeof cards> = {};
  for (const c of cards) (byDeck[c.deck_id] ||= []).push(c);

  const decks = drows.map((d) => {
    const id = String(d._row_id);
    const list = byDeck[id] || [];
    return {
      id, name: d.name, sort_order: Number(d.sort_order) || 0,
      total: list.length,
      due: list.filter((c) => c.due_now).length,
      fresh: list.filter((c) => c.is_new).length,
    };
  });

  // When nothing is due, say when something next will be — an empty screen with no
  // horizon reads as "broken" rather than "finished".
  const upcoming = cards.filter((c) => !c.due_now && c.due).map((c) => c.due).sort();
  return { today, decks, cards, next_due: upcoming[0] || "", can_study: !!peer.is_sfi_member };
}

function notify(sfiId: string) {
  pushToInstance(sfiId, { type: "flashcards_changed" });
}

async function handleWrite(sfiId: string, op: string, v: Record<string, unknown> | null, peer: Peer): Promise<WriteResult> {
  if (!(await readyTables(peer))) return { status: 503, body: { error: "tables not ready" } };
  const decks = table("decks", sfiId);
  const cards = table("cards", sfiId);
  const reviews = table("reviews", sfiId);

  // Reviewing is member work, not editor work: it writes only YOUR OWN row and changes
  // nothing anyone else can see. Everything that edits the shared deck stays editor-only.
  // (This is the legitimate use of is_sfi_member — never for the editor gate below.)
  if (op === "review") {
    if (!peer.is_sfi_member) return { status: 403, body: { error: "members only" } };
    const uid = String(peer.user_id ?? "");
    if (!uid) return { status: 403, body: { error: "no identity to schedule against" } };
    const cardId = String(v?.card_id ?? "");
    if (!cardId || !(await cards.get(cardId))) return { status: 400, body: { error: "bad card" } };
    const q = Number(v?.quality);
    if (!Number.isFinite(q) || q < 0 || q > 5) return { status: 400, body: { error: "bad quality" } };

    const { rows } = await reviews.query({ where: { card_id: cardId, user_id: uid }, limit: 1 });
    const prev: Sched = rows.length
      ? { reps: Number(rows[0].reps) || 0, ef: Number(rows[0].ef) || 2.5, ivl: Number(rows[0].ivl) || 0 }
      : { reps: 0, ef: 2.5, ivl: 0 };
    const next = schedule(prev, q);
    const today = dayStr(Date.now());
    const patch = { card_id: cardId, user_id: uid, reps: next.reps, ef: next.ef, ivl: next.ivl,
                    due: addDays(today, next.ivl), seen_ms: Date.now() };
    await reviews.upsert(rows.length ? String(rows[0]._row_id) : null, patch);
    // Deliberately NO push: this changed one person's schedule and nobody else's screen
    // should move because of it.
    return { status: 200, body: { ok: true, reps: next.reps, ef: next.ef, ivl: next.ivl, due: patch.due } };
  }

  if (!peer.is_sfi_editor) return { status: 403, body: { error: "editors only" } };
  const ok = async (): Promise<WriteResult> => { notify(sfiId); return { status: 200, body: { ok: true } }; };

  if (op === "deck") {
    const name = sanitizeText(v?.name, 100);
    if (!name) return { status: 400, body: { error: "name required" } };
    const { rows } = await decks.query({ order_by: [{ col: "sort_order", dir: "desc" }], limit: 1 });
    const nextOrder = rows.length ? (Number(rows[0].sort_order) || 0) + 1 : 0;
    const { row_id } = await decks.upsert(null, { name, sort_order: nextOrder });
    // Must push like every other mutation. Returning early to hand back the row id
    // skipped notify(), so a deck created over the bus (which is fire-and-forget, and
    // therefore relies ENTIRELY on the push to refresh) appeared to do nothing at all.
    notify(sfiId);
    return { status: 200, body: { ok: true, id: row_id } };
  }
  if (op.startsWith("deck/")) {
    const [id, action] = op.slice("deck/".length).split("/");
    if (!id || !(await decks.get(id))) return { status: 400, body: { error: "bad id" } };
    if (action === "delete") {
      // Take the cards and everybody's progress on them: an orphaned review row is
      // invisible and would resurrect if a row id were ever reused.
      const { rows } = await cards.query({ where: { deck_id: id }, limit: 5000 });
      for (const c of rows) await reviews.deleteWhere({ card_id: String(c._row_id) });
      await cards.deleteWhere({ deck_id: id });
      await decks.delete(id);
      return ok();
    }
    if (action) return { status: 404, body: { error: "not found" } };
    if (v?.name !== undefined) { const n = sanitizeText(v.name, 100); if (n) await decks.upsert(id, { name: n }); }
    return ok();
  }

  if (op === "card") {
    const front = sanitizeText(v?.front, 1000);
    const back = sanitizeText(v?.back, 2000);
    if (!front || !back) return { status: 400, body: { error: "both sides are needed" } };
    const deckId = String(v?.deck_id ?? "");
    if (!deckId || !(await decks.get(deckId))) return { status: 400, body: { error: "pick a deck" } };
    await cards.upsert(null, { deck_id: deckId, front, back, added_ms: Date.now() });
    return ok();
  }
  if (op.startsWith("card/")) {
    const [id, action] = op.slice("card/".length).split("/");
    if (!id || !(await cards.get(id))) return { status: 400, body: { error: "bad id" } };
    if (action === "delete") {
      await reviews.deleteWhere({ card_id: id });
      await cards.delete(id);
      return ok();
    }
    if (action === "reset") {
      // Forget MY progress on this card only — a deck author must not be able to wipe
      // somebody else's schedule.
      await reviews.deleteWhere({ card_id: id, user_id: String(peer.user_id ?? "") });
      return ok();
    }
    if (action) return { status: 404, body: { error: "not found" } };
    const patch: Record<string, unknown> = {};
    if (v?.front !== undefined) { const f = sanitizeText(v.front, 1000); if (f) patch.front = f; }
    if (v?.back !== undefined) { const b = sanitizeText(v.back, 2000); if (b) patch.back = b; }
    if (v?.deck_id !== undefined && await decks.get(String(v.deck_id))) patch.deck_id = String(v.deck_id);
    if (Object.keys(patch).length) await cards.upsert(id, patch);
    return ok();
  }

  return { status: 404, body: { error: "not found" } };
}

onUiMessage(async (sfiId, data, peer) => {
  if (!sfiId || typeof data !== "object" || data === null) return;
  const d = data as Record<string, unknown>;
  if (typeof d.op !== "string") return;
  const r = await handleWrite(sfiId, d.op, d, peer);
  if (r.status !== 200) log(`flashcards: bus op ${d.op} → ${r.status} (${JSON.stringify(r.body)})`);
});

self.onNetworkRequest = async function (replyPort, reqPath, method, headers, query, body, cookies) {
  const peer = parsePeerInfo(query, cookies);
  const sfiId = peer.sfi_id;

  if (method === "GET" && !reqPath.startsWith("/api/")) {
    return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url), headers);
  }

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

  // A review needs its result back — the next interval is shown on the button that
  // produced it — so the write arm answers rather than being fire-and-forget.
  if (reqPath.startsWith("/api/") && (method === "POST" || method === "PUT")) {
    const r = await handleWrite(sfiId, reqPath.slice("/api/".length), parseJsonBody<Record<string, unknown>>(body), peer);
    return jsonReply(replyPort, r.status, r.body);
  }

  if (!(await readyTables(peer))) return jsonReply(replyPort, 503, { error: "tables not ready" });

  if (reqPath === "/api/list" && method === "GET") {
    return jsonReply(replyPort, 200, await readAll(sfiId, peer));
  }

  return jsonReply(replyPort, 404, { error: "not found" });
};

log("Flashcards frame is up and running!");
