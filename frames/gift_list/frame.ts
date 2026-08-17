// ----------------------------------------------------------------------------------------
// Gift List — a wish list that can keep a secret.
//
// Design axes:
//   privacy:        privacy-public-view  — non-members see the wishes (so relatives with no
//                                           account can still read the list); space editors
//                                           add and claim.
//   data_storage:   storage-graduating   — LocalTable by default, owner can graduate this
//                                           placement to a shared SyncTable. See
//                                           docs/table-graduation.md.
//   view_realtime:  view-collaborative    — every mutation pushes, so two aunts cannot both
//                                           claim the same thing.
//   settings_scope: settings-per-sfi
//
// THE SECRET IS KEPT ON THE SERVER. The whole point of this frame is that the person a gift
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
  declareTables, ensureTables, table,
} from "@frame-core";
// Namespace import so features newer than the running host degrade to no-ops
// instead of failing the module load (0.2.6 hosts lack forgetBinding).
import * as frameCore from "@frame-core";

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
];

declareTables([
  { key: "wishes", title: "Gift List", description: "Wishes for this placement's gift list.", local: true, schema: WISHES_SCHEMA },
]);

let sharedDeclsRegistered = false;
function ensureSharedDecls(): void {
  if (sharedDeclsRegistered) return;
  sharedDeclsRegistered = true;
  declareTables([
    {
      key: "wishes_shared", title: "Gift List",
      description: "Wishes of a shared gift list. Create a new table, or pick the one other frames should read.",
      schema: WISHES_SCHEMA,
    },
  ]);
}

type Backend = "local" | "shared";
type GradMode = "convert" | "adopt";
type SfiSettings = { backend: Backend; pending_graduation?: GradMode };
const allSettings: Record<string, SfiSettings> = loadJsonFile(import.meta.url, "settings.json", {});
function getSettings(sfiId: string): SfiSettings {
  return allSettings[sfiId] ?? { backend: "local" };
}
function saveSettings(sfiId: string, s: SfiSettings): void {
  allSettings[sfiId] = s;
  saveJsonFile(import.meta.url, "settings.json", allSettings);
}

type Tbl = ReturnType<typeof table>;
type Peer = ReturnType<typeof parsePeerInfo>;

function dataTable(sfiId: string, s: SfiSettings): Tbl {
  return table(s.backend === "shared" ? "wishes_shared" : "wishes", sfiId);
}
function sharedBound(sfiId: string): boolean {
  try { table("wishes_shared", sfiId); return true; } catch { return false; }
}

async function readyLocalTables(peer: Peer): Promise<boolean> {
  const quiet = { ...peer, is_owner: false } as Peer;
  let r = ensureTables(quiet);
  if (!r.byKey["wishes"]) {
    try { await table("wishes", peer.sfi_id).query({ limit: 1 }); } catch (e) { log(`gift_list: ensure "wishes" failed: ${e}`); }
    r = ensureTables(quiet);
  }
  return !!r.byKey["wishes"];
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

// ----- Graduation ------------------------------------------------------------------------
async function runGraduation(sfiId: string, settings: SfiSettings): Promise<void> {
  const mode = settings.pending_graduation!;
  let copied = "";
  if (mode === "convert") {
    const shared = table("wishes_shared", sfiId);
    const { rows } = await table("wishes", sfiId).query({});
    for (const r of rows) {
      await shared.upsert(r._row_id, {
        item: r.item, for_who: r.for_who, for_user_id: r.for_user_id,
        url: r.url, notes: r.notes,
        claimed_by: r.claimed_by, claimed_by_id: r.claimed_by_id, added_ms: r.added_ms,
      });
    }
    copied = ` (${rows.length} wishes copied)`;
  }
  settings.backend = "shared";
  delete settings.pending_graduation;
  saveSettings(sfiId, settings);
  wireSharedListeners(sfiId);
  notify(sfiId);
  log(`gift_list: placement ${sfiId} moved to shared tables (${mode})${copied}`);
}

const wiredShared = new Set<string>();
function wireSharedListeners(sfiId: string): void {
  if (wiredShared.has(sfiId)) return;
  wiredShared.add(sfiId);
  try {
    table("wishes_shared", sfiId).onChange(() => notify(sfiId));
  } catch {
    wiredShared.delete(sfiId);
  }
}

// ----- Queries ---------------------------------------------------------------------------
/** The list AS THIS VIEWER MAY SEE IT. The strip happens here, at the one place rows turn
 * into a payload, so no route can accidentally serve an unredacted wish. */
async function listRows(t: Tbl, peer: Peer) {
  const { rows } = await t.query({ order_by: [{ col: "for_who" }, { col: "added_ms" }] });
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
    return {
      ...base,
      claimed_by: r.claimed_by,
      claimed_by_id: r.claimed_by_id,
      claimed_by_me: !!r.claimed_by_id && r.claimed_by_id === peer.user_id,
    };
  });
}

function notify(sfiId: string) {
  pushToInstance(sfiId, { type: "wishes_changed" });
}

// ----- Writes ----------------------------------------------------------------------------
type WriteResult = { status: number; body: unknown };

