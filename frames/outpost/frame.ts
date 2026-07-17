// ----------------------------------------------------------------------------------------
// Outpost — a lightweight public posting board, one per placement (sfi_id).
//
// Members (editors) publish short posts to share with the world; anyone with the frame's
// share link can read them. A post carries the author's name, the moment it was shared,
// free text (with auto-clickable URLs handled frontend-side), an optional light "kind"
// (thought / question / status / announcement), optional attached media (image / audio /
// video / file), and an optional brief poll that any reader may vote in.
//
// The feed is served in reverse-chronological pages (newest first) via a keyset cursor on
// created_ms, so a long-running community's board stays cheap to load and scroll.
//
// Design axes:
//   privacy:        privacy-public-view  — three tiers. Non-members and Viewer-role members
//                                           get a read-only feed; editors (Contributor+ / owner)
//                                           get the composer. Writes are gated on
//                                           `peer.is_sfi_editor`, NEVER on `is_sfi_member`.
//                                           (Poll voting is a softer gate — any real Seamside
//                                           user may vote, member or not, but NOT anonymous
//                                           web viewers, who see results read-only.)
//   data_storage:   storage-local-db      — LocalTables (encrypted at rest, host-local, not
//                                           peer-synced), scoped per placement: posts / media
//                                           rows / votes / prefs. Attached media bytes still
//                                           live as files in a <post_id>/ subfolder under
//                                           data/outposts/<sfi>/. The host serves its posts
//                                           to viewers over HTTP.
//   view_realtime:  view-collaborative    — every mutation calls pushToInstance so all viewers
//                                           of the placement refresh live.
//   settings_scope: settings-per-sfi      — tables (and the prefs row) are per peer.sfi_id.
// ----------------------------------------------------------------------------------------
import {
  log, jsonReply, parseJsonBody, parsePeerInfo, pushToInstance,
  frameDataDir, serveFileAtPath, sanitizeText, clampInt, toIntOrNull, path,
  declareTables, ensureTables, table, frameSettings,
} from "@frame-core";

type Peer = ReturnType<typeof parsePeerInfo>;
type Tbl = ReturnType<typeof table>;
type Settings = ReturnType<typeof frameSettings>;

// ----- Shapes ---------------------------------------------------------------------------
type Kind = "thought" | "question" | "status" | "announcement";
const KINDS: Kind[] = ["thought", "question", "status", "announcement"];

type Prefs = {
  title: string;                       // heading shown at the top of the outpost
  tagline: string;                     // one-line description under the heading
  who_can_post: "owner" | "editors";   // who may publish
};
const DEFAULT_PREFS: Prefs = { title: "Outpost", tagline: "", who_can_post: "editors" };

// A post as read back from the table (poll_options is a JSON string or null).
type PostRow = {
  id: string; author: string; author_user_id: string; created_ms: number;
  kind: string; text: string; poll_options: string | null;
};
type MediaRow = { id: string; post_id: string; name: string; mime: string; size: number };

// ----- Limits ---------------------------------------------------------------------------
const MAX_TEXT = 4000;
const MAX_TAGLINE = 160;
const MAX_TITLE = 80;
const MAX_MEDIA_PER_POST = 6;
const MAX_MEDIA_MB = 50;
const MAX_POLL_OPTIONS = 6;
const MIN_POLL_OPTIONS = 2;
const MAX_OPTION_LEN = 120;
const DEFAULT_PAGE = 15;   // posts per feed page
const MAX_PAGE = 50;

// ----- On-disk layout (media BYTES only; rows live in LocalTables) -----------------------
// data/outposts/<sfi_slug>/<post_id>/<media_id> — one file per attached media item.
const OUTPOSTS_DIR = path.join(frameDataDir(import.meta.url), "outposts");

function sfiSlug(sfiId: string): string {
  return (sfiId || "").replace(/[^a-zA-Z0-9_-]/g, "_") || "default";
}
function postDir(sfiId: string, postId: string): string {
  return path.join(OUTPOSTS_DIR, sfiSlug(sfiId), postId);
}

