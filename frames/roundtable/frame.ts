// ----------------------------------------------------------------------------------------
// Roundtable — a space's discussion + two prioritized lists.
//
// Auth model:
//   - Editors (collaborator and up) chat, add items to either list, +1, and delete their
//     own; the owner can also delete anyone's and set the title, list labels and the
//     viewers toggle.
//   - `public_to_space_viewers` (owner-only, off by default): when on, Viewer-role members
//     of the space participate like editors.
//       canParticipate = isSfiEditor OR (publicToSpaceViewers AND isSfiMember)
//     Every write requires canParticipate, decided on ctx.peer, who the door proved is asking.
//   - Everyone else who reaches the frame — viewers while the toggle is off, and anyone
//     the frame is published to — follows along read-only. The page reads no table: what
//     it shows is what GET /api/state hands whoever is asking.
//   - Messages, items and votes are the space's tables (roundtable_messages,
//     roundtable_items, roundtable_votes), synced with it; the prefs are settings rows.
//
// Realtime: a push says what changed and never what it holds. Every open page of the
// frame hears it, a stranger's included, and each reads again as whoever it is.
// ----------------------------------------------------------------------------------------
import type { Ctx, FrameTableDecl } from "@frame-core";
import { declareTables, sanitizeText } from "@frame-core";

// ----------------------------------------------------------------------------------------
// PREFS — owner-editable, rows of a settings store every frame in the space shares, so
// each key carries this frame's name. Each value is JSON under `v`.
// ----------------------------------------------------------------------------------------
const SETTINGS = "__fc_settings";

type Prefs = { title: string; positive_label: string; negative_label: string; public_to_space_viewers: boolean };
const DEFAULT_PREFS: Prefs = {
  title: "Roundtable",
  positive_label: "Positives",
  negative_label: "Negatives",
  public_to_space_viewers: false,
};
const LABEL_KEYS = ["title", "positive_label", "negative_label"] as const;

async function setting<T>(ctx: Ctx, key: string): Promise<T | null> {
  const row = await rows(ctx, SETTINGS).get(key);
  if (row?.v == null) return null;
  try {
    return JSON.parse(String(row.v)) as T;
  } catch {
    return null;
  }
}

const setSetting = (ctx: Ctx, key: string, value: unknown) => keep(ctx, SETTINGS, key, { v: JSON.stringify(value) });

async function getPrefs(ctx: Ctx): Promise<Prefs> {
  const out = { ...DEFAULT_PREFS };
  for (const k of LABEL_KEYS) out[k] = (await setting<string>(ctx, `roundtable_${k}`)) || DEFAULT_PREFS[k];
  out.public_to_space_viewers = (await setting<boolean>(ctx, "roundtable_public_to_space_viewers")) === true;
  return out;
}
async function setPrefs(ctx: Ctx, next: Prefs): Promise<void> {
  for (const k of LABEL_KEYS) await setSetting(ctx, `roundtable_${k}`, next[k]);
  await setSetting(ctx, "roundtable_public_to_space_viewers", next.public_to_space_viewers);
}

function canParticipate(peer: Ctx["peer"], prefs: Prefs): boolean {
  return peer.is_sfi_editor || peer.is_owner || (prefs.public_to_space_viewers && peer.is_sfi_member);
}

// ----------------------------------------------------------------------------------------
// THE SPACE'S TABLES — messages, list items, item votes; named for this frame
// ----------------------------------------------------------------------------------------
const MESSAGES = "roundtable_messages";
const ITEMS = "roundtable_items";
const VOTES = "roundtable_votes";

const TABLES: FrameTableDecl[] = [
  {
    key: MESSAGES,
    title: "Roundtable Messages",
    description: "Chat messages for this roundtable.",
    schema: [
      { name: "user_id",    col_type: "text",    nullable: false, default_val: "" },
      { name: "user_name",  col_type: "text",    nullable: false, default_val: "" },
      { name: "body",       col_type: "text",    nullable: false, default_val: "" },
      { name: "created_at", col_type: "integer", nullable: false, default_val: "0" },
    ],
  },
  {
    key: ITEMS,
    title: "Roundtable Items",
    description: "Positive/negative list items, ranked by votes.",
    schema: [
      { name: "kind",       col_type: "text",    nullable: false, default_val: "positive" },
      { name: "user_id",    col_type: "text",    nullable: false, default_val: "" },
      { name: "user_name",  col_type: "text",    nullable: false, default_val: "" },
      { name: "body",       col_type: "text",    nullable: false, default_val: "" },
      { name: "created_at", col_type: "integer", nullable: false, default_val: "0" },
    ],
  },
  {
    key: VOTES,
    title: "Roundtable Votes",
    description: "One +1 per (item, user); toggled on and off.",
    schema: [
      { name: "item_id",    col_type: "text",    nullable: false, default_val: "" },
      { name: "user_id",    col_type: "text",    nullable: false, default_val: "" },
      { name: "user_name",  col_type: "text",    nullable: false, default_val: "" },
      { name: "created_at", col_type: "integer", nullable: false, default_val: "0" },
    ],
  },
];
declareTables(TABLES);

