// ----------------------------------------------------------------------------------------
// Community Home — simple public-facing landing page that members of a space can edit.
//
// Auth model:
//   - Everyone else (anon visitors, Viewer-role members) — sees the published page only.
//   - Space editor — sees an admin builder UI (title, sections, links)
//     with a "preview" toggle that renders the same public view.
//
// The page's blocks are the table community_blocks in the space's frame data folder
// (_fdata/), so each space has one page, synced with it; the marker that it was seeded is
// _fdata/community_setup beside it. Its title and tagline are the session's own settings
// (ctx.own.table("settings")), read with the default where none was set. A visitor reads no
// table: the page asks GET /api/page, and every write route decides on ctx.peer.
//
// Realtime: a push says that the page changed and never what it holds. Every open page of
// the frame hears it and reads again as whoever it is.
// ----------------------------------------------------------------------------------------
import type { Ctx } from "@frame-core";

// ----------------------------------------------------------------------------------------
// THE SPACE'S TABLES, in its frame data folder, named for what they hold; and the session's
// own settings.
// ----------------------------------------------------------------------------------------
const BLOCKS = "community_blocks";
const SETUP = "community_setup";
const SETTINGS = "settings";

// Unified page-content table. Lets admins mix sections, links, and pub_frame embeds
// in any order. The per-kind columns stay empty for kinds that don't use them.
const BLOCK_SCHEMA = [
  { name: "kind",       col_type: "text",    nullable: false, default_val: "section" },
  { name: "heading",    col_type: "text",    nullable: false, default_val: "" },
  { name: "body",       col_type: "text",    nullable: false, default_val: "" },
  { name: "format",     col_type: "text",    nullable: false, default_val: "text" },
  { name: "label",      col_type: "text",    nullable: false, default_val: "" },
  { name: "url",        col_type: "text",    nullable: false, default_val: "" },
  { name: "width",      col_type: "integer", nullable: false, default_val: "320" },
  { name: "height",     col_type: "integer", nullable: false, default_val: "320" },
  { name: "sort_order", col_type: "integer", nullable: false, default_val: "0" },
] as const;

// What a new block holds before its own values are laid over it.
const BLOCK_DEFAULTS: Record<string, unknown> = Object.fromEntries(
  BLOCK_SCHEMA.map((c) => [c.name, c.col_type === "integer" ? Number(c.default_val) : c.default_val]),
);

// ----------------------------------------------------------------------------------------
// HELPERS
// ----------------------------------------------------------------------------------------
type Row = Record<string, unknown> & { id: string };

// The settings are the session's own; every other table is the space's frame data (`_fdata/`),
// shared with every frame and member.
const rows = (ctx: Ctx, name: string) =>
  name === SETTINGS ? ctx.own.table<Record<string, unknown>>(name) : ctx.shared.table<Record<string, unknown>>(name);

/** Write a row over what it held, stamped when it was made and when it changed.
 *  A row that was not there starts from `fresh`. */
async function keep(
  ctx: Ctx, name: string, id: string | null, values: Record<string, unknown>, fresh: Record<string, unknown> = {},
): Promise<Row> {
  const was = id ? await rows(ctx, name).get(id) : null;
  const now = Date.now();
  return await rows(ctx, name).upsert({
    ...(was ?? { ...fresh, _created_at: now }),
    ...values,
    ...(id ? { id } : {}),
    _modified_at: now,
  });
}

const keepBlock = (ctx: Ctx, id: string | null, values: Record<string, unknown>) =>
  keep(ctx, BLOCKS, id, values, BLOCK_DEFAULTS);

function cmp(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a ?? "").localeCompare(String(b ?? ""));
}

const VALID_FORMATS = new Set(["text", "html"]);
const VALID_KINDS = new Set(["section", "link", "pub_frame"]);

// Only http(s) links on the page: never javascript:/data:/file:.
function isSafeUrl(u: string): boolean {
  return /^https?:\/\//i.test(u.trim());
}
const MAX_TITLE = 200;
const MAX_TAGLINE = 400;
const MAX_HEADING = 200;
const MAX_BODY = 10_000;
const MAX_LABEL = 120;
const MAX_URL = 2048;
const MIN_DIM = 80;
const MAX_DIM = 2000;

function clampDim(v: unknown, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(MIN_DIM, Math.min(MAX_DIM, Math.round(n)));
}

function clampStr(v: unknown, max: number): string {
  const s = typeof v === "string" ? v : String(v ?? "");
  return s.length > max ? s.slice(0, max) : s;
}

