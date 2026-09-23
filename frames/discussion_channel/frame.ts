// ----------------------------------------------------------------------------------------
// Discussion Channel — a realtime chat channel for a space.
//
// Auth model:
//   - Editors (collaborator and up) chat, react, and delete their own messages; the owner
//     can also delete anyone's, rename the channel and flip the viewers toggle.
//   - `public_to_space_viewers` (owner-only, off by default): when on, Viewer-role members
//     of the space participate like editors — chat, react, delete their own.
//       canParticipate = isSfiEditor OR (publicToSpaceViewers AND isSfiMember)
//     Every write requires canParticipate.
//   - Everyone else who reaches the frame — viewers while the toggle is off, and anyone
//     the frame is published to — reads the channel live.
//   - Messages and reactions are the space's tables, discussion_messages and
//     discussion_reactions, synced with the space; the title is a frameSettings row.
//
// Realtime: new messages, deletions, reaction toggles, and pref changes are broadcast via
// pushToInstance(sfi_id, …).
// ----------------------------------------------------------------------------------------
import {
  log, parsePeerInfo, serveFileAtPath, serveHtmlShell, pushToInstance, onUiMessage,
  jsonReply, parseJsonBody, sanitizeText,
  declareTables, ensureTables, table, frameSettings,
} from "@frame-core";

// ----------------------------------------------------------------------------------------
// PREFS (channel name, viewers toggle) — frameSettings rows of the space; every frame in
// the space shares that store, so the keys carry this frame's name.
// ----------------------------------------------------------------------------------------
type Prefs = { title: string; public_to_space_viewers: boolean };
const DEFAULT_PREFS: Prefs = { title: "Discussion", public_to_space_viewers: false };

async function getPrefs(sfiId: string): Promise<Prefs> {
  const s = frameSettings(sfiId);
  const title = await s.get<string>("discussion_title");
  const viewers = await s.get<boolean>("discussion_viewers_participate");
  return { title: title || DEFAULT_PREFS.title, public_to_space_viewers: viewers === true };
}
async function setPrefs(sfiId: string, next: Prefs): Promise<void> {
  const s = frameSettings(sfiId);
  await s.set("discussion_title", next.title);
  await s.set("discussion_viewers_participate", next.public_to_space_viewers);
}

function canParticipate(peer: { is_sfi_editor: boolean; is_sfi_member: boolean }, prefs: Prefs): boolean {
  return peer.is_sfi_editor || (prefs.public_to_space_viewers && peer.is_sfi_member);
}

// ----------------------------------------------------------------------------------------
// THE SPACE'S TABLES — named for this frame, so no other frame's rows land in them
// ----------------------------------------------------------------------------------------
declareTables([
  {
    key: "discussion_messages",
    title: "Channel Messages",
    description: "Messages in this space's discussion channel.",
    schema: [
      { name: "user_id",    col_type: "text",    nullable: false, default_val: "" },
      { name: "user_name",  col_type: "text",    nullable: false, default_val: "" },
      { name: "body",       col_type: "text",    nullable: false, default_val: "" },
      { name: "created_at", col_type: "integer", nullable: false, default_val: "0" },
    ],
  },
  {
    key: "discussion_reactions",
    title: "Channel Reactions",
    description: "Per-user reaction icons on messages.",
    schema: [
      { name: "message_id", col_type: "text",    nullable: false, default_val: "" },
      { name: "user_id",    col_type: "text",    nullable: false, default_val: "" },
      { name: "user_name",  col_type: "text",    nullable: false, default_val: "" },
      { name: "icon",       col_type: "text",    nullable: false, default_val: "" },
      { name: "created_at", col_type: "integer", nullable: false, default_val: "0" },
    ],
  },
]);

type Tbl = ReturnType<typeof table>;

// Curated allow-list of Phosphor Light icons used as reactions.
const REACTION_ICONS = [
  "thumbs-up", "heart", "fire", "smiley", "hand-waving",
  "sparkle", "lightning", "rocket", "confetti", "star",
] as const;
const REACTION_ICON_SET = new Set<string>(REACTION_ICONS);

const HISTORY_LIMIT = 200;

// ----------------------------------------------------------------------------------------
// QUERIES
// ----------------------------------------------------------------------------------------
async function listMessages(messages: Tbl, reactions: Tbl) {
  const { rows: msgs } = await messages.query({
    order_by: [{ col: "created_at" }, { col: "_created_at" }],
    limit: HISTORY_LIMIT,
  });
  if (msgs.length === 0) return [];
  const ids = msgs.map((m) => m._row_id);
  // Batch-load this page's reactions in one query, then group in JS.
  const { rows: rxs } = await reactions.query({
    where: { message_id: { in: ids } },
    order_by: [{ col: "created_at" }, { col: "_created_at" }],
  });
  const byMsg = new Map<string, Array<{ user_id: string; user_name: string; icon: string }>>();
  for (const r of rxs) {
    let bucket = byMsg.get(r.message_id as string);
    if (!bucket) { bucket = []; byMsg.set(r.message_id as string, bucket); }
    bucket.push({ user_id: r.user_id as string, user_name: r.user_name as string, icon: r.icon as string });
  }
  return msgs.map((m) => ({
    id: m._row_id, user_id: m.user_id, user_name: m.user_name,
    body: m.body, created_at: m.created_at,
    reactions: byMsg.get(m._row_id) ?? [],
  }));
}

