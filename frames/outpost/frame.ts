// ----------------------------------------------------------------------------------------
// Outpost — a lightweight public posting board, one per session of the frame.
//
// Members (editors) publish short posts to share with the world; anyone with the frame's
// share link can read them. A post carries the author's name, the moment it was shared,
// free text (with auto-clickable URLs handled frontend-side), an optional light "kind"
// (thought / question / status / announcement), optional attached media (image / audio /
// video / file), and an optional brief poll that any signed-in reader may vote in.
//
// The feed is served in reverse-chronological pages (newest first) via a keyset cursor on
// created_ms, so a long-running community's board stays cheap to load and scroll.
//
// Who may do what, decided here on ctx.peer (the page reads no table and writes no row):
//   - anyone: reads the feed, its media and live poll results.
//   - anyone signed in (any role, or a visitor not on the roster): votes in polls.
//   - editors (collaborator and up; the owner alone when the owner says so): post.
//   - the owner, or the editor who wrote it: deletes a post.
//   - the owner: sets the heading, tagline and who may post.
//
// Posts, media rows and votes are the space's tables (outpost_posts / outpost_media /
// outpost_votes). Attached media are files of the space under Outpost/<post_id>/, served
// by this worker to everyone who reads the board. Settings are rows of __fc_settings.
// Every write pushes what to read again; each open page reads again as whoever it is.
// ----------------------------------------------------------------------------------------
import type { Ctx, FrameTableDecl, PeerInfo } from "@frame-core";
import { clampInt, declareTables, sanitizeText, toIntOrNull } from "@frame-core";

// ----- Shapes ---------------------------------------------------------------------------
type Kind = "thought" | "question" | "status" | "announcement";
const KINDS: Kind[] = ["thought", "question", "status", "announcement"];

type Prefs = {
  title: string;                       // heading shown at the top of the outpost
  tagline: string;                     // one-line description under the heading
  who_can_post: "owner" | "editors";   // who may publish
};
const DEFAULT_PREFS: Prefs = { title: "Outpost", tagline: "", who_can_post: "editors" };

type Row = Record<string, unknown> & { id: string };
// A post as read back from the table (poll_options is a JSON string or null).
type PostRow = {
  id: string; author: string; author_user_id: string; created_ms: number;
  kind: string; text: string; poll_options: string | null;
};
type MediaRow = { id: string; post_id: string; name: string; mime: string; size: number; path: string };

// ----- Limits ---------------------------------------------------------------------------
const MAX_TEXT = 4000;
const MAX_TAGLINE = 160;
const MAX_TITLE = 80;
const MAX_MEDIA_PER_POST = 6;
const MAX_MEDIA_MB = 8;    // a request body, and a file a worker writes, is at most 8 MiB
const MAX_POLL_OPTIONS = 6;
const MIN_POLL_OPTIONS = 2;
const MAX_OPTION_LEN = 120;
const DEFAULT_PAGE = 15;   // posts per feed page
const MAX_PAGE = 50;

// ----- Media files: Outpost/<post_id>/<name>, files of the space; the media row names it --
const FOLDER = "Outpost";
function postDir(postId: string): string {
  return `${FOLDER}/${postId}`;
}

// ----- The space's tables (named for this frame, so no other frame's rows land in them) --
const POSTS = "outpost_posts";
const MEDIA = "outpost_media";
const VOTES = "outpost_votes";
// Every frame in the space shares this store, so the keys carry this frame's name.
const SETTINGS = "__fc_settings";

