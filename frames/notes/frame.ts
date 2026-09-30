// ----------------------------------------------------------------------------------------
// Notes — an instant-capture stream, not a document.
//
// Design axes:
//   privacy:        privacy-public-view  — non-members read the stream live, through
//                                           GET /api/list; space editors write.
//   data_storage:   the space's frame data — `_fdata/notes.table.jsonl`, synced
//                                           with the space to every member and openable in any
//                                           table tool. No contract: nobody else acts on these
//                                           rows (docs/schema-contracts.md, "When NOT to write a
//                                           contract").
//   view_realtime:  view-collaborative    — every write pushes; a note typed on a phone is
//                                           on the desk machine before you look up.
//   settings_scope: settings-per-sfi
//
// The whole point is that capturing costs one keystroke and no decisions: no title, no
// folder, no file. So the backend does the filing instead of asking the writer to — tags
// are DERIVED from the body (any #word), never entered separately. A second field to fill
// in is exactly the friction this frame exists to remove.
// ----------------------------------------------------------------------------------------
import type { Ctx } from "@frame-core";
import { sanitizeText } from "@frame-core";

const NOTES = "notes";
const NOTES_SCHEMA = [
  { name: "body",        col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "tags",        col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "author_name", col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "author_id",   col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "created_ms",  col_type: "integer" as const, nullable: false, default_val: "0" },
  { name: "edited_ms",   col_type: "integer" as const, nullable: false, default_val: "0" },
  { name: "pinned",      col_type: "integer" as const, nullable: false, default_val: "0" },
];

type Row = Record<string, unknown> & { id: string };

const MAX_BODY = 4000;

const DEFAULTS: Record<string, unknown> = Object.fromEntries(
  NOTES_SCHEMA.map((c) => [c.name, c.col_type === "integer" ? Number(c.default_val) : c.default_val]),
);

/** Write a note over what it held (a new one over the schema's defaults), stamped when
 * it was made and when it changed. */
async function keep(ctx: Ctx, id: string | null, values: Record<string, unknown>): Promise<Row> {
  const t = ctx.shared.table<Record<string, unknown>>(NOTES);
  const was = id ? await t.get(id) : null;
  const now = Date.now();
  return await t.upsert({
    ...(was ?? { ...DEFAULTS, _created_at: now }),
    ...values,
    ...(id ? { id } : {}),
    _modified_at: now,
  });
}

/** Pull #tags out of the body. Lowercased so "#Work" and "#work" are one tag, deduped,
 * and capped so a wall of hashes can't bloat the row. Trailing punctuation is trimmed:
 * people type "#work." at the end of a sentence and mean the tag, not the full stop. */
function extractTags(body: string): string {
  const found: string[] = [];
  const re = /(^|\s)#([\p{L}\p{N}][\p{L}\p{N}_-]{0,39})/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const t = m[2].toLowerCase().replace(/[-_]+$/, "");
    if (t && !found.includes(t)) found.push(t);
    if (found.length >= 12) break;
  }
  return found.join(",");
}

async function listNotes(ctx: Ctx) {
  // Newest first. Pinned notes are lifted client-side rather than sorted here, so the
  // stream's underlying order stays purely chronological.
  const rows = (await ctx.shared.table<Record<string, unknown>>(NOTES).all())
    .sort((a, b) => (Number(b.created_ms) || 0) - (Number(a.created_ms) || 0))
    .slice(0, 500);
  return rows.map((r) => ({
    id: r.id,
    body: r.body,
    tags: String(r.tags || "").split(",").filter(Boolean),
    author_name: r.author_name,
    author_id: r.author_id,
    created_ms: Number(r.created_ms) || 0,
    edited_ms: Number(r.edited_ms) || 0,
    pinned: !!Number(r.pinned),
  }));
}

const json = (v: unknown, status = 200) => Response.json(v, { status });

async function handleWrite(ctx: Ctx, op: string, v: Record<string, unknown> | null): Promise<Response> {
  // Never gate writes on is_sfi_member — a Viewer-role member would slip through.
  if (!(ctx.peer.is_sfi_editor || ctx.peer.is_owner)) return json({ error: "editors only" }, 403);

  // What changed, never what it holds: each page reads again as whoever it is.
  const ok = async () => {
    ctx.push({ notes: "notes" });
    return json({ notes: await listNotes(ctx) });
  };

  if (op === "note") {
    const body = sanitizeText(v?.body, MAX_BODY);
    if (!body.trim()) return json({ error: "empty note" }, 400);
    await keep(ctx, null, {
      body,
      tags: extractTags(body),
      author_name: sanitizeText(ctx.peer.user_name, 60),
      author_id: String(ctx.peer.user_id ?? ""),
      created_ms: Date.now(),
      edited_ms: 0,
      pinned: 0,
    });
    return ok();
  }

  if (op.startsWith("note/")) {
    const [id, action] = op.slice("note/".length).split("/");
    const row = id ? await ctx.shared.table(NOTES).get(id) : null;
    if (!row) return json({ error: "bad id" }, 400);

    if (action === "delete") { await ctx.shared.table(NOTES).delete(id); return ok(); }
    if (action === "pin") {
      await keep(ctx, id, { pinned: Number(v?.pinned) ? 1 : 0 });
      return ok();
    }
    if (action) return json({ error: "not found" }, 404);

    if (v?.body !== undefined) {
      const body = sanitizeText(v.body, MAX_BODY);
      if (!body.trim()) return json({ error: "empty note" }, 400);
      // Re-derive the tags: the body is the only source of truth for them, so an edit
      // that removes a #tag has to remove it from the filter list too.
      await keep(ctx, id, { body, tags: extractTags(body), edited_ms: Date.now() });
    }
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

export default {
  async fetch(request: Request, ctx: Ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    const method = request.method;

    if (method === "GET" && !pathname.startsWith("/api/")) return ctx.file(pathname);

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

    if (pathname === "/api/list" && method === "GET") return json({ notes: await listNotes(ctx) });

    return json({ error: "not found" }, 404);
  },
};