async function handleWrite(sfiId: string, op: string, v: Record<string, unknown> | null, peer: Peer): Promise<WriteResult> {
  const settings = getSettings(sfiId);
  if (settings.backend === "shared" || settings.pending_graduation) ensureSharedDecls();
  if (settings.pending_graduation && sharedBound(sfiId)) {
    try { await runGraduation(sfiId, settings); } catch (e) { log(`gift_list: graduation failed (will retry): ${e}`); }
  }
  if (settings.backend === "shared" && !sharedBound(sfiId)) {
    return { status: 503, body: { error: "table not bound" } };
  }
  if (settings.backend === "shared") wireSharedListeners(sfiId);
  if (settings.backend === "local" && !(await readyLocalTables(peer))) {
    return { status: 503, body: { error: "table not ready" } };
  }
  const t = dataTable(sfiId, settings);

  // Never gate writes on is_sfi_member — a Viewer-role member would slip through.
  if (!peer.is_sfi_editor) return { status: 403, body: { error: "editors only" } };

  const ok = async (): Promise<WriteResult> => {
    notify(sfiId);
    return { status: 200, body: { wishes: await listRows(t, peer) } };
  };

  // --- Data backend (owner-only) ------------------------------------------------------
  if (op === "data/graduate") {
    if (!peer.is_owner) return { status: 403, body: { error: "owner only" } };
    if (settings.backend === "shared") {
      // Re-point: only "adopt" makes sense once shared. Forget the current binding(s)
      // so ensureTables re-fires the picker(s); pending "adopt" finishes on sight.
      if (v?.mode !== "adopt") return { status: 400, body: { error: "already shared" } };
      ensureSharedDecls();
      frameCore.forgetBinding?.("wishes_shared", sfiId);
      wiredShared.delete(sfiId);
    }
    settings.pending_graduation = v?.mode === "adopt" ? "adopt" : "convert";
    saveSettings(sfiId, settings);
    ensureSharedDecls();
    ensureTables(peer);
    notify(sfiId);
    return { status: 200, body: { waiting: true } };
  }
  if (op === "data/cancel_graduate") {
    if (!peer.is_owner) return { status: 403, body: { error: "owner only" } };
    delete settings.pending_graduation;
    saveSettings(sfiId, settings);
    notify(sfiId);
    return { status: 200, body: { ok: true } };
  }

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
      claimed_by: "", claimed_by_id: "", added_ms: Date.now(),
    });
    return ok();
  }

  if (op.startsWith("wish/")) {
    const [id, action] = op.slice("wish/".length).split("/");
    const row = id ? await t.get(id) : null;
    if (!row) return { status: 400, body: { error: "bad id" } };

    if (action === "claim") {
      // You cannot claim a gift meant for you: you would never be shown the result, so the
      // button would appear to do nothing. Refuse it plainly instead.
      if (isRecipient(row, peer)) return { status: 400, body: { error: "that one is for you" } };
      if (row.claimed_by_id) return { status: 409, body: { error: "already claimed" } };
      await t.upsert(id, {
        claimed_by: sanitizeText(peer.user_name, 60),
        claimed_by_id: String(peer.user_id ?? ""),
      });
      return ok();
    }

    if (action === "unclaim") {
      // Only the person holding the claim may release it — otherwise one relative could
      // quietly take over another's gift, and neither would be told.
      if (!row.claimed_by_id) return ok();
      if (String(row.claimed_by_id) !== String(peer.user_id ?? "")) {
        return { status: 403, body: { error: "not your claim" } };
      }
      await t.upsert(id, { claimed_by: "", claimed_by_id: "" });
      return ok();
    }

    if (action === "delete") {
      await t.delete(id);
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

  const settings = getSettings(sfiId);
  if (settings.backend === "shared" || settings.pending_graduation) ensureSharedDecls();
  if (settings.pending_graduation && sharedBound(sfiId)) {
    try { await runGraduation(sfiId, settings); } catch (e) { log(`gift_list: graduation failed (will retry): ${e}`); }
  }
  if (settings.pending_graduation && peer.is_owner && !sharedBound(sfiId)
      && reqPath === "/api/list" && method === "GET") {
    ensureTables(peer);
  }
  if (settings.backend === "shared" && !sharedBound(sfiId)) {
    if (reqPath === "/api/list" && method === "GET") {
      if (peer.is_owner) ensureTables(peer);
      return jsonReply(replyPort, 200, {
        waiting_for_binding: true, is_owner: peer.is_owner,
        storage: { backend: settings.backend, pending: false, can_manage: peer.is_owner },
      });
    }
    return jsonReply(replyPort, 503, { error: "table not bound" });
  }
  if (settings.backend === "shared") wireSharedListeners(sfiId);
  if (settings.backend === "local" && !(await readyLocalTables(peer))) {
    return jsonReply(replyPort, 503, { error: "table not ready" });
  }

  // Read — open to everyone, redacted per viewer by listRows.
  if (reqPath === "/api/list" && method === "GET") {
    const r = ensureTables({ ...peer, is_owner: false } as Peer);
    return jsonReply(replyPort, 200, {
      wishes: await listRows(dataTable(sfiId, settings), peer),
      me_name: peer.user_name,
      storage: {
        backend: settings.backend,
        pending: !!settings.pending_graduation,
        can_manage: peer.is_owner,
        // bound shared table name(s) — app ≥ 0.2.7 supplies tableTitle; older hosts leave it unset
        table_titles: settings.backend === "shared" ? [r.byKey["wishes_shared"]?.tableTitle].filter((t): t is string => !!t) : [],
      },
    });
  }

  return jsonReply(replyPort, 404, { error: "not found" });
};

log("Gift List frame is up and running!");
