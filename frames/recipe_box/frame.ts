// ----------------------------------------------------------------------------------------
// Recipe Box — the family recipe collection: store recipes, read them beautifully.
//
// Design axes:
//   privacy:        privacy-public-view  — non-members get a live read-only view through
//                                           GET /api/recipes; space editors manage the
//                                           collection.
//   data_storage:   the frame data folder — `_fdata/recipes.table.jsonl`, synced with
//                                           the space; the Meal Planner in
//                                           the same space reads the same rows.
//   view_realtime:  view-collaborative    — every write pushes, so every open page reads
//                                           again.
//
// Recipe Box OWNS the `recipes` v1 contract (docs/schema-contracts.md): the schema below
// is the contract constant, declared verbatim. Linked frames read these rows; this frame
// has full CRUD.
// ----------------------------------------------------------------------------------------
import type { Ctx } from "@frame-core";
import { sanitizeText } from "@frame-core";

// ----- Schema (contract `recipes` v1, verbatim) -----------------------------------------
const RECIPES_SCHEMA = [
  { name: "title",            col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "ingredients_lines", col_type: "text"   as const, nullable: false, default_val: "" },
  { name: "steps_lines",      col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "servings",         col_type: "integer" as const, nullable: false, default_val: "0" },
  { name: "tags",             col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "notes",            col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "created_ms",       col_type: "integer" as const, nullable: false, default_val: "0" },
  { name: "photo",            col_type: "text"    as const, nullable: false, default_val: "" },
];

// ----- The space's `recipes` table (the contract name: every kitchen frame in the space reads it)
const RECIPES = "recipes";

type Row = Record<string, unknown> & { id: string };

const DEFAULTS: Record<string, unknown> = Object.fromEntries(
  RECIPES_SCHEMA.map((c) => [c.name, c.col_type === "integer" ? Number(c.default_val) : c.default_val]),
);

/** Write a recipe over what it held (a new one over the schema's defaults), stamped when
 * it was made and when it changed. */
async function keep(ctx: Ctx, id: string | null, values: Record<string, unknown>): Promise<Row> {
  const t = ctx.shared.table<Record<string, unknown>>(RECIPES);
  const was = id ? await t.get(id) : null;
  const now = Date.now();
  return await t.upsert({
    ...(was ?? { ...DEFAULTS, _created_at: now }),
    ...values,
    ...(id ? { id } : {}),
    _modified_at: now,
  });
}

// ----- Field normalization --------------------------------------------------------------
/** Comma-separated lowercase tag list (contract format), each tag sanitized. */
function normalizeTags(v: unknown): string {
  if (typeof v !== "string") return "";
  const seen = new Set<string>();
  for (const part of v.split(",")) {
    const t = sanitizeText(part, 32).trim().toLowerCase();
    if (t) seen.add(t);
  }
  return [...seen].join(",");
}

/** Servings: a non-negative integer; anything else reads as 0 (= unspecified). */
function normalizeServings(v: unknown): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/** Photo per the contract: a small image data URI or empty. The frontend downscales
 * before sending; this is the backstop (type + size), never sanitizeText — a base64
 * payload is not prose. */
function normalizePhoto(v: unknown): string {
  if (typeof v !== "string" || v === "") return "";
  if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(v)) return "";
  return v.length <= 200_000 ? v : "";
}

// ----- Queries --------------------------------------------------------------------------
async function recipesData(ctx: Ctx) {
  const rows = await ctx.shared.table<Record<string, unknown>>(RECIPES).all();
  return rows
    .map((r) => ({
      id: r.id, title: r.title, ingredients_lines: r.ingredients_lines,
      steps_lines: r.steps_lines, servings: r.servings, tags: r.tags,
      notes: r.notes, created_ms: r.created_ms, photo: r.photo ?? "",
    }))
    .sort((a, b) => String(a.title).localeCompare(String(b.title), undefined, { sensitivity: "base" }));
}

const json = (v: unknown, status = 200) => Response.json(v, { status });