// ----- LocalTables ------------------------------------------------------------------------
declareTables([
  {
    key: "posts",
    title: "Outpost Posts",
    description: "Published posts for this outpost, newest first.",
    local: true,
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
    key: "media",
    title: "Outpost Media",
    description: "Attached-media metadata (bytes live as files beside the tables).",
    local: true,
    schema: [
      { name: "post_id", col_type: "text",    nullable: false, default_val: "" },
      { name: "name",    col_type: "text",    nullable: false, default_val: "" },
      { name: "mime",    col_type: "text",    nullable: false, default_val: "" },
      { name: "size",    col_type: "integer", nullable: false, default_val: "0" },
      { name: "ord",     col_type: "integer", nullable: false, default_val: "0" },
    ],
  },
  {
    key: "votes",
    title: "Outpost Votes",
    description: "One poll vote per (post, voter); re-voting replaces the choice.",
    local: true,
    schema: [
      { name: "post_id", col_type: "text",    nullable: false, default_val: "" },
      { name: "voter",   col_type: "text",    nullable: false, default_val: "" },
      { name: "choice",  col_type: "integer", nullable: false, default_val: "0" },
    ],
  },
]);

interface Tables { settings: Settings; posts: Tbl; media: Tbl; votes: Tbl; }

// Prefs live in the per-placement frameSettings key/value store — one row per key,
// race-free (no query-then-insert), and extensible without a schema change.
async function getPrefs(t: Tables): Promise<Prefs> {
  const [title, tagline, who] = await Promise.all([
    t.settings.get<string>("title"),
    t.settings.get<string>("tagline"),
    t.settings.get<string>("who_can_post"),
  ]);
  return {
    title: title || DEFAULT_PREFS.title,
    tagline: tagline ?? "",
    who_can_post: who === "owner" ? "owner" : "editors",
  };
}

async function setPrefs(t: Tables, next: Prefs): Promise<void> {
  await Promise.all([
    t.settings.set("title", next.title),
    t.settings.set("tagline", next.tagline),
    t.settings.set("who_can_post", next.who_can_post),
  ]);
}

function rowToPost(r: any): PostRow {
  return {
    id: r._row_id, author: r.author, author_user_id: r.author_user_id,
    created_ms: r.created_ms, kind: r.kind, text: r.text,
    poll_options: (r.poll_options as string | null) ?? null,
  };
}

// ----- Ids / validation -----------------------------------------------------------------
const ID_RE = /^[0-9a-fA-F-]{8,64}$/;
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
function canPost(peer: Peer, prefs: Prefs): boolean {
  return prefs.who_can_post === "owner" ? peer.is_owner : peer.is_sfi_editor;
}
function canDeletePost(peer: Peer, authorUserId: string): boolean {
  return peer.is_owner || (peer.is_sfi_editor && !!peer.user_id && authorUserId === peer.user_id);
}
// Poll voting is limited to real Seamside users (signed-in, non-anonymous) — they need not
// be a known contact, just an actual account, not an anonymous web viewer. Anonymous readers
// can see live results but can't cast a vote. A voter is identified by their stable user_id.
function voterId(peer: Peer): string {
  return (!peer.is_anon && peer.user_id) ? "u:" + peer.user_id : "";
}
function canVote(peer: Peer): boolean {
  return voterId(peer) !== "";
}

// ----- Public projection ----------------------------------------------------------------
function publicMedia(m: MediaRow) {
  const k = isMediaKind(m.mime);
  return { id: m.id, name: m.name, mime: m.mime, size: m.size, is_image: k.image, is_video: k.video, is_audio: k.audio };
}

