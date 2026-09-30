// ----------------------------------------------------------------------------------------
// Member Manager — view and manage people and their roles within an organization.
//
// The roster is a `members` list of the space: `members.table.jsonl`, or a subtype such as
// `club.members.table.jsonl` when a space keeps more than one. Each session is bound to one
// (ctx.kv `bound/members`), chosen by an editor. It is a shared contract: Community
// Library, Member Reachout and Garden Planner, bound to the same list, read the same rows.
// Columns: name, email, phone (optional), role. Preferences (org name, role list, owner-only
// edit) are this session's own: the `prefs` row of its own `settings` table (`ctx.own`),
// which no wire serves.
//
// Who is shown what is decided here, on ctx.peer: a member of the space reads the roster
// with its contact details, anyone else names and roles only.
// ----------------------------------------------------------------------------------------
import type { Ctx, Table } from "@frame-core";
import { sanitizeText } from "@frame-core";

// ----- Which list: `members` or a subtype `<name>.members`, bound per session -------------
const LIST_NAME = /^([a-z0-9][a-z0-9_-]*\.)*members$/;
const validList = (n: unknown): n is string => typeof n === "string" && n.length <= 64 && LIST_NAME.test(n);
async function boundList(ctx: Ctx): Promise<string | null> {
  const v = (await ctx.kv.get("bound/members"))?.value;
  return validList(v) ? v : null;
}

// ----- Preferences (this session's own) ---------------------------------------------------
const settings = (ctx: Ctx) => ctx.own.table<Record<string, unknown>>("settings");

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

async function getPrefs(ctx: Ctx): Promise<Prefs> {
  let p: Partial<Prefs> = {};
  try { p = JSON.parse(String((await settings(ctx).get("prefs"))?.v ?? "{}")) ?? {}; } catch { /* defaults */ }
  return {
    org_name: typeof p.org_name === "string" && p.org_name ? p.org_name : DEFAULT_PREFS.org_name,
    roles: Array.isArray(p.roles) && p.roles.length > 0 ? p.roles.map(String) : [...DEFAULT_PREFS.roles],
    owner_only_edit: !!p.owner_only_edit,
  };
}

async function setPrefs(ctx: Ctx, next: Prefs): Promise<void> {
  await keep(settings(ctx), "prefs", { v: JSON.stringify(next) });
}

// ----- Helpers --------------------------------------------------------------------------
// Writes are editor-only. Never gate on is_sfi_member — a Viewer-role member would slip
// through and be able to edit the roster.
function canEdit(ctx: Ctx, prefs: Prefs): boolean {
  if (prefs.owner_only_edit) return ctx.peer.is_owner;
  return ctx.peer.is_sfi_editor;
}

type Row = Record<string, unknown> & { id: string };

const rows = (ctx: Ctx, list: string) => ctx.table<Record<string, unknown>>(list);

/** Write a row over what it held, stamped when it was made and when it changed. */
async function keep(t: Table<Record<string, unknown>>, id: string | null, values: Record<string, unknown>): Promise<Row> {
  const was = id ? await t.get(id) : null;
  const now = Date.now();
  return await t.upsert({
    ...(was ?? { _created_at: now }),
    ...values,
    ...(id ? { id } : {}),
    _modified_at: now,
  });
}

/** A row as the page is sent it: the id under the names it has always had. */
function sent(row: Row): Record<string, unknown> {
  const { id, ...fields } = row;
  return {
    ...fields,
    row_id: id,
    _row_id: id,
    _created_at: Number(fields._created_at ?? 0),
    _modified_at: Number(fields._modified_at ?? 0),
  };
}

// What changed, never what it holds: each page reads again as whoever it is. Only this
// session's pages hear it; member pages also watch the bound table itself, which other
// frames write.
const tell = (ctx: Ctx, what: "members" | "settings") => ctx.push({ member_manager: what });

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

