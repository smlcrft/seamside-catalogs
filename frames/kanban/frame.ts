// ----------------------------------------------------------------------------------------
// Kanban Board — a drag-and-drop task board with channel-colored columns.
//
// Design axes:
//   privacy:        privacy-public-view  — non-members get a live read-only view;
//                                           space editors get the interactive board.
//   data_storage:   the space's tables   — `kanban_columns` and `kanban_cards`
//                                           (`<name>.table.jsonl` at the space's root),
//                                           synced with the space; one board per space.
//   view_realtime:  view-collaborative    — every mutation calls pushToInstance(sfi_id, …)
//                                           so every viewer refreshes live.
//
// Columns carry a channel (c1–c12) as their identity color; cards carry a title,
// an optional description, and an optional short label.
// ----------------------------------------------------------------------------------------
import {
  log, serveFileAtPath, jsonReply, parseJsonBody, parsePeerInfo, onUiMessage,
  pushToInstance, sanitizeText,
  declareTables, table,
} from "@frame-core";

// ----- Schemas ----------------------------------------------------------------------------
const COLUMNS_SCHEMA = [
  { name: "title",      col_type: "text" as const,    nullable: false, default_val: "" },
  { name: "channel",    col_type: "text" as const,    nullable: false, default_val: "c1" },
  { name: "sort_order", col_type: "integer" as const, nullable: false, default_val: "0" },
];
const CARDS_SCHEMA = [
  { name: "column_id",   col_type: "text" as const,    nullable: false, default_val: "" },
  { name: "title",       col_type: "text" as const,    nullable: false, default_val: "" },
  { name: "description", col_type: "text" as const,    nullable: false, default_val: "" },
  { name: "label",       col_type: "text" as const,    nullable: false, default_val: "" },
  { name: "sort_order",  col_type: "integer" as const, nullable: false, default_val: "0" },
  { name: "created_ms",  col_type: "integer" as const, nullable: false, default_val: "0" },
];

// ----- The space's tables, named for this frame (`cards` alone is also Flashcards') ------
declareTables([
  { key: "kanban_columns", title: "Kanban Columns", description: "Columns of this space's kanban board.", schema: COLUMNS_SCHEMA },
  { key: "kanban_cards",   title: "Kanban Cards",   description: "Cards of this space's kanban board.",   schema: CARDS_SCHEMA },
]);

type Tbl = ReturnType<typeof table>;
type Peer = ReturnType<typeof parsePeerInfo>;

function dataTables(sfiId: string): { columns: Tbl; cards: Tbl } {
  return { columns: table("kanban_columns", sfiId), cards: table("kanban_cards", sfiId) };
}

const CHANNEL_RE = /^c([1-9]|1[0-2])$/;
const SEED_COLUMNS: Array<[string, string]> = [
  ["To do", "c2"], ["In progress", "c4"], ["Done", "c5"],
];

// ----- Queries --------------------------------------------------------------------------
async function boardData(columns: Tbl, cards: Tbl) {
  const { rows: cols } = await columns.query({
    order_by: [{ col: "sort_order" }, { col: "_created_at" }],
  });
  const { rows: allCards } = await cards.query({
    order_by: [{ col: "sort_order" }, { col: "created_ms" }],
  });
  const byCol = new Map<string, Array<Record<string, unknown>>>();
  for (const c of allCards) {
    let bucket = byCol.get(c.column_id as string);
    if (!bucket) { bucket = []; byCol.set(c.column_id as string, bucket); }
    bucket.push({
      id: c._row_id, title: c.title, description: c.description,
      label: c.label, sort_order: c.sort_order,
    });
  }
  return cols.map((col) => ({
    id: col._row_id, title: col.title, channel: col.channel,
    sort_order: col.sort_order, cards: byCol.get(col._row_id) ?? [],
  }));
}

async function nextSortOrder(t: Tbl): Promise<number> {
  return Number(await t.max("sort_order") ?? -1) + 1;
}

function notify(sfiId: string) {
  pushToInstance(sfiId, { type: "kanban_changed" });
}

// ----- Writes ---------------------------------------------------------------------------
// One shared mutation path for BOTH transports: the bus dispatcher below (frame.busSend →
// onUiMessage, the primary write path) and the HTTP POST arm in onNetworkRequest (kept for
// older viewers whose framelib has no busSend). `op` is the API path with "api/" stripped
// (e.g. "card/<id>/move"); `v` is the parsed payload. Role gates live here so the two
// entry points can never drift.
type WriteResult = { status: number; body: unknown };

