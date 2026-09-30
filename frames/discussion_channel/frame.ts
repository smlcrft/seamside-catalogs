// ----------------------------------------------------------------------------------------
// Discussion Channel — a realtime chat channel for a space.
//
// Auth model:
//   - Editors (collaborator and up) chat, react, and delete their own messages; the owner
//     can also delete anyone's, rename the channel and flip the viewers toggle.
//   - `public_to_space_viewers` (owner-only, off by default): when on, Viewer-role members
//     of the space participate like editors — chat, react, delete their own.
//       canParticipate = isSfiEditor OR (publicToSpaceViewers AND isSfiMember)
//     Every write requires canParticipate, decided here on ctx.peer.
//   - Everyone else who reaches the frame — viewers while the toggle is off, and anyone
//     the frame is published to — reads the channel live, through GET /api/state.
//   - Messages and reactions are the space's tables, discussion_messages and
//     discussion_reactions, synced with the space; the title is a settings row.
//
// Realtime: a push says what changed and never what it holds. Every open page of the
// frame hears it and reads the channel again as whoever it is.
// ----------------------------------------------------------------------------------------
import type { Ctx, FrameTableDecl } from "@frame-core";
import { declareTables, sanitizeText } from "@frame-core";

const MESSAGES = "discussion_messages";
const REACTIONS = "discussion_reactions";
// Settings are rows of a store every frame in the space shares, so the keys carry this
// frame's name. Each value is JSON under `v`.
const SETTINGS = "__fc_settings";

// ----------------------------------------------------------------------------------------
// THE SPACE'S TABLES — named for this frame, so no other frame's rows land in them
// ----------------------------------------------------------------------------------------
const TABLES: FrameTableDecl[] = [
  {
    key: MESSAGES,
    title: "Channel Messages",
    description: "Messages in this space's discussion channel.",
    schema: [
      { name: "user_id",    col_type: "text",    nullable: false, default_val: "" },
      { name: "user_name",  col_type: "text",    nullable: false, default_val: "" },
      { name: "body",       col_type: "text",    nullable: false, default_val: "" },
      { name: "created_at", col_type: "integer", nullable: false, default_val: "0" },
    ],
  },
  {
    key: REACTIONS,
    title: "Channel Reactions",
    description: "Per-user reaction icons on messages.",
    schema: [
      { name: "message_id", col_type: "text",    nullable: false, default_val: "" },
      { name: "user_id",    col_type: "text",    nullable: false, default_val: "" },
      { name: "user_name",  col_type: "text",    nullable: false, default_val: "" },
      { name: "icon",       col_type: "text",    nullable: false, default_val: "" },
      { name: "created_at", col_type: "integer", nullable: false, default_val: "0" },
    ],
  },
];
declareTables(TABLES);

// ----------------------------------------------------------------------------------------
// HELPERS
// ----------------------------------------------------------------------------------------
type Row = Record<string, unknown> & { id: string };

const rows = (ctx: Ctx, name: string) => ctx.table<Record<string, unknown>>(name);

/** What a new row of a table starts from: the defaults its schema declares. */
function defaults(name: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of TABLES.find((t) => t.key === name)?.schema ?? []) {
    if (c.default_val === undefined) continue;
    out[c.name] = c.col_type === "integer" || c.col_type === "real" ? Number(c.default_val) : c.default_val;
  }
  return out;
}

/** Write a row over what it held, stamped when it was made and when it changed. */
async function keep(ctx: Ctx, name: string, id: string | null, values: Record<string, unknown>): Promise<Row> {
  const was = id ? await rows(ctx, name).get(id) : null;
  const now = Date.now();
  return await rows(ctx, name).upsert({
    ...(was ?? { ...defaults(name), _created_at: now }),
    ...values,
    ...(id ? { id } : {}),
    _modified_at: now,
  });
}