const TABLES: FrameTableDecl[] = [
  {
    key: POSTS,
    title: "Outpost Posts",
    description: "Published posts for this outpost, newest first.",
    schema: [
      { name: "author",         col_type: "text",    nullable: false, default_val: "" },
      { name: "author_user_id", col_type: "text",    nullable: false, default_val: "" },
      { name: "created_ms",     col_type: "integer", nullable: false, default_val: "0" },
      { name: "kind",           col_type: "text",    nullable: false, default_val: "thought" },
      { name: "text",           col_type: "text",    nullable: false, default_val: "" },
      { name: "poll_options",   col_type: "text",    nullable: true },  // JSON array of strings, or null if not a poll
    ],
  },
  {
    key: MEDIA,
    title: "Outpost Media",
    description: "Attached media; `path` is the file in the space (Outpost/<post_id>/<name>).",
    schema: [
      { name: "post_id", col_type: "text",    nullable: false, default_val: "" },
      { name: "name",    col_type: "text",    nullable: false, default_val: "" },
      { name: "mime",    col_type: "text",    nullable: false, default_val: "" },
      { name: "size",    col_type: "integer", nullable: false, default_val: "0" },
      { name: "ord",     col_type: "integer", nullable: false, default_val: "0" },
      { name: "path",    col_type: "text",    nullable: false, default_val: "" },
    ],
  },
  {
    key: VOTES,
    title: "Outpost Votes",
    description: "One poll vote per (post, voter); re-voting replaces the choice.",
    schema: [
      { name: "post_id", col_type: "text",    nullable: false, default_val: "" },
      { name: "voter",   col_type: "text",    nullable: false, default_val: "" },
      { name: "choice",  col_type: "integer", nullable: false, default_val: "0" },
    ],
  },
];
declareTables(TABLES);

// ----- Rows -----------------------------------------------------------------------------
const rows = (ctx: Ctx, name: string) => ctx.table<Record<string, unknown>>(name);

/** The defaults a new row of `name` starts from, as the schema declares them. */
function defaultsOf(name: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of TABLES.find((t) => t.key === name)?.schema ?? []) {
    if (c.default_val === undefined) continue;
    out[c.name] = c.col_type === "integer" || c.col_type === "real" ? Number(c.default_val) : c.default_val;
  }
  return out;
}

/** Write a row over what it held (a new one over the schema's defaults), stamped when it
 *  was made and when it changed. */
async function keep(ctx: Ctx, name: string, id: string | null, values: Record<string, unknown>): Promise<Row> {
  const was = id ? await rows(ctx, name).get(id) : null;
  const now = Date.now();
  return await rows(ctx, name).upsert({
    ...(was ?? { ...defaultsOf(name), _created_at: now }),
    ...values,
    ...(id ? { id } : {}),
    _modified_at: now,
  });
}

/** Order by these columns, each ascending; `-name` descends. */
function by(...cols: string[]) {
  return (a: Row, b: Row) => {
    for (const c of cols) {
      const [name, dir] = c.startsWith("-") ? [c.slice(1), -1] : [c, 1];
      const x = a[name], y = b[name];
      const d = typeof x === "number" && typeof y === "number" ? x - y : String(x ?? "").localeCompare(String(y ?? ""));
      if (d) return dir * d;
    }
    return 0;
  };
}

// ----- Settings -------------------------------------------------------------------------
async function setting<T>(ctx: Ctx, key: string): Promise<T | null> {
  const row = await rows(ctx, SETTINGS).get(key);
  if (row?.v == null) return null;
  try { return JSON.parse(String(row.v)) as T; } catch { return null; }
}
const setSetting = (ctx: Ctx, key: string, value: unknown) => keep(ctx, SETTINGS, key, { v: JSON.stringify(value) });

async function getPrefs(ctx: Ctx): Promise<Prefs> {
  const [title, tagline, who] = await Promise.all([
    setting<string>(ctx, "outpost_title"),
    setting<string>(ctx, "outpost_tagline"),
    setting<string>(ctx, "outpost_who_can_post"),
  ]);
  return {
    title: title || DEFAULT_PREFS.title,
    tagline: tagline ?? "",
    who_can_post: who === "owner" ? "owner" : "editors",
  };
}