async function handleWrite(sfiId: string, op: string, v: Record<string, unknown> | null, peer: Peer): Promise<WriteResult> {
  const { columns, cards } = dataTables(sfiId);

  // Every op below mutates state and is editor-only. Non-members AND Viewer-role
  // members are rejected with the same gate (never gate writes on is_sfi_member —
  // Viewer-role members would slip through).
  if (!peer.is_sfi_editor) return { status: 403, body: { error: "editors only" } };

  const ok = async (): Promise<WriteResult> => {
    notify(sfiId);
    return { status: 200, body: { columns: await boardData(columns, cards) } };
  };

  // --- Columns --------------------------------------------------------------------------
  if (op === "column") {
    const title = sanitizeText(v?.title, 80) || "Untitled";
    const channelRaw = typeof v?.channel === "string" ? v.channel : "";
    const existing = (await columns.query({})).rows.length;
    const channel = CHANNEL_RE.test(channelRaw) ? channelRaw : `c${(existing % 12) + 1}`;
    await columns.upsert(null, { title, channel, sort_order: await nextSortOrder(columns) });
    return ok();
  }

  if (op === "columns/reorder") {
    const ids = Array.isArray(v?.ids) ? v.ids.filter((x): x is string => typeof x === "string" && !!x) : [];
    const { rows } = await columns.query({});
    const known = new Set(rows.map((r) => r._row_id));
    for (let i = 0; i < ids.length; i++) {
      if (known.has(ids[i])) await columns.upsert(ids[i], { sort_order: i });
    }
    return ok();
  }

  if (op.startsWith("column/")) {
    const [id, action] = op.slice("column/".length).split("/");
    if (!id || !(await columns.get(id))) return { status: 400, body: { error: "bad id" } };
    if (action === "delete") {
      await cards.deleteWhere({ column_id: id });
      await columns.delete(id);
      return ok();
    }
    if (action) return { status: 404, body: { error: "not found" } };
    if (v?.title !== undefined) {
      const title = sanitizeText(v.title, 80);
      if (title) await columns.upsert(id, { title });
    }
    if (typeof v?.channel === "string" && CHANNEL_RE.test(v.channel)) {
      await columns.upsert(id, { channel: v.channel });
    }
    return ok();
  }

  // --- Cards ----------------------------------------------------------------------------
  if (op === "card") {
    const columnId = typeof v?.column_id === "string" ? v.column_id : "";
    const title = sanitizeText(v?.title, 200);
    if (!title) return { status: 400, body: { error: "title required" } };
    if (!columnId || !(await columns.get(columnId))) return { status: 400, body: { error: "bad column" } };
    // "top" (the header +) slots the card first; "bottom" (the end-of-list zone)
    // appends. Orders are relative, so min-1 / max+1 need no renumbering.
    const { rows } = await cards.query({ where: { column_id: columnId } });
    const sortOrder = v?.position === "top"
      ? rows.reduce((m, r) => Math.min(m, Number(r.sort_order)), 1) - 1
      : rows.reduce((m, r) => Math.max(m, Number(r.sort_order)), -1) + 1;
    await cards.upsert(null, {
      column_id: columnId, title, description: "", label: "",
      sort_order: sortOrder, created_ms: Date.now(),
    });
    return ok();
  }

  if (op.startsWith("card/")) {
    const [id, action] = op.slice("card/".length).split("/");
    if (!id || !(await cards.get(id))) return { status: 400, body: { error: "bad id" } };

    if (action === "delete") {
      await cards.delete(id);
      return ok();
    }

    // Move: payload carries the target column and that column's full card order
    // (including the moved card) after the drop.
    if (action === "move") {
      const columnId = typeof v?.column_id === "string" ? v.column_id : "";
      if (!columnId || !(await columns.get(columnId))) return { status: 400, body: { error: "bad column" } };
      const ids = Array.isArray(v?.ids) ? v.ids.filter((x): x is string => typeof x === "string" && !!x) : [];
      await cards.upsert(id, { column_id: columnId });
      const { rows } = await cards.query({});
      const known = new Set(rows.map((r) => r._row_id));
      for (let i = 0; i < ids.length; i++) {
        if (known.has(ids[i])) await cards.upsert(ids[i], { sort_order: i });
      }
      return ok();
    }

    if (action) return { status: 404, body: { error: "not found" } };
    if (v?.title !== undefined) {
      const title = sanitizeText(v.title, 200);
      if (title) await cards.upsert(id, { title });
    }
    if (v?.description !== undefined) {
      await cards.upsert(id, { description: sanitizeText(v.description, 4000) });
    }
    if (v?.label !== undefined) {
      await cards.upsert(id, { label: sanitizeText(v.label, 24) });
    }
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
  if (r.status !== 200) log(`kanban: bus op ${d.op} → ${r.status} (${JSON.stringify(r.body)})`);
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

  const { columns, cards } = dataTables(sfiId);

  // Read — open to everyone (non-members get a read-only view of the board).
  if (reqPath === "/api/board" && method === "GET") {
    // First-open seeding: an editor's first look at an empty board lands the three
    // classic columns (no sample cards). Never seeded for read-only viewers — a GET
    // from a viewer must not mutate.
    if (peer.is_sfi_editor && (await columns.query({ limit: 1 })).rows.length === 0) {
      for (let i = 0; i < SEED_COLUMNS.length; i++) {
        await columns.upsert(null, {
          title: SEED_COLUMNS[i][0], channel: SEED_COLUMNS[i][1], sort_order: i,
        });
      }
    }
    return jsonReply(replyPort, 200, {
      columns: await boardData(columns, cards),
    });
  }

  return jsonReply(replyPort, 404, { error: "not found" });
};

log("Kanban Board frame is up and running!");