/** Order by these columns, each ascending. */
function by(...cols: string[]) {
  return (a: Row, b: Row) => {
    for (const c of cols) {
      const x = a[c], y = b[c];
      const d = typeof x === "number" && typeof y === "number" ? x - y : String(x ?? "").localeCompare(String(y ?? ""));
      if (d) return d;
    }
    return 0;
  };
}

async function setting<T>(ctx: Ctx, key: string): Promise<T | null> {
  const row = await rows(ctx, SETTINGS).get(key);
  if (row?.v == null) return null;
  try {
    return JSON.parse(String(row.v)) as T;
  } catch {
    return null;
  }
}

const setSetting = (ctx: Ctx, key: string, value: unknown) => keep(ctx, SETTINGS, key, { v: JSON.stringify(value) });

// What changed, never what it holds: each page reads again as whoever it is.
const tell = (ctx: Ctx, what: "messages" | "prefs") => ctx.push({ discussion_channel: what });

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

// ----------------------------------------------------------------------------------------
// PREFS (channel name, viewers toggle)
// ----------------------------------------------------------------------------------------
type Prefs = { title: string; public_to_space_viewers: boolean };
const DEFAULT_PREFS: Prefs = { title: "Discussion", public_to_space_viewers: false };

async function getPrefs(ctx: Ctx): Promise<Prefs> {
  const title = await setting<string>(ctx, "discussion_title");
  const viewers = await setting<boolean>(ctx, "discussion_viewers_participate");
  return { title: title || DEFAULT_PREFS.title, public_to_space_viewers: viewers === true };
}
async function setPrefs(ctx: Ctx, next: Prefs): Promise<void> {
  await setSetting(ctx, "discussion_title", next.title);
  await setSetting(ctx, "discussion_viewers_participate", next.public_to_space_viewers);
}

function canParticipate(peer: Ctx["peer"], prefs: Prefs): boolean {
  return peer.is_sfi_editor || (prefs.public_to_space_viewers && peer.is_sfi_member);
}

// Curated allow-list of Phosphor Light icons used as reactions.
const REACTION_ICONS = [
  "thumbs-up", "heart", "fire", "smiley", "hand-waving",
  "sparkle", "lightning", "rocket", "confetti", "star",
] as const;
const REACTION_ICON_SET = new Set<string>(REACTION_ICONS);

const HISTORY_LIMIT = 200;

// ----------------------------------------------------------------------------------------
// QUERIES
// ----------------------------------------------------------------------------------------
async function reactionsOf(ctx: Ctx, messageId?: string): Promise<Row[]> {
  return (await rows(ctx, REACTIONS).all())
    .filter((r) => messageId === undefined || r.message_id === messageId)
    .sort(by("created_at", "_created_at"));
}

async function listMessages(ctx: Ctx) {
  const msgs = (await rows(ctx, MESSAGES).all()).sort(by("created_at", "_created_at")).slice(0, HISTORY_LIMIT);
  if (msgs.length === 0) return [];
  const byMsg = new Map<string, Array<{ user_id: unknown; user_name: unknown; icon: unknown }>>();
  for (const r of await reactionsOf(ctx)) {
    let bucket = byMsg.get(r.message_id as string);
    if (!bucket) { bucket = []; byMsg.set(r.message_id as string, bucket); }
    bucket.push({ user_id: r.user_id, user_name: r.user_name, icon: r.icon });
  }
  return msgs.map((m) => ({
    id: m.id, user_id: m.user_id, user_name: m.user_name,
    body: m.body, created_at: m.created_at,
    reactions: byMsg.get(m.id) ?? [],
  }));
}

