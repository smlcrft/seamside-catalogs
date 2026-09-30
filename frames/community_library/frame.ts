// ----------------------------------------------------------------------------------------
// Community Library — track community-owned items (books, tools, gear) and who has them
// checked out. Two tables of the space: `library_assets` in its frame data folder
// (`_fdata/library_assets.table.jsonl`) for items + checkout info, and a `members` list —
// `members.table.jsonl` or a subtype such as `club.members.table.jsonl` — the roster Member
// Manager keeps, which this frame only reads. Each session is bound to one list (ctx.kv
// `bound/members`), chosen by an editor. The library's rules (its name, item types, loan
// lengths: the `library` row) and who may edit (the `prefs` row) are the owner's alone, so
// both are rows of this session's own `settings` table (`ctx.own`), which no door reaches:
// a table in `_fdata` is any collaborator's to write at the door, around the owner check.
//
// Anyone not on the space's roster is shown what is in and what is out, and nothing else:
// the page reads no item itself, and every route decides on ctx.peer.
// ----------------------------------------------------------------------------------------
import type { Ctx, Table } from "@frame-core";
import { declareTables, sanitizeText, toIntOrNull } from "@frame-core";

const ASSETS = "library_assets";

declareTables([
  {
    key: ASSETS,
    title: "Library Assets",
    description: "Items the community shares, with current checkout status.",
    schema: [
      { name: "name",                    col_type: "text",    nullable: false },
      { name: "item_type",               col_type: "text",    nullable: false },
      { name: "checked_out_member_id",   col_type: "text",    nullable: true  },
      { name: "checked_out_manual_name", col_type: "text",    nullable: true  },
      { name: "checked_out_at",          col_type: "integer", nullable: true  },
      { name: "borrow_days",             col_type: "integer", nullable: true  },
      { name: "needs_attention",         col_type: "integer", nullable: false, default_val: "0" },
      { name: "notes",                   col_type: "text",    nullable: true  },
    ],
  },
]);

// What a new item starts from: the schema's defaults.
const NEW_ASSET = { needs_attention: 0 };

type Row = Record<string, unknown> & { id: string };

type Rows = Table<Record<string, unknown>>;
/** The shared items; this session's own settings (a settings value is JSON under `v`); a
 *  members list. */
const assetTable = (ctx: Ctx): Rows => ctx.shared.table(ASSETS);
const settings = (ctx: Ctx): Rows => ctx.own.table("settings");
const rows = (ctx: Ctx, list: string): Rows => ctx.table(list);

/** Write a row over what it held, stamped when it was made and when it changed. */
async function keep(
  t: Rows,
  id: string | null,
  values: Record<string, unknown>,
  fresh: Record<string, unknown> = {},
): Promise<Row> {
  const was = id ? await t.get(id) : null;
  const now = Date.now();
  return await t.upsert({
    ...(was ?? { ...fresh, _created_at: now }),
    ...values,
    ...(id ? { id } : {}),
    _modified_at: now,
  });
}

// ----- Which members list: `members` or a subtype `<name>.members`, bound per session -----
// Read here for its name and role columns; Member Manager writes it.
const LIST_NAME = /^([a-z0-9][a-z0-9_-]*\.)*members$/;
const validList = (n: unknown): n is string => typeof n === "string" && n.length <= 64 && LIST_NAME.test(n);
async function boundList(ctx: Ctx): Promise<string | null> {
  const v = (await ctx.kv.get("bound/members"))?.value;
  return validList(v) ? v : null;
}

// ----- Preferences: the library's rules and who may edit, both this session's own --------
type BorrowOption = { label: string; days: number };
type Prefs = {
  org_name: string;
  item_types: string[];
  borrow_options: BorrowOption[];
  default_borrow_days: number;
  owner_only_edit: boolean;
};

const DEFAULT_PREFS: Prefs = {
  org_name: "Community Library",
  item_types: ["Book", "Tool", "Game", "Equipment", "Other"],
  borrow_options: [
    { label: "3 days",  days: 3  },
    { label: "1 week",  days: 7  },
    { label: "2 weeks", days: 14 },
    { label: "1 month", days: 30 },
  ],
  default_borrow_days: 7,
  owner_only_edit: false,
};