async function setPrefs(ctx: Ctx, next: Prefs): Promise<void> {
  await Promise.all([
    setSetting(ctx, "outpost_title", next.title),
    setSetting(ctx, "outpost_tagline", next.tagline),
    setSetting(ctx, "outpost_who_can_post", next.who_can_post),
  ]);
}

function rowToPost(r: Row): PostRow {
  return {
    id: r.id, author: String(r.author ?? ""), author_user_id: String(r.author_user_id ?? ""),
    created_ms: Number(r.created_ms) || 0, kind: String(r.kind ?? ""), text: String(r.text ?? ""),
    poll_options: (r.poll_options as string | null) ?? null,
  };
}

// ----- Ids / validation -----------------------------------------------------------------
const ID_RE = /^[0-9a-zA-Z-]{8,64}$/;  // row ids are base36 time + random
function isMediaKind(mime: string): { image: boolean; video: boolean; audio: boolean } {
  return { image: mime.startsWith("image/"), video: mime.startsWith("video/"), audio: mime.startsWith("audio/") };
}
function safeName(raw: unknown): string {
  let n = String(raw ?? "").split(/[\\/]/).pop() || "";
  n = n.replace(/[\x00-\x1f]/g, "").replace(/^\.+/, "").trim();
  if (n.length > 200) n = n.slice(0, 200);
  return n || "file";
}

// ----- Permission predicates ------------------------------------------------------------
function canPost(peer: PeerInfo, prefs: Prefs): boolean {
  return prefs.who_can_post === "owner" ? peer.is_owner : peer.is_sfi_editor;
}
function canDeletePost(peer: PeerInfo, authorUserId: string): boolean {
  return peer.is_owner || (peer.is_sfi_editor && !!peer.user_id && authorUserId === peer.user_id);
}
// Poll voting is for anyone who signed in — any role, or a visitor not on the roster
// (`is_anon` means "not on the roster"; `user_id` is set once someone signs in).
// Nobody-named readers see live results only. A voter is identified by their user_id.
function voterId(peer: PeerInfo): string {
  return peer.user_id ? "u:" + peer.user_id : "";
}
function canVote(peer: PeerInfo): boolean {
  return voterId(peer) !== "";
}

// ----- Public projection ----------------------------------------------------------------
function publicMedia(m: MediaRow) {
  const k = isMediaKind(m.mime);
  return { id: m.id, name: m.name, mime: m.mime, size: m.size, is_image: k.image, is_video: k.video, is_audio: k.audio };
}

async function mediaOf(ctx: Ctx, ids: Set<string>): Promise<Row[]> {
  return (await rows(ctx, MEDIA).all()).filter((r) => ids.has(String(r.post_id))).sort(by("post_id", "ord"));
}

// Project a set of post rows into the public shape, with media and votes for just these ids.
async function projectPosts(ctx: Ctx, list: PostRow[], vkey: string) {
  if (!list.length) return [];
  const ids = new Set(list.map((r) => r.id));

  const mediaByPost = new Map<string, MediaRow[]>();
  for (const r of await mediaOf(ctx, ids)) {
    const m: MediaRow = { id: r.id, post_id: String(r.post_id), name: String(r.name ?? ""), mime: String(r.mime ?? ""), size: Number(r.size) || 0, path: String(r.path ?? "") };
    (mediaByPost.get(m.post_id) ?? mediaByPost.set(m.post_id, []).get(m.post_id)!).push(m);
  }
  // Poll tallies per (post, choice), and this voter's own choice.
  const countsByPost = new Map<string, Map<number, number>>();
  const myByPost = new Map<string, number>();
  for (const v of await rows(ctx, VOTES).all()) {
    const pid = String(v.post_id);
    if (!ids.has(pid)) continue;
    const cm = countsByPost.get(pid) ?? countsByPost.set(pid, new Map()).get(pid)!;
    cm.set(Number(v.choice), (cm.get(Number(v.choice)) || 0) + 1);
    if (vkey && v.voter === vkey) myByPost.set(pid, Number(v.choice));
  }

  return list.map((p) => {
    let poll = null;
    if (p.poll_options) {
      let options: string[] = [];
      try { options = JSON.parse(p.poll_options); } catch { /* corrupt — treat as no poll */ }
      if (Array.isArray(options) && options.length) {
        const cm = countsByPost.get(p.id) || new Map<number, number>();
        const counts = options.map((_, i) => cm.get(i) || 0);
        const total = counts.reduce((a, b) => a + b, 0);
        poll = { options, counts, total, my_choice: myByPost.has(p.id) ? myByPost.get(p.id)! : null };
      }
    }
    return {
      id: p.id,
      author: p.author || "Someone",
      created_ms: p.created_ms,
      kind: p.kind,
      text: p.text,
      media: (mediaByPost.get(p.id) || []).map(publicMedia),
      poll,
      can_delete: canDeletePost(ctx.peer, p.author_user_id),
    };
  });
}

