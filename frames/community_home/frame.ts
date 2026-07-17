// ----------------------------------------------------------------------------------------
// Community Home — simple public-facing landing page that members of a space can edit.
//
// Auth model:
//   - Anonymous request (peer.is_anon OR user_id is empty) — sees the published page only.
//   - Known user of the space — sees an admin builder UI (title, accent, sections, links)
//     with a "preview" toggle that renders the same public view.
//
// Storage is LocalTables (encrypted at rest, host-local, not peer-synced), scoped per
// placement — the same frame can be placed multiple times in one space (or across many
// spaces) and each placement owns its own content. Realtime edits are fanned out to every
// live viewer of the placement via pushToInstance(sfi_id, …).
// ----------------------------------------------------------------------------------------
import {
  log, serveFileAtPath, serveHtmlShell, pushToInstance, parsePeerInfo,
  parseJsonBody, declareTables, ensureTables, table,
} from "@frame-core";

// ----------------------------------------------------------------------------------------
// LOCALTABLES — per-placement (no sfi_id columns needed).
// ----------------------------------------------------------------------------------------
declareTables([
  {
    key: "pages",
    title: "Community Home Page",
    description: "Title, tagline, and accent for this placement's landing page.",
    local: true,
    schema: [
      { name: "title",      col_type: "text",    nullable: false, default_val: "" },
      { name: "tagline",    col_type: "text",    nullable: false, default_val: "" },
      { name: "accent",     col_type: "text",    nullable: false, default_val: "c1" },
      { name: "updated_at", col_type: "integer", nullable: false, default_val: "0" },
    ],
  },
  {
    // Unified page-content table. Lets admins mix sections, links, and pub_frame embeds
    // in any order. The per-kind columns stay empty for kinds that don't use them.
    key: "blocks",
    title: "Community Home Blocks",
    description: "Sections, links, and public-frame embeds, in display order.",
    local: true,
    schema: [
      { name: "kind",       col_type: "text",    nullable: false, default_val: "section" },
      { name: "heading",    col_type: "text",    nullable: false, default_val: "" },
      { name: "body",       col_type: "text",    nullable: false, default_val: "" },
      { name: "format",     col_type: "text",    nullable: false, default_val: "text" },
      { name: "label",      col_type: "text",    nullable: false, default_val: "" },
      { name: "url",        col_type: "text",    nullable: false, default_val: "" },
      { name: "width",      col_type: "integer", nullable: false, default_val: "320" },
      { name: "height",     col_type: "integer", nullable: false, default_val: "320" },
      { name: "sort_order", col_type: "integer", nullable: false, default_val: "0" },
    ],
  },
]);

type Tbl = ReturnType<typeof table>;

// ----------------------------------------------------------------------------------------
// HELPERS
// ----------------------------------------------------------------------------------------
const VALID_ACCENTS = new Set(["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"]);
const VALID_FORMATS = new Set(["text", "html"]);
const VALID_KINDS = new Set(["section", "link", "pub_frame"]);

// Reject javascript:/data:/file: URLs so pub_frame iframe srcs can't run scripts in the parent context.
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

// The page row is a singleton per placement (LocalTables are placement-scoped).
async function pageRow(pages: Tbl) {
  const { rows } = await pages.query({ limit: 1 });
  return rows[0] ?? null;
}

async function ensurePage(pages: Tbl, blocks: Tbl): Promise<void> {
  if (await pageRow(pages)) return;
  await pages.upsert(null, {
    title: "Welcome to our community",
    tagline: "A place for updates, links, and news.",
    accent: "c1", updated_at: Date.now(),
  });
  await blocks.upsert(null, {
    kind: "section", heading: "About us",
    body: "Tell visitors what your community is about. Use the edit panel on the left to change this text, update the title, pick an accent color, and add sections, links, or public-frame embeds in any order.",
    format: "text", sort_order: 0,
  });
}

async function getPage(pages: Tbl, blocks: Tbl) {
  const page = await pageRow(pages);
  const { rows } = await blocks.query({
    order_by: [{ col: "sort_order" }, { col: "_created_at" }],
  });
  return {
    title: page?.title ?? "",
    tagline: page?.tagline ?? "",
    accent: page?.accent ?? "c1",
    updated_at: page?.updated_at ?? 0,
    blocks: rows.map((r) => ({
      id: r._row_id, kind: r.kind, heading: r.heading, body: r.body, format: r.format,
      label: r.label, url: r.url, width: r.width, height: r.height, sort_order: r.sort_order,
    })),
  };
}