type Row = Record<string, unknown> & { id: string };

const rows = (ctx: Ctx, name: string) => ctx.table<Record<string, unknown>>(name);

/** What a new row of a table starts from: the defaults its schema declares. */
function defaults(name: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of TABLES.find((t) => t.key === name)?.schema ?? []) {
    if (c.default_val !== undefined) out[c.name] = c.col_type === "integer" ? Number(c.default_val) : c.default_val;
  }
  return out;
}

/** Write a row over what it held, stamped when it was made and when it changed. */
async function keep(ctx: Ctx, name: string, id: string | null, values: Record<string, unknown>): Promise<Row> {
  const was = id ? await rows(ctx, name).get(id) : null;
  const now = Date.now();
  return await rows(ctx, name).upsert({
    ...(was ?? { ...defaults(name), _created_at: now }),
    ...values,
    ...(id ? { id } : {}),
    _modified_at: now,
  });
}

const KIND_POSITIVE = "positive";
const KIND_NEGATIVE = "negative";
const VALID_KINDS = new Set([KIND_POSITIVE, KIND_NEGATIVE]);

const MESSAGE_HISTORY_LIMIT = 200;
const ITEM_LIMIT = 500;
const MESSAGE_MAX_LEN = 4000;
const ITEM_MAX_LEN = 280;

// ----------------------------------------------------------------------------------------
// QUERIES
// ----------------------------------------------------------------------------------------
const num = (v: unknown) => Number(v) || 0;

async function listMessages(ctx: Ctx) {
  return (await rows(ctx, MESSAGES).all())
    .sort((a, b) => (num(a.created_at) - num(b.created_at)) || (num(a._created_at) - num(b._created_at)))
    .slice(0, MESSAGE_HISTORY_LIMIT)
    .map((m) => ({
      id: m.id, user_id: m.user_id, user_name: m.user_name,
      body: m.body, created_at: m.created_at,
    }));
}

const votesOf = async (ctx: Ctx, itemId: string) => (await rows(ctx, VOTES).all()).filter((v) => v.item_id === itemId);

