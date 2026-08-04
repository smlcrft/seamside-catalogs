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
  log, serveFileAtPath, jsonReply, parseJsonBody, parsePeerInfo, onUiMessage,
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

// ----- Writes ---------------------------------------------------------------------------
// Shared by the HTTP arms and the bus dispatcher (frame.busSend → BusUiToFrame) — the two
// entry points must never drift on validation or role gates. `op` is the API path with the
// leading "api/" stripped. Every write is editor-only: non-members AND Viewer-role members
// are rejected with the same gate (never gate writes on is_sfi_member — Viewer-role
// members would slip through).
type WritePeer = ReturnType<typeof parsePeerInfo>;
type WriteResult = { status: number; body: unknown };

async function handleWrite(
  sfiId: string, op: string, v: Record<string, unknown> | null, peer: WritePeer,
): Promise<WriteResult> {
  // Local tables resolve with zero ceremony, but keep the standard gate so a
  // future graduation to a synced table needs no code change here.
  const tables = ensureTables(peer);
  if (!tables.ready) return { status: 503, body: { error: "table not bound" } };
  if (!peer.is_sfi_editor) return { status: 403, body: { error: "editors only" } };
  const items = table("items", sfiId);

  // Add a new item in the last slot.
  if (op === "add") {
    const text = sanitizeText(v?.text, 1000);
    if (!text) return { status: 400, body: { error: "text required" } };
    await items.upsert(null, {
      text, state: 0, sort_order: await nextSortOrder(items), created_ms: Date.now(),
    });
    notify(sfiId);
    return { status: 200, body: { items: await listItems(items) } };
  }

  // Update one item's state and/or text. The table is placement-scoped, so an
  // id from another placement simply doesn't exist here. Guard with get() —
  // upsert(unknownId) would otherwise create a phantom row.
  if (op.startsWith("item/")) {
    const id = op.slice("item/".length);
    if (!id || !(await items.get(id))) return { status: 400, body: { error: "bad id" } };
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
    notify(sfiId);
    return { status: 200, body: { items: await listItems(items) } };
  }

  // Reorder — carries the full ordered list of item ids for this placement.
  if (op === "reorder") {
    const ids = Array.isArray(v?.ids) ? v.ids.filter((x): x is string => typeof x === "string" && !!x) : [];
    // Only touch ids that actually exist in this placement (never phantom-create).
    const { rows } = await items.query({});
    const known = new Set(rows.map((r) => r._row_id));
    for (let i = 0; i < ids.length; i++) {
      if (known.has(ids[i])) await items.upsert(ids[i], { sort_order: i });
    }
    notify(sfiId);
    return { status: 200, body: { items: await listItems(items) } };
  }

  // Delete.
  if (op.startsWith("delete/")) {
    const id = op.slice("delete/".length);
    if (!id) return { status: 400, body: { error: "bad id" } };
    await items.delete(id);
    notify(sfiId);
    return { status: 200, body: { items: await listItems(items) } };
  }

  return { status: 404, body: { error: "not found" } };
}

// Bus dispatcher — the frontend's write path (frame.busSend → BusUiToFrame → here).
// `peer` is the sender's platform-resolved identity, same shape as parsePeerInfo; the
// role gate lives inside handleWrite. Denials are logged, not answered — a legitimate
// client never sends a write it isn't allowed to make.
onUiMessage(async (sfiId, data, peer) => {
  if (!sfiId || typeof data !== "object" || data === null) return;
  const d = data as Record<string, unknown>;
  if (typeof d.op !== "string") return;
  const r = await handleWrite(sfiId, d.op, d, peer);
  if (r.status !== 200) log(`checklist: bus op ${d.op} → ${r.status} (${JSON.stringify(r.body)})`);
});

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
      space_color:   peer.space_color,
    });
  }

  // Local tables resolve with zero ceremony, but keep the standard gate so a
  // future graduation to a synced table needs no code change here.
  const tables = ensureTables(peer);
  if (!tables.ready) return jsonReply(replyPort, 503, { error: "table not bound" });

  // Read — open to everyone (non-members get a read-only view of this placement's list).
  if (reqPath === "/api/list" && method === "GET") {
    return jsonReply(replyPort, 200, { items: await listItems(table("items", peer.sfi_id)) });
  }

  // Writes — kept as HTTP arms for older viewers; same shared logic as the bus dispatcher.
  if (reqPath.startsWith("/api/") && method === "POST") {
    const r = await handleWrite(
      peer.sfi_id, reqPath.slice("/api/".length), parseJsonBody<Record<string, unknown>>(body), peer,
    );
    return jsonReply(replyPort, r.status, r.body);
  }

  return jsonReply(replyPort, 404, { error: "not found" });
};

log("Checklist frame is up and running!");