// One reverse-chronological page. `before` (a created_ms cursor) is null for the first page.
async function pagePayload(ctx: Ctx, before: number | null, limit: number) {
  const all = (await rows(ctx, POSTS).all())
    .filter((r) => before == null || (Number(r.created_ms) || 0) < before)
    .sort(by("-created_ms", "-_created_at"))
    .map(rowToPost);
  const has_more = all.length > limit;
  const page = all.slice(0, limit);
  return {
    posts: await projectPosts(ctx, page, voterId(ctx.peer)),
    has_more,
    next_before: page.length ? page[page.length - 1].created_ms : null,
  };
}

async function projectOne(ctx: Ctx, id: string, vkey: string) {
  const row = await rows(ctx, POSTS).get(id);
  return row ? (await projectPosts(ctx, [rowToPost(row)], vkey))[0] : null;
}

// ----- Routes ---------------------------------------------------------------------------
const json = (v: unknown, status = 200) => Response.json(v, { status });
const refuse = (status: number, error: string) => json({ error }, status);
// What changed, never what it holds: each page reads again as whoever it is.
const tell = (ctx: Ctx, what: "posts" | "prefs") => ctx.push({ outpost: what });

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const v = JSON.parse(await request.text());
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

// Create a post (metadata only; media is uploaded afterward). Editors only.
async function post(ctx: Ctx, v: Record<string, unknown>): Promise<Response> {
  if (!canPost(ctx.peer, await getPrefs(ctx))) return refuse(403, "editors only");
  const text = sanitizeText(v.text, MAX_TEXT);
  const kind: Kind = KINDS.includes(v.kind as Kind) ? (v.kind as Kind) : "thought";

  let pollJson: string | null = null;
  if (Array.isArray(v.poll_options)) {
    const options = v.poll_options
      .map((o: unknown) => sanitizeText(o, MAX_OPTION_LEN))
      .filter((o: string) => o.length > 0)
      .slice(0, MAX_POLL_OPTIONS);
    if (options.length >= MIN_POLL_OPTIONS) pollJson = JSON.stringify(options);
  }
  const mediaToFollow = clampInt(toIntOrNull(v.media_count) ?? 0, 0, MAX_MEDIA_PER_POST) > 0;
  if (!text && !pollJson && !mediaToFollow) return refuse(400, "a post needs text, a poll, or media");

  const row = await keep(ctx, POSTS, null, {
    author: ctx.peer.user_name || "Someone", author_user_id: ctx.peer.user_id || "",
    created_ms: Date.now(), kind, text, poll_options: pollJson,
  });
  tell(ctx, "posts");
  return json({ post_id: row.id, post: await projectOne(ctx, row.id, voterId(ctx.peer)) });
}

