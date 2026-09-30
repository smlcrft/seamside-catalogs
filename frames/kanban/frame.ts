// ----------------------------------------------------------------------------------------
// Kanban Board — a drag-and-drop task board with channel-colored columns.
//
// Design axes:
//   privacy:        privacy-public-view  — non-members get a live read-only view;
//                                           space editors get the interactive board.
//                                           The page reads no table: the board comes
//                                           from this worker, and every write is a
//                                           route here that decides on ctx.peer.
//   data_storage:   the space's frame data — `kanban_columns` and `kanban_cards`
//                                           (`_fdata/<name>.table.jsonl`),
//                                           synced with the space; one board per space.
//   view_realtime:  view-collaborative    — every mutation pushes { kanban: "board" },
//                                           and every open page reads the board again.
//
// Columns carry a channel (c1–c12) as their identity color; cards carry a title,
// an optional description, and an optional short label.
// ----------------------------------------------------------------------------------------
import type { Ctx, PeerInfo } from "@frame-core";
import { declareTables, parseJsonBody, sanitizeText } from "@frame-core";

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

// ----- The space's frame data tables, named for this frame (`cards` alone is also Flashcards') ------
const COLUMNS = "kanban_columns";
const CARDS = "kanban_cards";
declareTables([
  { key: COLUMNS, title: "Kanban Columns", description: "Columns of this space's kanban board.", schema: COLUMNS_SCHEMA },
  { key: CARDS,   title: "Kanban Cards",   description: "Cards of this space's kanban board.",   schema: CARDS_SCHEMA },
]);
const SCHEMAS: Record<string, Array<{ name: string; col_type: string; default_val: string }>> = {
  [COLUMNS]: COLUMNS_SCHEMA, [CARDS]: CARDS_SCHEMA,
};

type Row = Record<string, unknown> & { id: string };

const rows = (ctx: Ctx, name: string) => ctx.shared.table<Record<string, unknown>>(name);

/** A new row: the schema's defaults, stamped when it was made. */
function fresh(name: string, now: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of SCHEMAS[name] ?? []) {
    out[c.name] = c.col_type === "integer" ? Number(c.default_val) : c.default_val;
  }
  out._created_at = now;
  return out;
}

/** Write a row over what it held, stamped when it changed. */
async function keep(ctx: Ctx, name: string, id: string | null, values: Record<string, unknown>): Promise<Row> {
  const was = id ? await rows(ctx, name).get(id) : null;
  const now = Date.now();
  return await rows(ctx, name).upsert({
    ...(was ?? fresh(name, now)),
    ...values,
    ...(id ? { id } : {}),
    _modified_at: now,
  });
}

function cmp(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a ?? "").localeCompare(String(b ?? ""));
}
/** Order by these columns, each ascending. */
const by = (...cols: string[]) => (a: Row, b: Row) => {
  for (const c of cols) { const d = cmp(a[c], b[c]); if (d) return d; }
  return 0;
};

const CHANNEL_RE = /^c([1-9]|1[0-2])$/;
const SEED_COLUMNS: Array<[string, string]> = [
  ["To do", "c2"], ["In progress", "c4"], ["Done", "c5"],
];

// ----- Queries --------------------------------------------------------------------------
async function boardData(ctx: Ctx) {
  const cols = (await rows(ctx, COLUMNS).all()).sort(by("sort_order", "_created_at"));
  const allCards = (await rows(ctx, CARDS).all()).sort(by("sort_order", "created_ms"));
  const byCol = new Map<string, Array<Record<string, unknown>>>();
  for (const c of allCards) {
    let bucket = byCol.get(c.column_id as string);
    if (!bucket) { bucket = []; byCol.set(c.column_id as string, bucket); }
    bucket.push({
      id: c.id, title: c.title, description: c.description,
      label: c.label, sort_order: c.sort_order,
    });
  }
  return cols.map((col) => ({
    id: col.id, title: col.title, channel: col.channel,
    sort_order: col.sort_order, cards: byCol.get(col.id) ?? [],
  }));
}