async function reactionsFor(reactions: Tbl, messageId: string) {
  const { rows } = await reactions.query({
    where: { message_id: messageId },
    order_by: [{ col: "created_at" }, { col: "_created_at" }],
  });
  return rows.map((r) => ({ user_id: r.user_id, user_name: r.user_name, icon: r.icon }));
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
  const messages = table("discussion_messages", sfiId);
  const reactions = table("discussion_reactions", sfiId);
  const isOwner = peer.is_owner;

  // Every write requires canParticipate (see header) — readers get one uniform 403 here
  // instead of per-op checks.
  const current = await getPrefs(sfiId);
  if (!canParticipate(peer, current)) return { status: 403, body: { error: "read-only access" } };

  if (op === "send") {
    const text = sanitizeText(v?.body, 4000);
    if (!text) return { status: 400, body: { error: "body required" } };
    const userName = sanitizeText(peer.user_name, 80) || "user";
    const now = Date.now();
    const { row_id } = await messages.upsert(null, {
      user_id: peer.user_id, user_name: userName, body: text, created_at: now,
    });
    const msg = { id: row_id, user_id: peer.user_id, user_name: userName, body: text, created_at: now, reactions: [] };
    pushToInstance(sfiId, { type: "dc_message", sfi_id: sfiId, message: msg });
    return { status: 200, body: { ok: true, id: row_id } };
  }

  if (op === "delete") {
    const id = typeof v?.id === "string" ? v.id : "";
    if (!id) return { status: 400, body: { error: "id required" } };
    const row = await messages.get(id);
    if (!row) return { status: 404, body: { error: "not found" } };
    if (!isOwner && row.user_id !== peer.user_id) return { status: 403, body: { error: "forbidden" } };
    await reactions.deleteWhere({ message_id: id });
    await messages.delete(id);
    pushToInstance(sfiId, { type: "dc_delete", sfi_id: sfiId, id });
    return { status: 200, body: { ok: true } };
  }

  // Toggle a reaction: remove if this user already reacted with this icon, otherwise add.
  if (op === "react") {
    const mid = typeof v?.message_id === "string" ? v.message_id : "";
    const icon = sanitizeText(v?.icon, 40);
    if (!mid || !icon || !REACTION_ICON_SET.has(icon)) return { status: 400, body: { error: "invalid" } };
    if (!(await messages.get(mid))) return { status: 404, body: { error: "not found" } };
    const userName = sanitizeText(peer.user_name, 80) || "user";
    // One reaction row per (message, user, icon), keyed by a stable id — toggling is
    // get→delete/upsert on that id, so concurrent taps can't fork it into duplicates.
    const rxId = `${mid}:${peer.user_id}:${icon}`;
    if (await reactions.get(rxId)) {
      await reactions.delete(rxId);
    } else {
      await reactions.upsert(rxId, {
        message_id: mid, user_id: peer.user_id, user_name: userName,
        icon, created_at: Date.now(),
      });
    }
    const rx = await reactionsFor(reactions, mid);
    pushToInstance(sfiId, { type: "dc_reactions", sfi_id: sfiId, message_id: mid, reactions: rx });
    return { status: 200, body: { ok: true } };
  }

  // Owner-only: the channel's name and the viewers toggle (it decides who writes).
  if (op === "settings") {
    if (!isOwner) return { status: 403, body: { error: "owner only" } };
    const next: Prefs = {
      title: sanitizeText(v?.title, 80) || current.title,
      public_to_space_viewers: v?.public_to_space_viewers !== undefined
        ? v.public_to_space_viewers === true : current.public_to_space_viewers,
    };
    await setPrefs(sfiId, next);
    pushToInstance(sfiId, { type: "dc_prefs", sfi_id: sfiId, prefs: next });
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
  if (r.status !== 200) log(`discussion_channel: bus op ${op} → ${r.status} (${JSON.stringify(r.body)})`);
});

// ----------------------------------------------------------------------------------------
// HANDLER
// ----------------------------------------------------------------------------------------
self.onNetworkRequest = async (replyPort, reqPath, method, _headers, query, body, cookies) => {
  const peer = parsePeerInfo(query, cookies);
  const sfiId = peer.sfi_id;
  const isOwner = peer.is_owner;

  // UI shell — anon viewers receive the same HTML; the iframe checks window.__peer
  // and renders the private notice without making any API calls.
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
      const messages = table("discussion_messages", sfiId);
      const reactions = table("discussion_reactions", sfiId);
      const prefs = await getPrefs(sfiId);
      return jsonReply(replyPort, 200, {
        prefs,
        messages: await listMessages(messages, reactions),
        reaction_icons: REACTION_ICONS,
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
      if (op === "send" || op === "delete" || op === "react" || op === "settings") {
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

log("Discussion Channel frame is up.");