async function touchPage(pages: Tbl): Promise<void> {
  const page = await pageRow(pages);
  if (page) await pages.upsert(page._row_id, { updated_at: Date.now() });
}

async function broadcast(sfiId: string, pages: Tbl, blocks: Tbl): Promise<void> {
  pushToInstance(sfiId, { type: "ch_page_updated", sfi_id: sfiId, page: await getPage(pages, blocks) });
}

// ----------------------------------------------------------------------------------------
// NETWORKING
// ----------------------------------------------------------------------------------------
self.onNetworkRequest = async function (replyPort, reqPath, method, _headers, query, body, cookies) {
  const send = (data: unknown, status = 200) => replyPort.postMessage({
    status, contentType: "application/json", body: JSON.stringify(data),
  });
  const peer = parsePeerInfo(query, cookies);
  const sfiId = peer.sfi_id;
  const anon = peer.is_anon || !peer.user_id;

  // ----- index.html: serve a single bundled response (html + inlined css + per-viewer
  // window.__peer stamp) so the UI can render without an extra /api/whoami round-trip.
  // The script is inline in index.html as <script type="module"> so it can import
  // /lib/js/framelib.js — inlineJs would flatten that to a non-module <script>, which
  // can't use ES module imports, so it's intentionally omitted here.
  if (reqPath === "/index.html" && method === "GET") {
    return serveHtmlShell(replyPort, new URL("./public/index.html", import.meta.url), {
      peer,
      inlineCss: ["index.css"],
    });
  }

  if (reqPath.startsWith("/api/")) {
    if (!sfiId) {
      if (reqPath === "/api/page" && method === "GET") {
        return send({ title: "", tagline: "", accent: "c1", blocks: [] });
      }
      return send({ error: "sfi_id missing" }, 400);
    }
    // Local tables are always ready; the gate stays so a future graduation to
    // synced tables needs no code change here.
    const ready = ensureTables(peer);
    if (!ready.ready) return send({ error: "table not bound" }, 503);
    const pages = table("pages", sfiId);
    const blocks = table("blocks", sfiId);

    // ----- public: fetch current page content (both anon and admin share this).
    if (reqPath === "/api/page" && method === "GET") {
      await ensurePage(pages, blocks);
      return send(await getPage(pages, blocks));
    }

    // ----- admin routes — require a known user.
    if (reqPath.startsWith("/api/admin/")) {
      if (anon) return send({ error: "forbidden" }, 403);
      await ensurePage(pages, blocks);

      // Update top-level page settings (title / tagline / accent).
      if (reqPath === "/api/admin/page" && method === "PUT") {
        const data = parseJsonBody(body);
        if (!data) return send({ error: "invalid body" }, 400);
        const page = await pageRow(pages);
        if (!page) return send({ error: "page missing" }, 500);
        if (typeof data.title === "string") {
          await pages.upsert(page._row_id, { title: clampStr(data.title, MAX_TITLE), updated_at: Date.now() });
        }
        if (typeof data.tagline === "string") {
          await pages.upsert(page._row_id, { tagline: clampStr(data.tagline, MAX_TAGLINE), updated_at: Date.now() });
        }
        if (typeof data.accent === "string") {
          if (!VALID_ACCENTS.has(data.accent)) return send({ error: "invalid accent" }, 400);
          await pages.upsert(page._row_id, { accent: data.accent, updated_at: Date.now() });
        }
        await broadcast(sfiId, pages, blocks);
        return send({ ok: true });
      }

      // Create a new block. Body: { kind: "section" | "link" | "pub_frame", ...fields }.
      // Always appended to the end — UI positions the add buttons below the last block.
      if (reqPath === "/api/admin/blocks" && method === "POST") {
        const data = parseJsonBody(body);
        const kind = typeof data?.kind === "string" ? data.kind : "";
        if (!VALID_KINDS.has(kind)) return send({ error: "invalid kind" }, 400);

        const order = Number(await blocks.max("sort_order") ?? -1) + 1;

        if (kind === "section") {
          const heading = clampStr(data.heading, MAX_HEADING);
          const bodyText = clampStr(data.body, MAX_BODY);
          const format = typeof data.format === "string" && VALID_FORMATS.has(data.format) ? data.format : "text";
          await blocks.upsert(null, { kind: "section", heading, body: bodyText, format, sort_order: order });
        } else if (kind === "link") {
          const label = clampStr(data.label, MAX_LABEL);
          const url = clampStr(data.url, MAX_URL).trim();
          if (!label) return send({ error: "label required" }, 400);
          if (!url || !isSafeUrl(url)) return send({ error: "valid http(s) url required" }, 400);
          await blocks.upsert(null, { kind: "link", label, url, sort_order: order });
        } else if (kind === "pub_frame") {
          const url = clampStr(data.url, MAX_URL).trim();
          if (!url || !isSafeUrl(url)) return send({ error: "valid http(s) url required" }, 400);
          // heading is reused as an optional title displayed above the iframe.
          const heading = clampStr(data.heading, MAX_HEADING);
          const width = clampDim(data.width, 320);
          const height = clampDim(data.height, 320);
          await blocks.upsert(null, { kind: "pub_frame", heading, url, width, height, sort_order: order });
        }

        await touchPage(pages);
        await broadcast(sfiId, pages, blocks);
        return send({ ok: true });
      }

      // Update any block. Only fields present in the patch are touched; kind is immutable.
      // Block ids are opaque row-id strings; a path segment must not contain '/'.
      const blockMatch = reqPath.match(/^\/api\/admin\/blocks\/([^/]+)$/);
      if (blockMatch && blockMatch[1] !== "reorder" && method === "PUT") {
        const id = blockMatch[1];
        if (!(await blocks.get(id))) return send({ error: "not found" }, 404);
        const data = parseJsonBody(body);
        if (!data) return send({ error: "invalid body" }, 400);

        if (typeof data.heading === "string") {
          await blocks.upsert(id, { heading: clampStr(data.heading, MAX_HEADING) });
        }
        if (typeof data.body === "string") {
          await blocks.upsert(id, { body: clampStr(data.body, MAX_BODY) });
        }
        if (typeof data.format === "string") {
          if (!VALID_FORMATS.has(data.format)) return send({ error: "invalid format" }, 400);
          await blocks.upsert(id, { format: data.format });
        }
        if (typeof data.label === "string") {
          await blocks.upsert(id, { label: clampStr(data.label, MAX_LABEL) });
        }
        if (typeof data.url === "string") {
          const url = clampStr(data.url, MAX_URL).trim();
          if (url && !isSafeUrl(url)) return send({ error: "invalid url" }, 400);
          await blocks.upsert(id, { url });
        }
        // pub_frame dimensions — only meaningful for that kind, but harmless to store otherwise.
        if (data.width !== undefined) {
          await blocks.upsert(id, { width: clampDim(data.width, 320) });
        }
        if (data.height !== undefined) {
          await blocks.upsert(id, { height: clampDim(data.height, 320) });
        }
        await touchPage(pages);
        await broadcast(sfiId, pages, blocks);
        return send({ ok: true });
      }

      if (blockMatch && blockMatch[1] !== "reorder" && method === "DELETE") {
        const id = blockMatch[1];
        if (!(await blocks.get(id))) return send({ error: "not found" }, 404);
        await blocks.delete(id);
        await touchPage(pages);
        await broadcast(sfiId, pages, blocks);
        return send({ ok: true });
      }

      // Reorder blocks: body = { order: [id, id, id] }
      if (reqPath === "/api/admin/blocks/reorder" && method === "PUT") {
        const data = parseJsonBody(body);
        if (!Array.isArray(data?.order)) return send({ error: "order[] required" }, 400);
        const ids = data.order.filter((x: unknown): x is string => typeof x === "string" && !!x);
        // Only touch ids that actually exist (never phantom-create via upsert).
        const { rows } = await blocks.query({});
        const known = new Set(rows.map((r) => r._row_id));
        for (let i = 0; i < ids.length; i++) {
          if (known.has(ids[i])) await blocks.upsert(ids[i], { sort_order: i });
        }
        await broadcast(sfiId, pages, blocks);
        return send({ ok: true });
      }

      return send({ error: "unknown admin route" }, 404);
    }
  }

  // ----- static file fallback.
  if (method === "GET") {
    serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url));
  } else {
    replyPort.postMessage({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Not found.", code: "NOT_FOUND" }) });
  }
};

log("Community Home frame is up and running!");
