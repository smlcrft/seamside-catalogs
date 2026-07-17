// ----------------------------------------------------------------------------------------
// Discussion Channel — Per-placement realtime chat + two owner access toggles.
//
// Auth model (mirrors Roundtable's two independent owner toggles):
//   - `public_to_space_viewers` — when true, Viewer-role members of the space (members
//     with is_sfi_editor=false) are opted into full participation: chat, react, delete
//     their own. Editors / owners participate regardless. When OFF, Viewer-role members
//     can still READ the channel (they're members) but cannot mutate anything.
//   - `public_read_view` — when true, even non-members (anonymous FAT visitors, or
//     signed-in users whose only access is a bookmark to this SFI) can READ the channel —
//     no mutations of any kind.
//
//   Resolution:
//     canParticipate = isSfiEditor OR (publicToSpaceViewers AND isSfiMember)
//     canRead        = canParticipate OR isSfiMember OR publicReadView
//     /api/state requires canRead. Every mutation route requires canParticipate.
//     /api/settings additionally requires isOwner.
//   - Owners can additionally delete anyone's message.
//   - Messages/reactions live in per-placement LocalTables (encrypted at rest, host-local,
//     not peer-synced) — each placement is its own channel.
//
// Realtime: new messages, deletions, reaction toggles, and pref changes are broadcast via
// pushToInstance(sfi_id, …); framecore handles viewer tracking, including read-only viewers.
// ----------------------------------------------------------------------------------------
import {
  log, parsePeerInfo, serveFileAtPath, serveHtmlShell, pushToInstance,
  jsonReply, parseJsonBody, sanitizeText,
  loadJsonFile, saveJsonFile, declareTables, ensureTables, table,
} from "@frame-core";

