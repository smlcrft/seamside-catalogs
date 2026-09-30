// ----------------------------------------------------------------------------------------
// Checklist — a simple, collaborative to-do list.
//
// Design axes:
//   privacy:        privacy-public-view  — anyone who reaches the frame gets a live
//                                           read-only view; editors get the interactive UI.
//                                           The page reads no table: the list comes from
//                                           GET /api/list, and every write is a route here.
//   data_storage:   the space's table    — `checklist.table.jsonl` at the space's root:
//                                           one list per space, synced with it to every
//                                           member, openable in any table tool. Every
//                                           checklist session in the space shows it.
//   view_realtime:  view-collaborative    — every write pushes `{ checklist: "items" }`,
//                                           which says what to read again and never what
//                                           it holds, so every open page refreshes live.
//
// Each item has a 3-state status: 0 = unstarted, 1 = in-progress, 2 = complete.
// ----------------------------------------------------------------------------------------
import type { Ctx } from "@frame-core";
import { declareTables, sanitizeText, toIntOrNull, clampInt } from "@frame-core";

// ----- The space's table (named for this frame, so no other frame's rows land in it) ------
const ITEMS = "checklist";
const SCHEMA = [
  { name: "text",       col_type: "text",    nullable: false, default_val: "" },
  { name: "state",      col_type: "integer", nullable: false, default_val: "0" },
  { name: "sort_order", col_type: "integer", nullable: false, default_val: "0" },
  { name: "created_ms", col_type: "integer", nullable: false, default_val: "0" },
  { name: "actor_id",   col_type: "text",    nullable: true,  default_val: "" },
  { name: "actor_name", col_type: "text",    nullable: true,  default_val: "" },
] as const;

declareTables([{
  key: ITEMS,
  title: "Checklist Items",
  description: "Tasks on this space's checklist.",
  local: true,
  schema: [...SCHEMA],
}]);

// ----- Helpers --------------------------------------------------------------------------
type Row = Record<string, unknown> & { id: string };

const items = (ctx: Ctx) => ctx.table<Record<string, unknown>>(ITEMS);

const DEFAULTS: Record<string, unknown> = Object.fromEntries(
  SCHEMA.map((c) => [c.name, c.col_type === "integer" ? Number(c.default_val) : c.default_val]),
);

/** Write a row over what it held (a new one from the schema's defaults), stamped. */
async function keep(ctx: Ctx, id: string | null, values: Record<string, unknown>): Promise<Row> {
  const was = id ? await items(ctx).get(id) : null;
  const now = Date.now();
  return await items(ctx).upsert({
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

async function listItems(ctx: Ctx) {
  const rows = (await items(ctx).all()).sort((a, b) =>
    cmp(a.sort_order, b.sort_order) || cmp(a.created_ms, b.created_ms));
  return rows.map((r) => ({
    id: r.id, text: r.text, state: r.state,
    sort_order: r.sort_order, actor_name: r.actor_name || "",
  }));
}

async function nextSortOrder(ctx: Ctx): Promise<number> {
  let best: unknown = null;
  for (const r of await items(ctx).all()) {
    const v = r.sort_order;
    if (v === null || v === undefined) continue;
    if (best === null || cmp(v, best) > 0) best = v;
  }
  return Number(best ?? -1) + 1;
}

// What changed, never what it holds: each page reads again as whoever it is.
const tell = (ctx: Ctx) => ctx.push({ checklist: "items" });

const json = (v: unknown, status = 200) => Response.json(v, { status });

// deno-lint-ignore no-explicit-any
async function body(request: Request): Promise<Record<string, any> | null> {
  try {
    const v = JSON.parse(await request.text());
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

// ----- Writes ---------------------------------------------------------------------------
// `op` is the API path with the leading "/api/" stripped. Every write is an editor's:
// strangers AND viewer-role members are refused by the same gate.
// deno-lint-ignore no-explicit-any
async function write(ctx: Ctx, op: string, v: Record<string, any> | null): Promise<Response> {
  if (!(ctx.peer.is_sfi_editor || ctx.peer.is_owner)) return json({ error: "editors only" }, 403);

  // Add a new item in the last slot.
  if (op === "add") {
    const text = sanitizeText(v?.text, 1000);
    if (!text) return json({ error: "text required" }, 400);
    await keep(ctx, null, { text, state: 0, sort_order: await nextSortOrder(ctx), created_ms: Date.now() });
    tell(ctx);
    return json({ items: await listItems(ctx) });
  }

  // Update one item's state and/or text; an unknown id is refused, never created.
  if (op.startsWith("item/")) {
    const id = op.slice("item/".length);
    if (!id || !(await items(ctx).get(id))) return json({ error: "bad id" }, 400);
    const next: Record<string, unknown> = {};
    if (v?.state !== undefined) {
      const state = clampInt(toIntOrNull(v.state) ?? 0, 0, 2);
      // Credit who moved this item off "unstarted"; clear the credit when it returns to 0.
      if (state === 0) Object.assign(next, { state, actor_id: "", actor_name: "" });
      else {
        const actorName = sanitizeText(ctx.peer.user_name, 80) || "someone";
        Object.assign(next, { state, actor_id: ctx.peer.user_id ?? "", actor_name: actorName });
      }
    }
    if (v?.text !== undefined) next.text = sanitizeText(v.text, 1000);
    if (Object.keys(next).length) await keep(ctx, id, next);
    tell(ctx);
    return json({ items: await listItems(ctx) });
  }

  // Reorder — carries the full ordered list of item ids; only ids that exist are touched.
  if (op === "reorder") {
    const ids: string[] = Array.isArray(v?.ids) ? v.ids.filter((x: unknown): x is string => typeof x === "string" && !!x) : [];
    const known = new Set((await items(ctx).all()).map((r) => r.id));
    for (let i = 0; i < ids.length; i++) {
      if (known.has(ids[i])) await keep(ctx, ids[i], { sort_order: i });
    }
    tell(ctx);
    return json({ items: await listItems(ctx) });
  }

  if (op.startsWith("delete/")) {
    const id = op.slice("delete/".length);
    if (!id) return json({ error: "bad id" }, 400);
    await items(ctx).delete(id);
    tell(ctx);
    return json({ items: await listItems(ctx) });
  }

  return json({ error: "not found" }, 404);
}

// ----- Networking -----------------------------------------------------------------------
export default {
  async fetch(request: Request, ctx: Ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    const editor = ctx.peer.is_sfi_editor || ctx.peer.is_owner;
    const member = editor || ctx.peer.is_sfi_member;

    // The page and its assets — open to everyone, read-only visitors included.
    if (request.method === "GET" && !pathname.startsWith("/api/")) return ctx.file(pathname);

    // Who the door says is asking — drives which render mode the page shows.
    if (pathname === "/api/whoami" && request.method === "GET") {
      return json({
        is_anon:       ctx.peer.is_anon,
        is_sfi_member: member,
        is_sfi_editor: editor,
        is_owner:      ctx.peer.is_owner,
        user_id:       ctx.peer.user_id,
        user_name:     ctx.peer.user_name,
        space_color:   ctx.peer.space_color,
      });
    }

    // Read — open to everyone who reaches the frame (a read-only view of the list).
    if (pathname === "/api/list" && request.method === "GET") return json({ items: await listItems(ctx) });

    if (pathname.startsWith("/api/") && request.method === "POST") {
      return write(ctx, pathname.slice("/api/".length), await body(request));
    }

    return json({ error: "not found" }, 404);
  },
};
