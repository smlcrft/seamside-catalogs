// ----------------------------------------------------------------------------------------
// Checklist — a simple, collaborative to-do list.
//
// Design axes:
//   privacy:        privacy-public-view  — non-members get a live read-only view;
//                                           space editors get the interactive UI.
//   data_storage:   storage-local-db     — a LocalTable: encrypted at rest on the host
//                                           device, scoped per placement so each placement
//                                           is its own independent list. NOT shared
//                                           peer-to-peer; collaboration happens at the
//                                           frontend layer (all viewers talk to this one
//                                           backend and re-fetch on push).
//   view_realtime:  view-collaborative    — every mutation calls pushToInstance(sfi_id, …)
//                                           so all viewers of the placement refresh live.
//   settings_scope: settings-per-sfi      — the table binding is keyed by peer.sfi_id.
//
// Each item has a 3-state status: 0 = unstarted, 1 = in-progress, 2 = complete.
// ----------------------------------------------------------------------------------------
import {
  log, serveFileAtPath, jsonReply, parseJsonBody, parsePeerInfo,
  pushToInstance, sanitizeText, toIntOrNull, clampInt,
  declareTables, ensureTables, table,
} from "@frame-core";

// ----- LocalTable (encrypted, per-placement — no sfi_id column needed) ------------------
declareTables([{
  key: "items",
  title: "Checklist Items",
  description: "Tasks for this placement's checklist.",
  local: true,
  schema: [
    { name: "text",       col_type: "text",    nullable: false, default_val: "" },
    { name: "state",      col_type: "integer", nullable: false, default_val: "0" },
    { name: "sort_order", col_type: "integer", nullable: false, default_val: "0" },
    { name: "created_ms", col_type: "integer", nullable: false, default_val: "0" },
    { name: "actor_id",   col_type: "text",    nullable: true,  default_val: "" },
    { name: "actor_name", col_type: "text",    nullable: true,  default_val: "" },
  ],
}]);

// ----- Helpers --------------------------------------------------------------------------
type ItemsTable = ReturnType<typeof table>;

async function listItems(items: ItemsTable) {
  const { rows } = await items.query({
    order_by: [{ col: "sort_order" }, { col: "created_ms" }],
  });
  return rows.map((r) => ({
    id: r._row_id, text: r.text, state: r.state,
    sort_order: r.sort_order, actor_name: r.actor_name || "",
  }));
}

async function nextSortOrder(items: ItemsTable): Promise<number> {
  return Number(await items.max("sort_order") ?? -1) + 1;
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

  // Local tables resolve with zero ceremony, but keep the standard gate so a
  // future graduation to a synced table needs no code change here.
  const tables = ensureTables(peer);
  if (!tables.ready) return jsonReply(replyPort, 503, { error: "table not bound" });
  const items = table("items", peer.sfi_id);

  // Read — open to everyone (non-members get a read-only view of this placement's list).
  if (reqPath === "/api/list" && method === "GET") {
    return jsonReply(replyPort, 200, { items: await listItems(items) });
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
    await items.upsert(null, {
      text, state: 0, sort_order: await nextSortOrder(items), created_ms: Date.now(),
    });
    notify(peer.sfi_id);
    return jsonReply(replyPort, 200, { items: await listItems(items) });
  }

  // Update one item's state and/or text. The table is placement-scoped, so an
  // id from another placement simply doesn't exist here. Guard with get() —
  // upsert(unknownId) would otherwise create a phantom row.
  if (reqPath.startsWith("/api/item/") && method === "POST") {
    if (!editorOnly()) return;
    const id = reqPath.slice("/api/item/".length);
    if (!id || !(await items.get(id))) return jsonReply(replyPort, 400, { error: "bad id" });
    const v = parseJsonBody<{ state?: unknown; text?: unknown }>(body);
    if (v?.state !== undefined) {
      const state = clampInt(toIntOrNull(v.state) ?? 0, 0, 2);
      // Record who moved this item off "unstarted"; clear the credit when it returns to 0.
      if (state === 0) {
        await items.upsert(id, { state, actor_id: "", actor_name: "" });
      } else {
        const actorName = sanitizeText(peer.user_name, 80) || "someone";
        await items.upsert(id, { state, actor_id: peer.user_id ?? "", actor_name: actorName });
      }
    }
    if (v?.text !== undefined) {
      const text = sanitizeText(v.text, 1000);
      await items.upsert(id, { text });
    }
    notify(peer.sfi_id);
    return jsonReply(replyPort, 200, { items: await listItems(items) });
  }

  // Reorder — body carries the full ordered list of item ids for this placement.
  if (reqPath === "/api/reorder" && method === "POST") {
    if (!editorOnly()) return;
    const v = parseJsonBody<{ ids?: unknown }>(body);
    const ids = Array.isArray(v?.ids) ? v.ids.filter((x): x is string => typeof x === "string" && !!x) : [];
    // Only touch ids that actually exist in this placement (never phantom-create).
    const { rows } = await items.query({});
    const known = new Set(rows.map((r) => r._row_id));
    for (let i = 0; i < ids.length; i++) {
      if (known.has(ids[i])) await items.upsert(ids[i], { sort_order: i });
    }
    notify(peer.sfi_id);
    return jsonReply(replyPort, 200, { items: await listItems(items) });
  }

  // Delete.
  if (reqPath.startsWith("/api/delete/") && method === "POST") {
    if (!editorOnly()) return;
    const id = reqPath.slice("/api/delete/".length);
    if (!id) return jsonReply(replyPort, 400, { error: "bad id" });
    await items.delete(id);
    notify(peer.sfi_id);
    return jsonReply(replyPort, 200, { items: await listItems(items) });
  }

  return jsonReply(replyPort, 404, { error: "not found" });
};

log("Checklist frame is up and running!");
