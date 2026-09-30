// ----------------------------------------------------------------------------------------
// Flashcards — a shared deck, a private schedule.
//
// Design axes:
//   privacy:        privacy-space-users  — anyone in the space can study; space editors
//                                           write the cards.
//   data_storage:   the space's tables   — `flashcards_decks`, `flashcards` (the cards) and
//                                           `flashcards_reviews`, in the frame data folder `_fdata/`,
//                                           synced with it; no contract (docs/schema-contracts.md).
//   view_realtime:  view-collaborative    — deck and card edits push `{ flashcards: "decks" }`,
//                                           which says to read again and never what changed,
//                                           so a group building a deck together sees it grow.
//                                           Reviews do NOT push (see below).
//
// The page reads no table: everything comes from GET /api/list, which folds in only the
// asker's own schedule, and every write is a route here that decides on ctx.peer.
//
// THE SPLIT THAT MAKES THIS WORTH BUILDING: cards are shared, scheduling is personal. A
// study group writes one deck between them, and every member gets their own intervals —
// your card does not become "easy" because a classmate found it easy. That is why review
// state is a separate table keyed by user_id rather than columns on the card, and why a
// review never pushes: nobody else's screen should change because you answered something.
// Separate is not secret: the reviews table is a file of the space like the others, so a
// member who opens it sees everyone's rows. The frame shows each person only their own.
//
// SM-2 is implemented here rather than in the frontend. It is the whole product: a subtly
// wrong easiness factor does not throw an error, it quietly teaches you the wrong things at
// the wrong time, and you would not notice for weeks.
// ----------------------------------------------------------------------------------------
import type { Ctx } from "@frame-core";
import { declareTables, sanitizeText } from "@frame-core";

const DECKS = "flashcards_decks";
const CARDS = "flashcards";
const REVIEWS = "flashcards_reviews";

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
  { key: DECKS,   title: "Decks",   description: "Card decks in this space.", local: true, schema: DECKS_SCHEMA },
  { key: CARDS,   title: "Cards",   description: "Cards belonging to this space's decks.", local: true, schema: CARDS_SCHEMA },
  { key: REVIEWS, title: "Review progress", description: "Each person's spaced-repetition state, one row per card per person.", local: true, schema: REVIEWS_SCHEMA },
]);

type Row = Record<string, unknown> & { id: string };
type Schema = ReadonlyArray<{ name: string; col_type: "text" | "integer" | "real"; default_val: string }>;
type WriteResult = { status: number; body: unknown };

const rows = (ctx: Ctx, name: string) => ctx.shared.table<Record<string, unknown>>(name);

const defaultsOf = (schema: Schema): Record<string, unknown> => Object.fromEntries(
  schema.map((c) => [c.name, c.col_type === "text" ? c.default_val : Number(c.default_val)]),
);
const DEFAULTS: Record<string, Record<string, unknown>> = {
  [DECKS]: defaultsOf(DECKS_SCHEMA),
  [CARDS]: defaultsOf(CARDS_SCHEMA),
  [REVIEWS]: defaultsOf(REVIEWS_SCHEMA),
};

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

async function drop(ctx: Ctx, name: string, match: (r: Row) => boolean): Promise<void> {
  for (const r of await rows(ctx, name).all()) if (match(r)) await rows(ctx, name).delete(r.id);
}

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

/** Everything the viewer needs, with THEIR schedule folded in. A card with no review row
 * is new and therefore due — that is how a fresh deck presents itself. */
async function readAll(ctx: Ctx) {
  const peer = ctx.peer;
  const today = dayStr(Date.now());
  const drows = (await rows(ctx, DECKS).all())
    .sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));
  const crows = await rows(ctx, CARDS).all();
  const rrows = await rows(ctx, REVIEWS).all();

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
    const id = c.id;
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
    const id = d.id;
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

// What changed, never what it holds: each page reads again as whoever it is.
const tell = (ctx: Ctx) => ctx.push({ flashcards: "decks" });