// Vote in a poll (see canVote). One vote per user_id; re-voting replaces the previous
// choice. Returns just the updated post so the reader's scroll position is untouched.
async function vote(ctx: Ctx, v: Record<string, unknown>): Promise<Response> {
  if (!canVote(ctx.peer)) return refuse(403, "sign in to Seamside to vote");
  const vkey = voterId(ctx.peer);
  const found = typeof v.post_id === "string" && v.post_id ? await rows(ctx, POSTS).get(v.post_id) : null;
  if (!found || !found.poll_options) return refuse(404, "poll not found");
  let options: string[] = [];
  try { options = JSON.parse(found.poll_options as string); } catch { /* corrupt */ }
  const opt = clampInt(Number(v.option), 0, options.length - 1);
  if (Number(v.option) !== opt) return refuse(400, "bad option");
  // One vote per (post, voter): a stable id makes re-voting an in-place replace.
  await keep(ctx, VOTES, `${found.id}:${vkey}`, { post_id: found.id, voter: vkey, choice: opt });
  tell(ctx, "posts");
  return json({ post: await projectOne(ctx, found.id, vkey) });
}

// Delete a post (owner, or the editor who wrote it), with its votes, media rows and files.
async function remove(ctx: Ctx, postId: string): Promise<Response> {
  if (!ID_RE.test(postId)) return refuse(400, "bad id");
  const found = await rows(ctx, POSTS).get(postId);
  if (!found) return refuse(404, "not found");
  if (!canDeletePost(ctx.peer, String(found.author_user_id ?? ""))) return refuse(403, "not allowed");
  for (const r of await rows(ctx, VOTES).all()) if (r.post_id === postId) await rows(ctx, VOTES).delete(r.id);
  for (const r of await rows(ctx, MEDIA).all()) if (r.post_id === postId) await rows(ctx, MEDIA).delete(r.id);
  await rows(ctx, POSTS).delete(postId);
  await ctx.files.remove(postDir(postId)).catch(() => { /* no media */ });
  tell(ctx, "posts");
  return json({ ok: true });
}

// Attach media to a post you just created. Bytes ride in the raw body, name in ?name=.
async function attach(ctx: Ctx, postId: string, request: Request, query: URLSearchParams): Promise<Response> {
  if (!ID_RE.test(postId)) return refuse(400, "bad post id");
  if (!canPost(ctx.peer, await getPrefs(ctx))) return refuse(403, "editors only");
  const found = await rows(ctx, POSTS).get(postId);
  if (!found) return refuse(404, "post not found");
  if (!canDeletePost(ctx.peer, String(found.author_user_id ?? ""))) return refuse(403, "not your post");
  const ord = (await mediaOf(ctx, new Set([postId]))).length;
  if (ord >= MAX_MEDIA_PER_POST) return refuse(409, `max ${MAX_MEDIA_PER_POST} attachments`);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_MEDIA_MB * 1024 * 1024) return refuse(413, `file exceeds ${MAX_MEDIA_MB} MB`);

  const name = safeName(query.get("name"));
  const mime = sanitizeText(query.get("mime"), 120) || "application/octet-stream";
  // Two attachments of one name get "name (2).ext".
  const taken = new Set((await ctx.files.list(postDir(postId)).catch(() => [])).map((e) => e.name));
  let file = name;
  for (let n = 2; taken.has(file); n++) file = name.replace(/(\.[^.]*)?$/, (ext) => ` (${n})${ext}`);
  const filePath = `${postDir(postId)}/${file}`;
  const media = await keep(ctx, MEDIA, null, { post_id: postId, name, mime, size: bytes.byteLength, ord, path: filePath });
  try {
    await ctx.files.write(filePath, bytes);
  } catch (e) {
    await rows(ctx, MEDIA).delete(media.id);
    return refuse(500, "failed to store media: " + e);
  }
  tell(ctx, "posts");
  return json({ ok: true });
}