// Page-level settings (title / tagline / updated_at) are rows of the session's own settings
// table, each value JSON under `v`, read as SEED's where no row is. The default block is
// seeded once, by the first editor to open the page, and the marker is row `seeded` of the
// space's community_setup table, so no other session or device seeds it again after an editor
// removed it; until then a reader is shown the same default, unwritten.
const SEED_BLOCK_ROW = "seed_about"; // fixed id so a concurrent first-load can't duplicate it
const K = (k: string) => `community_home_${k}`;
const SEED = {
  title: "Welcome to our community",
  tagline: "A place for updates, links, and news.",
  block: {
    kind: "section", heading: "About us",
    body: "Tell visitors what your community is about. Edit this text, the title and the tagline, and add sections and links in any order.",
    format: "text", sort_order: 0,
  },
};

async function setting<T>(ctx: Ctx, key: string): Promise<T | null> {
  const row = await rows(ctx, SETTINGS).get(K(key));
  if (row?.v == null) return null;
  try {
    return JSON.parse(String(row.v)) as T;
  } catch {
    return null;
  }
}

const setSetting = (ctx: Ctx, key: string, value: unknown) => keep(ctx, SETTINGS, K(key), { v: JSON.stringify(value) });

const seeded = async (ctx: Ctx) => (await rows(ctx, SETUP).get("seeded"))?.v === "true";

async function ensurePage(ctx: Ctx): Promise<void> {
  if (await seeded(ctx)) return;
  await keep(ctx, SETUP, "seeded", { v: "true" });
  await keepBlock(ctx, SEED_BLOCK_ROW, SEED.block);
}

async function getPage(ctx: Ctx) {
  const [title, tagline, updatedAt, all] = await Promise.all([
    setting<string>(ctx, "title"),
    setting<string>(ctx, "tagline"),
    setting<number>(ctx, "updated_at"),
    rows(ctx, BLOCKS).all(),
  ]);
  all.sort((a, b) => cmp(a.sort_order, b.sort_order) || cmp(Number(a._created_at ?? 0), Number(b._created_at ?? 0)));
  return {
    title: title ?? SEED.title,
    tagline: tagline ?? SEED.tagline,
    updated_at: updatedAt ?? 0,
    blocks: all.map((r) => ({
      id: r.id, kind: r.kind, heading: r.heading, body: r.body, format: r.format,
      label: r.label, url: r.url, width: r.width, height: r.height, sort_order: r.sort_order,
    })),
  };
}

const touchPage = (ctx: Ctx) => setSetting(ctx, "updated_at", Date.now());

// That the page changed, never what it holds: each open page reads again as whoever it is.
const tell = (ctx: Ctx) => ctx.push({ community_home: "page" });

const json = (v: unknown, status = 200) => Response.json(v, { status });
const refuse = (status: number, error: string) => json({ error }, status);