// ----------------------------------------------------------------------------------------
// WRITES — `op` is the API path with the leading "/api/" stripped.
// ----------------------------------------------------------------------------------------
async function handleWrite(ctx: Ctx, op: string, v: Record<string, unknown> | null): Promise<Response> {
  const peer = ctx.peer;

  // Every write requires canParticipate (see header) — readers get one uniform 403 here
  // instead of per-op checks.
  const current = await getPrefs(ctx);
  if (!canParticipate(peer, current)) return refuse(403, "read-only access");

  if (op === "send") {
    const text = sanitizeText(v?.body, 4000);
    if (!text) return refuse(400, "body required");
    const userName = sanitizeText(peer.user_name, 80) || "user";
    const row = await keep(ctx, MESSAGES, null, {
      user_id: peer.user_id, user_name: userName, body: text, created_at: Date.now(),
    });
    tell(ctx, "messages");
    return json({ ok: true, id: row.id });
  }

  if (op === "delete") {
    const id = typeof v?.id === "string" ? v.id : "";
    if (!id) return refuse(400, "id required");
    const row = await rows(ctx, MESSAGES).get(id);
    if (!row) return refuse(404, "not found");
    if (!peer.is_owner && row.user_id !== peer.user_id) return refuse(403, "forbidden");
    for (const r of await reactionsOf(ctx, id)) await rows(ctx, REACTIONS).delete(r.id);
    await rows(ctx, MESSAGES).delete(id);
    tell(ctx, "messages");
    return json({ ok: true });
  }

  // Toggle a reaction: remove if this user already reacted with this icon, otherwise add.
  if (op === "react") {
    const mid = typeof v?.message_id === "string" ? v.message_id : "";
    const icon = sanitizeText(v?.icon, 40);
    if (!mid || !icon || !REACTION_ICON_SET.has(icon)) return refuse(400, "invalid");
    if (!(await rows(ctx, MESSAGES).get(mid))) return refuse(404, "not found");
    const userName = sanitizeText(peer.user_name, 80) || "user";
    // One reaction row per (message, user, icon), keyed by a stable id — toggling is
    // get→delete/upsert on that id, so concurrent taps can't fork it into duplicates.
    const rxId = `${mid}:${peer.user_id}:${icon}`;
    if (await rows(ctx, REACTIONS).get(rxId)) {
      await rows(ctx, REACTIONS).delete(rxId);
    } else {
      await keep(ctx, REACTIONS, rxId, {
        message_id: mid, user_id: peer.user_id, user_name: userName,
        icon, created_at: Date.now(),
      });
    }
    tell(ctx, "messages");
    return json({ ok: true });
  }

  // Owner-only: the channel's name and the viewers toggle (it decides who writes).
  if (op === "settings") {
    if (!peer.is_owner) return refuse(403, "owner only");
    const next: Prefs = {
      title: sanitizeText(v?.title, 80) || current.title,
      public_to_space_viewers: v?.public_to_space_viewers !== undefined
        ? v.public_to_space_viewers === true : current.public_to_space_viewers,
    };
    await setPrefs(ctx, next);
    tell(ctx, "prefs");
    return json({ ok: true, prefs: next });
  }

  return refuse(404, "unknown op");
}

// ----------------------------------------------------------------------------------------
// HANDLER
// ----------------------------------------------------------------------------------------
export default {
  async fetch(request: Request, ctx: Ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    const { method } = request;
    if (!pathname.startsWith("/api/")) {
      if (method !== "GET") return json({ error: "Not found.", code: "NOT_FOUND" }, 404);
      return ctx.file(pathname);
    }

    if (pathname === "/api/state" && method === "GET") {
      const peer = ctx.peer;
      const prefs = await getPrefs(ctx);
      return json({
        prefs,
        messages: await listMessages(ctx),
        reaction_icons: REACTION_ICONS,
        can_edit_settings: peer.is_owner,
        can_participate: canParticipate(peer, prefs),
        me: { user_id: peer.user_id, user_name: peer.user_name, is_owner: peer.is_owner },
        color: peer.space_color,
      });
    }

    if (method === "POST") {
      const op = pathname.slice("/api/".length);
      if (op === "send" || op === "delete" || op === "react" || op === "settings") {
        return handleWrite(ctx, op, await body(request));
      }
    }
    return json({ error: "Not found.", code: "NOT_FOUND" }, 404);
  },
};