// Items with vote counts and a per-requester "already voted" flag, ranked: votes DESC,
// created_at DESC, then id DESC as a stable final tie-break.
function listItems(items: Row[], votes: Row[], kind: string, meUserId: string) {
  const counts = new Map<string, number>();
  const mine = new Set<string>();
  for (const v of votes) {
    const item = String(v.item_id);
    counts.set(item, (counts.get(item) ?? 0) + 1);
    if (meUserId && v.user_id === meUserId) mine.add(item);
  }
  return items
    .filter((r) => r.kind === kind)
    .slice(0, ITEM_LIMIT)
    .map((r) => ({
      id: r.id,
      user_id: r.user_id as string,
      user_name: r.user_name as string,
      body: r.body as string,
      created_at: r.created_at as number,
      votes: counts.get(r.id) ?? 0,
      i_voted: mine.has(r.id),
    }))
    .sort((a, b) =>
      (b.votes - a.votes) ||
      (b.created_at - a.created_at) ||
      (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

// ----------------------------------------------------------------------------------------
// WRITES — the participation and owner gates live here. `op` is the API path with the
// leading "/api/" stripped.
// ----------------------------------------------------------------------------------------
// What changed, never what it holds: each page reads again as whoever it is.
const tell = (ctx: Ctx, what: "messages" | "items" | "prefs") => ctx.push({ roundtable: what });

const json = (v: unknown, status = 200) => Response.json(v, { status });
const refuse = (status: number, error: string) => json({ error }, status);

async function body(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const v = JSON.parse(await request.text());
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

const WRITES = new Set(["send", "delete-message", "item-add", "item-delete", "item-vote", "settings"]);

async function handleWrite(ctx: Ctx, op: string, v: Record<string, unknown> | null): Promise<Response> {
  const peer = ctx.peer;
  const isOwner = peer.is_owner;

  // Every write requires canParticipate (see header) — readers get one uniform 403 here
  // instead of per-op checks.
  const current = await getPrefs(ctx);
  if (!canParticipate(peer, current)) return refuse(403, "read-only access");

  if (op === "send") {
    const text = sanitizeText(v?.body, MESSAGE_MAX_LEN);
    if (!text) return refuse(400, "body required");
    const userName = sanitizeText(peer.user_name, 80) || "user";
    const row = await keep(ctx, MESSAGES, null, {
      user_id: peer.user_id, user_name: userName, body: text, created_at: Date.now(),
    });
    tell(ctx, "messages");
    return json({ ok: true, id: row.id });
  }

  if (op === "delete-message") {
    const id = typeof v?.id === "string" ? v.id : "";
    if (!id) return refuse(400, "id required");
    const row = await rows(ctx, MESSAGES).get(id);
    if (!row) return refuse(404, "not found");
    if (!isOwner && row.user_id !== peer.user_id) return refuse(403, "forbidden");
    await rows(ctx, MESSAGES).delete(id);
    tell(ctx, "messages");
    return json({ ok: true });
  }

  // -------- LIST ITEMS --------
  if (op === "item-add") {
    const kind = sanitizeText(v?.kind, 20);
    if (!VALID_KINDS.has(kind)) return refuse(400, "invalid kind");
    const text = sanitizeText(v?.body, ITEM_MAX_LEN);
    if (!text) return refuse(400, "body required");
    const userName = sanitizeText(peer.user_name, 80) || "user";
    const now = Date.now();
    const row = await keep(ctx, ITEMS, null, {
      kind, user_id: peer.user_id, user_name: userName, body: text, created_at: now,
    });
    // Adding an item counts as the author's own +1 — sharing an idea is itself a vote
    // for it. One vote row per (item, user): key it by a stable id so it can never fork.
    await keep(ctx, VOTES, `${row.id}:${peer.user_id}`, {
      item_id: row.id, user_id: peer.user_id, user_name: userName, created_at: now,
    });
    tell(ctx, "items");
    return json({ ok: true, id: row.id });
  }

  if (op === "item-delete") {
    const id = typeof v?.id === "string" ? v.id : "";
    if (!id) return refuse(400, "id required");
    const row = await rows(ctx, ITEMS).get(id);
    if (!row) return refuse(404, "not found");
    if (!isOwner && row.user_id !== peer.user_id) return refuse(403, "forbidden");
    for (const vote of await votesOf(ctx, id)) await rows(ctx, VOTES).delete(vote.id);
    await rows(ctx, ITEMS).delete(id);
    tell(ctx, "items");
    return json({ ok: true });
  }

  // Toggle a +1 from the requesting user. Self-votes are allowed — the value of an item
  // is the count of distinct members who think it matters, including its author.
  if (op === "item-vote") {
    const id = typeof v?.id === "string" ? v.id : "";
    if (!id) return refuse(400, "id required");
    if (!(await rows(ctx, ITEMS).get(id))) return refuse(404, "not found");
    const userName = sanitizeText(peer.user_name, 80) || "user";
    // One vote row per (item, user), keyed by a stable id — toggling is get→delete/upsert
    // on that id, so concurrent votes can never fork it into two rows.
    const voteId = `${id}:${peer.user_id}`;
    const hadVote = !!(await rows(ctx, VOTES).get(voteId));
    if (hadVote) {
      await rows(ctx, VOTES).delete(voteId);
    } else {
      await keep(ctx, VOTES, voteId, {
        item_id: id, user_id: peer.user_id, user_name: userName, created_at: Date.now(),
      });
    }
    const votes = (await votesOf(ctx, id)).length;
    tell(ctx, "items");
    return json({ ok: true, votes, i_voted: !hadVote });
  }

  // -------- OWNER SETTINGS --------
  if (op === "settings") {
    if (!isOwner) return refuse(403, "owner only");
    const next: Prefs = {
      title: sanitizeText(v?.title, 80) || DEFAULT_PREFS.title,
      positive_label: sanitizeText(v?.positive_label, 40) || DEFAULT_PREFS.positive_label,
      negative_label: sanitizeText(v?.negative_label, 40) || DEFAULT_PREFS.negative_label,
      public_to_space_viewers: v?.public_to_space_viewers !== undefined
        ? v.public_to_space_viewers === true : current.public_to_space_viewers,
    };
    await setPrefs(ctx, next);
    tell(ctx, "prefs");
    return json({ ok: true, prefs: next });
  }

  return refuse(404, "unknown op");
}

// ----------------------------------------------------------------------------------------
// HANDLER
// ----------------------------------------------------------------------------------------
export default {
  async fetch(request: Request, ctx: Ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    const peer = ctx.peer;

    // The state as whoever is asking may see it, and who the door says that is.
    if (pathname === "/api/state" && request.method === "GET") {
      const prefs = await getPrefs(ctx);
      const items = await rows(ctx, ITEMS).all();
      const votes = await rows(ctx, VOTES).all();
      return json({
        prefs,
        messages: await listMessages(ctx),
        positives: listItems(items, votes, KIND_POSITIVE, peer.user_id),
        negatives: listItems(items, votes, KIND_NEGATIVE, peer.user_id),
        can_edit_settings: peer.is_owner,
        can_participate: canParticipate(peer, prefs),
        me: { user_id: peer.user_id, user_name: peer.user_name, is_owner: peer.is_owner },
        is_member: peer.is_sfi_member || peer.is_sfi_editor || peer.is_owner,
        color: peer.space_color,
      });
    }

    if (pathname.startsWith("/api/") && request.method === "POST") {
      const op = pathname.slice("/api/".length);
      if (WRITES.has(op)) return handleWrite(ctx, op, await body(request));
    }

    if (request.method === "GET") return ctx.file(pathname);
    return json({ error: "Not found.", code: "NOT_FOUND" }, 404);
  },
};