async function body(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const v = JSON.parse(await request.text());
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

// Block ids are opaque row-id strings; a path segment must not contain '/'.
const RE_BLOCK = /^(PUT|DELETE) \/admin\/blocks\/([^/]+)$/;

// ----------------------------------------------------------------------------------------
// AN EDITOR'S WRITES
// ----------------------------------------------------------------------------------------
async function write(ctx: Ctx, route: string, request: Request): Promise<Response> {
  // Update top-level page settings (title / tagline).
  if (route === "PUT /admin/page") {
    const data = await body(request);
    if (!data) return refuse(400, "invalid body");
    if (typeof data.title === "string") await setSetting(ctx, "title", clampStr(data.title, MAX_TITLE));
    if (typeof data.tagline === "string") await setSetting(ctx, "tagline", clampStr(data.tagline, MAX_TAGLINE));
    await touchPage(ctx);
    tell(ctx);
    return json({ ok: true });
  }

  // Create a new block. Payload: { kind: "section" | "link" | "pub_frame", ...fields }.
  // Always appended to the end — UI positions the add buttons below the last block.
  if (route === "POST /admin/blocks") {
    const data = await body(request);
    const kind = data && typeof data.kind === "string" ? data.kind : "";
    if (!data || !VALID_KINDS.has(kind)) return refuse(400, "invalid kind");

    const last = (await rows(ctx, BLOCKS).all())
      .reduce<unknown>((m, r) => (r.sort_order == null || (m != null && cmp(r.sort_order, m) <= 0) ? m : r.sort_order), null);
    const order = Number(last ?? -1) + 1;

    if (kind === "section") {
      const heading = clampStr(data.heading, MAX_HEADING);
      const bodyText = clampStr(data.body, MAX_BODY);
      const format = typeof data.format === "string" && VALID_FORMATS.has(data.format) ? data.format : "text";
      await keepBlock(ctx, null, { kind: "section", heading, body: bodyText, format, sort_order: order });
    } else if (kind === "link") {
      const label = clampStr(data.label, MAX_LABEL);
      const url = clampStr(data.url, MAX_URL).trim();
      if (!label) return refuse(400, "label required");
      if (!url || !isSafeUrl(url)) return refuse(400, "valid http(s) url required");
      await keepBlock(ctx, null, { kind: "link", label, url, sort_order: order });
    } else if (kind === "pub_frame") {
      const url = clampStr(data.url, MAX_URL).trim();
      if (!url || !isSafeUrl(url)) return refuse(400, "valid http(s) url required");
      // heading is reused as an optional title displayed above the link.
      const heading = clampStr(data.heading, MAX_HEADING);
      const width = clampDim(data.width, 320);
      const height = clampDim(data.height, 320);
      await keepBlock(ctx, null, { kind: "pub_frame", heading, url, width, height, sort_order: order });
    }

    await touchPage(ctx);
    tell(ctx);
    return json({ ok: true });
  }

  // Reorder blocks: payload = { order: [id, id, id] }
  if (route === "PUT /admin/blocks/reorder") {
    const order = (await body(request))?.order;
    if (!Array.isArray(order)) return refuse(400, "order[] required");
    const ids = order.filter((x: unknown): x is string => typeof x === "string" && !!x);
    // Only touch ids that actually exist: a write to an unknown id would make the row.
    const known = new Set((await rows(ctx, BLOCKS).all()).map((r) => r.id));
    for (let i = 0; i < ids.length; i++) {
      if (known.has(ids[i])) await keepBlock(ctx, ids[i], { sort_order: i });
    }
    tell(ctx);
    return json({ ok: true });
  }

  // Update / delete a single block. Only fields present in the patch are touched; kind is
  // immutable.
  const block = route.match(RE_BLOCK);
  if (block) {
    const id = block[2];
    if (!(await rows(ctx, BLOCKS).get(id))) return refuse(404, "not found");

    if (block[1] === "DELETE") {
      await rows(ctx, BLOCKS).delete(id);
      await touchPage(ctx);
      tell(ctx);
      return json({ ok: true });
    }

    const data = await body(request);
    if (!data) return refuse(400, "invalid body");
    // Fields are taken in this order, and what came before a refused one is kept.
    const next: Record<string, unknown> = {};
    const refused = ((): string | null => {
      if (typeof data.heading === "string") next.heading = clampStr(data.heading, MAX_HEADING);
      if (typeof data.body === "string") next.body = clampStr(data.body, MAX_BODY);
      if (typeof data.format === "string") {
        if (!VALID_FORMATS.has(data.format)) return "invalid format";
        next.format = data.format;
      }
      if (typeof data.label === "string") next.label = clampStr(data.label, MAX_LABEL);
      if (typeof data.url === "string") {
        const url = clampStr(data.url, MAX_URL).trim();
        if (url && !isSafeUrl(url)) return "invalid url";
        next.url = url;
      }
      // pub_frame dimensions — only meaningful for that kind, but harmless to store otherwise.
      if (data.width !== undefined) next.width = clampDim(data.width, 320);
      if (data.height !== undefined) next.height = clampDim(data.height, 320);
      return null;
    })();
    if (Object.keys(next).length) await keepBlock(ctx, id, next);
    if (refused) return refuse(400, refused);
    await touchPage(ctx);
    tell(ctx);
    return json({ ok: true });
  }

  return refuse(404, "unknown admin route");
}

// ----------------------------------------------------------------------------------------
// NETWORKING
// ----------------------------------------------------------------------------------------
export default {
  async fetch(request: Request, ctx: Ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith("/api/")) {
      if (request.method !== "GET") return refuse(404, "Not found.");
      return ctx.file(pathname);
    }
    const route = `${request.method} ${pathname.slice(4)}`;
    const editor = ctx.peer.is_sfi_editor || ctx.peer.is_owner;
    const member = editor || ctx.peer.is_sfi_member;

    // ----- anyone: the page as it stands, and who the door says is asking.
    if (route === "GET /page") {
      const you = { member, editor };
      const color = ctx.peer.space_color;
      if (editor) await ensurePage(ctx);
      else if (!(await seeded(ctx))) {
        return json({
          title: SEED.title, tagline: SEED.tagline, updated_at: 0,
          blocks: [{ id: SEED_BLOCK_ROW, ...SEED.block }], color, you,
        });
      }
      return json({ ...(await getPage(ctx)), color, you });
    }

    // ----- admin routes — space editors only (Viewer-role members read like anyone else).
    if (route.includes(" /admin/")) {
      if (!editor) return refuse(403, "forbidden");
      await ensurePage(ctx);
      return write(ctx, route, request);
    }

    return refuse(404, "Not found.");
  },
};