// ----- Writes ---------------------------------------------------------------------------
// `op` is the API path with "/api/" stripped (e.g. "recipe/<id>/delete"); `v` the parsed body.
async function handleWrite(ctx: Ctx, op: string, v: Record<string, unknown> | null): Promise<Response> {
  // Every op below mutates state and is editor-only. Non-members AND Viewer-role
  // members are rejected with the same gate (never gate writes on is_sfi_member —
  // Viewer-role members would slip through).
  if (!(ctx.peer.is_sfi_editor || ctx.peer.is_owner)) return json({ error: "editors only" }, 403);

  // What changed, never what it holds: each page reads again as whoever it is.
  const ok = async () => {
    ctx.push({ recipe_box: "recipes" });
    return json({ recipes: await recipesData(ctx) });
  };

  // --- Recipes --------------------------------------------------------------------------
  if (op === "recipe") {
    const title = sanitizeText(v?.title, 200);
    if (!title) return json({ error: "title required" }, 400);
    await keep(ctx, null, {
      title,
      ingredients_lines: sanitizeText(v?.ingredients_lines, 8000),
      steps_lines: sanitizeText(v?.steps_lines, 8000),
      servings: normalizeServings(v?.servings),
      tags: normalizeTags(v?.tags),
      notes: sanitizeText(v?.notes, 4000),
      created_ms: Date.now(),
      photo: normalizePhoto(v?.photo),
    });
    return ok();
  }

  if (op.startsWith("recipe/")) {
    const [id, action] = op.slice("recipe/".length).split("/");
    if (!id || !(await ctx.shared.table(RECIPES).get(id))) return json({ error: "bad id" }, 400);

    if (action === "delete") {
      await ctx.shared.table(RECIPES).delete(id);
      return ok();
    }
    if (action) return json({ error: "not found" }, 404);

    const patch: Record<string, unknown> = {};
    if (v?.title !== undefined) {
      const title = sanitizeText(v.title, 200);
      if (title) patch.title = title;
    }
    if (v?.ingredients_lines !== undefined) patch.ingredients_lines = sanitizeText(v.ingredients_lines, 8000);
    if (v?.steps_lines !== undefined) patch.steps_lines = sanitizeText(v.steps_lines, 8000);
    if (v?.servings !== undefined) patch.servings = normalizeServings(v.servings);
    if (v?.tags !== undefined) patch.tags = normalizeTags(v.tags);
    if (v?.notes !== undefined) patch.notes = sanitizeText(v.notes, 4000);
    if (v?.photo !== undefined) patch.photo = normalizePhoto(v.photo);
    if (Object.keys(patch).length) await keep(ctx, id, patch);
    return ok();
  }

  return json({ error: "not found" }, 404);
}

async function body(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const v = JSON.parse(await request.text());
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

// ----- Networking -----------------------------------------------------------------------
export default {
  async fetch(request: Request, ctx: Ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    const method = request.method;

    // Static assets — open to everyone, including anon read-only viewers.
    if (method === "GET" && !pathname.startsWith("/api/")) return ctx.file(pathname);

    // Identity probe — drives which render mode the frontend shows.
    if (pathname === "/api/whoami" && method === "GET") {
      const peer = ctx.peer;
      return json({
        is_anon:       peer.is_anon,
        is_sfi_member: peer.is_sfi_member,
        is_sfi_editor: peer.is_sfi_editor || peer.is_owner,
        is_owner:      peer.is_owner,
        user_id:       peer.user_id,
        user_name:     peer.user_name,
        space_color:   peer.space_color,
      });
    }

    if (pathname.startsWith("/api/") && (method === "POST" || method === "PUT")) {
      return handleWrite(ctx, pathname.slice("/api/".length), await body(request));
    }

    // Read — open to everyone (non-members get a read-only view of the
    // collection). Never seeded: an empty box renders its own empty state.
    if (pathname === "/api/recipes" && method === "GET") return json({ recipes: await recipesData(ctx) });

    return json({ error: "not found" }, 404);
  },
};
