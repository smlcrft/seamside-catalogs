// ----------------------------------------------------------------------------------------
// Member Reachout — send updates / notifications to the people in your roster.
//
// Contacts (name, email, role, optional phone) are a `members` list of the space —
// `members.table.jsonl` or a subtype such as `club.members.table.jsonl`, the roster Member
// Manager keeps. Each session is bound to one (sessionKv `bound/members`), chosen by an
// editor; this frame only READS it.
//
// Every send is a row of the space's `reachout_sent` table, saying which list it went to,
// who sent it, when, to which role(s) (or everyone) and how (email or text); a session
// shows the sends to its own list. Settings (board title, which roles' messages outsiders
// may read) are this session's own (sessionKv `settings`). The actual sending happens
// OS-side: the frontend builds a `mailto:` (all recipients bcc'd) or a per-person `sms:`
// link and asks the viewer to open it.
// ----------------------------------------------------------------------------------------
import {
  log, serveFileAtPath, pushToInstance, parsePeerInfo, onUiMessage,
  table, sessionKv,
  jsonReply, parseJsonBody, sanitizeText, clampInt,
} from "@frame-core";

// ----- Which members list: `members` or a subtype `<name>.members`, bound per session -----
const LIST_NAME = /^([a-z0-9][a-z0-9_-]*\.)*members$/;
const validList = (n: unknown): n is string => typeof n === "string" && n.length <= 64 && LIST_NAME.test(n);
async function boundList(): Promise<string | null> {
  const v = (await sessionKv.get("bound/members"))?.value;
  return validList(v) ? v : null;
}

// ----- Settings (this session's own) ------------------------------------------------------
type Settings = {
  title: string;
  public_roles: string[]; // role(s) whose message history is exposed to non-member viewers
};

const DEFAULT_SETTINGS: Settings = {
  title: "Reachout",
  public_roles: [],
};

async function getSettings(): Promise<Settings> {
  let v: Partial<Settings> = {};
  try { v = JSON.parse((await sessionKv.get("settings"))?.value ?? "{}") ?? {}; } catch { /* defaults */ }
  return {
    title: typeof v.title === "string" && v.title.trim() ? v.title : DEFAULT_SETTINGS.title,
    public_roles: Array.isArray(v.public_roles) ? v.public_roles.map(String) : [],
  };
}

async function setSettings(next: Settings): Promise<void> {
  await sessionKv.put("settings", JSON.stringify(next));
}

// ----- Sent-message log (the space's reachout_sent table) ---------------------------------
const SENT = "reachout_sent";
type SentEntry = {
  id: string;
  list: string;             // the members list it went to
  sent_by: string;          // the sender's DID
  sent_by_name: string;
  sent_at_ms: number;
  to_all: boolean;
  roles: string[];          // empty when to_all
  method: "email" | "text";
  subject: string;          // email only; "" otherwise
  message: string;
  recipient_count: number;  // how many people the audience resolved to at send time
  attempted_count: number;  // text only: how many were actually tapped (== recipient_count for email)
};

async function sentTo(sfi_id: string, list: string): Promise<SentEntry[]> {
  const { rows } = await table(SENT, sfi_id).query({ where: { list }, limit: 5000 });
  return rows.map((r) => ({
    id: r._row_id,
    list: String(r.list ?? ""),
    sent_by: String(r.sent_by ?? ""),
    sent_by_name: String(r.sent_by_name ?? ""),
    sent_at_ms: Number(r.sent_at_ms) || 0,
    to_all: !!r.to_all,
    roles: Array.isArray(r.roles) ? r.roles.map(String) : [],
    method: r.method === "text" ? "text" : "email",
    subject: String(r.subject ?? ""),
    message: String(r.message ?? ""),
    recipient_count: Number(r.recipient_count) || 0,
    attempted_count: Number(r.attempted_count) || 0,
  }));
}

