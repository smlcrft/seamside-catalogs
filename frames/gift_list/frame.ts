// ----------------------------------------------------------------------------------------
// Gift List — a wish list that can keep a secret.
//
// Design axes:
//   privacy:        privacy-public-view  — non-members see the wishes (so relatives with no
//                                           account can still read the list); space editors
//                                           add and claim.
//   data_storage:   a `wishes` list of the space (wishes.table.jsonl, or a subtype such as
//                                           christmas.wishes.table.jsonl), one bound per session in
//                                           `sessionKv` `bound/wishes`; WHO claimed is not in it.
//   view_realtime:  view-collaborative    — every mutation pushes, so two aunts cannot both
//                                           claim the same thing.
//
// WHO CLAIMED IS KEPT ON THE SERVER, and so never in the table. A table is a file of the
// space: every member reads it, through the door or in their synced replica, so a name
// written there would reach the very person it hides from. Holders live in this worker's
// `data/claims.json` on the keeper's device, keyed by space and list, which the space does
// not sync and the door does not serve; `claimed_by`/`claimed_by_id` stay empty. The row
// keeps only `claimed` (0/1), so a claim outlives the loss of data/ as "claimed by someone"
// — which anyone who opens the table file can read (the keeper accepted that).
// The whole point of this frame is that the person a gift
// is for cannot see who claimed it — so the claim fields are STRIPPED from the payload
// before it is sent to them, never merely hidden in the frontend. A frontend that receives
// the secret and declines to draw it has not kept it: it is one devtools panel, one saved
// HTML file, or one curl away from the surprise being ruined.
//
// Not even a boolean survives the strip. "Something on your list is claimed" is enough to
// spoil a one-item list, so the recipient's copy of a wish is byte-for-byte the same
// whether or not anyone has claimed it, and the frame tells them plainly that claims exist
// and are hidden — a fixed sentence that is true on an empty list and a finished one alike.
//
// Recognising the recipient errs on the side of secrecy, because the two failure modes are
// not equal: mistakenly hiding claims from a bystander is a small confusion, while
// mistakenly showing them to the recipient is the one thing this frame exists to prevent.
// So a wish matches its recipient by user_id when we have one (exact) AND by a loosened
// name comparison when we don't (generous).
// ----------------------------------------------------------------------------------------
import {
  log, serveFileAtPath, jsonReply, parseJsonBody, parsePeerInfo, onUiMessage,
  pushToInstance, sanitizeText, loadJsonFile, saveJsonFile,
  declareTables, table, sessionKv,
} from "@frame-core";

// ----- Schema (the `wishes` v1 contract — declared verbatim, one source of truth) -------
const WISHES_SCHEMA = [
  { name: "item",          col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "for_who",       col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "for_user_id",   col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "url",           col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "notes",         col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "claimed_by",    col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "claimed_by_id", col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "added_ms",      col_type: "integer" as const, nullable: false, default_val: "0" },
  { name: "claimed",       col_type: "integer" as const, nullable: false, default_val: "0" },
];

declareTables([
  { key: "wishes", title: "Gift List", description: "Wishes on this space's gift list.", schema: WISHES_SCHEMA },
]);

type Tbl = ReturnType<typeof table>;
type Peer = ReturnType<typeof parsePeerInfo>;

// ----- Which list: `wishes` or a subtype `<name>.wishes`, bound per session ------------------
const LIST_NAME = /^([a-z0-9][a-z0-9_-]*\.)*wishes$/;
const validList = (n: unknown): n is string => typeof n === "string" && n.length <= 64 && LIST_NAME.test(n);
async function boundList(): Promise<string | null> {
  const v = (await sessionKv.get("bound/wishes"))?.value;
  return validList(v) ? v : null;
}