async function handleWrite(ctx: Ctx, op: string, v: Record<string, unknown> | null): Promise<WriteResult> {
  const peer = ctx.peer;
  const editor = peer.is_sfi_editor || peer.is_owner;
  const member = editor || peer.is_sfi_member;

  // Reviewing is member work, not editor work: it writes only YOUR OWN row and changes
  // nothing anyone else can see. Everything that edits the shared deck stays editor-only.
  if (op === "review") {
    if (!member) return { status: 403, body: { error: "members only" } };
    const uid = String(peer.user_id ?? "");
    if (!uid) return { status: 403, body: { error: "no identity to schedule against" } };
    const cardId = String(v?.card_id ?? "");
    if (!cardId || !(await rows(ctx, CARDS).get(cardId))) return { status: 400, body: { error: "bad card" } };
    const q = Number(v?.quality);
    if (!Number.isFinite(q) || q < 0 || q > 5) return { status: 400, body: { error: "bad quality" } };

    const was = (await rows(ctx, REVIEWS).all()).find((r) => String(r.card_id) === cardId && String(r.user_id) === uid);
    const prev: Sched = was
      ? { reps: Number(was.reps) || 0, ef: Number(was.ef) || 2.5, ivl: Number(was.ivl) || 0 }
      : { reps: 0, ef: 2.5, ivl: 0 };
    const next = schedule(prev, q);
    const today = dayStr(Date.now());
    const patch = { card_id: cardId, user_id: uid, reps: next.reps, ef: next.ef, ivl: next.ivl,
                    due: addDays(today, next.ivl), seen_ms: Date.now() };
    await keep(ctx, REVIEWS, was ? was.id : null, patch);
    // Deliberately NO push: this changed one person's schedule and nobody else's screen
    // should move because of it.
    return { status: 200, body: { ok: true, reps: next.reps, ef: next.ef, ivl: next.ivl, due: patch.due } };
  }

  if (!editor) return { status: 403, body: { error: "editors only" } };
  const ok = (): WriteResult => { tell(ctx); return { status: 200, body: { ok: true } }; };
  const decks = rows(ctx, DECKS);
  const cards = rows(ctx, CARDS);

  if (op === "deck") {
    const name = sanitizeText(v?.name, 100);
    if (!name) return { status: 400, body: { error: "name required" } };
    const last = (await decks.all()).reduce((m, d) => Math.max(m, Number(d.sort_order) || 0), -1);
    const row = await keep(ctx, DECKS, null, { name, sort_order: last + 1 });
    tell(ctx);
    return { status: 200, body: { ok: true, id: row.id } };
  }
  if (op.startsWith("deck/")) {
    const [id, action] = op.slice("deck/".length).split("/");
    if (!id || !(await decks.get(id))) return { status: 400, body: { error: "bad id" } };
    if (action === "delete") {
      // Take the cards and everybody's progress on them: an orphaned review row is
      // invisible and would resurrect if a row id were ever reused.
      const gone = new Set((await cards.all()).filter((c) => String(c.deck_id) === id).map((c) => c.id));
      await drop(ctx, REVIEWS, (r) => gone.has(String(r.card_id)));
      await drop(ctx, CARDS, (c) => gone.has(c.id));
      await decks.delete(id);
      return ok();
    }
    if (action) return { status: 404, body: { error: "not found" } };
    if (v?.name !== undefined) { const n = sanitizeText(v.name, 100); if (n) await keep(ctx, DECKS, id, { name: n }); }
    return ok();
  }

  if (op === "card") {
    const front = sanitizeText(v?.front, 1000);
    const back = sanitizeText(v?.back, 2000);
    if (!front || !back) return { status: 400, body: { error: "both sides are needed" } };
    const deckId = String(v?.deck_id ?? "");
    if (!deckId || !(await decks.get(deckId))) return { status: 400, body: { error: "pick a deck" } };
    await keep(ctx, CARDS, null, { deck_id: deckId, front, back, added_ms: Date.now() });
    return ok();
  }
  if (op.startsWith("card/")) {
    const [id, action] = op.slice("card/".length).split("/");
    if (!id || !(await cards.get(id))) return { status: 400, body: { error: "bad id" } };
    if (action === "delete") {
      await drop(ctx, REVIEWS, (r) => String(r.card_id) === id);
      await cards.delete(id);
      return ok();
    }
    if (action === "reset") {
      // Forget MY progress on this card only — a deck author must not be able to wipe
      // somebody else's schedule.
      const uid = String(peer.user_id ?? "");
      await drop(ctx, REVIEWS, (r) => String(r.card_id) === id && String(r.user_id) === uid);
      return ok();
    }
    if (action) return { status: 404, body: { error: "not found" } };
    const patch: Record<string, unknown> = {};
    if (v?.front !== undefined) { const f = sanitizeText(v.front, 1000); if (f) patch.front = f; }
    if (v?.back !== undefined) { const b = sanitizeText(v.back, 2000); if (b) patch.back = b; }
    if (v?.deck_id !== undefined && await decks.get(String(v.deck_id))) patch.deck_id = String(v.deck_id);
    if (Object.keys(patch).length) await keep(ctx, CARDS, id, patch);
    return ok();
  }

  return { status: 404, body: { error: "not found" } };
}

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

    if (method === "GET" && !pathname.startsWith("/api/")) return ctx.file(pathname);

    if (pathname === "/api/whoami" && method === "GET") {
      const peer = ctx.peer;
      return json({
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
    // produced it — and every other write answers too, so the page re-reads after it.
    if (pathname.startsWith("/api/") && (method === "POST" || method === "PUT")) {
      const r = await handleWrite(ctx, pathname.slice("/api/".length), await body(request));
      return json(r.body, r.status);
    }

    if (pathname === "/api/list" && method === "GET") return json(await readAll(ctx));

    return json({ error: "not found" }, 404);
  },
};
