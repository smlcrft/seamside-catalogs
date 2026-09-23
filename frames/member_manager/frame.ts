// ----------------------------------------------------------------------------------------
// Member Manager — view and manage people and their roles within an organization.
//
// The roster is a `members` list of the space: `members.table.jsonl`, or a subtype such as
// `club.members.table.jsonl` when a space keeps more than one. Each session is bound to one
// (sessionKv `bound/members`), chosen by an editor. It is a shared contract: Community
// Library, Member Reachout and Garden Planner, bound to the same list, read the same rows.
// Columns: name, email, phone (optional), role. Preferences (org name, role list, owner-only
// edit) are this session's own (sessionKv `prefs`).
// ----------------------------------------------------------------------------------------
import {
  log, serveFileAtPath, pushToInstance, parsePeerInfo, onUiMessage,
  table, sessionKv,
  jsonReply, parseJsonBody, sanitizeText, wireTableChangeListener,
} from "@frame-core";

// ----- Which list: `members` or a subtype `<name>.members`, bound per session -------------
const LIST_NAME = /^([a-z0-9][a-z0-9_-]*\.)*members$/;
const validList = (n: unknown): n is string => typeof n === "string" && n.length <= 64 && LIST_NAME.test(n);
async function boundList(): Promise<string | null> {
  const v = (await sessionKv.get("bound/members"))?.value;
  return validList(v) ? v : null;
}

// ----- Preferences (this session's own) ---------------------------------------------------
type Prefs = {
  org_name: string;
  roles: string[];
  owner_only_edit: boolean;
};

const DEFAULT_PREFS: Prefs = {
  org_name: "Our Organization",
  roles: ["Owner", "Admin", "Member", "Guest"],
  owner_only_edit: false,
};

async function getPrefs(): Promise<Prefs> {
  let p: Partial<Prefs> = {};
  try { p = JSON.parse((await sessionKv.get("prefs"))?.value ?? "{}") ?? {}; } catch { /* defaults */ }
  return {
    org_name: typeof p.org_name === "string" && p.org_name ? p.org_name : DEFAULT_PREFS.org_name,
    roles: Array.isArray(p.roles) && p.roles.length > 0 ? p.roles.map(String) : [...DEFAULT_PREFS.roles],
    owner_only_edit: !!p.owner_only_edit,
  };
}

async function setPrefs(next: Prefs): Promise<void> {
  await sessionKv.put("prefs", JSON.stringify(next));
}

// ----- Helpers --------------------------------------------------------------------------
// Writes are editor-only. Never gate on is_sfi_member — a Viewer-role member would slip
// through and be able to edit the roster.
function canEdit(peer: ReturnType<typeof parsePeerInfo>, prefs: Prefs): boolean {
  if (prefs.owner_only_edit) return peer.is_owner;
  return peer.is_sfi_editor;
}

// ----- Shared write logic ---------------------------------------------------------------
// Both entry points (HTTP arms and the bus dispatcher) land here; role gates live inside.
// Member writes reach this session's viewers via the wired members_changed push (member
// pages also watch the bound table itself, which other frames write); settings and a new
// binding push settings_changed.
type WriteResult = { status: number; body: unknown };

async function handleWrite(
  op: string,
  v: Record<string, unknown> | null,
  sfiId: string,
  peer: ReturnType<typeof parsePeerInfo>,
): Promise<WriteResult> {
  const p = peer.sfi_id === sfiId ? peer : { ...peer, sfi_id: sfiId };
  const prefs = await getPrefs();

  if (op === "bind") {
    if (!p.is_sfi_editor) return { status: 403, body: { error: "editors only" } };
    const name = v?.list;
    if (!validList(name)) return { status: 400, body: { error: "a members list is named members or <name>.members" } };
    await sessionKv.put("bound/members", name);
    pushToInstance(sfiId, { type: "settings_changed" });
    return { status: 200, body: { bound: name } };
  }

  if (op === "settings") {
    // Settings can always be edited by the owner; non-owners get blocked here regardless of owner_only_edit.
    if (!p.is_owner) return { status: 403, body: { error: "only the frame owner can change settings" } };
    if (!v) return { status: 400, body: { error: "invalid JSON" } };
    const org_name = sanitizeText(v.org_name, 120) || DEFAULT_PREFS.org_name;
    const rolesIn: unknown[] = Array.isArray(v.roles) ? v.roles : [];
    const roles = Array.from(new Set(rolesIn.map((r: unknown) => sanitizeText(r, 80)).filter((r: string) => r.length > 0)));
    if (roles.length === 0) return { status: 400, body: { error: "at least one role is required" } };
    const next: Prefs = {
      org_name,
      roles,
      owner_only_edit: !!v.owner_only_edit,
    };
    await setPrefs(next);
    pushToInstance(sfiId, { type: "settings_changed" });
    return { status: 200, body: { prefs: next } };
  }

  const list = await boundList();
  if (!list) return { status: 409, body: { error: "no members list chosen yet" } };
  wireTableChangeListener(list, sfiId, "members_changed");
  const members = table(list, sfiId);

  if (op === "member") {
    if (!canEdit(p, prefs)) return { status: 403, body: { error: prefs.owner_only_edit ? "editing is restricted to the frame owner" : "editors only" } };
    if (!v) return { status: 400, body: { error: "invalid JSON" } };
    const name = sanitizeText(v.name, 120);
    const email = sanitizeText(v.email, 200);
    const phone = sanitizeText(v.phone, 40); // optional
    const role = sanitizeText(v.role, 80);
    if (!name) return { status: 400, body: { error: "name required" } };
    if (!email) return { status: 400, body: { error: "email required" } };
    if (!role) return { status: 400, body: { error: "role required" } };
    if (!prefs.roles.includes(role)) return { status: 400, body: { error: "role not in allowed list" } };
    const rowId = v.row_id ? String(v.row_id) : null;
    // An id that names no row is refused, never created (upsert would phantom-create it).
    if (rowId && !(await members.get(rowId))) return { status: 404, body: { error: "member not found" } };
    const { row_id } = await members.upsert(rowId, { name, email, phone, role });
    return { status: 200, body: { row_id } };
  }

  if (op === "member/delete") {
    if (!canEdit(p, prefs)) return { status: 403, body: { error: prefs.owner_only_edit ? "editing is restricted to the frame owner" : "editors only" } };
    const rowId = String(v?.row_id ?? "");
    if (!rowId) return { status: 400, body: { error: "row_id required" } };
    await members.delete(rowId);
    return { status: 204, body: null };
  }

  return { status: 404, body: { error: "unknown op" } };
}

