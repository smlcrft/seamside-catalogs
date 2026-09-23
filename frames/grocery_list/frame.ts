// ----------------------------------------------------------------------------------------
// Grocery List — the realtime shared family shopping list.
//
// Design axes:
//   privacy:        privacy-public-view  — non-members get a live read-only view;
//                                           space editors get the interactive list.
//   data_storage:   the space's table    — `grocery.table.jsonl` at the space's root,
//                                           synced with the space.
//   view_realtime:  view-collaborative    — every mutation calls pushToInstance(sfi_id, …)
//                                           so all viewers refresh live; a push reaches
//                                           every frame in the space, so the Meal
//                                           Planner's inserts refresh this list too.
//
// This frame OWNS the `grocery` v1 contract (docs/schema-contracts.md). A Meal Planner in
// the same space inserts ingredient rows into the same table with a `source`; this frame
// renders those with a small provenance hint but treats them as ordinary rows (full CRUD
// stays here, per the contract's role lines).
// ----------------------------------------------------------------------------------------
import {
  log, serveFileAtPath, jsonReply, parseJsonBody, parsePeerInfo, onUiMessage,
  pushToInstance, sanitizeText,
  declareTables, table,
} from "@frame-core";

// ----- Schema (the `grocery` v1 contract — declared verbatim, one source of truth) ------
const GROCERY_SCHEMA = [
  { name: "item",     col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "quantity", col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "category", col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "checked",  col_type: "integer" as const, nullable: false, default_val: "0" },
  { name: "source",   col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "added_ms", col_type: "integer" as const, nullable: false, default_val: "0" },
];

// ----- The space's `grocery` table (the contract name) --------------------------------
declareTables([
  { key: "grocery", title: "Grocery List", description: "The grocery list of this space.", schema: GROCERY_SCHEMA },
]);

type Tbl = ReturnType<typeof table>;
type Peer = ReturnType<typeof parsePeerInfo>;

// ----- Queries --------------------------------------------------------------------------
async function listRows(t: Tbl) {
  const { rows } = await t.query({
    order_by: [{ col: "category" }, { col: "added_ms" }],
  });
  return rows.map((r) => ({
    id: r._row_id, item: r.item, quantity: r.quantity, category: r.category,
    checked: r.checked, source: r.source, added_ms: r.added_ms,
  }));
}

function notify(sfiId: string) {
  pushToInstance(sfiId, { type: "grocery_changed" });
}

// ----- Writes ---------------------------------------------------------------------------
// One shared mutation path for BOTH transports: the bus dispatcher below (frame.busSend →
// onUiMessage, the primary write path) and the HTTP POST arm in onNetworkRequest (kept for
// older viewers whose framelib has no busSend). `op` is the API path with "api/" stripped
// (e.g. "item/<id>/delete"); `v` is the parsed payload. Role gates live here so the two
// entry points can never drift.
type WriteResult = { status: number; body: unknown };

async function handleWrite(sfiId: string, op: string, v: Record<string, unknown> | null, peer: Peer): Promise<WriteResult> {
  const t = table("grocery", sfiId);

  // Every op below mutates state and is editor-only. Non-members AND Viewer-role
  // members are rejected with the same gate (never gate writes on is_sfi_member —
  // Viewer-role members would slip through).
  if (!peer.is_sfi_editor) return { status: 403, body: { error: "editors only" } };

  const ok = async (): Promise<WriteResult> => {
    notify(sfiId);
    return { status: 200, body: { items: await listRows(t) } };
  };

  // --- Items ----------------------------------------------------------------------------
  if (op === "item") {
    const item = sanitizeText(v?.item, 200);
    if (!item) return { status: 400, body: { error: "item required" } };
    await t.upsert(null, {
      item,
      quantity: sanitizeText(v?.quantity, 40),
      category: sanitizeText(v?.category, 40).toLowerCase(),
      checked: 0, source: "", added_ms: Date.now(),
    });
    return ok();
  }

  if (op.startsWith("item/")) {
    const [id, action] = op.slice("item/".length).split("/");
    if (!id || !(await t.get(id))) return { status: 400, body: { error: "bad id" } };
    if (action === "delete") {
      await t.delete(id);
      return ok();
    }
    if (action) return { status: 404, body: { error: "not found" } };
    if (v?.item !== undefined) {
      const item = sanitizeText(v.item, 200);
      if (item) await t.upsert(id, { item });
    }
    if (v?.quantity !== undefined) {
      await t.upsert(id, { quantity: sanitizeText(v.quantity, 40) });
    }
    if (v?.category !== undefined) {
      await t.upsert(id, { category: sanitizeText(v.category, 40).toLowerCase() });
    }
    if (v?.checked !== undefined) {
      await t.upsert(id, { checked: Number(v.checked) ? 1 : 0 });
    }
    return ok();
  }

  // The "clear bought" sweep — delete every checked row in one pass.
  if (op === "clear_checked") {
    await t.deleteWhere({ checked: 1 });
    return ok();
  }

  return { status: 404, body: { error: "not found" } };
}

// ----- Bus dispatcher — the frontend's write path (frame.busSend → BusUiToFrame) --------
// `peer` is the sender's platform-resolved identity, same shape as parsePeerInfo; the
// role gates live inside handleWrite. Denials are logged, not answered — a legitimate
// client never sends a write it isn't allowed to make.
onUiMessage(async (sfiId, data, peer) => {
  if (!sfiId || typeof data !== "object" || data === null) return;
  const d = data as Record<string, unknown>;
  if (typeof d.op !== "string") return;
  const r = await handleWrite(sfiId, d.op, d, peer);
  if (r.status !== 200) log(`grocery_list: bus op ${d.op} → ${r.status} (${JSON.stringify(r.body)})`);
});

// ----- Networking -----------------------------------------------------------------------
self.onNetworkRequest = async function (replyPort, reqPath, method, headers, query, body, cookies) {
  const peer = parsePeerInfo(query, cookies);
  const sfiId = peer.sfi_id;

  // Static assets — open to everyone, including anon read-only viewers.
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

  // Writes — the HTTP arm of the shared write path (see handleWrite above).
  if (reqPath.startsWith("/api/") && (method === "POST" || method === "PUT")) {
    const r = await handleWrite(sfiId, reqPath.slice("/api/".length), parseJsonBody<Record<string, unknown>>(body), peer);
    return jsonReply(replyPort, r.status, r.body);
  }

  // Read — open to everyone (non-members get a read-only view of the list).
  // No seeding: an empty grocery list is an honest empty list.
  if (reqPath === "/api/list" && method === "GET") {
    return jsonReply(replyPort, 200, {
      items: await listRows(table("grocery", sfiId)),
    });
  }

  return jsonReply(replyPort, 404, { error: "not found" });
};

log("Grocery List frame is up and running!");