async function nextSortOrder(ctx: Ctx, name: string): Promise<number> {
  return (await rows(ctx, name).all()).reduce((m, r) => Math.max(m, Number(r.sort_order)), -1) + 1;
}

// ----- Writes ---------------------------------------------------------------------------
// `op` is the API path with "/api/" stripped (e.g. "card/<id>/move"); `v` the parsed body.
type WriteResult = { status: number; body: unknown };

async function handleWrite(ctx: Ctx, op: string, v: Record<string, unknown> | null, editor: boolean): Promise<WriteResult> {
  // Every op below mutates state and is editor-only: strangers and Viewer-role members
  // are refused alike.
  if (!editor) return { status: 403, body: { error: "editors only" } };

  const ok = async (): Promise<WriteResult> => {
    ctx.push({ kanban: "board" });
    return { status: 200, body: { columns: await boardData(ctx) } };
  };

  // --- Columns --------------------------------------------------------------------------
  if (op === "column") {
    const title = sanitizeText(v?.title, 80) || "Untitled";
    const channelRaw = typeof v?.channel === "string" ? v.channel : "";
    const existing = (await rows(ctx, COLUMNS).all()).length;
    const channel = CHANNEL_RE.test(channelRaw) ? channelRaw : `c${(existing % 12) + 1}`;
    await keep(ctx, COLUMNS, null, { title, channel, sort_order: await nextSortOrder(ctx, COLUMNS) });
    return ok();
  }

  if (op === "columns/reorder") {
    const ids = Array.isArray(v?.ids) ? v.ids.filter((x): x is string => typeof x === "string" && !!x) : [];
    const known = new Set((await rows(ctx, COLUMNS).all()).map((r) => r.id));
    for (let i = 0; i < ids.length; i++) {
      if (known.has(ids[i])) await keep(ctx, COLUMNS, ids[i], { sort_order: i });
    }
    return ok();
  }

  if (op.startsWith("column/")) {
    const [id, action] = op.slice("column/".length).split("/");
    if (!id || !(await rows(ctx, COLUMNS).get(id))) return { status: 400, body: { error: "bad id" } };
    if (action === "delete") {
      for (const c of await rows(ctx, CARDS).all()) {
        if (c.column_id === id) await rows(ctx, CARDS).delete(c.id);
      }
      await rows(ctx, COLUMNS).delete(id);
      return ok();
    }
    if (action) return { status: 404, body: { error: "not found" } };
    if (v?.title !== undefined) {
      const title = sanitizeText(v.title, 80);
      if (title) await keep(ctx, COLUMNS, id, { title });
    }
    if (typeof v?.channel === "string" && CHANNEL_RE.test(v.channel)) {
      await keep(ctx, COLUMNS, id, { channel: v.channel });
    }
    return ok();
  }

  // --- Cards ----------------------------------------------------------------------------
  if (op === "card") {
    const columnId = typeof v?.column_id === "string" ? v.column_id : "";
    const title = sanitizeText(v?.title, 200);
    if (!title) return { status: 400, body: { error: "title required" } };
    if (!columnId || !(await rows(ctx, COLUMNS).get(columnId))) return { status: 400, body: { error: "bad column" } };
    // "top" (the header +) slots the card first; "bottom" (the end-of-list zone)
    // appends. Orders are relative, so min-1 / max+1 need no renumbering.
    const inCol = (await rows(ctx, CARDS).all()).filter((r) => r.column_id === columnId);
    const sortOrder = v?.position === "top"
      ? inCol.reduce((m, r) => Math.min(m, Number(r.sort_order)), 1) - 1
      : inCol.reduce((m, r) => Math.max(m, Number(r.sort_order)), -1) + 1;
    await keep(ctx, CARDS, null, {
      column_id: columnId, title, description: "", label: "",
      sort_order: sortOrder, created_ms: Date.now(),
    });
    return ok();
  }

  if (op.startsWith("card/")) {
    const [id, action] = op.slice("card/".length).split("/");
    if (!id || !(await rows(ctx, CARDS).get(id))) return { status: 400, body: { error: "bad id" } };

    if (action === "delete") {
      await rows(ctx, CARDS).delete(id);
      return ok();
    }

    // Move: payload carries the target column and that column's full card order
    // (including the moved card) after the drop.
    if (action === "move") {
      const columnId = typeof v?.column_id === "string" ? v.column_id : "";
      if (!columnId || !(await rows(ctx, COLUMNS).get(columnId))) return { status: 400, body: { error: "bad column" } };
      const ids = Array.isArray(v?.ids) ? v.ids.filter((x): x is string => typeof x === "string" && !!x) : [];
      await keep(ctx, CARDS, id, { column_id: columnId });
      const known = new Set((await rows(ctx, CARDS).all()).map((r) => r.id));
      for (let i = 0; i < ids.length; i++) {
        if (known.has(ids[i])) await keep(ctx, CARDS, ids[i], { sort_order: i });
      }
      return ok();
    }

    if (action) return { status: 404, body: { error: "not found" } };
    if (v?.title !== undefined) {
      const title = sanitizeText(v.title, 200);
      if (title) await keep(ctx, CARDS, id, { title });
    }
    if (v?.description !== undefined) {
      await keep(ctx, CARDS, id, { description: sanitizeText(v.description, 4000) });
    }
    if (v?.label !== undefined) {
      await keep(ctx, CARDS, id, { label: sanitizeText(v.label, 24) });
    }
    return ok();
  }

  return { status: 404, body: { error: "not found" } };
}