// ----------------------------------------------------------------------------------------
// PER-PLACEMENT PREFS (channel name + theme color), stored as JSON
// ----------------------------------------------------------------------------------------
type Prefs = {
  title: string;
  theme: string;
  // When true, Viewer-role space members can fully participate (chat, react,
  // delete their own). Off by default — Viewers still read as members.
  public_to_space_viewers: boolean;
  // When true, non-members (anon FAT visitors and bookmark-only users) can
  // read the channel in a fully read-only view. Default off.
  public_read_view: boolean;
};
const DEFAULT_PREFS: Prefs = {
  title: "Discussion", theme: "c1",
  public_to_space_viewers: false, public_read_view: false,
};
const VALID_THEMES = new Set(["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"]);

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

  // Two-tier auth (mirrors Roundtable — see header). Read: members always, plus
  // anyone when public_read_view. Participate: editors always, plus Viewer-role
  // members when public_to_space_viewers. Fail closed for everyone else.
  const authPrefs = sfiId ? getPrefs(sfiId) : DEFAULT_PREFS;
  const canParticipate = peer.is_sfi_editor || (authPrefs.public_to_space_viewers === true && peer.is_sfi_member);
  const canRead = canParticipate || peer.is_sfi_member || authPrefs.public_read_view === true;
  if (!canRead && reqPath.startsWith("/api/")) {
    return jsonReply(replyPort, 403, { error: "private channel" });
  }

  if (reqPath.startsWith("/api/")) {
    if (!sfiId) return jsonReply(replyPort, 400, { error: "sfi_id missing" });
    // Local tables are always ready; the gate stays so a future graduation to
    // synced tables needs no code change here.
    const ready = ensureTables(peer);
    if (!ready.ready) return jsonReply(replyPort, 503, { error: "table not bound" });
    const messages = table("messages", sfiId);
    const reactions = table("reactions", sfiId);

    if (reqPath === "/api/state" && method === "GET") {
      return jsonReply(replyPort, 200, {
        prefs: getPrefs(sfiId),
        messages: await listMessages(messages, reactions),
        reaction_icons: REACTION_ICONS,
        can_edit_settings: isOwner,
        can_participate: canParticipate,
        me: { user_id: peer.user_id, user_name: peer.user_name, is_owner: isOwner },
      });
    }

    // Every mutation route below requires canParticipate — read-only viewers
    // (members without participation, or public_read_view outsiders) get one
    // uniform 403 here instead of per-route checks.
    if (!canParticipate) {
      return jsonReply(replyPort, 403, { error: "read-only access" });
    }

    if (reqPath === "/api/send" && method === "POST") {
      const v = parseJsonBody<{ body?: unknown }>(body);
      const text = sanitizeText(v?.body, 4000);
      if (!text) return jsonReply(replyPort, 400, { error: "body required" });
      const userName = sanitizeText(peer.user_name, 80) || "user";
      const now = Date.now();
      const { row_id } = await messages.upsert(null, {
        user_id: peer.user_id, user_name: userName, body: text, created_at: now,
      });
      const msg = { id: row_id, user_id: peer.user_id, user_name: userName, body: text, created_at: now, reactions: [] };
      pushToInstance(sfiId, { type: "dc_message", sfi_id: sfiId, message: msg });
      return jsonReply(replyPort, 200, { ok: true, id: row_id });
    }

    if (reqPath === "/api/delete" && method === "POST") {
      const v = parseJsonBody<{ id?: unknown }>(body);
      const id = typeof v?.id === "string" ? v.id : "";
      if (!id) return jsonReply(replyPort, 400, { error: "id required" });
      const row = await messages.get(id);
      if (!row) return jsonReply(replyPort, 404, { error: "not found" });
      if (!isOwner && row.user_id !== peer.user_id) return jsonReply(replyPort, 403, { error: "forbidden" });
      await reactions.deleteWhere({ message_id: id });
      await messages.delete(id);
      pushToInstance(sfiId, { type: "dc_delete", sfi_id: sfiId, id });
      return jsonReply(replyPort, 200, { ok: true });
    }

    // Toggle a reaction: remove if this user already reacted with this icon, otherwise add.
    if (reqPath === "/api/react" && method === "POST") {
      const v = parseJsonBody<{ message_id?: unknown; icon?: unknown }>(body);
      const mid = typeof v?.message_id === "string" ? v.message_id : "";
      const icon = sanitizeText(v?.icon, 40);
      if (!mid || !icon || !REACTION_ICON_SET.has(icon)) return jsonReply(replyPort, 400, { error: "invalid" });
      if (!(await messages.get(mid))) return jsonReply(replyPort, 404, { error: "not found" });
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
      return jsonReply(replyPort, 200, { ok: true });
    }

    // Owner-only: channel identity + the two access toggles (they gate who can
    // read/write, so they're strictly owner-controlled, like Roundtable's).
    if (reqPath === "/api/settings" && method === "POST") {
      if (!isOwner) return jsonReply(replyPort, 403, { error: "owner only" });
      const v = parseJsonBody<{ title?: unknown; theme?: unknown; public_to_space_viewers?: unknown; public_read_view?: unknown }>(body);
      const current = getPrefs(sfiId);
      const title = sanitizeText(v?.title, 80) || current.title || DEFAULT_PREFS.title;
      const themeRaw = sanitizeText(v?.theme, 4);
      const next: Prefs = {
        title,
        theme: VALID_THEMES.has(themeRaw) ? themeRaw : current.theme,
        public_to_space_viewers: v?.public_to_space_viewers !== undefined
          ? v.public_to_space_viewers === true : current.public_to_space_viewers,
        public_read_view: v?.public_read_view !== undefined
          ? v.public_read_view === true : current.public_read_view,
      };
      setPrefs(sfiId, next);
      pushToInstance(sfiId, { type: "dc_prefs", sfi_id: sfiId, prefs: next });
      return jsonReply(replyPort, 200, { ok: true, prefs: next });
    }
  }

  if (method === "GET") {
    return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url));
  }
  replyPort.postMessage({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Not found.", code: "NOT_FOUND" }) });
};

log("Discussion Channel frame is up.");