// Serve a media file inline (anyone with the link may view it).
async function serveMedia(ctx: Ctx, rest: string): Promise<Response> {
  const parts = rest.split("/");
  if (parts.length !== 2 || !ID_RE.test(parts[0]) || !ID_RE.test(parts[1])) return refuse(400, "bad path");
  const [postId, mediaId] = parts;
  const media = await rows(ctx, MEDIA).get(mediaId);
  if (!media || media.post_id !== postId) return refuse(404, "not found");
  // Only a file of this post's folder is served, whatever a row says.
  const filePath = String(media.path ?? "");
  if (!filePath.startsWith(postDir(postId) + "/")) return refuse(404, "not found");
  const buf = await ctx.files.read(filePath).catch(() => null);
  if (!buf) return refuse(404, "not found");
  const mediaName = String(media.name ?? "file");
  const asciiName = mediaName.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  return new Response(buf as Uint8Array<ArrayBuffer>, {
    headers: {
      "content-type": String(media.mime || "application/octet-stream"),
      "content-disposition": `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(mediaName)}`,
    },
  });
}

export default {
  async fetch(request: Request, ctx: Ctx): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;
    const peer = ctx.peer;

    // The page and its assets — open to everyone (every tier needs the shell to render).
    if (!pathname.startsWith("/api/")) {
      if (method !== "GET") return refuse(404, "not found");
      return ctx.file(pathname);
    }

    // Identity + prefs + the FIRST page of the feed, in one round trip. ?limit= lets a
    // live-refresh re-request the range already on screen.
    if (pathname === "/api/state" && method === "GET") {
      const prefs = await getPrefs(ctx);
      const limit = clampInt(toIntOrNull(url.searchParams.get("limit")) ?? DEFAULT_PAGE, 1, MAX_PAGE);
      return json({
        me: {
          is_anon: peer.is_anon, signed_in: !!peer.user_id, is_sfi_member: peer.is_sfi_member,
          is_sfi_editor: peer.is_sfi_editor, is_owner: peer.is_owner,
          user_name: peer.user_name, space_color: peer.space_color,
        },
        prefs,
        can_post: canPost(peer, prefs),
        can_vote: canVote(peer),
        ...(await pagePayload(ctx, null, limit)),
      });
    }

    // Older pages: ?before=<created_ms cursor>&limit=  (public — read-only feed).
    if (pathname === "/api/posts" && method === "GET") {
      const before = toIntOrNull(url.searchParams.get("before"));
      const limit = clampInt(toIntOrNull(url.searchParams.get("limit")) ?? DEFAULT_PAGE, 1, MAX_PAGE);
      return json(await pagePayload(ctx, before, limit));
    }

    if (pathname.startsWith("/api/media/") && method === "GET") return serveMedia(ctx, pathname.slice("/api/media/".length));

    if (pathname === "/api/post" && method === "POST") return post(ctx, await body(request));

    if (pathname.startsWith("/api/post/") && pathname.endsWith("/media") && method === "POST") {
      return attach(ctx, pathname.slice("/api/post/".length, -"/media".length), request, url.searchParams);
    }

    if (pathname === "/api/vote" && method === "POST") return vote(ctx, await body(request));

    if (pathname.startsWith("/api/delete/") && method === "POST") return remove(ctx, pathname.slice("/api/delete/".length));

    // Owner-only: this outpost's heading, tagline, and who-can-post setting.
    if (pathname === "/api/prefs" && method === "POST") {
      if (!peer.is_owner) return refuse(403, "owner only");
      const v = await body(request);
      await setPrefs(ctx, {
        title: sanitizeText(v.title, MAX_TITLE) || DEFAULT_PREFS.title,
        tagline: sanitizeText(v.tagline, MAX_TAGLINE),
        who_can_post: v.who_can_post === "owner" ? "owner" : "editors",
      });
      tell(ctx, "prefs");
      return json({ prefs: await getPrefs(ctx) });
    }

    return refuse(404, "not found");
  },
};