// ----- Writes: the role gates live inside -------------------------------------------------
async function write(ctx: Ctx, op: string, v: Record<string, unknown> | null): Promise<Response> {
  const prefs = await getPrefs(ctx);

  if (op === "bind") {
    if (!ctx.peer.is_sfi_editor) return refuse(403, "editors only");
    const name = v?.list;
    if (!validList(name)) return refuse(400, "a members list is named members or <name>.members");
    await ctx.kv.put("bound/members", name);
    tell(ctx, "settings");
    return json({ bound: name });
  }

  if (op === "settings") {
    // Settings can always be edited by the owner; non-owners get blocked here regardless of owner_only_edit.
    if (!ctx.peer.is_owner) return refuse(403, "only the frame owner can change settings");
    if (!v) return refuse(400, "invalid JSON");
    const org_name = sanitizeText(v.org_name, 120) || DEFAULT_PREFS.org_name;
    const rolesIn: unknown[] = Array.isArray(v.roles) ? v.roles : [];
    const roles = Array.from(new Set(rolesIn.map((r: unknown) => sanitizeText(r, 80)).filter((r: string) => r.length > 0)));
    if (roles.length === 0) return refuse(400, "at least one role is required");
    const next: Prefs = {
      org_name,
      roles,
      owner_only_edit: !!v.owner_only_edit,
    };
    await setPrefs(ctx, next);
    tell(ctx, "settings");
    return json({ prefs: next });
  }

  const list = await boundList(ctx);
  if (!list) return refuse(409, "no members list chosen yet");
  const denied = prefs.owner_only_edit ? "editing is restricted to the frame owner" : "editors only";

  if (op === "member") {
    if (!canEdit(ctx, prefs)) return refuse(403, denied);
    if (!v) return refuse(400, "invalid JSON");
    const name = sanitizeText(v.name, 120);
    const email = sanitizeText(v.email, 200);
    const phone = sanitizeText(v.phone, 40); // optional
    const role = sanitizeText(v.role, 80);
    if (!name) return refuse(400, "name required");
    if (!email) return refuse(400, "email required");
    if (!role) return refuse(400, "role required");
    if (!prefs.roles.includes(role)) return refuse(400, "role not in allowed list");
    const rowId = v.row_id ? String(v.row_id) : null;
    // An id that names no row is refused, never created.
    if (rowId && !(await rows(ctx, list).get(rowId))) return refuse(404, "member not found");
    const row = await keep(rows(ctx, list), rowId, { name, email, phone, role });
    tell(ctx, "members");
    return json({ row_id: row.id });
  }

  if (op === "member/delete") {
    if (!canEdit(ctx, prefs)) return refuse(403, denied);
    const rowId = String(v?.row_id ?? "");
    if (!rowId) return refuse(400, "row_id required");
    await rows(ctx, list).delete(rowId);
    tell(ctx, "members");
    return new Response(null, { status: 204 });
  }

  return refuse(404, "unknown op");
}

// ----- Requests -------------------------------------------------------------------------
export default {
  async fetch(request: Request, ctx: Ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    const route = `${request.method} ${pathname}`;
    const peer = ctx.peer;

    if (route === "GET /api/state") {
      const prefs = await getPrefs(ctx);
      return json({
        prefs,
        viewer: {
          user_name: peer.user_name || "anon",
          is_owner: peer.is_owner,
          is_anon: peer.is_anon,
        },
        can_edit: canEdit(ctx, prefs),
        bound: await boundList(ctx),
        can_bind: peer.is_sfi_editor,
        has_phone: true,
      });
    }

    // Open to every viewer who reaches the frame. Anyone not on the space's roster
    // (`is_anon`) gets a reduced projection below (name + role only, no email or phone).
    if (route === "GET /api/members") {
      const list = await boundList(ctx);
      if (!list) return json({ rows: [], anon_view: peer.is_anon });
      const prefs = await getPrefs(ctx);
      const all = (await rows(ctx, list).all()).slice(0, 1000);
      // Group by role (in the configured role order), then alphabetically by name
      // within each role. Legacy/unknown roles sort to the end, then by name.
      const roleRank = new Map(prefs.roles.map((r, i) => [r, i]));
      const rankOf = (role: unknown) => roleRank.has(String(role)) ? roleRank.get(String(role))! : Number.MAX_SAFE_INTEGER;
      all.sort((a, b) => {
        const ra = rankOf(a.role), rb = rankOf(b.role);
        if (ra !== rb) return ra - rb;
        return String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base" });
      });
      if (peer.is_anon) {
        // Public read-only view: name + role only — strip email and any other fields.
        return json({ rows: all.map((r) => ({ _row_id: r.id, name: r.name, role: r.role })), anon_view: true });
      }
      return json({ rows: all.map(sent) });
    }

    if (route === "POST /api/member" || route === "POST /api/member/delete" ||
        route === "POST /api/settings" || route === "POST /api/bind") {
      return write(ctx, pathname.slice("/api/".length), await body(request));
    }

    if (request.method === "GET") return ctx.file(pathname);

    return json({ error: "Not found.", code: "NOT_FOUND" }, 404);
  },
};