// ----- Roster helpers -------------------------------------------------------------------
type Member = { name: string; email: string; role: string; phone: string };

async function loadMembers(sfi_id: string, list: string | null): Promise<Member[]> {
  if (!list) return [];
  const { rows } = await table(list, sfi_id).query({ limit: 5000 });
  return rows.map((r: Record<string, unknown>) => ({
    name: typeof r.name === "string" ? r.name : String(r.name ?? ""),
    email: typeof r.email === "string" ? r.email : String(r.email ?? ""),
    role: typeof r.role === "string" ? r.role : String(r.role ?? ""),
    phone: typeof r.phone === "string" ? r.phone.trim() : "",
  })).filter((m) => m.name || m.email);
}

// Distinct roles present in the roster, with a count and whether every member in that role
// has a phone number (which is what unlocks the "Send as text" path for that audience).
type RoleInfo = { role: string; count: number; all_have_phone: boolean };

function summarizeRoles(members: Member[]): RoleInfo[] {
  const byRole = new Map<string, Member[]>();
  for (const m of members) {
    const r = m.role || "(no role)";
    if (!byRole.has(r)) byRole.set(r, []);
    byRole.get(r)!.push(m);
  }
  const out: RoleInfo[] = [];
  for (const [role, list] of byRole) {
    out.push({
      role,
      count: list.length,
      all_have_phone: list.length > 0 && list.every((m) => m.phone.length > 0),
    });
  }
  out.sort((a, b) => a.role.localeCompare(b.role, undefined, { sensitivity: "base" }));
  return out;
}

