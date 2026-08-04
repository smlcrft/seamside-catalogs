// ----------------------------------------------------------------------------------------
// Community Home — simple public-facing landing page that members of a space can edit.
//
// Auth model:
//   - Everyone else (anon visitors, Viewer-role members) — sees the published page only.
//   - Space editor — sees an admin builder UI (title, sections, links)
//     with a "preview" toggle that renders the same public view.
//
// Storage is LocalTables (encrypted at rest, host-local, not peer-synced), scoped per
// placement — the same frame can be placed multiple times in one space (or across many
// spaces) and each placement owns its own content. Realtime edits are fanned out to every
// live viewer of the placement via pushToInstance(sfi_id, …).
// ----------------------------------------------------------------------------------------
import {
  log, serveFileAtPath, serveHtmlShell, pushToInstance, parsePeerInfo, onUiMessage,
  parseJsonBody, declareTables, ensureTables, table, frameSettings,
} from "@frame-core";

// ----------------------------------------------------------------------------------------
// LOCALTABLES — per-placement (no sfi_id columns needed).
// ----------------------------------------------------------------------------------------
declareTables([
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
type Settings = ReturnType<typeof frameSettings>;

// ----------------------------------------------------------------------------------------
// HELPERS
// ----------------------------------------------------------------------------------------
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

// Page-level settings (title / tagline / updated_at) live in the
// per-placement frameSettings store — one row per key, race-free. The default
// "About us" block is seeded once, gated on the "seeded" setting marker.
const SEED_BLOCK_ROW = "seed_about"; // fixed id so a concurrent first-load can't duplicate it

async function ensurePage(settings: Settings, blocks: Tbl): Promise<void> {
  if (await settings.get("seeded")) return;
  await settings.set("seeded", true);
  await settings.set("title", "Welcome to our community");
  await settings.set("tagline", "A place for updates, links, and news.");
  await settings.set("updated_at", Date.now());
  await blocks.upsert(SEED_BLOCK_ROW, {
    kind: "section", heading: "About us",
    body: "Tell visitors what your community is about. Use the edit panel on the left to change this text, update the title, and add sections, links, or public-frame embeds in any order.",
    format: "text", sort_order: 0,
  });
}

async function getPage(settings: Settings, blocks: Tbl) {
  const [title, tagline, updatedAt] = await Promise.all([
    settings.get<string>("title"),
    settings.get<string>("tagline"),
    settings.get<number>("updated_at"),
  ]);
  const { rows } = await blocks.query({
    order_by: [{ col: "sort_order" }, { col: "_created_at" }],
  });
  return {
    title: title ?? "",
    tagline: tagline ?? "",
    updated_at: updatedAt ?? 0,
    blocks: rows.map((r) => ({
      id: r._row_id, kind: r.kind, heading: r.heading, body: r.body, format: r.format,
      label: r.label, url: r.url, width: r.width, height: r.height, sort_order: r.sort_order,
    })),
  };
}

async function touchPage(settings: Settings): Promise<void> {
  await settings.set("updated_at", Date.now());
}

async function broadcast(sfiId: string, settings: Settings, blocks: Tbl): Promise<void> {
  pushToInstance(sfiId, { type: "ch_page_updated", sfi_id: sfiId, page: await getPage(settings, blocks) });
}

// ----------------------------------------------------------------------------------------
// SHARED WRITE LOGIC — every admin mutation, whether it arrives over HTTP or the tether
// (frame.busSend → onUiMessage), runs through here. `op` is the API path minus the leading
// "api/" ("admin/page", "admin/blocks", "admin/blocks/<id>", "admin/blocks/<id>/delete",
// "admin/blocks/reorder"). The editor gate lives here so the two entry points never drift.
// ----------------------------------------------------------------------------------------
type WriteResult = { status: number; body: Record<string, unknown> };

async function handleWrite(
  sfiId: string,
  op: string,
  data: Record<string, unknown> | null,
  peer: ReturnType<typeof parsePeerInfo>,
): Promise<WriteResult> {
  if (!peer.is_sfi_editor) return { status: 403, body: { error: "forbidden" } };
  const settings = frameSettings(sfiId);
  const blocks = table("blocks", sfiId);
  await ensurePage(settings, blocks);

  // Update top-level page settings (title / tagline).
  if (op === "admin/page") {
    if (!data) return { status: 400, body: { error: "invalid body" } };
    if (typeof data.title === "string") {
      await settings.set("title", clampStr(data.title, MAX_TITLE));
    }
    if (typeof data.tagline === "string") {
      await settings.set("tagline", clampStr(data.tagline, MAX_TAGLINE));
    }
    await settings.set("updated_at", Date.now());
    await broadcast(sfiId, settings, blocks);
    return { status: 200, body: { ok: true } };
  }

  // Create a new block. Payload: { kind: "section" | "link" | "pub_frame", ...fields }.
  // Always appended to the end — UI positions the add buttons below the last block.
  if (op === "admin/blocks") {
    const kind = data && typeof data.kind === "string" ? data.kind : "";
    if (!data || !VALID_KINDS.has(kind)) return { status: 400, body: { error: "invalid kind" } };

    const order = Number(await blocks.max("sort_order") ?? -1) + 1;

    if (kind === "section") {
      const heading = clampStr(data.heading, MAX_HEADING);
      const bodyText = clampStr(data.body, MAX_BODY);
      const format = typeof data.format === "string" && VALID_FORMATS.has(data.format) ? data.format : "text";
      await blocks.upsert(null, { kind: "section", heading, body: bodyText, format, sort_order: order });
    } else if (kind === "link") {
      const label = clampStr(data.label, MAX_LABEL);
      const url = clampStr(data.url, MAX_URL).trim();
      if (!label) return { status: 400, body: { error: "label required" } };
      if (!url || !isSafeUrl(url)) return { status: 400, body: { error: "valid http(s) url required" } };
      await blocks.upsert(null, { kind: "link", label, url, sort_order: order });
    } else if (kind === "pub_frame") {
      const url = clampStr(data.url, MAX_URL).trim();
      if (!url || !isSafeUrl(url)) return { status: 400, body: { error: "valid http(s) url required" } };
      // heading is reused as an optional title displayed above the iframe.
      const heading = clampStr(data.heading, MAX_HEADING);
      const width = clampDim(data.width, 320);
      const height = clampDim(data.height, 320);
      await blocks.upsert(null, { kind: "pub_frame", heading, url, width, height, sort_order: order });
    }

    await touchPage(settings);
    await broadcast(sfiId, settings, blocks);
    return { status: 200, body: { ok: true } };
  }

  // Reorder blocks: payload = { order: [id, id, id] }
  if (op === "admin/blocks/reorder") {
    const order = data?.order;
    if (!Array.isArray(order)) return { status: 400, body: { error: "order[] required" } };
    const ids = order.filter((x: unknown): x is string => typeof x === "string" && !!x);
    // Only touch ids that actually exist (never phantom-create via upsert).
    const { rows } = await blocks.query({});
    const known = new Set(rows.map((r) => r._row_id));
    for (let i = 0; i < ids.length; i++) {
      if (known.has(ids[i])) await blocks.upsert(ids[i], { sort_order: i });
    }
    await broadcast(sfiId, settings, blocks);
    return { status: 200, body: { ok: true } };
  }

  // Update / delete a single block. Only fields present in the patch are touched; kind is
  // immutable. Block ids are opaque row-id strings; a path segment must not contain '/'.
  const blockMatch = op.match(/^admin\/blocks\/([^/]+)(\/delete)?$/);
  if (blockMatch && blockMatch[1] !== "reorder") {
    const id = blockMatch[1];
    if (!(await blocks.get(id))) return { status: 404, body: { error: "not found" } };

    if (blockMatch[2]) {
      await blocks.delete(id);
      await touchPage(settings);
      await broadcast(sfiId, settings, blocks);
      return { status: 200, body: { ok: true } };
    }

    if (!data) return { status: 400, body: { error: "invalid body" } };
    if (typeof data.heading === "string") {
      await blocks.upsert(id, { heading: clampStr(data.heading, MAX_HEADING) });
    }
    if (typeof data.body === "string") {
      await blocks.upsert(id, { body: clampStr(data.body, MAX_BODY) });
    }
    if (typeof data.format === "string") {
      if (!VALID_FORMATS.has(data.format)) return { status: 400, body: { error: "invalid format" } };
      await blocks.upsert(id, { format: data.format });
    }
    if (typeof data.label === "string") {
      await blocks.upsert(id, { label: clampStr(data.label, MAX_LABEL) });
    }
    if (typeof data.url === "string") {
      const url = clampStr(data.url, MAX_URL).trim();
      if (url && !isSafeUrl(url)) return { status: 400, body: { error: "invalid url" } };
      await blocks.upsert(id, { url });
    }
    // pub_frame dimensions — only meaningful for that kind, but harmless to store otherwise.
    if (data.width !== undefined) {
      await blocks.upsert(id, { width: clampDim(data.width, 320) });
    }
    if (data.height !== undefined) {
      await blocks.upsert(id, { height: clampDim(data.height, 320) });
    }
    await touchPage(settings);
    await broadcast(sfiId, settings, blocks);
    return { status: 200, body: { ok: true } };
  }

  return { status: 404, body: { error: "unknown admin route" } };
}

// ----------------------------------------------------------------------------------------
// BUS DISPATCHER — the frontend's write path (frame.busSend → BusUiToFrame). `peer` is the
// sender's platform-resolved identity, same shape as parsePeerInfo; the editor gate lives
// inside handleWrite. Denials are logged, not answered — a legitimate client never sends a
// write it isn't allowed to make.
// ----------------------------------------------------------------------------------------
onUiMessage(async (sfiId, data, peer) => {
  if (!sfiId || typeof data !== "object" || data === null) return;
  const d = data as Record<string, unknown>;
  if (typeof d.op !== "string" || !d.op) return;
  if (!ensureTables(peer).ready) return log(`community home: bus op ${d.op} dropped (table not bound)`);
  const r = await handleWrite(sfiId, d.op, d, peer);
  if (r.status !== 200) log(`community home: bus op ${d.op} → ${r.status} (${JSON.stringify(r.body)})`);
});

// ----------------------------------------------------------------------------------------
// NETWORKING
// ----------------------------------------------------------------------------------------
self.onNetworkRequest = async function (replyPort, reqPath, method, _headers, query, body, cookies) {
  const send = (data: unknown, status = 200) => replyPort.postMessage({
    status, contentType: "application/json", body: JSON.stringify(data),
  });
  const peer = parsePeerInfo(query, cookies);
  const sfiId = peer.sfi_id;

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
        return send({ title: "", tagline: "", blocks: [] });
      }
      return send({ error: "sfi_id missing" }, 400);
    }
    // Local tables are always ready; the gate stays so a future graduation to
    // synced tables needs no code change here.
    const ready = ensureTables(peer);
    if (!ready.ready) return send({ error: "table not bound" }, 503);
    const settings = frameSettings(sfiId);
    const blocks = table("blocks", sfiId);

    // ----- public: fetch current page content (both anon and admin share this).
    if (reqPath === "/api/page" && method === "GET") {
      await ensurePage(settings, blocks);
      return send(await getPage(settings, blocks));
    }

    // ----- admin routes — space editors only (Viewer-role members read like anyone else).
    // Each route maps to a bus op (path minus "/api/", DELETE → op + "/delete") and runs
    // through the same handleWrite the bus dispatcher uses.
    if (reqPath.startsWith("/api/admin/")) {
      if (!peer.is_sfi_editor) return send({ error: "forbidden" }, 403);
      const rest = reqPath.slice("/api/".length);
      const blockMatch = rest.match(/^admin\/blocks\/([^/]+)$/);
      const op =
        rest === "admin/page" && method === "PUT" ? rest
        : rest === "admin/blocks" && method === "POST" ? rest
        : rest === "admin/blocks/reorder" && method === "PUT" ? rest
        : blockMatch && blockMatch[1] !== "reorder" && method === "PUT" ? rest
        : blockMatch && blockMatch[1] !== "reorder" && method === "DELETE" ? rest + "/delete"
        : null;
      if (!op) return send({ error: "unknown admin route" }, 404);
      const r = await handleWrite(sfiId, op, parseJsonBody(body), peer);
      return send(r.body, r.status);
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