// Project a set of post rows into the public shape, scoping media + vote lookups to just
// these ids (one grouped query each) so a page stays cheap regardless of total feed size.
async function projectPosts(t: Tables, rows: PostRow[], peer: Peer, vkey: string) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);

  const mediaByPost = new Map<string, MediaRow[]>();
  const { rows: mediaRows } = await t.media.query({
    where: { post_id: { in: ids } },
    order_by: [{ col: "post_id" }, { col: "ord" }],
  });
  for (const r of mediaRows) {
    const m: MediaRow = { id: r._row_id, post_id: r.post_id as string, name: r.name as string, mime: r.mime as string, size: r.size as number };
    (mediaByPost.get(m.post_id) ?? mediaByPost.set(m.post_id, []).get(m.post_id)!).push(m);
  }
  // Poll tallies: COUNT(*) per (post, choice), done by the table layer.
  const countsByPost = new Map<string, Map<number, number>>();
  for (const g of await t.votes.countBy(["post_id", "choice"], { where: { post_id: { in: ids } } })) {
    const pid = g.post_id as string;
    (countsByPost.get(pid) ?? countsByPost.set(pid, new Map()).get(pid)!).set(Number(g.choice), Number(g._count));
  }
  const myByPost = new Map<string, number>();
  if (vkey) {
    const { rows: mine } = await t.votes.query({ where: { voter: vkey, post_id: { in: ids } } });
    for (const r of mine) myByPost.set(r.post_id as string, Number(r.choice));
  }

  return rows.map((p) => {
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
      can_delete: canDeletePost(peer, p.author_user_id),
    };
  });
}

// One reverse-chronological page. `before` (a created_ms cursor) is null for the first page.
async function pagePayload(t: Tables, peer: Peer, vkey: string, before: number | null, limit: number) {
  const { rows } = await t.posts.query({
    where: before == null ? undefined : { created_ms: { lt: before } },
    order_by: [{ col: "created_ms", dir: "desc" }, { col: "_created_at", dir: "desc" }],
    limit: limit + 1,
  });
  const posts = rows.map(rowToPost);
  const has_more = posts.length > limit;
  const page = has_more ? posts.slice(0, limit) : posts;
  return {
    posts: await projectPosts(t, page, peer, vkey),
    has_more,
    next_before: page.length ? page[page.length - 1].created_ms : null,
  };
}

async function projectOne(t: Tables, id: string, peer: Peer, vkey: string) {
  const row = await t.posts.get(id);
  return row ? (await projectPosts(t, [rowToPost(row)], peer, vkey))[0] : null;
}

