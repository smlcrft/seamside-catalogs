// ----------------------------------------------------------------------------------------
// Discussion Channel — Per-placement realtime chat + two owner access toggles.
//
// Auth model (mirrors Roundtable's owner toggle):
//   - `public_to_space_viewers` — when true, Viewer-role members of the space (members
//     with is_sfi_editor=false) are opted into full participation: chat, react, delete
//     their own. Editors / owners participate regardless. When OFF, Viewer-role members
//     can still READ the channel (they're members) but cannot mutate anything.
//
//   Reads are open to every viewer who reaches the frame — whether a non-member can
//   reach it at all is the platform's call (public sharing on the placement), never
//   the frame's.
//
//   Resolution:
//     canParticipate = isSfiEditor OR (publicToSpaceViewers AND isSfiMember)
//     Every mutation route requires canParticipate.
//     /api/settings additionally requires isOwner.
//   - Owners can additionally delete anyone's message.
//   - Messages/reactions live in per-placement LocalTables (encrypted at rest, host-local,
//     not peer-synced) — each placement is its own channel.
//
// Realtime: new messages, deletions, reaction toggles, and pref changes are broadcast via
// pushToInstance(sfi_id, …); framecore handles viewer tracking, including read-only viewers.
// ----------------------------------------------------------------------------------------
import {
  log, parsePeerInfo, serveFileAtPath, serveHtmlShell, pushToInstance, onUiMessage,
  jsonReply, parseJsonBody, sanitizeText,
  loadJsonFile, saveJsonFile, declareTables, ensureTables, table,
} from "@frame-core";

// ----------------------------------------------------------------------------------------
// PER-PLACEMENT PREFS (channel name), stored as JSON
// ----------------------------------------------------------------------------------------
type Prefs = {
  title: string;
  // When true, Viewer-role space members can fully participate (chat, react,
  // delete their own). Off by default — Viewers still read as members.
  public_to_space_viewers: boolean;
};
const DEFAULT_PREFS: Prefs = {
  title: "Discussion",
  public_to_space_viewers: false,
};

const allPrefs: Record<string, Prefs> = loadJsonFile(import.meta.url, "prefs.json", {});
function getPrefs(sfiId: string): Prefs {
  return { ...DEFAULT_PREFS, ...(allPrefs[sfiId] ?? {}) };
}
function setPrefs(sfiId: string, next: Prefs): void {
  allPrefs[sfiId] = next;
  saveJsonFile(import.meta.url, "prefs.json", allPrefs);
}

// ----------------------------------------------------------------------------------------
// LOCALTABLES — messages + reactions, per-placement (no sfi_id columns needed)
// ----------------------------------------------------------------------------------------
declareTables([
  {
    key: "messages",
    title: "Channel Messages",
    description: "Messages in this placement's discussion channel.",
    local: true,
    schema: [
      { name: "user_id",    col_type: "text",    nullable: false, default_val: "" },
      { name: "user_name",  col_type: "text",    nullable: false, default_val: "" },
      { name: "body",       col_type: "text",    nullable: false, default_val: "" },
      { name: "created_at", col_type: "integer", nullable: false, default_val: "0" },
    ],
  },
  {
    key: "reactions",
    title: "Channel Reactions",
    description: "Per-user reaction icons on messages.",
    local: true,
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
  // Local tables are always ready; the gate stays so a future graduation to
  // synced tables needs no code change here.
  const ready = ensureTables(peer);
  if (!ready.ready) return { status: 503, body: { error: "table not bound" } };
  const messages = table("messages", sfiId);
  const reactions = table("reactions", sfiId);
  const isOwner = peer.is_owner;

  // Every write requires canParticipate (see header) — read-only viewers get one
  // uniform 403 here instead of per-op checks.
  const current = getPrefs(sfiId);
  const canParticipate = peer.is_sfi_editor || (current.public_to_space_viewers === true && peer.is_sfi_member);
  if (!canParticipate) return { status: 403, body: { error: "read-only access" } };

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

  // Owner-only: channel identity + the two access toggles (they gate who can
  // read/write, so they're strictly owner-controlled, like Roundtable's).
  if (op === "settings") {
    if (!isOwner) return { status: 403, body: { error: "owner only" } };
    const title = sanitizeText(v?.title, 80) || current.title || DEFAULT_PREFS.title;
    const next: Prefs = {
      title,
      public_to_space_viewers: v?.public_to_space_viewers !== undefined
        ? v.public_to_space_viewers === true : current.public_to_space_viewers,
    };
    setPrefs(sfiId, next);
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
  const isAnon = peer.is_anon || !peer.user_id;
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

  // Participation auth (mirrors Roundtable — see header): editors always, plus
  // Viewer-role members when public_to_space_viewers. Reads are open to every
  // viewer who reaches the frame.
  const authPrefs = sfiId ? getPrefs(sfiId) : DEFAULT_PREFS;
  const canParticipate = peer.is_sfi_editor || (authPrefs.public_to_space_viewers === true && peer.is_sfi_member);

  if (reqPath.startsWith("/api/")) {
    if (!sfiId) return jsonReply(replyPort, 400, { error: "sfi_id missing" });

    if (reqPath === "/api/state" && method === "GET") {
      // Local tables are always ready; the gate stays so a future graduation to
      // synced tables needs no code change here.
      const ready = ensureTables(peer);
      if (!ready.ready) return jsonReply(replyPort, 503, { error: "table not bound" });
      const messages = table("messages", sfiId);
      const reactions = table("reactions", sfiId);
      return jsonReply(replyPort, 200, {
        prefs: getPrefs(sfiId),
        messages: await listMessages(messages, reactions),
        reaction_icons: REACTION_ICONS,
        can_edit_settings: isOwner,
        can_participate: canParticipate,
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
