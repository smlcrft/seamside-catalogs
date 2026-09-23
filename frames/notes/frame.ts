// ----------------------------------------------------------------------------------------
// Notes — an instant-capture stream, not a document.
//
// Design axes:
//   privacy:        privacy-public-view  — non-members read the stream live; space editors
//                                           write.
//   data_storage:   the space's table    — `notes.table.jsonl` at the space's root, synced
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
import {
  log, serveFileAtPath, jsonReply, parseJsonBody, parsePeerInfo, onUiMessage,
  pushToInstance, sanitizeText, declareTables, table,
} from "@frame-core";

const NOTES_SCHEMA = [
  { name: "body",        col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "tags",        col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "author_name", col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "author_id",   col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "created_ms",  col_type: "integer" as const, nullable: false, default_val: "0" },
  { name: "edited_ms",   col_type: "integer" as const, nullable: false, default_val: "0" },
  { name: "pinned",      col_type: "integer" as const, nullable: false, default_val: "0" },
];

declareTables([
  { key: "notes", title: "Notes", description: "Notes captured in this space's stream.", local: true, schema: NOTES_SCHEMA },
]);

type Peer = ReturnType<typeof parsePeerInfo>;
type Tbl = ReturnType<typeof table>;
type WriteResult = { status: number; body: unknown };

const MAX_BODY = 4000;

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

async function listNotes(t: Tbl) {
  // Newest first. Pinned notes are lifted client-side rather than sorted here, so the
  // stream's underlying order stays purely chronological.
  const { rows } = await t.query({ order_by: [{ col: "created_ms", dir: "desc" }], limit: 500 });
  return rows.map((r) => ({
    id: r._row_id,
    body: r.body,
    tags: String(r.tags || "").split(",").filter(Boolean),
    author_name: r.author_name,
    author_id: r.author_id,
    created_ms: Number(r.created_ms) || 0,
    edited_ms: Number(r.edited_ms) || 0,
    pinned: !!Number(r.pinned),
  }));
}

function notify(sfiId: string) {
  pushToInstance(sfiId, { type: "notes_changed" });
}

async function handleWrite(sfiId: string, op: string, v: Record<string, unknown> | null, peer: Peer): Promise<WriteResult> {
  const t = table("notes", sfiId);

  // Never gate writes on is_sfi_member — a Viewer-role member would slip through.
  if (!peer.is_sfi_editor) return { status: 403, body: { error: "editors only" } };

  const ok = async (): Promise<WriteResult> => {
    notify(sfiId);
    return { status: 200, body: { notes: await listNotes(t) } };
  };

  if (op === "note") {
    const body = sanitizeText(v?.body, MAX_BODY);
    if (!body.trim()) return { status: 400, body: { error: "empty note" } };
    await t.upsert(null, {
      body,
      tags: extractTags(body),
      author_name: sanitizeText(peer.user_name, 60),
      author_id: String(peer.user_id ?? ""),
      created_ms: Date.now(),
      edited_ms: 0,
      pinned: 0,
    });
    return ok();
  }

  if (op.startsWith("note/")) {
    const [id, action] = op.slice("note/".length).split("/");
    const row = id ? await t.get(id) : null;
    if (!row) return { status: 400, body: { error: "bad id" } };

    if (action === "delete") { await t.delete(id); return ok(); }
    if (action === "pin") {
      await t.upsert(id, { pinned: Number(v?.pinned) ? 1 : 0 });
      return ok();
    }
    if (action) return { status: 404, body: { error: "not found" } };

    if (v?.body !== undefined) {
      const body = sanitizeText(v.body, MAX_BODY);
      if (!body.trim()) return { status: 400, body: { error: "empty note" } };
      // Re-derive the tags: the body is the only source of truth for them, so an edit
      // that removes a #tag has to remove it from the filter list too.
      await t.upsert(id, { body, tags: extractTags(body), edited_ms: Date.now() });
    }
    return ok();
  }

  return { status: 404, body: { error: "not found" } };
}

onUiMessage(async (sfiId, data, peer) => {
  if (!sfiId || typeof data !== "object" || data === null) return;
  const d = data as Record<string, unknown>;
  if (typeof d.op !== "string") return;
  const r = await handleWrite(sfiId, d.op, d, peer);
  if (r.status !== 200) log(`notes: bus op ${d.op} → ${r.status} (${JSON.stringify(r.body)})`);
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

  if (reqPath.startsWith("/api/") && (method === "POST" || method === "PUT")) {
    const r = await handleWrite(sfiId, reqPath.slice("/api/".length), parseJsonBody<Record<string, unknown>>(body), peer);
    return jsonReply(replyPort, r.status, r.body);
  }

  if (reqPath === "/api/list" && method === "GET") {
    return jsonReply(replyPort, 200, { notes: await listNotes(table("notes", sfiId)) });
  }

  return jsonReply(replyPort, 404, { error: "not found" });
};

log("Notes frame is up and running!");
