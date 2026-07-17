// ----------------------------------------------------------------------------------------
// Roundtable — Per-placement private discussion + two prioritized lists.
//
// Auth model (two independent owner toggles):
//   - `public_to_space_viewers` — when true, Viewer-role members of the space (members
//     with is_sfi_editor=false) are opted into full participation: chat, add items, vote,
//     delete their own. Editors / owners (is_sfi_editor=true) participate regardless.
//     When OFF, Viewer-role members can still READ this Roundtable (they're members of
//     the space) but cannot mutate anything.
//   - `public_read_view` — when true, even non-members (empty user_id from anonymous FAT
//     visitors, or signed-in users whose only access is a bookmark to this SFI) can READ
//     the channel — no mutations of any kind.
//
//   Resolution:
//     canParticipate = isSfiEditor OR (publicToSpaceViewers AND isSfiMember)
//     canRead        = canParticipate OR isSfiMember OR publicReadView
//     /api/state requires canRead. Every mutation route requires canParticipate.
//     /api/settings additionally requires isOwner.
//   - Owners can additionally delete anyone's message or item.
//   - Messages/items/votes live in per-placement LocalTables (encrypted at rest,
//     host-local, not peer-synced) — each placement is its own roundtable.
//   - Non-members never participate; the participation toggle only governs Viewer-role
//     space members, not anonymous / bookmark visitors. Anonymous read access is the
//     separate `public_read_view` toggle.
//
// Realtime: chat, item, vote, and pref changes are broadcast via pushToInstance(sfi_id, …);
// framecore handles viewer tracking, including anonymous read-only viewers.
// ----------------------------------------------------------------------------------------
import {
  log, parsePeerInfo, serveFileAtPath, serveHtmlShell, pushToInstance,
  jsonReply, parseJsonBody, sanitizeText,
  loadJsonFile, saveJsonFile, declareTables, ensureTables, table,
} from "@frame-core";

// ----------------------------------------------------------------------------------------
// PER-PLACEMENT PREFS — owner-editable frame settings, stored as JSON
// ----------------------------------------------------------------------------------------
type Prefs = {
  title: string;
  theme: string;
  positive_label: string;
  negative_label: string;
  // When true, Viewer-role space members (members of this space whose role is below
  // Contributor) can fully participate: chat, add items, vote, delete their own. Off by
  // default — Viewers can still READ the channel because they're space members, but
  // can't mutate anything. Editors/Owners participate regardless of this toggle.
  public_to_space_viewers: boolean;
  // When true, non-members (anonymous FAT visitors AND signed-in users whose only
  // access is a bookmark to this SFI) can read the channel in a fully read-only view.
  // They can never post, vote, or delete. Default off. Combine with
  // `public_to_space_viewers` to open up writes to Viewer-role members while keeping a
  // read-only window for outsiders.
  public_read_view: boolean;
};
const DEFAULT_PREFS: Prefs = {
  title: "Roundtable",
  theme: "c1",
  positive_label: "Positives",
  negative_label: "Negatives",
  public_to_space_viewers: false,
  public_read_view: false,
};
const VALID_THEMES = new Set(["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10", "c11", "c12"]);

const allPrefs: Record<string, Prefs> = loadJsonFile(import.meta.url, "prefs.json", {});
function getPrefs(sfiId: string): Prefs {
  // Note: existing placements with the legacy `public_to_users` field are NOT migrated —
  // the field is just ignored. The new `public_to_space_viewers` toggle defaults to off,
  // so previously-elevated participants drop back to the default access tier and the
  // owner can re-enable participation under the new clearer semantics if they want it.
  return { ...DEFAULT_PREFS, ...(allPrefs[sfiId] ?? {}) };
}
function setPrefs(sfiId: string, next: Prefs): void {
  allPrefs[sfiId] = next;
  saveJsonFile(import.meta.url, "prefs.json", allPrefs);
}