// ----- Bus dispatcher (frame.busSend → BusUiToFrame) ------------------------------------
// Fire-and-forget: denied or invalid writes are logged, not answered — the UI is
// role-gated and never sends them.
onUiMessage(async (sfiId, data, peer) => {
  if (!sfiId || typeof data !== "object" || data === null) return;
  const d = data as Record<string, unknown>;
  const op = typeof d.op === "string" ? d.op : "";
  if (!op) return;
  const r = await handleWrite(op, d, sfiId, peer);
  if (r.status >= 400) log(`member_manager: bus op ${op} → ${r.status} (${JSON.stringify(r.body)})`);
});

// ----- HTTP handler ---------------------------------------------------------------------
self.onNetworkRequest = async function (replyPort, reqPath, method, _headers, query, body, cookies) {
  const peer = parsePeerInfo(query, cookies);

  const list = await boundList();
  if (list) wireTableChangeListener(list, peer.sfi_id, "members_changed");
  const prefs = await getPrefs();
  const editable = canEdit(peer, prefs);

  if (reqPath === "/api/state" && method === "GET") {
    return jsonReply(replyPort, 200, {
      prefs,
      viewer: {
        user_name: peer.user_name || "anon",
        is_owner: peer.is_owner,
        is_anon: peer.is_anon,
      },
      can_edit: editable,
      bound: list,
      can_bind: peer.is_sfi_editor,
      has_phone: true,
    });
  }

  // Open to every viewer who reaches the frame. Anyone not on the space's roster (v1's
  // `is_anon`) gets a reduced projection below (name + role only, no email or phone).
  if (reqPath === "/api/members" && method === "GET") {
    if (!list) return jsonReply(replyPort, 200, { rows: [], anon_view: peer.is_anon });
    const { rows } = await table(list, peer.sfi_id).query({ limit: 1000 });
    // Group by role (in the configured role order), then alphabetically by name
    // within each role. Legacy/unknown roles sort to the end, then by name.
    const roleRank = new Map(prefs.roles.map((r, i) => [r, i]));
    const rankOf = (role: unknown) => roleRank.has(String(role)) ? roleRank.get(String(role))! : Number.MAX_SAFE_INTEGER;
    rows.sort((a, b) => {
      const ra = rankOf(a.role), rb = rankOf(b.role);
      if (ra !== rb) return ra - rb;
      return String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base" });
    });
    if (peer.is_anon) {
      // Public read-only view: name + role only — strip email and any other fields.
      const publicRows = rows.map((r: Record<string, unknown>) => ({
        _row_id: r._row_id,
        name: r.name,
        role: r.role,
      }));
      return jsonReply(replyPort, 200, { rows: publicRows, anon_view: true });
    }
    return jsonReply(replyPort, 200, { rows });
  }

  if (reqPath === "/api/member" && method === "POST") {
    const r = await handleWrite("member", parseJsonBody(body), peer.sfi_id, peer);
    return jsonReply(replyPort, r.status, r.body);
  }

  if (reqPath === "/api/member/delete" && method === "POST") {
    const r = await handleWrite("member/delete", parseJsonBody(body), peer.sfi_id, peer);
    if (r.status === 204) return replyPort.postMessage({ status: 204, contentType: "text/plain", body: null });
    return jsonReply(replyPort, r.status, r.body);
  }

  if ((reqPath === "/api/settings" || reqPath === "/api/bind") && method === "POST") {
    const r = await handleWrite(reqPath.slice("/api/".length), parseJsonBody(body), peer.sfi_id, peer);
    return jsonReply(replyPort, r.status, r.body);
  }

  if (method === "GET") {
    return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url));
  }

  replyPort.postMessage({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Not found.", code: "NOT_FOUND" }) });
};

log("Member Manager frame is up and running.");
