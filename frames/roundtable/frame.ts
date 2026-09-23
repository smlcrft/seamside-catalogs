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
//     Every write requires canParticipate.
//   - Everyone else who reaches the frame — viewers while the toggle is off, and anyone
//     the frame is published to — follows along read-only.
//   - Messages, items and votes are the space's tables (roundtable_messages,
//     roundtable_items, roundtable_votes), synced with it; the prefs are frameSettings rows.
//
// Realtime: chat, item, vote, and pref changes are broadcast via pushToInstance(sfi_id, …).
// ----------------------------------------------------------------------------------------
import {
  log, parsePeerInfo, serveFileAtPath, serveHtmlShell, pushToInstance, onUiMessage,
  jsonReply, parseJsonBody, sanitizeText,
  declareTables, ensureTables, table, frameSettings,
} from "@frame-core";

// ----------------------------------------------------------------------------------------
// PREFS — owner-editable, frameSettings rows of the space. Every frame in the space shares
// that store, so each key carries this frame's name.
// ----------------------------------------------------------------------------------------
type Prefs = { title: string; positive_label: string; negative_label: string; public_to_space_viewers: boolean };
const DEFAULT_PREFS: Prefs = {
  title: "Roundtable",
  positive_label: "Positives",
  negative_label: "Negatives",
  public_to_space_viewers: false,
};
const LABEL_KEYS = ["title", "positive_label", "negative_label"] as const;

async function getPrefs(sfiId: string): Promise<Prefs> {
  const s = frameSettings(sfiId);
  const out = { ...DEFAULT_PREFS };
  for (const k of LABEL_KEYS) out[k] = (await s.get<string>(`roundtable_${k}`)) || DEFAULT_PREFS[k];
  out.public_to_space_viewers = (await s.get<boolean>("roundtable_public_to_space_viewers")) === true;
  return out;
}
async function setPrefs(sfiId: string, next: Prefs): Promise<void> {
  const s = frameSettings(sfiId);
  for (const k of LABEL_KEYS) await s.set(`roundtable_${k}`, next[k]);
  await s.set("roundtable_public_to_space_viewers", next.public_to_space_viewers);
}

function canParticipate(peer: { is_sfi_editor: boolean; is_sfi_member: boolean }, prefs: Prefs): boolean {
  return peer.is_sfi_editor || (prefs.public_to_space_viewers && peer.is_sfi_member);
}

// ----------------------------------------------------------------------------------------
// THE SPACE'S TABLES — messages, list items, item votes; named for this frame
// ----------------------------------------------------------------------------------------
declareTables([
  {
    key: "roundtable_messages",
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
    key: "roundtable_items",
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
    key: "roundtable_votes",
    title: "Roundtable Votes",
    description: "One +1 per (item, user); toggled on and off.",
    schema: [
      { name: "item_id",    col_type: "text",    nullable: false, default_val: "" },
      { name: "user_id",    col_type: "text",    nullable: false, default_val: "" },
      { name: "user_name",  col_type: "text",    nullable: false, default_val: "" },
      { name: "created_at", col_type: "integer", nullable: false, default_val: "0" },
    ],
  },
]);

type Tbl = ReturnType<typeof table>;
interface Tables { messages: Tbl; items: Tbl; votes: Tbl; }

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
async function listMessages(t: Tables) {
  const { rows } = await t.messages.query({
    order_by: [{ col: "created_at" }, { col: "_created_at" }],
    limit: MESSAGE_HISTORY_LIMIT,
  });
  return rows.map((m) => ({
    id: m._row_id, user_id: m.user_id, user_name: m.user_name,
    body: m.body, created_at: m.created_at,
  }));
}

