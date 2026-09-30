// ----------------------------------------------------------------------------------------
// Grocery List — the realtime shared family shopping list.
//
// Design axes:
//   privacy:        privacy-public-view  — anyone who reaches the frame gets a live
//                                           read-only view; space editors get the
//                                           interactive list. The page reads the list
//                                           from GET /api/list, and every write is a
//                                           route here.
//   data_storage:   the frame data folder — `_fdata/grocery.table.jsonl`, shared with
//                                           every frame of the space and synced with it.
//   view_realtime:  view-collaborative    — every write pushes `{ grocery_list: "items" }`,
//                                           which says what to read again and never what
//                                           it holds. A push reaches only this session's
//                                           pages, so a member's page also watches the
//                                           table for rows other frames write.
//
// This frame OWNS the `grocery` v1 contract (docs/schema-contracts.md). A Meal Planner in
// the same space inserts ingredient rows into the same table with a `source`; this frame
// renders those with a small provenance hint but treats them as ordinary rows (full CRUD
// stays here, per the contract's role lines).
// ----------------------------------------------------------------------------------------
import type { Ctx } from "@frame-core";
import { declareTables, sanitizeText } from "@frame-core";

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
const GROCERY = "grocery";
declareTables([
  { key: GROCERY, title: "Grocery List", description: "The grocery list of this space.", schema: GROCERY_SCHEMA },
]);

// ----- Helpers --------------------------------------------------------------------------
type Row = Record<string, unknown> & { id: string };

const rows = (ctx: Ctx) => ctx.shared.table<Record<string, unknown>>(GROCERY);

const DEFAULTS: Record<string, unknown> = Object.fromEntries(
  GROCERY_SCHEMA.map((c) => [c.name, c.col_type === "integer" ? Number(c.default_val) : c.default_val]),
);

/** Write a row over what it held (a new one from the schema's defaults), stamped. */
async function keep(ctx: Ctx, id: string | null, values: Record<string, unknown>): Promise<Row> {
  const was = id ? await rows(ctx).get(id) : null;
  const now = Date.now();
  return await rows(ctx).upsert({
    ...(was ?? { ...DEFAULTS, _created_at: now }),
    ...values,
    ...(id ? { id } : {}),
    _modified_at: now,
  });
}

function cmp(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a ?? "").localeCompare(String(b ?? ""));
}

// ----- Queries --------------------------------------------------------------------------
async function listRows(ctx: Ctx) {
  const all = (await rows(ctx).all()).sort((a, b) => cmp(a.category, b.category) || cmp(a.added_ms, b.added_ms));
  return all.map((r) => ({
    id: r.id, item: r.item, quantity: r.quantity, category: r.category,
    checked: r.checked, source: r.source, added_ms: r.added_ms,
  }));
}

// What changed, never what it holds: each page reads again as whoever it is.
const tell = (ctx: Ctx) => ctx.push({ grocery_list: "items" });

const json = (v: unknown, status = 200) => Response.json(v, { status });

async function body(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const v = JSON.parse(await request.text());
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

// ----- Writes ---------------------------------------------------------------------------
// `op` is the API path with "/api/" stripped (e.g. "item/<id>/delete"); `v` is the parsed
// payload.
async function write(ctx: Ctx, op: string, v: Record<string, unknown> | null): Promise<Response> {
  // Every op below mutates state and is editor-only. Non-members AND Viewer-role
  // members are rejected with the same gate (never gate writes on is_sfi_member —
  // Viewer-role members would slip through).
  if (!(ctx.peer.is_sfi_editor || ctx.peer.is_owner)) return json({ error: "editors only" }, 403);

  const ok = async () => {
    tell(ctx);
    return json({ items: await listRows(ctx) });
  };

  // --- Items ----------------------------------------------------------------------------
  if (op === "item") {
    const item = sanitizeText(v?.item, 200);
    if (!item) return json({ error: "item required" }, 400);
    await keep(ctx, null, {
      item,
      quantity: sanitizeText(v?.quantity, 40),
      category: sanitizeText(v?.category, 40).toLowerCase(),
      checked: 0, source: "", added_ms: Date.now(),
    });
    return ok();
  }

  if (op.startsWith("item/")) {
    const [id, action] = op.slice("item/".length).split("/");
    if (!id || !(await rows(ctx).get(id))) return json({ error: "bad id" }, 400);
    if (action === "delete") {
      await rows(ctx).delete(id);
      return ok();
    }
    if (action) return json({ error: "not found" }, 404);
    const next: Record<string, unknown> = {};
    if (v?.item !== undefined) {
      const item = sanitizeText(v.item, 200);
      if (item) next.item = item;
    }
    if (v?.quantity !== undefined) next.quantity = sanitizeText(v.quantity, 40);
    if (v?.category !== undefined) next.category = sanitizeText(v.category, 40).toLowerCase();
    if (v?.checked !== undefined) next.checked = Number(v.checked) ? 1 : 0;
    if (Object.keys(next).length) await keep(ctx, id, next);
    return ok();
  }

  // The "clear bought" sweep — delete every checked row in one pass.
  if (op === "clear_checked") {
    for (const r of await rows(ctx).all()) {
      if (Number(r.checked) === 1) await rows(ctx).delete(r.id);
    }
    return ok();
  }

  return json({ error: "not found" }, 404);
}

// ----- Networking -----------------------------------------------------------------------
export default {
  async fetch(request: Request, ctx: Ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    const { method } = request;

    // Static assets — open to everyone, including anon read-only viewers.
    if (method === "GET" && !pathname.startsWith("/api/")) return ctx.file(pathname);

    // Identity probe — drives which render mode the frontend shows.
    if (pathname === "/api/whoami" && method === "GET") {
      const editor = ctx.peer.is_sfi_editor || ctx.peer.is_owner;
      return json({
        is_anon:       ctx.peer.is_anon,
        is_sfi_member: editor || ctx.peer.is_sfi_member,
        is_sfi_editor: editor,
        is_owner:      ctx.peer.is_owner,
        user_id:       ctx.peer.user_id,
        user_name:     ctx.peer.user_name,
        space_color:   ctx.peer.space_color,
      });
    }

    if (pathname.startsWith("/api/") && (method === "POST" || method === "PUT")) {
      return write(ctx, pathname.slice("/api/".length), await body(request));
    }

    // Read — open to everyone (non-members get a read-only view of the list).
    // No seeding: an empty grocery list is an honest empty list.
    if (pathname === "/api/list" && method === "GET") return json({ items: await listRows(ctx) });

    return json({ error: "not found" }, 404);
  },
};