// ----- Networking -----------------------------------------------------------------------
self.onNetworkRequest = async function (replyPort, reqPath, method, headers, query, body, cookies) {
  const peer = parsePeerInfo(query, cookies);

  // Static assets — open to everyone (all tiers need the shell to render).
  if (method === "GET" && !reqPath.startsWith("/api/")) {
    return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url), headers);
  }

  // Local tables are always ready; the gate stays so a future graduation to
  // synced tables needs no code change here.
  const ready = ensureTables(peer);
  if (!ready.ready) return jsonReply(replyPort, 503, { error: "table not bound" });
  const t: Tables = {
    settings: frameSettings(peer.sfi_id),
    posts: table("posts", peer.sfi_id),
    media: table("media", peer.sfi_id),
    votes: table("votes", peer.sfi_id),
  };

  // Identity + prefs + the FIRST page of the feed, in one round trip. ?limit= lets a
  // live-refresh re-request the range already on screen.
  if (reqPath === "/api/state" && method === "GET") {
    const prefs = await getPrefs(t);
    const limit = clampInt(toIntOrNull(query.limit) ?? DEFAULT_PAGE, 1, MAX_PAGE);
    return jsonReply(replyPort, 200, {
      me: {
        is_anon: peer.is_anon, is_sfi_member: peer.is_sfi_member,
        is_sfi_editor: peer.is_sfi_editor, is_owner: peer.is_owner,
        user_name: peer.user_name, space_color: peer.space_color,
      },
      prefs,
      can_post: canPost(peer, prefs),
      can_vote: canVote(peer),
      ...(await pagePayload(t, peer, voterId(peer), null, limit)),
    });
  }

  // Older pages: ?before=<created_ms cursor>&limit=  (public — read-only feed).
  if (reqPath === "/api/posts" && method === "GET") {
    const before = toIntOrNull(query.before);
    const limit = clampInt(toIntOrNull(query.limit) ?? DEFAULT_PAGE, 1, MAX_PAGE);
    return jsonReply(replyPort, 200, await pagePayload(t, peer, voterId(peer), before, limit));
  }

  // Create a post (metadata only; media is uploaded afterward). Editors only.
  if (reqPath === "/api/post" && method === "POST") {
    const prefs = await getPrefs(t);
    if (!canPost(peer, prefs)) return jsonReply(replyPort, 403, { error: "editors only" });
    const v = parseJsonBody<{ text?: string; kind?: string; poll_options?: unknown[] }>(body) || {};
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
    if (!text && !pollJson) return jsonReply(replyPort, 400, { error: "a post needs text, a poll, or media" });

    const { row_id } = await t.posts.upsert(null, {
      author: peer.user_name || "Someone", author_user_id: peer.user_id || "",
      created_ms: Date.now(), kind, text, poll_options: pollJson,
    });
    pushToInstance(peer.sfi_id, { type: "outpost_changed" });
    return jsonReply(replyPort, 200, { post_id: row_id, post: await projectOne(t, row_id, peer, voterId(peer)) });
  }

  // Attach media to a post you just created. Bytes ride in the raw body, name in ?name=.
  if (reqPath.startsWith("/api/post/") && reqPath.endsWith("/media") && method === "POST") {
    const postId = reqPath.slice("/api/post/".length, -"/media".length);
    if (!ID_RE.test(postId)) return jsonReply(replyPort, 400, { error: "bad post id" });
    if (!canPost(peer, await getPrefs(t))) return jsonReply(replyPort, 403, { error: "editors only" });
    const post = await t.posts.get(postId);
    if (!post) return jsonReply(replyPort, 404, { error: "post not found" });
    if (!canDeletePost(peer, post.author_user_id as string)) return jsonReply(replyPort, 403, { error: "not your post" });
    const ord = (await t.media.query({ where: { post_id: postId }, limit: 1 })).total;
    if (ord >= MAX_MEDIA_PER_POST) return jsonReply(replyPort, 409, { error: `max ${MAX_MEDIA_PER_POST} attachments` });
    if (body.byteLength > MAX_MEDIA_MB * 1024 * 1024) return jsonReply(replyPort, 413, { error: `file exceeds ${MAX_MEDIA_MB} MB` });

    const name = safeName(query.name);
    const mime = sanitizeText(query.mime, 120) || "application/octet-stream";
    // Row first (its _row_id names the file on disk); best-effort undo if the write fails.
    const { row_id: mediaId } = await t.media.upsert(null, {
      post_id: postId, name, mime, size: body.byteLength, ord,
    });
    try {
      const dir = postDir(peer.sfi_id, postId);
      Deno.mkdirSync(dir, { recursive: true });
      Deno.writeFileSync(path.join(dir, mediaId), new Uint8Array(body));
    } catch (e) {
      await t.media.delete(mediaId);
      return jsonReply(replyPort, 500, { error: "failed to store media: " + e });
    }
    pushToInstance(peer.sfi_id, { type: "outpost_changed" });
    return jsonReply(replyPort, 200, { ok: true });
  }

  // Serve a media file inline (public — anyone with the link may view it).
  if (reqPath.startsWith("/api/media/") && method === "GET") {
    const parts = reqPath.slice("/api/media/".length).split("/");
    if (parts.length !== 2 || !ID_RE.test(parts[0]) || !ID_RE.test(parts[1])) {
      return jsonReply(replyPort, 400, { error: "bad path" });
    }
    const [postId, mediaId] = parts;
    const media = await t.media.get(mediaId);
    if (!media || media.post_id !== postId) return jsonReply(replyPort, 404, { error: "not found" });
    let buf: Uint8Array;
    try { buf = Deno.readFileSync(path.join(postDir(peer.sfi_id, postId), mediaId)); }
    catch { return jsonReply(replyPort, 404, { error: "not found" }); }
    const mediaName = String(media.name ?? "file");
    const asciiName = mediaName.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
    return replyPort.postMessage({
      status: 200, body: buf, contentType: String(media.mime || "application/octet-stream"),
      headers: { "Content-Disposition": `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(mediaName)}` },
    }, [buf.buffer]);
  }

  // Vote in a poll. Restricted to real Seamside users (non-anonymous); anonymous web viewers
  // are rejected here and don't see the control. One vote per user_id; re-voting replaces the
  // previous choice. Returns just the updated post so the reader's scroll position is untouched.
  if (reqPath === "/api/vote" && method === "POST") {
    if (!canVote(peer)) return jsonReply(replyPort, 403, { error: "sign in to Seamside to vote" });
    const v = parseJsonBody<{ post_id?: string; option?: number }>(body) || {};
    const vkey = voterId(peer);
    const post = typeof v.post_id === "string" && v.post_id ? await t.posts.get(v.post_id) : null;
    if (!post || !post.poll_options) return jsonReply(replyPort, 404, { error: "poll not found" });
    let options: string[] = [];
    try { options = JSON.parse(post.poll_options as string); } catch { /* corrupt */ }
    const opt = clampInt(Number(v.option), 0, options.length - 1);
    if (Number(v.option) !== opt) return jsonReply(replyPort, 400, { error: "bad option" });
    // One vote per (post, voter): re-voting replaces the previous choice.
    const { rows: existing } = await t.votes.query({
      where: { post_id: post._row_id, voter: vkey }, limit: 1,
    });
    await t.votes.upsert(existing[0]?._row_id ?? null, {
      post_id: post._row_id, voter: vkey, choice: opt,
    });
    pushToInstance(peer.sfi_id, { type: "outpost_changed" });
    return jsonReply(replyPort, 200, { post: await projectOne(t, post._row_id, peer, vkey) });
  }

  // Delete a post (owner, or the editor who wrote it). Removes its media rows + files too.
  if (reqPath.startsWith("/api/delete/") && method === "POST") {
    const postId = reqPath.slice("/api/delete/".length);
    if (!ID_RE.test(postId)) return jsonReply(replyPort, 400, { error: "bad id" });
    const post = await t.posts.get(postId);
    if (!post) return jsonReply(replyPort, 404, { error: "not found" });
    if (!canDeletePost(peer, post.author_user_id as string)) return jsonReply(replyPort, 403, { error: "not allowed" });
    await t.votes.deleteWhere({ post_id: postId });
    await t.media.deleteWhere({ post_id: postId });
    await t.posts.delete(postId);
    try { Deno.removeSync(postDir(peer.sfi_id, postId), { recursive: true }); } catch { /* no media */ }
    pushToInstance(peer.sfi_id, { type: "outpost_changed" });
    return jsonReply(replyPort, 200, { ok: true });
  }

  // Owner-only: update this outpost's heading, tagline, and who-can-post setting.
  if (reqPath === "/api/prefs" && method === "POST") {
    if (!peer.is_owner) return jsonReply(replyPort, 403, { error: "owner only" });
    const v = parseJsonBody<Partial<Prefs>>(body) || {};
    await setPrefs(t, {
      title: sanitizeText(v.title, MAX_TITLE) || DEFAULT_PREFS.title,
      tagline: sanitizeText(v.tagline, MAX_TAGLINE),
      who_can_post: v.who_can_post === "owner" ? "owner" : "editors",
    });
    pushToInstance(peer.sfi_id, { type: "outpost_changed" });
    return jsonReply(replyPort, 200, { prefs: await getPrefs(t) });
  }

  return jsonReply(replyPort, 404, { error: "not found" });
};

log("Outpost frame is up and running!");