// Resolve an audience (everyone, or a set of roles) to the matching members, de-duplicated
// by email and sorted by name. Used by both the email and the text send paths.
function resolveRecipients(members: Member[], to_all: boolean, roles: string[]): Member[] {
  const roleSet = new Set(roles);
  const seen = new Set<string>();
  const out: Member[] = [];
  for (const m of members) {
    if (!to_all && !roleSet.has(m.role || "(no role)")) continue;
    const key = (m.email || m.name).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return out;
}

// Whether a non-member viewer may see this entry. Reaching the frame at all is the
// platform's call; this only decides WHAT a non-member sees, which the owner controls by
// marking specific roles public. A message qualifies when it was sent to specific role(s),
// every one of which the owner marked public. "Everyone" sends are never public — they may
// have reached private-role recipients.
function isEntryPublic(entry: SentEntry, settings: Settings): boolean {
  if (entry.to_all) return false;
  if (!entry.roles.length) return false;
  const pub = new Set(settings.public_roles);
  return entry.roles.every((r) => pub.has(r));
}

// Public/non-member projection: no sender, no tap count; the message and its audience.
function publicEntry(e: SentEntry) {
  return {
    id: e.id,
    sent_at_ms: e.sent_at_ms,
    to_all: e.to_all,
    roles: e.roles,
    method: e.method,
    subject: e.subject,
    message: e.message,
    recipient_count: e.recipient_count,
  };
}

// ----- Shared write logic ---------------------------------------------------------------
// Both entry points (HTTP arms and the bus dispatcher) land here; role gates live inside.
// Every mutation ends in a pushToInstance so all viewers — the sender included — re-render.
type WriteResult = { status: number; body: unknown };

async function handleWrite(
  op: string,
  v: Record<string, unknown> | null,
  sfiId: string,
  peer: ReturnType<typeof parsePeerInfo>,
): Promise<WriteResult> {
  const p = peer.sfi_id === sfiId ? peer : { ...peer, sfi_id: sfiId };

  // ---- Choose this session's members list (editor only) -------------------------------
  if (op === "bind") {
    if (!p.is_sfi_editor) return { status: 403, body: { error: "editors only" } };
    const name = v?.list;
    if (!validList(name)) return { status: 400, body: { error: "a members list is named members or <name>.members" } };
    await sessionKv.put("bound/members", name);
    pushToInstance(sfiId, { type: "settings_changed" });
    return { status: 200, body: { bound: name } };
  }

  // ---- Record a send into the log (editor only) ---------------------------------------
  if (op === "log") {
    if (!p.is_sfi_editor) return { status: 403, body: { error: "editors only" } };
    if (!v) return { status: 400, body: { error: "invalid JSON" } };
    const list = await boundList();
    if (!list) return { status: 409, body: { error: "no members list chosen yet" } };
    const sendMethod = v.method === "text" ? "text" : "email";
    const to_all = !!v.to_all;
    const roles = Array.isArray(v.roles) ? v.roles.map((r) => sanitizeText(r, 80)).filter(Boolean) : [];
    const message = sanitizeText(v.message, 5000);
    const subject = sendMethod === "email" ? sanitizeText(v.subject, 200) : "";
    if (!message) return { status: 400, body: { error: "message required" } };
    if (!to_all && roles.length === 0) return { status: 400, body: { error: "audience required" } };
    const recipient_count = clampInt(Number(v.recipient_count) || 0, 0, 100000);
    const attempted_count = clampInt(Number(v.attempted_count ?? recipient_count) || 0, 0, recipient_count);
    const entry = {
      list,
      sent_by: p.user_id,
      sent_by_name: sanitizeText(p.user_name, 120),
      sent_at_ms: Date.now(),
      to_all,
      roles: to_all ? [] : roles,
      method: sendMethod,
      subject,
      message,
      recipient_count,
      attempted_count,
    };
    const { row_id } = await table(SENT, sfiId).upsert(null, entry);
    pushToInstance(sfiId, { type: "log_changed" });
    return { status: 200, body: { entry: { id: row_id, ...entry } } };
  }

  // ---- Delete a logged message (editor only) ------------------------------------------
  if (op === "log/delete") {
    if (!p.is_sfi_editor) return { status: 403, body: { error: "editors only" } };
    const id = String(v?.id ?? "");
    if (!id) return { status: 400, body: { error: "id required" } };
    const sent = table(SENT, sfiId);
    const row = await sent.get(id);
    if (!row || row.list !== (await boundList())) return { status: 404, body: { error: "no such message" } };
    await sent.delete(id);
    pushToInstance(sfiId, { type: "log_changed" });
    return { status: 204, body: null };
  }

  // ---- Settings (owner only) ----------------------------------------------------------
  if (op === "settings") {
    if (!p.is_owner) return { status: 403, body: { error: "only the frame owner can change settings" } };
    if (!v) return { status: 400, body: { error: "invalid JSON" } };
    const title = sanitizeText(v.title, 80) || DEFAULT_SETTINGS.title;
    const public_roles = Array.isArray(v.public_roles)
      ? Array.from(new Set(v.public_roles.map((r) => sanitizeText(r, 80)).filter(Boolean)))
      : [];
    const next: Settings = { title, public_roles };
    await setSettings(next);
    pushToInstance(sfiId, { type: "settings_changed" });
    return { status: 200, body: { settings: next } };
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
  if (r.status >= 400) log(`member_reachout: bus op ${op} → ${r.status} (${JSON.stringify(r.body)})`);
});

// ----- HTTP handler ---------------------------------------------------------------------
self.onNetworkRequest = async function (replyPort, reqPath, method, headers, query, body, cookies) {
  const peer = parsePeerInfo(query, cookies);

  const settings = await getSettings();
  const list = await boundList();
  const isEditor = peer.is_sfi_editor;
  const isMember = peer.is_sfi_member;

  // ---- State: who am I, what can I do, what roles exist --------------------------------
  if (reqPath === "/api/state" && method === "GET") {
    let roles: RoleInfo[] = [];
    if (isMember) {
      const members = await loadMembers(peer.sfi_id, list);
      roles = summarizeRoles(members);
    }
    return jsonReply(replyPort, 200, {
      settings,
      viewer: {
        user_name: peer.user_name || "anon",
        is_owner: peer.is_owner,
        is_anon: peer.is_anon,
        is_sfi_member: isMember,
        is_sfi_editor: isEditor,
        space_color: peer.space_color || "",
      },
      can_edit: isEditor,
      bound: list,
      can_bind: isEditor,
      roles, // editors compose against this; non-members get [] (roster structure stays private)
    });
  }

  // ---- The sent-message backlog -------------------------------------------------------
  if (reqPath === "/api/log" && method === "GET") {
    const entries = list ? (await sentTo(peer.sfi_id, list)).sort((a, b) => b.sent_at_ms - a.sent_at_ms) : [];
    if (isMember) {
      return jsonReply(replyPort, 200, { entries, can_edit: isEditor });
    }
    // Anonymous / non-member: only the publicly-exposed role messages, stripped down.
    const pub = entries.filter((e) => isEntryPublic(e, settings)).map(publicEntry);
    return jsonReply(replyPort, 200, { entries: pub, anon_view: true });
  }

  // ---- Resolve an audience to concrete recipients (editor only — exposes contacts) ----
  // A read that needs its response (it builds the mailto:/sms: links), so it can't ride
  // the bus; GET carries the audience in the query string. The POST arm stays for older
  // cached frontends.
  if (reqPath === "/api/resolve" && (method === "GET" || method === "POST")) {
    if (!isEditor) return jsonReply(replyPort, 403, { error: "editors only" });
    let to_all: boolean;
    let roles: string[];
    if (method === "GET") {
      to_all = query.to_all === "1";
      let parsed: unknown = [];
      try { parsed = JSON.parse(String(query.roles ?? "[]")); } catch { parsed = []; }
      roles = Array.isArray(parsed) ? parsed.map((r) => sanitizeText(r, 80)).filter(Boolean) : [];
    } else {
      const v = parseJsonBody<{ to_all?: unknown; roles?: unknown }>(body);
      if (!v) return jsonReply(replyPort, 400, { error: "invalid JSON" });
      to_all = !!v.to_all;
      roles = Array.isArray(v.roles) ? v.roles.map((r) => sanitizeText(r, 80)).filter(Boolean) : [];
    }
    if (!to_all && roles.length === 0) return jsonReply(replyPort, 400, { error: "pick an audience" });
    const members = await loadMembers(peer.sfi_id, list);
    const recipients = resolveRecipients(members, to_all, roles).map((m) => ({
      name: m.name, email: m.email, phone: m.phone,
    }));
    const all_have_phone = recipients.length > 0 && recipients.every((r) => r.phone.length > 0);
    return jsonReply(replyPort, 200, { recipients, all_have_phone });
  }

  // ---- Record a send into the log (editor only) ---------------------------------------
  if (reqPath === "/api/log" && method === "POST") {
    const r = await handleWrite("log", parseJsonBody(body), peer.sfi_id, peer);
    return jsonReply(replyPort, r.status, r.body);
  }

  // ---- Delete a logged message (editor only) ------------------------------------------
  if (reqPath === "/api/log/delete" && method === "POST") {
    const r = await handleWrite("log/delete", parseJsonBody(body), peer.sfi_id, peer);
    if (r.status === 204) return replyPort.postMessage({ status: 204, contentType: "text/plain", body: null });
    return jsonReply(replyPort, r.status, r.body);
  }

  // ---- Settings (owner only) ----------------------------------------------------------
  if ((reqPath === "/api/settings" || reqPath === "/api/bind") && method === "POST") {
    const r = await handleWrite(reqPath.slice("/api/".length), parseJsonBody(body), peer.sfi_id, peer);
    return jsonReply(replyPort, r.status, r.body);
  }

  if (method === "GET") {
    return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url), headers);
  }

  return jsonReply(replyPort, 404, { error: "not found", path: reqPath });
};

log("Member Reachout frame is up and running.");