// ----------------------------------------------------------------------------------------
// LOCALTABLES — messages, list items, item votes; per-placement (no sfi_id columns)
// ----------------------------------------------------------------------------------------
declareTables([
  {
    key: "messages",
    title: "Roundtable Messages",
    description: "Chat messages for this roundtable.",
    local: true,
    schema: [
      { name: "user_id",    col_type: "text",    nullable: false, default_val: "" },
      { name: "user_name",  col_type: "text",    nullable: false, default_val: "" },
      { name: "body",       col_type: "text",    nullable: false, default_val: "" },
      { name: "created_at", col_type: "integer", nullable: false, default_val: "0" },
    ],
  },
  {
    key: "items",
    title: "Roundtable Items",
    description: "Positive/negative list items, ranked by votes.",
    local: true,
    schema: [
      { name: "kind",       col_type: "text",    nullable: false, default_val: "positive" },
      { name: "user_id",    col_type: "text",    nullable: false, default_val: "" },
      { name: "user_name",  col_type: "text",    nullable: false, default_val: "" },
      { name: "body",       col_type: "text",    nullable: false, default_val: "" },
      { name: "created_at", col_type: "integer", nullable: false, default_val: "0" },
    ],
  },
  {
    key: "votes",
    title: "Roundtable Votes",
    description: "One +1 per (item, user); toggled on and off.",
    local: true,
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
// HANDLER
// ----------------------------------------------------------------------------------------
self.onNetworkRequest = async (replyPort, reqPath, method, _headers, query, body, cookies) => {
  const peer = parsePeerInfo(query, cookies);
  const sfiId = peer.sfi_id;
  const isSfiMember = peer.is_sfi_member;
  const isSfiEditor = peer.is_sfi_editor;
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

  // Auth — two-tier:
  //   canParticipate: full read+write (chat, items, votes). SFI editors (role > Viewer)
  //     always; Viewer-role space members when the owner has turned on
  //     `public_to_space_viewers`. Non-members never participate.
  //   canRead:        canParticipate OR isSfiMember (so Viewer-role members can always
  //                   follow along read-only) OR (public_read_view AND any visitor).
  // Mutation routes additionally short-circuit with `if (!canParticipate)` below so a
  // read-only viewer that tries to POST gets a clean 403 instead of an unauthorized write.
  const authPrefs = sfiId ? getPrefs(sfiId) : DEFAULT_PREFS;
  const publicToSpaceViewers = authPrefs.public_to_space_viewers === true;
  const publicReadView = authPrefs.public_read_view === true;
  const canParticipate = isSfiEditor || (publicToSpaceViewers && isSfiMember);
  const canRead = canParticipate || isSfiMember || publicReadView;
  if (!canRead && reqPath.startsWith("/api/")) {
    return jsonReply(replyPort, 403, { error: "private frame" });
  }

  if (reqPath.startsWith("/api/")) {
    if (!sfiId) return jsonReply(replyPort, 400, { error: "sfi_id missing" });
    // Local tables are always ready; the gate stays so a future graduation to
    // synced tables needs no code change here.
    const ready = ensureTables(peer);
    if (!ready.ready) return jsonReply(replyPort, 503, { error: "table not bound" });
    const t: Tables = {
      messages: table("messages", sfiId),
      items: table("items", sfiId),
      votes: table("votes", sfiId),
    };

    if (reqPath === "/api/state" && method === "GET") {
      return jsonReply(replyPort, 200, {
        prefs: getPrefs(sfiId),
        messages: await listMessages(t),
        positives: await listItems(t, KIND_POSITIVE, peer.user_id),
        negatives: await listItems(t, KIND_NEGATIVE, peer.user_id),
        can_edit_settings: isOwner,
        can_participate: canParticipate,
        me: { user_id: peer.user_id, user_name: peer.user_name, is_owner: isOwner },
      });
    }

    // Every mutation route below requires canParticipate. Read-only viewers (public_read_view
    // with no participation rights) get a single uniform 403 here instead of per-route checks.
    if (!canParticipate) {
      return jsonReply(replyPort, 403, { error: "read-only access" });
    }

    if (reqPath === "/api/send" && method === "POST") {
      const v = parseJsonBody<{ body?: unknown }>(body);
      const text = sanitizeText(v?.body, MESSAGE_MAX_LEN);
      if (!text) return jsonReply(replyPort, 400, { error: "body required" });
      const userName = sanitizeText(peer.user_name, 80) || "user";
      const now = Date.now();
      const { row_id } = await t.messages.upsert(null, {
        user_id: peer.user_id, user_name: userName, body: text, created_at: now,
      });
      const msg = { id: row_id, user_id: peer.user_id, user_name: userName, body: text, created_at: now };
      pushToInstance(sfiId, { type: "rt_message", sfi_id: sfiId, message: msg });
      return jsonReply(replyPort, 200, { ok: true, id: row_id });
    }

    if (reqPath === "/api/delete-message" && method === "POST") {
      const v = parseJsonBody<{ id?: unknown }>(body);
      const id = typeof v?.id === "string" ? v.id : "";
      if (!id) return jsonReply(replyPort, 400, { error: "id required" });
      const row = await t.messages.get(id);
      if (!row) return jsonReply(replyPort, 404, { error: "not found" });
      if (!isOwner && row.user_id !== peer.user_id) return jsonReply(replyPort, 403, { error: "forbidden" });
      await t.messages.delete(id);
      pushToInstance(sfiId, { type: "rt_message_delete", sfi_id: sfiId, id });
      return jsonReply(replyPort, 200, { ok: true });
    }

    // -------- LIST ITEMS --------
    if (reqPath === "/api/item-add" && method === "POST") {
      const v = parseJsonBody<{ kind?: unknown; body?: unknown }>(body);
      const kind = sanitizeText(v?.kind, 20);
      if (!VALID_KINDS.has(kind)) return jsonReply(replyPort, 400, { error: "invalid kind" });
      const text = sanitizeText(v?.body, ITEM_MAX_LEN);
      if (!text) return jsonReply(replyPort, 400, { error: "body required" });
      const userName = sanitizeText(peer.user_name, 80) || "user";
      const now = Date.now();
      const { row_id } = await t.items.upsert(null, {
        kind, user_id: peer.user_id, user_name: userName, body: text, created_at: now,
      });
      // Adding an item counts as the author's own +1 — sharing an idea is itself a vote
      // for it. Other viewers will receive votes=1 / i_voted=false (their personal flag
      // gets corrected on receive based on whether they authored the item).
      await t.votes.upsert(null, {
        item_id: row_id, user_id: peer.user_id, user_name: userName, created_at: now,
      });
      const item = {
        id: row_id, user_id: peer.user_id, user_name: userName,
        body: text, created_at: now, votes: 1, i_voted: true,
      };
      pushToInstance(sfiId, { type: "rt_item_add", sfi_id: sfiId, kind, item });
      return jsonReply(replyPort, 200, { ok: true, id: row_id });
    }

    if (reqPath === "/api/item-delete" && method === "POST") {
      const v = parseJsonBody<{ id?: unknown }>(body);
      const id = typeof v?.id === "string" ? v.id : "";
      if (!id) return jsonReply(replyPort, 400, { error: "id required" });
      const row = await t.items.get(id);
      if (!row) return jsonReply(replyPort, 404, { error: "not found" });
      if (!isOwner && row.user_id !== peer.user_id) return jsonReply(replyPort, 403, { error: "forbidden" });
      await t.votes.deleteWhere({ item_id: id });
      await t.items.delete(id);
      pushToInstance(sfiId, { type: "rt_item_delete", sfi_id: sfiId, kind: row.kind, id });
      return jsonReply(replyPort, 200, { ok: true });
    }

    // Toggle a +1 from the requesting user. Self-votes are allowed — the value of an item
    // is the count of distinct members who think it matters, including its author.
    if (reqPath === "/api/item-vote" && method === "POST") {
      const v = parseJsonBody<{ id?: unknown }>(body);
      const id = typeof v?.id === "string" ? v.id : "";
      if (!id) return jsonReply(replyPort, 400, { error: "id required" });
      const row = await t.items.get(id);
      if (!row) return jsonReply(replyPort, 404, { error: "not found" });
      const userName = sanitizeText(peer.user_name, 80) || "user";
      const { rows: existing } = await t.votes.query({
        where: { item_id: id, user_id: peer.user_id }, limit: 1,
      });
      if (existing.length > 0) {
        await t.votes.delete(existing[0]._row_id);
      } else {
        await t.votes.upsert(null, {
          item_id: id, user_id: peer.user_id, user_name: userName, created_at: Date.now(),
        });
      }
      const votes = (await t.votes.query({ where: { item_id: id }, limit: 1 })).total;
      pushToInstance(sfiId, {
        type: "rt_item_vote", sfi_id: sfiId, kind: row.kind, id,
        votes,
      });
      return jsonReply(replyPort, 200, { ok: true, votes, i_voted: existing.length === 0 });
    }

    // -------- OWNER SETTINGS --------
    if (reqPath === "/api/settings" && method === "POST") {
      if (!isOwner) return jsonReply(replyPort, 403, { error: "owner only" });
      const v = parseJsonBody<{ title?: unknown; theme?: unknown; positive_label?: unknown; negative_label?: unknown; public_to_space_viewers?: unknown; public_read_view?: unknown }>(body);
      const title = sanitizeText(v?.title, 80) || DEFAULT_PREFS.title;
      const themeRaw = sanitizeText(v?.theme, 4);
      const positiveLabel = sanitizeText(v?.positive_label, 40) || DEFAULT_PREFS.positive_label;
      const negativeLabel = sanitizeText(v?.negative_label, 40) || DEFAULT_PREFS.negative_label;
      const next: Prefs = {
        title,
        theme: VALID_THEMES.has(themeRaw) ? themeRaw : DEFAULT_PREFS.theme,
        positive_label: positiveLabel,
        negative_label: negativeLabel,
        public_to_space_viewers: v?.public_to_space_viewers === true,
        public_read_view: v?.public_read_view === true,
      };
      setPrefs(sfiId, next);
      pushToInstance(sfiId, { type: "rt_prefs", sfi_id: sfiId, prefs: next });
      return jsonReply(replyPort, 200, { ok: true, prefs: next });
    }
  }

  if (method === "GET") {
    return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url));
  }
  replyPort.postMessage({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Not found.", code: "NOT_FOUND" }) });
};

log("Roundtable frame is up.");
