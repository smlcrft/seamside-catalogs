// ----------------------------------------------------------------------------------------
// Checklist — a simple, collaborative to-do list.
//
// Design axes:
//   privacy:        privacy-public-view  — non-members get a live read-only view;
//                                           space editors get the interactive UI.
//   data_storage:   storage-local-db     — one lightweight local SQLite DB on the host,
//                                           rows scoped by sfi_id so each placement is
//                                           its own independent list. The DB is NOT shared
//                                           peer-to-peer; collaboration happens at the
//                                           frontend layer (all viewers talk to this one
//                                           backend and re-fetch on push).
//   view_realtime:  view-collaborative    — every mutation calls pushToInstance(sfi_id, …)
//                                           so all viewers of the placement refresh live.
//   settings_scope: settings-per-sfi      — state is keyed by peer.sfi_id.
//
// Each item has a 3-state status: 0 = unstarted, 1 = in-progress, 2 = complete.
// ----------------------------------------------------------------------------------------
import {
  log, serveFileAtPath, jsonReply, parseJsonBody, parsePeerInfo,
  pushToInstance, sanitizeText, toIntOrNull, clampInt,
  DatabaseSync, mkdirSync, path,
} from "@frame-core";

// ----- Local SQLite (per-host; rows scoped by sfi_id) -----------------------------------
const dataDirPath = path.join(import.meta.dirname!, "data");
mkdirSync(dataDirPath, { recursive: true });
const db = new DatabaseSync(path.join(dataDirPath, "checklist.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    sfi_id     TEXT    NOT NULL,
    text       TEXT    NOT NULL DEFAULT '',
    state      INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_ms INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_items_sfi ON items (sfi_id, sort_order, id);
`);

// ----- Helpers --------------------------------------------------------------------------
function listItems(sfiId: string) {
  return db.prepare(
    "SELECT id, text, state, sort_order FROM items WHERE sfi_id = ? ORDER BY sort_order, id"
  ).all(sfiId);
}

function nextSortOrder(sfiId: string): number {
  const row = db.prepare(
    "SELECT COALESCE(MAX(sort_order), -1) AS m FROM items WHERE sfi_id = ?"
  ).get(sfiId) as { m: number };
  return row.m + 1;
}

function notify(sfiId: string) {
  pushToInstance(sfiId, { type: "checklist_changed" });
}

// ----- Networking -----------------------------------------------------------------------
self.onNetworkRequest = async function (replyPort, reqPath, method, headers, query, body, cookies) {
  const peer = parsePeerInfo(query, cookies);

  // Static assets (index.html, etc.) — open to everyone, including anon read-only viewers.
  if (method === "GET" && !reqPath.startsWith("/api/")) {
    return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url), headers);
  }

  // Identity probe — drives which render mode the frontend shows.
  if (reqPath === "/api/whoami" && method === "GET") {
    return jsonReply(replyPort, 200, {
      is_anon:       peer.is_anon,
      is_sfi_member: peer.is_sfi_member,
      is_sfi_editor: peer.is_sfi_editor,
      is_owner:      peer.is_owner,
      user_id:       peer.user_id,
      user_name:     peer.user_name,
    });
  }

  // Read — open to everyone (non-members get a read-only view of this placement's list).
  if (reqPath === "/api/list" && method === "GET") {
    return jsonReply(replyPort, 200, { items: listItems(peer.sfi_id) });
  }

  // Every endpoint below mutates state and is editor-only. Non-members AND Viewer-role
  // members are rejected with the same gate (never gate writes on is_sfi_member —
  // Viewer-role members would slip through).
  const editorOnly = () => {
    if (!peer.is_sfi_editor) { jsonReply(replyPort, 403, { error: "editors only" }); return false; }
    return true;
  };

  // Add a new item in the last slot.
  if (reqPath === "/api/add" && method === "POST") {
    if (!editorOnly()) return;
    const v = parseJsonBody<{ text?: unknown }>(body);
    const text = sanitizeText(v?.text, 1000);
    if (!text) return jsonReply(replyPort, 400, { error: "text required" });
    db.prepare(
      "INSERT INTO items (sfi_id, text, state, sort_order, created_ms) VALUES (?, ?, 0, ?, ?)"
    ).run(peer.sfi_id, text, nextSortOrder(peer.sfi_id), Date.now());
    notify(peer.sfi_id);
    return jsonReply(replyPort, 200, { items: listItems(peer.sfi_id) });
  }

  // Update one item's state and/or text. id is scoped to this sfi so a member of one
  // space can't reach into another placement's rows.
  if (reqPath.startsWith("/api/item/") && method === "POST") {
    if (!editorOnly()) return;
    const id = toIntOrNull(reqPath.slice("/api/item/".length));
    if (id == null) return jsonReply(replyPort, 400, { error: "bad id" });
    const v = parseJsonBody<{ state?: unknown; text?: unknown }>(body);
    if (v?.state !== undefined) {
      const state = clampInt(toIntOrNull(v.state) ?? 0, 0, 2);
      db.prepare("UPDATE items SET state = ? WHERE id = ? AND sfi_id = ?").run(state, id, peer.sfi_id);
    }
    if (v?.text !== undefined) {
      const text = sanitizeText(v.text, 1000);
      db.prepare("UPDATE items SET text = ? WHERE id = ? AND sfi_id = ?").run(text, id, peer.sfi_id);
    }
    notify(peer.sfi_id);
    return jsonReply(replyPort, 200, { items: listItems(peer.sfi_id) });
  }

  // Reorder — body carries the full ordered list of item ids for this placement.
  if (reqPath === "/api/reorder" && method === "POST") {
    if (!editorOnly()) return;
    const v = parseJsonBody<{ ids?: unknown }>(body);
    const ids = Array.isArray(v?.ids) ? v.ids.map((x) => toIntOrNull(x)).filter((x): x is number => x != null) : [];
    const update = db.prepare("UPDATE items SET sort_order = ? WHERE id = ? AND sfi_id = ?");
    ids.forEach((id, i) => update.run(i, id, peer.sfi_id));
    notify(peer.sfi_id);
    return jsonReply(replyPort, 200, { items: listItems(peer.sfi_id) });
  }

  // Delete.
  if (reqPath.startsWith("/api/delete/") && method === "POST") {
    if (!editorOnly()) return;
    const id = toIntOrNull(reqPath.slice("/api/delete/".length));
    if (id == null) return jsonReply(replyPort, 400, { error: "bad id" });
    db.prepare("DELETE FROM items WHERE id = ? AND sfi_id = ?").run(id, peer.sfi_id);
    notify(peer.sfi_id);
    return jsonReply(replyPort, 200, { items: listItems(peer.sfi_id) });
  }

  return jsonReply(replyPort, 404, { error: "not found" });
};

log("Checklist frame is up and running!");