// ----- Claims: the holder, off the table ---------------------------------------------------
type Claim = { by: string; by_id: string };
const claims: Record<string, Record<string, Claim>> = loadJsonFile(import.meta.url, "claims.json", {});
const claimsOf = (sfiId: string, list: string): Record<string, Claim> => (claims[`${sfiId}:${list}`] ??= {});
function setClaim(sfiId: string, list: string, wishId: string, c: Claim | null): void {
  const m = claimsOf(sfiId, list);
  if (c) m[wishId] = c; else delete m[wishId];
  saveJsonFile(import.meta.url, "claims.json", claims);
}

// ----- Who is this wish for? -------------------------------------------------------------
/** Loosened name key: trimmed, lowercased, inner whitespace collapsed. Used only to decide
 * whether to KEEP a secret, never to grant access, so leaning generous is safe. */
function nameKey(s: unknown): string {
  return String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** True when this viewer is the person the wish is for — i.e. the one who must not see the
 * claim. Exact on user_id when the wish carries one; otherwise a name match, including a
 * first-name match so "Ana" and "Ana Beck" are treated as the same person. */
function isRecipient(row: Record<string, unknown>, peer: Peer): boolean {
  const rid = String(row.for_user_id ?? "");
  if (rid && peer.user_id && rid === peer.user_id) return true;
  const rk = nameKey(row.for_who);
  const pk = nameKey(peer.user_name);
  if (!rk || !pk) return false;
  if (rk === pk) return true;
  return rk.split(" ")[0] === pk.split(" ")[0];
}

// ----- Queries ---------------------------------------------------------------------------
/** The list AS THIS VIEWER MAY SEE IT. The strip happens here, at the one place rows turn
 * into a payload, so no route can accidentally serve an unredacted wish. */
async function listRows(t: Tbl, sfiId: string, list: string, peer: Peer) {
  const { rows } = await t.query({ order_by: [{ col: "for_who" }, { col: "added_ms" }] });
  const held = claimsOf(sfiId, list);
  return rows.map((r) => {
    const mine = isRecipient(r, peer);
    const base = {
      id: r._row_id,
      item: r.item,
      for_who: r.for_who,
      url: r.url,
      notes: r.notes,
      added_ms: r.added_ms,
      // "this wish is for me" is safe to send: they already know who they are.
      for_me: mine,
    };
    // The recipient's copy carries no claim information of any kind — not a name, not an
    // id, not a boolean. Their row looks identical whether or not it has been claimed.
    if (mine) return base;
    const c = held[r._row_id];
    return {
      ...base,
      // `claimed` without a holder: the row says so but data/ lost who — "claimed by someone".
      claimed: !!c || Number(r.claimed) === 1,
      holder_known: !!c,
      claimed_by: c?.by ?? "",
      claimed_by_id: c?.by_id ?? "",
      claimed_by_me: !!c?.by_id && c.by_id === peer.user_id,
    };
  });
}

function notify(sfiId: string) {
  pushToInstance(sfiId, { type: "wishes_changed" });
}

// ----- Writes ----------------------------------------------------------------------------
type WriteResult = { status: number; body: unknown };

async function handleWrite(sfiId: string, op: string, v: Record<string, unknown> | null, peer: Peer): Promise<WriteResult> {
  // Never gate writes on is_sfi_member — a Viewer-role member would slip through.
  if (!peer.is_sfi_editor) return { status: 403, body: { error: "editors only" } };

  if (op === "bind") {
    const name = v?.list;
    if (!validList(name)) return { status: 400, body: { error: "a wishes list is named wishes or <name>.wishes" } };
    await sessionKv.put("bound/wishes", name);
    notify(sfiId);
    return { status: 200, body: { bound: name } };
  }

  const list = await boundList();
  if (!list) return { status: 409, body: { error: "no list chosen yet" } };
  const t = table(list, sfiId);

  const ok = async (): Promise<WriteResult> => {
    notify(sfiId);
    return { status: 200, body: { wishes: await listRows(t, sfiId, list, peer) } };
  };

  // --- Wishes --------------------------------------------------------------------------
  if (op === "wish") {
    const item = sanitizeText(v?.item, 200);
    if (!item) return { status: 400, body: { error: "item required" } };
    const forWho = sanitizeText(v?.for_who, 60);
    // A wish with no name is for whoever is adding it — the common case is writing your
    // own list. Claiming your own id only when the name is yours keeps the exact match
    // honest for someone adding on another person's behalf.
    const mineByName = !forWho || nameKey(forWho) === nameKey(peer.user_name);
    await t.upsert(null, {
      item,
      for_who: forWho || sanitizeText(peer.user_name, 60),
      for_user_id: mineByName ? String(peer.user_id ?? "") : "",
      url: sanitizeText(v?.url, 500),
      notes: sanitizeText(v?.notes, 300),
      claimed_by: "", claimed_by_id: "", added_ms: Date.now(), claimed: 0,
    });
    return ok();
  }

  if (op.startsWith("wish/")) {
    const [id, action] = op.slice("wish/".length).split("/");
    const row = id ? await t.get(id) : null;
    if (!row) return { status: 400, body: { error: "bad id" } };

    // You cannot claim or release a gift meant for you: you would never be shown the
    // result. Refused before the claim is looked at, so the answer says nothing about it.
    if ((action === "claim" || action === "unclaim") && isRecipient(row, peer)) {
      return { status: 400, body: { error: "that one is for you" } };
    }

    if (action === "claim") {
      if (claimsOf(sfiId, list)[id] || Number(row.claimed) === 1) return { status: 409, body: { error: "already claimed" } };
      // A claim needs someone to hold it: an unnamed caller could never release it.
      if (!peer.user_id) return { status: 403, body: { error: "sign in to claim" } };
      setClaim(sfiId, list, id, { by: sanitizeText(peer.user_name, 60), by_id: String(peer.user_id) });
      await t.upsert(id, { claimed: 1 });
      return ok();
    }

    if (action === "unclaim") {
      // Only the person holding the claim may release it — otherwise one relative could
      // quietly take over another's gift, and neither would be told. A claim whose holder
      // was lost with data/ is nobody's to prove, so any editor may let it go.
      const c = claimsOf(sfiId, list)[id];
      if (c && c.by_id !== String(peer.user_id ?? "")) {
        return { status: 403, body: { error: "not your claim" } };
      }
      if (c) setClaim(sfiId, list, id, null);
      if (Number(row.claimed) === 1) await t.upsert(id, { claimed: 0 });
      return ok();
    }

    if (action === "delete") {
      await t.delete(id);
      if (claimsOf(sfiId, list)[id]) setClaim(sfiId, list, id, null);
      return ok();
    }
    if (action) return { status: 404, body: { error: "not found" } };

    if (v?.item !== undefined) {
      const item = sanitizeText(v.item, 200);
      if (item) await t.upsert(id, { item });
    }
    if (v?.url !== undefined) await t.upsert(id, { url: sanitizeText(v.url, 500) });
    if (v?.notes !== undefined) await t.upsert(id, { notes: sanitizeText(v.notes, 300) });
    return ok();
  }

  return { status: 404, body: { error: "not found" } };
}

onUiMessage(async (sfiId, data, peer) => {
  if (!sfiId || typeof data !== "object" || data === null) return;
  const d = data as Record<string, unknown>;
  if (typeof d.op !== "string") return;
  const r = await handleWrite(sfiId, d.op, d, peer);
  if (r.status !== 200) log(`gift_list: bus op ${d.op} → ${r.status} (${JSON.stringify(r.body)})`);
});

// ----- Networking -------------------------------------------------------------------------
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

  // Read — open to everyone, redacted per viewer by listRows.
  if (reqPath === "/api/list" && method === "GET") {
    const list = await boundList();
    return jsonReply(replyPort, 200, {
      bound: list,
      can_bind: peer.is_sfi_editor,
      wishes: list ? await listRows(table(list, sfiId), sfiId, list, peer) : [],
      me_name: peer.user_name,
    });
  }

  return jsonReply(replyPort, 404, { error: "not found" });
};

log("Gift List frame is up and running!");
