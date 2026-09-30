// ----------------------------------------------------------------------------------------
// Member Reachout — send updates / notifications to the people in your roster.
//
// Contacts (name, email, role, optional phone) are a `members` list of the space —
// `members.table.jsonl` or a subtype such as `club.members.table.jsonl`, the roster Member
// Manager keeps. Each session is bound to one (ctx.kv `bound/members`), chosen by an
// editor; this frame only READS it.
//
// Every send is a row of the space's `reachout_sent` table, saying which list it went to,
// who sent it, when, to which role(s) (or everyone) and how (email or text); a session
// shows the sends to its own list. Settings (board title, which roles' messages outsiders
// may read) are this session's own: the `settings` row of `__fc_settings`, which no wire
// serves. The actual sending happens OS-side: the frontend builds a `mailto:` (all
// recipients bcc'd) or a per-person `sms:` link and asks the viewer to open it.
//
// The page reads the log and the roster's shape from the routes here, which decide on
// ctx.peer what each visitor is handed. A push says what changed and never what it holds.
// ----------------------------------------------------------------------------------------
import type { Ctx } from "@frame-core";
import { sanitizeText, clampInt } from "@frame-core";

// ----- Which members list: `members` or a subtype `<name>.members`, bound per session -----
const LIST_NAME = /^([a-z0-9][a-z0-9_-]*\.)*members$/;
const validList = (n: unknown): n is string => typeof n === "string" && n.length <= 64 && LIST_NAME.test(n);
async function boundList(ctx: Ctx): Promise<string | null> {
  const v = (await ctx.kv.get("bound/members"))?.value;
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

const SETTINGS = "__fc_settings";

/** The row stamped when it was made and when it changed. */
async function keepSettings(ctx: Ctx, v: string): Promise<void> {
  const table = ctx.table<Row>(SETTINGS);
  const was = await table.get("settings");
  const now = Date.now();
  await table.upsert({ ...(was ?? { _created_at: now }), v, id: "settings", _modified_at: now });
}

/** The stored JSON: the settings row, else what an older copy kept in the session key,
 *  which a stranger could read and a collaborator write, moved into the row once. The row
 *  is written on the first read either way, so a key written at the door later is ignored. */
async function storedSettings(ctx: Ctx): Promise<string> {
  const row = await ctx.table<Row>(SETTINGS).get("settings");
  if (row?.v != null) return String(row.v);
  const old = (await ctx.kv.get("settings"))?.value;
  const v = old ?? JSON.stringify(DEFAULT_SETTINGS);
  await keepSettings(ctx, v);
  if (old != null) await ctx.kv.del("settings");
  return v;
}

async function getSettings(ctx: Ctx): Promise<Settings> {
  let v: Partial<Settings> = {};
  try { v = JSON.parse(await storedSettings(ctx)) ?? {}; } catch { /* defaults */ }
  return {
    title: typeof v.title === "string" && v.title.trim() ? v.title : DEFAULT_SETTINGS.title,
    public_roles: Array.isArray(v.public_roles) ? v.public_roles.map(String) : [],
  };
}

async function setSettings(ctx: Ctx, next: Settings): Promise<void> {
  await keepSettings(ctx, JSON.stringify(next));
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

type Row = Record<string, unknown>;

async function sentTo(ctx: Ctx, list: string): Promise<SentEntry[]> {
  const rows = (await ctx.table<Row>(SENT).all()).filter((r) => r.list === list).slice(0, 5000);
  return rows.map((r) => ({
    id: r.id,
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

async function loadMembers(ctx: Ctx, list: string | null): Promise<Member[]> {
  if (!list) return [];
  const rows = (await ctx.table<Row>(list).all()).slice(0, 5000);
  return rows.map((r) => ({
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

// ----- Replies ---------------------------------------------------------------------------
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

// What changed, never what it holds: each page reads again as whoever it is.
const tell = (ctx: Ctx, what: "log" | "settings") => ctx.push({ member_reachout: what });

const rolesIn = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((r) => sanitizeText(r, 80)).filter(Boolean) : [];

// ----- HTTP handler ---------------------------------------------------------------------
export default {
  async fetch(request: Request, ctx: Ctx): Promise<Response> {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    const peer = ctx.peer;
    const isEditor = peer.is_sfi_editor || peer.is_owner;
    const isMember = isEditor || peer.is_sfi_member;

    // ---- State: who am I, what can I do, what roles exist --------------------------------
    if (route === "GET /api/state") {
      const list = await boundList(ctx);
      const roles = isMember ? summarizeRoles(await loadMembers(ctx, list)) : [];
      return json({
        settings: await getSettings(ctx),
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
    if (route === "GET /api/log") {
      const list = await boundList(ctx);
      const entries = list ? (await sentTo(ctx, list)).sort((a, b) => b.sent_at_ms - a.sent_at_ms) : [];
      if (isMember) return json({ entries, can_edit: isEditor });
      // Anonymous / non-member: only the publicly-exposed role messages, stripped down.
      const settings = await getSettings(ctx);
      return json({ entries: entries.filter((e) => isEntryPublic(e, settings)).map(publicEntry), anon_view: true });
    }

    // ---- Resolve an audience to concrete recipients (editor only — exposes contacts) ----
    // GET carries the audience in the query string; POST carries it as JSON.
    if (route === "GET /api/resolve" || route === "POST /api/resolve") {
      if (!isEditor) return refuse(403, "editors only");
      let to_all: boolean;
      let roles: string[];
      if (request.method === "GET") {
        to_all = url.searchParams.get("to_all") === "1";
        let parsed: unknown = [];
        try { parsed = JSON.parse(url.searchParams.get("roles") ?? "[]"); } catch { parsed = []; }
        roles = rolesIn(parsed);
      } else {
        const v = await body(request);
        if (!v) return refuse(400, "invalid JSON");
        to_all = !!v.to_all;
        roles = rolesIn(v.roles);
      }
      if (!to_all && roles.length === 0) return refuse(400, "pick an audience");
      const members = await loadMembers(ctx, await boundList(ctx));
      const recipients = resolveRecipients(members, to_all, roles).map((m) => ({
        name: m.name, email: m.email, phone: m.phone,
      }));
      const all_have_phone = recipients.length > 0 && recipients.every((r) => r.phone.length > 0);
      return json({ recipients, all_have_phone });
    }

    // ---- Choose this session's members list (editor only) -------------------------------
    if (route === "POST /api/bind") {
      if (!isEditor) return refuse(403, "editors only");
      const name = (await body(request))?.list;
      if (!validList(name)) return refuse(400, "a members list is named members or <name>.members");
      await ctx.kv.put("bound/members", name);
      tell(ctx, "settings");
      return json({ bound: name });
    }

    // ---- Record a send into the log (editor only) ---------------------------------------
    if (route === "POST /api/log") {
      if (!isEditor) return refuse(403, "editors only");
      const v = await body(request);
      if (!v) return refuse(400, "invalid JSON");
      const list = await boundList(ctx);
      if (!list) return refuse(409, "no members list chosen yet");
      const sendMethod = v.method === "text" ? "text" : "email";
      const to_all = !!v.to_all;
      const roles = rolesIn(v.roles);
      const message = sanitizeText(v.message, 5000);
      const subject = sendMethod === "email" ? sanitizeText(v.subject, 200) : "";
      if (!message) return refuse(400, "message required");
      if (!to_all && roles.length === 0) return refuse(400, "audience required");
      const recipient_count = clampInt(Number(v.recipient_count) || 0, 0, 100000);
      const attempted_count = clampInt(Number(v.attempted_count ?? recipient_count) || 0, 0, recipient_count);
      const entry = {
        list,
        sent_by: peer.user_id,
        sent_by_name: sanitizeText(peer.user_name, 120),
        sent_at_ms: Date.now(),
        to_all,
        roles: to_all ? [] : roles,
        method: sendMethod,
        subject,
        message,
        recipient_count,
        attempted_count,
      };
      const now = Date.now();
      const row = await ctx.table<Row>(SENT).upsert({ _created_at: now, ...entry, _modified_at: now });
      tell(ctx, "log");
      return json({ entry: { id: row.id, ...entry } });
    }

    // ---- Delete a logged message (editor only) ------------------------------------------
    if (route === "POST /api/log/delete") {
      if (!isEditor) return refuse(403, "editors only");
      const id = String((await body(request))?.id ?? "");
      if (!id) return refuse(400, "id required");
      const sent = ctx.table<Row>(SENT);
      const row = await sent.get(id);
      if (!row || row.list !== (await boundList(ctx))) return refuse(404, "no such message");
      await sent.delete(id);
      tell(ctx, "log");
      return new Response(null, { status: 204 });
    }

    // ---- Settings (owner only) ----------------------------------------------------------
    if (route === "POST /api/settings") {
      if (!peer.is_owner) return refuse(403, "only the frame owner can change settings");
      const v = await body(request);
      if (!v) return refuse(400, "invalid JSON");
      const title = sanitizeText(v.title, 80) || DEFAULT_SETTINGS.title;
      const next: Settings = { title, public_roles: Array.from(new Set(rolesIn(v.public_roles))) };
      await setSettings(ctx, next);
      tell(ctx, "settings");
      return json({ settings: next });
    }

    if (request.method === "GET") return ctx.file(url.pathname);

    return json({ error: "not found", path: url.pathname }, 404);
  },
};