// Items with vote counts and a per-requester "already voted" flag. The old SQL was a
// LEFT JOIN + GROUP BY + ORDER BY on the aggregate — now: countBy the votes table,
// query the requester's own votes, and rank in JS: votes DESC, created_at DESC,
// then _row_id DESC as a stable final tie-break.
async function listItems(t: Tables, kind: string, meUserId: string) {
  const { rows: items } = await t.items.query({ where: { kind }, limit: ITEM_LIMIT });
  if (items.length === 0) return [];
  const ids = items.map((i) => i._row_id);
  const counts = new Map<string, number>();
  for (const g of await t.votes.countBy("item_id", { where: { item_id: { in: ids } } })) {
    counts.set(g.item_id as string, Number(g._count));
  }
  const mine = new Set<string>();
  if (meUserId) {
    const { rows } = await t.votes.query({ where: { user_id: meUserId, item_id: { in: ids } } });
    for (const r of rows) mine.add(r.item_id as string);
  }
  return items
    .map((r) => ({
      id: r._row_id,
      user_id: r.user_id as string,
      user_name: r.user_name as string,
      body: r.body as string,
      created_at: r.created_at as number,
      votes: counts.get(r._row_id) ?? 0,
      i_voted: mine.has(r._row_id),
    }))
    .sort((a, b) =>
      (b.votes - a.votes) ||
      (b.created_at - a.created_at) ||
      (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

// ----------------------------------------------------------------------------------------
// SHARED WRITE LOGIC — one implementation behind both entry points (the HTTP POST arms
// and the bus dispatcher below); the participation/owner gates live here so the two
// paths can never drift. `op` is the API path with the leading "/api/" stripped.
// ----------------------------------------------------------------------------------------
type WritePeer = ReturnType<typeof parsePeerInfo>;
type WriteResult = { status: number; body: Record<string, unknown> };

async function handleWrite(sfiId: string, op: string, v: Record<string, unknown> | null, peer: WritePeer): Promise<WriteResult> {
  const ready = ensureTables(peer);
  if (!ready.ready) return { status: 503, body: { error: "table not bound" } };
  const t: Tables = {
    messages: table("roundtable_messages", sfiId),
    items: table("roundtable_items", sfiId),
    votes: table("roundtable_votes", sfiId),
  };
  const isOwner = peer.is_owner;

  // Every write requires canParticipate (see header) — readers get one uniform 403 here
  // instead of per-op checks.
  const current = await getPrefs(sfiId);
  if (!canParticipate(peer, current)) return { status: 403, body: { error: "read-only access" } };

  if (op === "send") {
    const text = sanitizeText(v?.body, MESSAGE_MAX_LEN);
    if (!text) return { status: 400, body: { error: "body required" } };
    const userName = sanitizeText(peer.user_name, 80) || "user";
    const now = Date.now();
    const { row_id } = await t.messages.upsert(null, {
      user_id: peer.user_id, user_name: userName, body: text, created_at: now,
    });
    const msg = { id: row_id, user_id: peer.user_id, user_name: userName, body: text, created_at: now };
    pushToInstance(sfiId, { type: "rt_message", sfi_id: sfiId, message: msg });
    return { status: 200, body: { ok: true, id: row_id } };
  }

  if (op === "delete-message") {
    const id = typeof v?.id === "string" ? v.id : "";
    if (!id) return { status: 400, body: { error: "id required" } };
    const row = await t.messages.get(id);
    if (!row) return { status: 404, body: { error: "not found" } };
    if (!isOwner && row.user_id !== peer.user_id) return { status: 403, body: { error: "forbidden" } };
    await t.messages.delete(id);
    pushToInstance(sfiId, { type: "rt_message_delete", sfi_id: sfiId, id });
    return { status: 200, body: { ok: true } };
  }

  // -------- LIST ITEMS --------
  if (op === "item-add") {
    const kind = sanitizeText(v?.kind, 20);
    if (!VALID_KINDS.has(kind)) return { status: 400, body: { error: "invalid kind" } };
    const text = sanitizeText(v?.body, ITEM_MAX_LEN);
    if (!text) return { status: 400, body: { error: "body required" } };
    const userName = sanitizeText(peer.user_name, 80) || "user";
    const now = Date.now();
    const { row_id } = await t.items.upsert(null, {
      kind, user_id: peer.user_id, user_name: userName, body: text, created_at: now,
    });
    // Adding an item counts as the author's own +1 — sharing an idea is itself a vote
    // for it. Other viewers will receive votes=1 / i_voted=false (their personal flag
    // gets corrected on receive based on whether they authored the item).
    // One vote row per (item, user): key it by a stable id so it can never fork.
    await t.votes.upsert(`${row_id}:${peer.user_id}`, {
      item_id: row_id, user_id: peer.user_id, user_name: userName, created_at: now,
    });
    const item = {
      id: row_id, user_id: peer.user_id, user_name: userName,
      body: text, created_at: now, votes: 1, i_voted: true,
    };
    pushToInstance(sfiId, { type: "rt_item_add", sfi_id: sfiId, kind, item });
    return { status: 200, body: { ok: true, id: row_id } };
  }

  if (op === "item-delete") {
    const id = typeof v?.id === "string" ? v.id : "";
    if (!id) return { status: 400, body: { error: "id required" } };
    const row = await t.items.get(id);
    if (!row) return { status: 404, body: { error: "not found" } };
    if (!isOwner && row.user_id !== peer.user_id) return { status: 403, body: { error: "forbidden" } };
    await t.votes.deleteWhere({ item_id: id });
    await t.items.delete(id);
    pushToInstance(sfiId, { type: "rt_item_delete", sfi_id: sfiId, kind: row.kind, id });
    return { status: 200, body: { ok: true } };
  }

  // Toggle a +1 from the requesting user. Self-votes are allowed — the value of an item
  // is the count of distinct members who think it matters, including its author.
  if (op === "item-vote") {
    const id = typeof v?.id === "string" ? v.id : "";
    if (!id) return { status: 400, body: { error: "id required" } };
    const row = await t.items.get(id);
    if (!row) return { status: 404, body: { error: "not found" } };
    const userName = sanitizeText(peer.user_name, 80) || "user";
    // One vote row per (item, user), keyed by a stable id — toggling is get→delete/upsert
    // on that id, so concurrent votes can never fork it into two rows.
    const voteId = `${id}:${peer.user_id}`;
    const hadVote = !!(await t.votes.get(voteId));
    if (hadVote) {
      await t.votes.delete(voteId);
    } else {
      await t.votes.upsert(voteId, {
        item_id: id, user_id: peer.user_id, user_name: userName, created_at: Date.now(),
      });
    }
    const votes = (await t.votes.query({ where: { item_id: id }, limit: 1 })).total;
    pushToInstance(sfiId, {
      type: "rt_item_vote", sfi_id: sfiId, kind: row.kind, id,
      votes,
    });
    return { status: 200, body: { ok: true, votes, i_voted: !hadVote } };
  }

  // -------- OWNER SETTINGS --------
  if (op === "settings") {
    if (!isOwner) return { status: 403, body: { error: "owner only" } };
    const title = sanitizeText(v?.title, 80) || DEFAULT_PREFS.title;
    const positiveLabel = sanitizeText(v?.positive_label, 40) || DEFAULT_PREFS.positive_label;
    const negativeLabel = sanitizeText(v?.negative_label, 40) || DEFAULT_PREFS.negative_label;
    const next: Prefs = {
      title,
      positive_label: positiveLabel,
      negative_label: negativeLabel,
      public_to_space_viewers: v?.public_to_space_viewers !== undefined
        ? v.public_to_space_viewers === true : current.public_to_space_viewers,
    };
    await setPrefs(sfiId, next);
    pushToInstance(sfiId, { type: "rt_prefs", sfi_id: sfiId, prefs: next });
    return { status: 200, body: { ok: true, prefs: next } };
  }

  return { status: 404, body: { error: "unknown op" } };
}

// ----------------------------------------------------------------------------------------
// BUS DISPATCHER — the frontend's write path (frame.busSend → BusUiToFrame). `peer` is the
// sender's platform-resolved identity, same shape as parsePeerInfo; the gates live inside
// handleWrite. Denials are logged, not answered.
// ----------------------------------------------------------------------------------------
onUiMessage(async (sfiId, data, peer) => {
  if (!sfiId || typeof data !== "object" || data === null) return;
  const d = data as Record<string, unknown>;
  const op = typeof d.op === "string" ? d.op : "";
  const r = await handleWrite(sfiId, op, d, peer);
  if (r.status !== 200) log(`roundtable: bus op ${op} → ${r.status} (${JSON.stringify(r.body)})`);
});

// ----------------------------------------------------------------------------------------
// HANDLER
// ----------------------------------------------------------------------------------------
self.onNetworkRequest = async (replyPort, reqPath, method, _headers, query, body, cookies) => {
  const peer = parsePeerInfo(query, cookies);
  const sfiId = peer.sfi_id;
  const isOwner = peer.is_owner;

  // UI shell — same HTML for everyone; the iframe attempts /api/state and falls back to a
  // private-frame notice on 403 (truly anonymous viewers or non-members on a non-public
  // Roundtable).
  if (reqPath === "/index.html" && method === "GET") {
    // The script is inline in index.html as <script type="module"> so it can import
    // /lib/js/framelib.js — inlineJs would flatten that to a non-module <script>, which
    // can't use ES module imports, so it's intentionally omitted here.
    return serveHtmlShell(replyPort, new URL("./public/index.html", import.meta.url), {
      peer,
      inlineCss: ["index.css"],
    });
  }

  if (reqPath.startsWith("/api/")) {
    if (!sfiId) return jsonReply(replyPort, 400, { error: "sfi_id missing" });

    if (reqPath === "/api/state" && method === "GET") {
      const ready = ensureTables(peer);
      if (!ready.ready) return jsonReply(replyPort, 503, { error: "table not bound" });
      const t: Tables = {
        messages: table("roundtable_messages", sfiId),
        items: table("roundtable_items", sfiId),
        votes: table("roundtable_votes", sfiId),
      };
      const prefs = await getPrefs(sfiId);
      return jsonReply(replyPort, 200, {
        prefs,
        messages: await listMessages(t),
        positives: await listItems(t, KIND_POSITIVE, peer.user_id),
        negatives: await listItems(t, KIND_NEGATIVE, peer.user_id),
        can_edit_settings: isOwner,
        can_participate: canParticipate(peer, prefs),
        me: { user_id: peer.user_id, user_name: peer.user_name, is_owner: isOwner },
      });
    }

    // HTTP arms kept for API compatibility (older viewers, web viewer fallback); the
    // frame's own UI writes over the bus (see the dispatcher above). Same logic, same
    // gates, either way.
    if (method === "POST") {
      const op = reqPath.slice("/api/".length);
      if (op === "send" || op === "delete-message" || op === "item-add"
        || op === "item-delete" || op === "item-vote" || op === "settings") {
        const r = await handleWrite(sfiId, op, parseJsonBody<Record<string, unknown>>(body), peer);
        return jsonReply(replyPort, r.status, r.body);
      }
    }
  }

  if (method === "GET") {
    return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url));
  }
  replyPort.postMessage({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Not found.", code: "NOT_FOUND" }) });
};

log("Roundtable frame is up.");