const LIBRARY_KEY = "library";
const PREFS_KEY = "prefs";

/** A settings row's JSON, or nothing when absent or unreadable; what it holds is checked
 *  below as it is read. */
async function stored(t: Rows, id: string): Promise<Partial<Prefs>> {
  try {
    const row = await t.get(id);
    const v = row?.v == null ? null : JSON.parse(String(row.v));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

async function getPrefs(ctx: Ctx): Promise<Prefs> {
  const library = await stored(settings(ctx), LIBRARY_KEY);
  const p: Partial<Prefs> = {
    ...(Object.keys(library).length ? library : DEFAULT_PREFS),
    owner_only_edit: (await stored(settings(ctx), PREFS_KEY)).owner_only_edit,
  };
  const itemTypes = Array.isArray(p.item_types) && p.item_types.length > 0
    ? p.item_types.map(String) : [...DEFAULT_PREFS.item_types];
  const borrowOptions = Array.isArray(p.borrow_options) && p.borrow_options.length > 0
    ? p.borrow_options
        .filter((o) => o && typeof o === "object")
        .map((o) => ({ label: String((o as BorrowOption).label ?? ""), days: Number((o as BorrowOption).days) }))
        .filter((o) => o.label && Number.isFinite(o.days) && o.days > 0)
    : [...DEFAULT_PREFS.borrow_options];
  return {
    org_name: typeof p.org_name === "string" && p.org_name ? p.org_name : DEFAULT_PREFS.org_name,
    item_types: itemTypes,
    borrow_options: borrowOptions.length > 0 ? borrowOptions : [...DEFAULT_PREFS.borrow_options],
    default_borrow_days: Number.isFinite(Number(p.default_borrow_days)) && Number(p.default_borrow_days) > 0
      ? Number(p.default_borrow_days)
      : (borrowOptions[0]?.days ?? DEFAULT_PREFS.default_borrow_days),
    owner_only_edit: !!p.owner_only_edit,
  };
}

async function setPrefs(ctx: Ctx, next: Prefs): Promise<void> {
  const { owner_only_edit, ...library } = next;
  await keep(settings(ctx), LIBRARY_KEY, { v: JSON.stringify(library) });
  await keep(settings(ctx), PREFS_KEY, { v: JSON.stringify({ owner_only_edit }) });
}

// ----- Helpers --------------------------------------------------------------------------
// Writes are editor-only. Never gate on is_sfi_member — a Viewer-role member would slip
// through and be able to edit the library.
const isEditor = (ctx: Ctx) => ctx.peer.is_sfi_editor || ctx.peer.is_owner;
function canEdit(ctx: Ctx, prefs: Prefs): boolean {
  if (prefs.owner_only_edit) return ctx.peer.is_owner;
  return isEditor(ctx);
}

type AssetStatus = "available" | "checked_out" | "overdue" | "issue";

function dueAt(checkedOutAt: number | null, borrowDays: number | null): number | null {
  if (!checkedOutAt || !borrowDays) return null;
  return checkedOutAt + borrowDays * 86400000;
}

function computeStatus(row: Row, now: number): AssetStatus {
  if (Number(row.needs_attention) === 1) return "issue";
  const checkedOutAt = toIntOrNull(row.checked_out_at);
  const borrowDays = toIntOrNull(row.borrow_days);
  if (!checkedOutAt) return "available";
  const due = dueAt(checkedOutAt, borrowDays);
  if (due !== null && now > due) return "overdue";
  return "checked_out";
}

// What changed, never what it holds: each page reads again as whoever it is.
const tell = (ctx: Ctx, what: "assets" | "settings") => ctx.push({ community_library: what });

const json = (v: unknown, status = 200) => Response.json(v, { status });
const refuse = (status: number, error: string) => json({ error }, status);
const notFound = () => json({ error: "Not found.", code: "NOT_FOUND" }, 404);

async function body(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const v = JSON.parse(await request.text());
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

// ----- Writes ---------------------------------------------------------------------------
// `op` is the API path minus the leading "/api/" ("asset", "asset/checkout", "settings", …).
async function write(ctx: Ctx, op: string, v: Record<string, unknown> | null): Promise<Response> {
  const prefs = await getPrefs(ctx);

  if (op === "bind") {
    if (!isEditor(ctx)) return refuse(403, "editors only");
    const name = v?.list;
    if (!validList(name)) return refuse(400, "a members list is named members or <name>.members");
    await ctx.kv.put("bound/members", name);
    tell(ctx, "settings");
    return json({ bound: name });
  }

  if (op === "settings") {
    if (!ctx.peer.is_owner) return refuse(403, "only the frame owner can change settings");
    if (!v) return refuse(400, "invalid JSON");
    const org_name = sanitizeText(v.org_name, 120) || DEFAULT_PREFS.org_name;
    const itemTypesIn: unknown[] = Array.isArray(v.item_types) ? v.item_types : [];
    const item_types = Array.from(new Set(itemTypesIn.map((t: unknown) => sanitizeText(t, 80)).filter((t: string) => t.length > 0)));
    if (item_types.length === 0) return refuse(400, "at least one item type is required");
    const borrowIn: unknown[] = Array.isArray(v.borrow_options) ? v.borrow_options : [];
    const borrow_options = borrowIn
      .map((o: unknown) => ({ label: sanitizeText((o as BorrowOption).label, 40), days: toIntOrNull((o as BorrowOption).days) ?? 0 }))
      .filter((o: { label: string; days: number }) => o.label.length > 0 && o.days > 0);
    if (borrow_options.length === 0) return refuse(400, "at least one borrow option is required");
    const requestedDefault = toIntOrNull(v.default_borrow_days);
    const days = borrow_options.map((o) => o.days);
    const default_borrow_days = requestedDefault && days.includes(requestedDefault) ? requestedDefault : days[0];
    const next: Prefs = {
      org_name, item_types, borrow_options, default_borrow_days,
      owner_only_edit: !!v.owner_only_edit,
    };
    await setPrefs(ctx, next);
    tell(ctx, "settings");
    return json({ prefs: next });
  }

  if (!canEdit(ctx, prefs)) return refuse(403, "editing is restricted");
  const assets = assetTable(ctx);
  // An id that names no item is refused, never created.
  const named = v?.row_id ? String(v.row_id) : "";
  if (named && !(await assets.get(named))) return refuse(404, "item not found");

  if (op === "asset") {
    if (!v) return refuse(400, "invalid JSON");
    const name = sanitizeText(v.name, 200);
    const itemType = sanitizeText(v.item_type, 80);
    const notes = sanitizeText(v.notes, 1000);
    if (!name) return refuse(400, "name required");
    if (!itemType) return refuse(400, "item_type required");
    if (!prefs.item_types.includes(itemType)) return refuse(400, "item_type not in allowed list");
    const row = await keep(assetTable(ctx), named || null, {
      name, item_type: itemType, notes,
      ...(named ? {} : { needs_attention: 0 }),
    }, NEW_ASSET);
    tell(ctx, "assets");
    return json({ row_id: row.id });
  }

  if (op === "asset/delete") {
    if (!named) return refuse(400, "row_id required");
    await assets.delete(named);
    tell(ctx, "assets");
    return new Response(null, { status: 204 });
  }

  if (op === "asset/checkout") {
    if (!v) return refuse(400, "invalid JSON");
    if (!named) return refuse(400, "row_id required");
    const memberId = sanitizeText(v.member_id, 100);
    const manualName = sanitizeText(v.manual_name, 200);
    if (!memberId && !manualName) return refuse(400, "member_id or manual_name required");
    const borrowDays = toIntOrNull(v.borrow_days) ?? prefs.default_borrow_days;
    const allowedDays = prefs.borrow_options.map((o) => o.days);
    if (!allowedDays.includes(borrowDays)) return refuse(400, "borrow_days not in allowed list");
    const checkedOutAt = toIntOrNull(v.checked_out_at) ?? Date.now();
    await keep(assetTable(ctx), named, {
      checked_out_member_id: memberId,
      checked_out_manual_name: memberId ? "" : manualName,
      checked_out_at: checkedOutAt,
      borrow_days: borrowDays,
    });
    tell(ctx, "assets");
    return json({ row_id: named });
  }

  if (op === "asset/checkin") {
    if (!named) return refuse(400, "row_id required");
    await keep(assetTable(ctx), named, {
      checked_out_member_id: "",
      checked_out_manual_name: "",
      checked_out_at: null,
      borrow_days: null,
    });
    tell(ctx, "assets");
    return json({ row_id: named });
  }

  if (op === "asset/attention") {
    if (!v) return refuse(400, "invalid JSON");
    if (!named) return refuse(400, "row_id required");
    const update: Record<string, unknown> = { needs_attention: v.needs_attention ? 1 : 0 };
    if (typeof v.notes !== "undefined") update.notes = sanitizeText(v.notes, 1000);
    await keep(assetTable(ctx), named, update);
    tell(ctx, "assets");
    return json({ row_id: named });
  }

  return notFound();
}

// ----- Reads ----------------------------------------------------------------------------
async function roster(ctx: Ctx): Promise<Row[]> {
  const list = await boundList(ctx);
  return list ? await rows(ctx, list).all() : [];
}

async function listAssets(ctx: Ctx): Promise<Response> {
  const now = Date.now();
  const all = await assetTable(ctx).all();
  all.sort((a, b) => String(a.name).localeCompare(String(b.name)));

  if (ctx.peer.is_anon) {
    // Not on the roster: name, item_type, simple status. No member identities, no notes.
    const publicRows = all.map((r) => ({
      _row_id: r.id,
      name: r.name,
      item_type: r.item_type,
      status: computeStatus(r, now),
      due_at: dueAt(toIntOrNull(r.checked_out_at), toIntOrNull(r.borrow_days)),
    }));
    return json({ rows: publicRows, anon_view: true });
  }

  // A member: full data + computed status + resolved checkout names.
  const memberById = new Map((await roster(ctx)).map((m) => [m.id, m]));
  const enriched = all.map((r) => {
    const checkedOutAt = toIntOrNull(r.checked_out_at);
    const borrowDays = toIntOrNull(r.borrow_days);
    const memberId = String(r.checked_out_member_id ?? "");
    const member = memberId ? memberById.get(memberId) : undefined;
    return {
      _row_id: r.id,
      _created_at: Number(r._created_at ?? 0),
      name: r.name,
      item_type: r.item_type,
      checked_out_member_id: memberId,
      checked_out_member_name: member ? String(member.name) : "",
      checked_out_manual_name: String(r.checked_out_manual_name ?? ""),
      checked_out_at: checkedOutAt,
      borrow_days: borrowDays,
      due_at: dueAt(checkedOutAt, borrowDays),
      needs_attention: Number(r.needs_attention) === 1,
      notes: String(r.notes ?? ""),
      status: computeStatus(r, now),
    };
  });
  return json({ rows: enriched });
}

export default {
  async fetch(request: Request, ctx: Ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    const route = `${request.method} ${pathname}`;

    if (route === "GET /api/state") {
      const prefs = await getPrefs(ctx);
      return json({
        prefs,
        viewer: {
          user_name: ctx.peer.user_name || "anon",
          is_owner: ctx.peer.is_owner,
          is_anon: ctx.peer.is_anon,
        },
        can_edit: canEdit(ctx, prefs),
        bound: await boundList(ctx),
        can_bind: isEditor(ctx),
        now: Date.now(),
      });
    }

    if (route === "GET /api/members") {
      if (ctx.peer.is_anon) return json({ rows: [] });
      const members = await roster(ctx);
      members.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return json({ rows: members.map((r) => ({ _row_id: r.id, name: r.name, role: r.role })) });
    }

    // Open to everyone who reaches the frame; listAssets decides what each is shown.
    if (route === "GET /api/assets") return listAssets(ctx);

    if (request.method === "POST" && pathname.startsWith("/api/")) {
      return write(ctx, pathname.slice("/api/".length), await body(request));
    }

    if (request.method === "GET") return ctx.file(pathname);

    if (pathname !== "/api/settings" && !canEdit(ctx, await getPrefs(ctx))) {
      return refuse(403, "editing is restricted");
    }
    return notFound();
  },
};
