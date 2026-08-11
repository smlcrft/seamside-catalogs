// ----------------------------------------------------------------------------------------
// Bookmarks — save a link, find it again.
//
// Design axes:
//   privacy:        privacy-public-view  — non-members read and follow the links; space
//                                           editors save and edit.
//   data_storage:   storage-local        — LocalTable, no contract. Nothing else acts on
//                                           these rows (docs/schema-contracts.md, "When NOT
//                                           to write a contract").
//   view_realtime:  view-collaborative    — every write pushes.
//   settings_scope: settings-per-sfi
//
// THIS FRAME FETCHES NOTHING. It would be easy to reach out for each page's <title> and
// favicon, and it would make the list prettier. It would also mean that saving a link
// privately quietly told that site you had done so, and turned a bookmark list into a
// browsing history broadcast — with `permissions.net: ["*"]`, since bookmarks can point
// anywhere. So the title is derived from the address itself and the user renames it if the
// URL was unhelpful. `permissions.net` stays empty, which is a promise the manifest makes
// on the frame's behalf and the platform enforces.
// ----------------------------------------------------------------------------------------
import {
  log, serveFileAtPath, jsonReply, parseJsonBody, parsePeerInfo, onUiMessage,
  pushToInstance, sanitizeText, declareTables, ensureTables, table,
} from "@frame-core";

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
  { key: "bookmarks", title: "Bookmarks", description: "Saved links for this placement.", local: true, schema: BOOKMARKS_SCHEMA },
]);

type Peer = ReturnType<typeof parsePeerInfo>;
type WriteResult = { status: number; body: unknown };

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

async function readyTables(peer: Peer): Promise<boolean> {
  const quiet = { ...peer, is_owner: false } as Peer;
  let r = ensureTables(quiet);
  if (!r.byKey["bookmarks"]) {
    try { await table("bookmarks", peer.sfi_id).query({ limit: 1 }); } catch (e) { log(`bookmarks: ensure failed: ${e}`); }
    r = ensureTables(quiet);
  }
  return !!r.byKey["bookmarks"];
}

async function listRows(sfiId: string) {
  const { rows } = await table("bookmarks", sfiId).query({ order_by: [{ col: "added_ms", dir: "desc" }], limit: 2000 });
  return rows.map((r) => ({
    id: r._row_id, url: r.url, title: r.title, domain: r.domain, note: r.note,
    tags: String(r.tags || "").split(",").filter(Boolean),
    added_ms: Number(r.added_ms) || 0, added_by: r.added_by,
  }));
}

function notify(sfiId: string) {
  pushToInstance(sfiId, { type: "bookmarks_changed" });
}

async function handleWrite(sfiId: string, op: string, v: Record<string, unknown> | null, peer: Peer): Promise<WriteResult> {
  if (!(await readyTables(peer))) return { status: 503, body: { error: "table not ready" } };
  if (!peer.is_sfi_editor) return { status: 403, body: { error: "editors only" } };
  const t = table("bookmarks", sfiId);

  const ok = async (extra?: Record<string, unknown>): Promise<WriteResult> => {
    notify(sfiId);
    return { status: 200, body: { ok: true, ...(extra ?? {}) } };
  };

  if (op === "bookmark") {
    const norm = normalizeUrl(v?.url);
    if (!norm) return { status: 400, body: { error: "that doesn't look like a web address" } };

    // Saving the same link twice is a mistake, not an intent: keep the original (and its
    // tags) and say so, rather than growing a second row that splits the tags between them.
    const { rows } = await t.query({ where: { url: norm.url }, limit: 1 });
    if (rows.length) return { status: 200, body: { ok: true, duplicate: true, id: rows[0]._row_id } };

    const title = sanitizeText(v?.title, 300) || titleFromUrl(norm.url, norm.domain);
    const { row_id } = await t.upsert(null, {
      url: norm.url, title, domain: norm.domain,
      note: sanitizeText(v?.note, 500),
      tags: cleanTags(v?.tags),
      added_ms: Date.now(), added_by: sanitizeText(peer.user_name, 60),
    });
    return ok({ id: row_id, title, domain: norm.domain });
  }

  if (op.startsWith("bookmark/")) {
    const [id, action] = op.slice("bookmark/".length).split("/");
    if (!id || !(await t.get(id))) return { status: 400, body: { error: "bad id" } };
    if (action === "delete") { await t.delete(id); return ok(); }
    if (action) return { status: 404, body: { error: "not found" } };

    const patch: Record<string, unknown> = {};
    if (v?.title !== undefined) { const s = sanitizeText(v.title, 300); if (s) patch.title = s; }
    if (v?.note !== undefined) patch.note = sanitizeText(v.note, 500);
    if (v?.tags !== undefined) patch.tags = cleanTags(v.tags);
    if (Object.keys(patch).length) await t.upsert(id, patch);
    return ok();
  }

  return { status: 404, body: { error: "not found" } };
}

onUiMessage(async (sfiId, data, peer) => {
  if (!sfiId || typeof data !== "object" || data === null) return;
  const d = data as Record<string, unknown>;
  if (typeof d.op !== "string") return;
  const r = await handleWrite(sfiId, d.op, d, peer);
  if (r.status !== 200) log(`bookmarks: bus op ${d.op} → ${r.status} (${JSON.stringify(r.body)})`);
});

self.onNetworkRequest = async function (replyPort, reqPath, method, headers, query, body, cookies) {
  const peer = parsePeerInfo(query, cookies);
  const sfiId = peer.sfi_id;

  if (method === "GET" && !reqPath.startsWith("/api/")) {
    return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url), headers);
  }

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

  // Saving returns its result (a duplicate, or the title we derived), so the paste path
  // stays on HTTP; everything else the frontend does is fire-and-forget over the bus.
  if (reqPath.startsWith("/api/") && (method === "POST" || method === "PUT")) {
    const r = await handleWrite(sfiId, reqPath.slice("/api/".length), parseJsonBody<Record<string, unknown>>(body), peer);
    return jsonReply(replyPort, r.status, r.body);
  }

  if (!(await readyTables(peer))) return jsonReply(replyPort, 503, { error: "table not ready" });

  if (reqPath === "/api/list" && method === "GET") {
    return jsonReply(replyPort, 200, { bookmarks: await listRows(sfiId) });
  }

  return jsonReply(replyPort, 404, { error: "not found" });
};

log("Bookmarks frame is up and running!");
