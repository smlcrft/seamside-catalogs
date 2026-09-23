// ----------------------------------------------------------------------------------------
// Recipe Box — the family recipe collection: store recipes, read them beautifully.
//
// Design axes:
//   privacy:        privacy-public-view  — non-members get a live read-only view;
//                                           space editors manage the collection.
//   data_storage:   the space's table    — `recipes.table.jsonl` at the space's root,
//                                           synced with the space; the Meal Planner in
//                                           the same space reads the same rows.
//   view_realtime:  view-collaborative    — every mutation calls pushToInstance(sfi_id, …)
//                                           so every viewer refreshes live.
//
// Recipe Box OWNS the `recipes` v1 contract (docs/schema-contracts.md): the schema below
// is the contract constant, declared verbatim. Linked frames read these rows; this frame
// has full CRUD.
// ----------------------------------------------------------------------------------------
import {
  log, serveFileAtPath, jsonReply, parseJsonBody, parsePeerInfo, onUiMessage,
  pushToInstance, sanitizeText,
  declareTables, table,
} from "@frame-core";

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
declareTables([
  { key: "recipes", title: "Recipes", description: "The recipe box of this space.", schema: RECIPES_SCHEMA },
]);

type Tbl = ReturnType<typeof table>;
type Peer = ReturnType<typeof parsePeerInfo>;

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
async function recipesData(recipes: Tbl) {
  const { rows } = await recipes.query({});
  return rows
    .map((r) => ({
      id: r._row_id, title: r.title, ingredients_lines: r.ingredients_lines,
      steps_lines: r.steps_lines, servings: r.servings, tags: r.tags,
      notes: r.notes, created_ms: r.created_ms, photo: r.photo ?? "",
    }))
    .sort((a, b) => String(a.title).localeCompare(String(b.title), undefined, { sensitivity: "base" }));
}

function notify(sfiId: string) {
  pushToInstance(sfiId, { type: "recipes_changed" });
}

// ----- Writes ---------------------------------------------------------------------------
// One shared mutation path for BOTH transports: the bus dispatcher below (frame.busSend →
// onUiMessage, the primary write path) and the HTTP POST arm in onNetworkRequest (kept for
// older viewers whose framelib has no busSend). `op` is the API path with "api/" stripped
// (e.g. "recipe/<id>/delete"); `v` is the parsed payload. Role gates live here so the two
// entry points can never drift.
type WriteResult = { status: number; body: unknown };

async function handleWrite(sfiId: string, op: string, v: Record<string, unknown> | null, peer: Peer): Promise<WriteResult> {
  const recipes = table("recipes", sfiId);

  // Every op below mutates state and is editor-only. Non-members AND Viewer-role
  // members are rejected with the same gate (never gate writes on is_sfi_member —
  // Viewer-role members would slip through).
  if (!peer.is_sfi_editor) return { status: 403, body: { error: "editors only" } };

  const ok = async (): Promise<WriteResult> => {
    notify(sfiId);
    return { status: 200, body: { recipes: await recipesData(recipes) } };
  };

  // --- Recipes --------------------------------------------------------------------------
  if (op === "recipe") {
    const title = sanitizeText(v?.title, 200);
    if (!title) return { status: 400, body: { error: "title required" } };
    await recipes.upsert(null, {
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
    if (!id || !(await recipes.get(id))) return { status: 400, body: { error: "bad id" } };

    if (action === "delete") {
      await recipes.delete(id);
      return ok();
    }
    if (action) return { status: 404, body: { error: "not found" } };

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
    if (Object.keys(patch).length) await recipes.upsert(id, patch);
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
  if (r.status !== 200) log(`recipe_box: bus op ${d.op} → ${r.status} (${JSON.stringify(r.body)})`);
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

  const recipes = table("recipes", sfiId);

  // Read — open to everyone (non-members get a read-only view of the
  // collection). Never seeded: an empty box renders its own empty state.
  if (reqPath === "/api/recipes" && method === "GET") {
    return jsonReply(replyPort, 200, {
      recipes: await recipesData(recipes),
    });
  }

  return jsonReply(replyPort, 404, { error: "not found" });
};

log("Recipe Box frame is up and running!");