const json = (v: unknown, status = 200) => Response.json(v, { status });

function whoami(peer: PeerInfo, editor: boolean, member: boolean) {
  return {
    is_anon:       peer.is_anon,
    is_sfi_member: member,
    is_sfi_editor: editor,
    is_owner:      peer.is_owner,
    user_id:       peer.user_id,
    user_name:     peer.user_name,
    space_color:   peer.space_color,
  };
}

// ----- Networking -----------------------------------------------------------------------
export default {
  async fetch(request: Request, ctx: Ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    const method = request.method;
    const editor = ctx.peer.is_sfi_editor || ctx.peer.is_owner;
    const member = editor || ctx.peer.is_sfi_member;

    // Static assets — open to everyone, including anon read-only viewers.
    if (method === "GET" && !pathname.startsWith("/api/")) return ctx.file(pathname);

    // Identity probe — drives which render mode the frontend shows.
    if (pathname === "/api/whoami" && method === "GET") return json(whoami(ctx.peer, editor, member));

    if (pathname.startsWith("/api/") && (method === "POST" || method === "PUT")) {
      const v = parseJsonBody<Record<string, unknown>>(await request.arrayBuffer());
      const r = await handleWrite(ctx, pathname.slice("/api/".length), v, editor);
      return json(r.body, r.status);
    }

    // Read — open to everyone (non-members get a read-only view of the board).
    if (pathname === "/api/board" && method === "GET") {
      // First-open seeding: an editor's first look at an empty board lands the three
      // classic columns (no sample cards). Never seeded for read-only viewers — a GET
      // from a viewer must not mutate.
      if (editor && (await rows(ctx, COLUMNS).all()).length === 0) {
        for (let i = 0; i < SEED_COLUMNS.length; i++) {
          await keep(ctx, COLUMNS, null, {
            title: SEED_COLUMNS[i][0], channel: SEED_COLUMNS[i][1], sort_order: i,
          });
        }
      }
      return json({ columns: await boardData(ctx) });
    }

    return json({ error: "not found" }, 404);
  },
};
