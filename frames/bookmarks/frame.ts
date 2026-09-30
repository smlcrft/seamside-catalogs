// ----------------------------------------------------------------------------------------
// Bookmarks — save a link, find it again.
//
// Design axes:
//   privacy:        privacy-public-view  — non-members read and follow the links, through
//                                           GET /api/list; space editors save and edit.
//   data_storage:   the space's table    — `_fdata/bookmarks.table.jsonl`, the frame data folder,
//                                           synced with the space to every member. No
//                                           contract: nothing else acts on these rows
//                                           (docs/schema-contracts.md, "When NOT to write a
//                                           contract").
//   view_realtime:  view-collaborative    — every write pushes what to read again.
//   settings_scope: settings-per-sfi
//
// THIS FRAME FETCHES NOTHING. It would be easy to reach out for each page's <title> and
// favicon, and it would make the list prettier. It would also mean that saving a link
// privately quietly told that site you had done so, and turned a bookmark list into a
// browsing history broadcast — and bookmarks can point anywhere, so no list of hosts would do. So the title is derived from the address itself and the user renames it if the
// URL was unhelpful. The manifest declares no `permissions_backend.net`, which is a promise it
// makes on the frame's behalf and the platform enforces.
// ----------------------------------------------------------------------------------------
import type { Ctx } from "@frame-core";
import { declareTables, sanitizeText } from "@frame-core";

const BOOKMARKS = "bookmarks";
const BOOKMARKS_SCHEMA = [
  { name: "url",      col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "title",    col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "domain",   col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "note",     col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "tags",     col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "added_ms", col_type: "integer" as const, nullable: false, default_val: "0" },
  { name: "added_by", col_type: "text"    as const, nullable: false, default_val: "" },
];

declareTables([
  { key: BOOKMARKS, title: "Bookmarks", description: "Saved links for this space.", local: true, schema: BOOKMARKS_SCHEMA },
]);

type Row = Record<string, unknown> & { id: string };

const DEFAULTS: Record<string, unknown> = Object.fromEntries(
  BOOKMARKS_SCHEMA.map((c) => [c.name, c.col_type === "integer" ? Number(c.default_val) : c.default_val]),
);

/** Write a bookmark over what it held (a new one over the schema's defaults), stamped when
 * it was made and when it changed. */
async function keep(ctx: Ctx, id: string | null, values: Record<string, unknown>): Promise<Row> {
  const t = ctx.shared.table<Record<string, unknown>>(BOOKMARKS);
  const was = id ? await t.get(id) : null;
  const now = Date.now();
  return await t.upsert({
    ...(was ?? { ...DEFAULTS, _created_at: now }),
    ...values,
    ...(id ? { id } : {}),
    _modified_at: now,
  });
}

/** Accept only what a browser could actually open. A bookmark is a URL a person pasted, so
 * it is checked before it is stored, not when it is clicked. */
function normalizeUrl(raw: unknown): { url: string; domain: string } | null {
  let s = String(raw ?? "").trim();
  if (!s) return null;
  // People paste "example.com/thing" as often as a full address.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = "https://" + s;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname || !u.hostname.includes(".")) return null;
  return { url: u.href.slice(0, 2000), domain: u.hostname.replace(/^www\./, "") };
}

/** A readable name from the address alone — no network. The last meaningful path segment
 * usually carries the article slug, and a slug beats a bare domain in a list of fifty. */
function titleFromUrl(url: string, domain: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").filter(Boolean).pop() ?? "";
    const cleaned = decodeURIComponent(seg)
      .replace(/\.(html?|php|aspx?|md|pdf)$/i, "")
      .replace(/[-_+]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    // A numeric id ("12345") is worse than the site's name.
    if (cleaned && cleaned.length > 2 && !/^\d+$/.test(cleaned)) {
      return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
    }
  } catch { /* fall through to the domain */ }
  return domain;
}

function cleanTags(raw: unknown): string {
  const parts = String(raw ?? "")
    .split(/[,\s]+/)
    .map((t) => t.trim().replace(/^#/, "").toLowerCase())
    .filter((t) => t && t.length <= 40);
  return [...new Set(parts)].slice(0, 12).join(",");
}

async function listRows(ctx: Ctx) {
  const rows = (await ctx.shared.table<Record<string, unknown>>(BOOKMARKS).all())
    .sort((a, b) => (Number(b.added_ms) || 0) - (Number(a.added_ms) || 0))
    .slice(0, 2000);
  return rows.map((r) => ({
    id: r.id, url: r.url, title: r.title, domain: r.domain, note: r.note,
    tags: String(r.tags || "").split(",").filter(Boolean),
    added_ms: Number(r.added_ms) || 0, added_by: r.added_by,
  }));
}

const json = (v: unknown, status = 200) => Response.json(v, { status });

async function handleWrite(ctx: Ctx, op: string, v: Record<string, unknown> | null): Promise<Response> {
  if (!(ctx.peer.is_sfi_editor || ctx.peer.is_owner)) return json({ error: "editors only" }, 403);
  const t = ctx.shared.table<Record<string, unknown>>(BOOKMARKS);

  // What changed, never what it holds: each page reads again as whoever it is.
  const ok = (extra?: Record<string, unknown>) => {
    ctx.push({ bookmarks: "bookmarks" });
    return json({ ok: true, ...(extra ?? {}) });
  };

  if (op === "bookmark") {
    const norm = normalizeUrl(v?.url);
    if (!norm) return json({ error: "that doesn't look like a web address" }, 400);

    // Saving the same link twice is a mistake, not an intent: keep the original (and its
    // tags) and say so, rather than growing a second row that splits the tags between them.
    const same = (await t.all()).find((r) => r.url === norm.url);
    if (same) return json({ ok: true, duplicate: true, id: same.id });

    const title = sanitizeText(v?.title, 300) || titleFromUrl(norm.url, norm.domain);
    const row = await keep(ctx, null, {
      url: norm.url, title, domain: norm.domain,
      note: sanitizeText(v?.note, 500),
      tags: cleanTags(v?.tags),
      added_ms: Date.now(), added_by: sanitizeText(ctx.peer.user_name, 60),
    });
    return ok({ id: row.id, title, domain: norm.domain });
  }

  if (op.startsWith("bookmark/")) {
    const [id, action] = op.slice("bookmark/".length).split("/");
    if (!id || !(await t.get(id))) return json({ error: "bad id" }, 400);
    if (action === "delete") { await t.delete(id); return ok(); }
    if (action) return json({ error: "not found" }, 404);

    const patch: Record<string, unknown> = {};
    if (v?.title !== undefined) { const s = sanitizeText(v.title, 300); if (s) patch.title = s; }
    if (v?.note !== undefined) patch.note = sanitizeText(v.note, 500);
    if (v?.tags !== undefined) patch.tags = cleanTags(v.tags);
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

    if (pathname === "/api/list" && method === "GET") return json({ bookmarks: await listRows(ctx) });

    return json({ error: "not found" }, 404);
  },
};
