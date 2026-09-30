// RSS Reader's server half. The page reads no table and reaches no host: what a member
// is shown, and every change, is a route here, decided on ctx.peer, who the door proved
// is asking. Feeds are fetched here too, on a visit and, by `start`, with nobody looking.
import type { Ctx } from "@frame-core";
import { declareTables } from "@frame-core";
import { parseFeed } from "./lib/parser.ts";
import { discoverFeedUrl, looksLikeFeed } from "./lib/discovery.ts";
import { sanitizeHtml } from "./lib/sanitize.ts";
import { planMerge, type ExistingItem } from "./lib/merge.ts";

const ITEM_CAP = 80;
/** A feed older than this is fetched again. */
const STALE_MS = 15 * 60 * 1000;
const CHECK_EVERY_MS = 60_000;

const GROUPS = "rss_groups";
const FEEDS = "rss_feeds";
const ITEMS = "rss_items";
const BOOSTS = "rss_boosts";
const COMMENTS = "rss_comments";
const READS = "rss_reads";

type ColType = "text" | "integer" | "real" | "blob";
type Col = { name: string; col_type: ColType; nullable: boolean; default_val?: string };
const col = (name: string, col_type: ColType, nullable: boolean, default_val?: string): Col =>
  ({ name, col_type, nullable, ...(default_val === undefined ? {} : { default_val }) });

const TABLES: Array<{ key: string; title: string; description: string; schema: Col[] }> = [
  { key: GROUPS, title: "Groups", description: "Feed groups", schema: [
    col("name", "text", false),
    col("sort", "integer", true, "0"),
  ]},
  { key: FEEDS, title: "Feeds", description: "Subscribed feeds", schema: [
    col("url", "text", false),
    col("site_url", "text", true),
    col("title", "text", false),
    col("group_id", "text", true),
    col("added_by", "text", true),
    col("last_fetched", "integer", true),
    col("last_error", "text", true),
  ]},
  { key: ITEMS, title: "Items", description: "Feed items", schema: [
    col("feed_id", "text", false),
    col("guid", "text", false),
    col("title", "text", false),
    col("link", "text", true),
    col("author", "text", true),
    col("content", "text", true),
    col("published_at", "integer", true),
    col("fetched_at", "integer", false),
  ]},
  { key: BOOSTS, title: "Boosts", description: "Co-reader boosts", schema: [
    col("item_id", "text", false),
    col("user_id", "text", false),
    col("user_name", "text", true),
    col("created_at", "integer", false),
  ]},
  { key: COMMENTS, title: "Comments", description: "Threaded comments", schema: [
    col("item_id", "text", false),
    col("parent_id", "text", true),
    col("user_id", "text", false),
    col("user_name", "text", true),
    col("body", "text", false),
    col("created_at", "integer", false),
  ]},
  { key: READS, title: "Read marks", description: "Who has read which item", schema: [
    col("item_id", "text", false),
    col("user_id", "text", false),
    col("read_at", "integer", false),
  ]},
];
declareTables(TABLES);

// deno-lint-ignore no-explicit-any
type Row = Record<string, any> & { id: string };

const rows = (ctx: Ctx, name: string) => ctx.table<Record<string, unknown>>(name);
const all = (ctx: Ctx, name: string) => rows(ctx, name).all() as Promise<Row[]>;

/** What a new row of this table starts from. */
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
  }) as Row;
}

function nowMs(): number { return Date.now(); }

// What changed, never what it holds: each page reads again as whoever it is.
const tell = (ctx: Ctx) => ctx.push({ rss_reader: "feeds" });

const json = (v: unknown, status = 200) => Response.json(v, { status });

// ----- Read state ------------------------------------------------------------------------
// Each person's read marks are rows of the space's `rss_reads` table (one per person and
// item), so they travel with the space — and, being a table of the space, every member can
// read whose marks are whose.
const safeId = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
const readId = (userId: string, itemId: string) => `${safeId(userId)}~${safeId(itemId)}`;
async function myReads(ctx: Ctx): Promise<Set<string>> {
  const mine = (await all(ctx, READS)).filter((r) => r.user_id === ctx.peer.user_id);
  return new Set(mine.map((r) => String(r.item_id)));
}
async function setRead(ctx: Ctx, itemId: string, read: boolean): Promise<void> {
  const id = readId(ctx.peer.user_id, itemId);
  if (read) await keep(ctx, READS, id, { item_id: itemId, user_id: ctx.peer.user_id, read_at: nowMs() });
  else await rows(ctx, READS).delete(id);
}

// deno-lint-ignore no-explicit-any
async function readBody(request: Request): Promise<any> {
  try {
    const v = JSON.parse(await request.text());
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

// ----- Fetching the open web ---------------------------------------------------------
// A reader has to reach whatever the user subscribes to, and no allowlist can be written
// ahead of time, so this frame asks for `permissions_backend.net: ["*"]`, which the keeper
// is shown and allows before the frame is added.
//
// What is ours: refuse anything that isn't plainly http(s), give up rather than hang, and
// stop reading a response that is too big to be a feed. A subscription is a URL a person
// typed, so it gets treated as untrusted input every time it is used, not just when it is
// first added.
const FETCH_TIMEOUT_MS = 15_000;
const MAX_FEED_BYTES = 5 * 1024 * 1024;

function assertFetchableUrl(url: string): URL {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error("that doesn't look like a web address"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("only http and https addresses can be fetched");
  }
  return u;
}

async function fetchUrl(url: string): Promise<{ status: number; contentType: string; body: string }> {
  const u = assertFetchableUrl(url);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(u.href, {
      signal: ctl.signal,
      redirect: "follow",
      headers: {
        // Identify ourselves the way a polite reader should; some feeds serve XML only
        // when asked for it.
        "user-agent": "Seamside RSS Reader (+https://seamside.com)",
        "accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8, */*;q=0.5",
      },
    });
    const contentType = res.headers.get("content-type") ?? "";

    // Read with a ceiling instead of res.text(): a feed that is actually a 4 GB file
    // should fail as "too big", not as an out-of-memory worker.
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > MAX_FEED_BYTES) throw new Error("that feed is too big to read");
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_FEED_BYTES) throw new Error("that feed is too big to read");

    return { status: res.status, contentType, body: new TextDecoder().decode(buf) };
  } catch (e) {
    // AbortError is the timeout; say so in words a reader can act on.
    const msg = (e instanceof Error && e.name === "AbortError")
      ? "that site took too long to answer"
      : (e instanceof Error ? e.message : String(e));
    throw new Error(msg);
  } finally {
    clearTimeout(timer);
  }
}

async function cascadeItem(ctx: Ctx, itemRowId: string): Promise<void> {
  for (const name of [READS, BOOSTS, COMMENTS]) {
    for (const r of await all(ctx, name)) if (r.item_id === itemRowId) await rows(ctx, name).delete(r.id);
  }
}

/** An item's row is named for its feed and its guid, so whoever fetches it writes the same row. */
async function itemId(feedRowId: string, guid: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${feedRowId}\n${guid}`));
  return [...new Uint8Array(hash)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function ingestFeed(ctx: Ctx, feedRowId: string, feedUrl: string): Promise<{ title: string; inserted: number }> {
  const resp = await fetchUrl(feedUrl);
  const parsed = parseFeed(resp.body, feedUrl);
  const existing: ExistingItem[] = (await all(ctx, ITEMS)).filter((i) => i.feed_id === feedRowId)
    .map((i) => ({ _row_id: i.id, guid: i.guid, published_at: i.published_at, fetched_at: i.fetched_at }));
  const { toInsert, toPrune } = planMerge(existing, parsed.items, ITEM_CAP);
  const ts = nowMs();
  for (const p of toInsert) {
    await keep(ctx, ITEMS, await itemId(feedRowId, p.guid), { feed_id: feedRowId, guid: p.guid, title: p.title,
      link: p.link, author: p.author, content: sanitizeHtml(p.content), published_at: p.published_at, fetched_at: ts });
  }
  for (const rid of toPrune) { await rows(ctx, ITEMS).delete(rid); await cascadeItem(ctx, rid); }
  return { title: parsed.title, inserted: toInsert.length };
}

/** Fetch each of these feeds again. One bad feed must not abort the sweep: its error is
 *  recorded and the rest carry on. */
async function refresh(ctx: Ctx, feeds: Row[]): Promise<{ refreshed: number; inserted: number }> {
  let inserted = 0;
  for (const f of feeds) {
    try {
      const r = await ingestFeed(ctx, f.id, f.url); inserted += r.inserted;
      await keep(ctx, FEEDS, f.id, { last_fetched: nowMs(), last_error: null });
    } catch (e) {
      await keep(ctx, FEEDS, f.id, { last_fetched: nowMs(), last_error: String(e instanceof Error ? e.message : e) });
    }
  }
  return { refreshed: feeds.length, inserted };
}

// ----- With nobody looking ---------------------------------------------------------------
// One timer for each session running here. `last_fetched` is a column of the feed, so a
// feed another device or a visit just fetched is left alone.
const timers = new Map<string, ReturnType<typeof setInterval>>();
const sweeping = new Set<string>();

async function refreshStale(ctx: Ctx): Promise<void> {
  if (sweeping.has(ctx.frame)) return;
  sweeping.add(ctx.frame);
  try {
    const now = nowMs();
    const stale = (await all(ctx, FEEDS)).filter((f) => !f.last_fetched || now - f.last_fetched > STALE_MS);
    if (!stale.length) return;
    await refresh(ctx, stale);
    tell(ctx);
  } finally {
    sweeping.delete(ctx.frame);
  }
}

// ----- Writes ---------------------------------------------------------------------------
// `op` is the API path with "/api/" stripped, and "/delete" added for a DELETE, so
// "items/<id>/boost" and "comments/<id>/delete" read as they always have. Role gates
// live here, and every shared change ends by telling the open pages.
function pathToOp(pathname: string, method: string): string {
  const rest = pathname.slice("/api/".length);
  return method === "DELETE" ? rest + "/delete" : rest;
}

// deno-lint-ignore no-explicit-any
async function handleWrite(ctx: Ctx, op: string, v: any): Promise<Response> {
  const peer = ctx.peer;
  const isEditor = peer.is_sfi_editor || peer.is_owner;
  const isMember = isEditor || peer.is_sfi_member;
  const seg = op.split("/");

  // Reading along with everyone else is a member's right; changing what the room
  // subscribes to is an editor's. Never gate on is_sfi_member for editor work — a
  // Viewer-role member would slip through.
  const editorOnly = (): Response | null => isEditor ? null : json({ error: "editors only" }, 403);
  const memberOnly = (): Response | null => isMember ? null : json({ error: "members only" }, 403);

  const done = (body: unknown): Response => {
    tell(ctx);
    return json(body);
  };

  // ---- Feeds -------------------------------------------------------------------------
  if (op === "feeds") {
    const gate = editorOnly(); if (gate) return gate;
    const url = String(v?.url ?? "").trim();
    if (!url) return json({ error: "a url is required" }, 400);
    let feedUrl = url;
    // Paste a site, get its feed: probe first, and if it isn't a feed look for one.
    try {
      const probe = await fetchUrl(feedUrl);
      if (!looksLikeFeed(probe.body)) {
        const discovered = discoverFeedUrl(probe.body, feedUrl);
        if (!discovered) return json({ error: "no feed found at that URL" });
        feedUrl = discovered;
      }
    } catch (e) { return json({ error: String(e instanceof Error ? e.message : e) }); }

    const { id } = await keep(ctx, FEEDS, null, { url: feedUrl, site_url: url, title: feedUrl,
      group_id: null, added_by: peer.user_id, last_fetched: null, last_error: null });
    try {
      const { title } = await ingestFeed(ctx, id, feedUrl);
      await keep(ctx, FEEDS, id, { title, last_fetched: nowMs(), last_error: null });
      return done({ id, title });
    } catch (e) {
      // The feed is kept with its error recorded rather than dropped: the subscription is
      // still what the person asked for, and a site that is down today may be up tomorrow.
      const msg = String(e instanceof Error ? e.message : e);
      await keep(ctx, FEEDS, id, { last_error: msg, last_fetched: nowMs() });
      return done({ id, title: feedUrl, warning: msg });
    }
  }
  if (seg[0] === "feeds" && seg[1] && seg[2] === "delete") {
    const gate = editorOnly(); if (gate) return gate;
    const items = (await all(ctx, ITEMS)).filter((i) => i.feed_id === seg[1]);
    for (const it of items) { await rows(ctx, ITEMS).delete(it.id); await cascadeItem(ctx, it.id); }
    await rows(ctx, FEEDS).delete(seg[1]);
    return done({ ok: true });
  }
  if (seg[0] === "feeds" && seg[1] && !seg[2]) {
    const gate = editorOnly(); if (gate) return gate;
    const patch: Record<string, unknown> = {};
    if (v?.title !== undefined) patch.title = String(v.title);
    if (v?.group_id !== undefined) patch.group_id = v.group_id ?? null;
    if (Object.keys(patch).length) await keep(ctx, FEEDS, seg[1], patch);
    return done({ ok: true });
  }

  // ---- Groups ------------------------------------------------------------------------
  if (op === "groups") {
    const gate = editorOnly(); if (gate) return gate;
    const name = String(v?.name ?? "").trim();
    if (!name) return json({ error: "a name is required" }, 400);
    const { id } = await keep(ctx, GROUPS, null, { name, sort: 0 });
    return done({ id, name });
  }
  if (seg[0] === "groups" && seg[1] && seg[2] === "delete") {
    const gate = editorOnly(); if (gate) return gate;
    // Feeds outlive their group — losing a group must not lose what you subscribed to.
    const feeds = (await all(ctx, FEEDS)).filter((f) => f.group_id === seg[1]);
    for (const f of feeds) await keep(ctx, FEEDS, f.id, { group_id: null });
    await rows(ctx, GROUPS).delete(seg[1]);
    return done({ ok: true });
  }
  if (seg[0] === "groups" && seg[1] && !seg[2]) {
    const gate = editorOnly(); if (gate) return gate;
    const patch: Record<string, unknown> = {};
    if (v?.name !== undefined) patch.name = String(v.name).trim();
    if (v?.sort !== undefined) patch.sort = Number(v.sort) || 0;
    if (Object.keys(patch).length) await keep(ctx, GROUPS, seg[1], patch);
    return done({ ok: true });
  }

  // ---- Refresh -----------------------------------------------------------------------
  if (op === "refresh") {
    const gate = editorOnly(); if (gate) return gate;
    const feedId = v?.feed_id ? String(v.feed_id) : "";
    const feeds = (await all(ctx, FEEDS)).filter((f) => !feedId || f.id === feedId);
    return done(await refresh(ctx, feeds));
  }

  // ---- Read / boost / comment (member) -----------------------------------------------
  if (seg[0] === "items" && seg[1] && seg[2] === "read") {
    const gate = memberOnly(); if (gate) return gate;
    const want = !!v?.read;
    await setRead(ctx, seg[1], want);
    // A read mark changes only its reader's view, so nobody else is told: every
    // j-keypress would reload the room.
    return json({ ok: true, read: want });
  }

  if (seg[0] === "items" && seg[1] && seg[2] === "boost") {
    const gate = memberOnly(); if (gate) return gate;
    const mine = (await all(ctx, BOOSTS)).find((f) => f.item_id === seg[1] && f.user_id === peer.user_id);
    const on = !!v?.on;
    if (on && !mine) await keep(ctx, BOOSTS, null, { item_id: seg[1], user_id: peer.user_id, user_name: peer.user_name, created_at: nowMs() });
    if (!on && mine) await rows(ctx, BOOSTS).delete(mine.id);
    return done({ ok: true, on });
  }

  if (seg[0] === "items" && seg[1] && seg[2] === "comments") {
    const gate = memberOnly(); if (gate) return gate;
    const text = String(v?.body ?? "").trim();
    if (!text) return json({ error: "empty comment" }, 400);
    const { id } = await keep(ctx, COMMENTS, null, {
      item_id: seg[1], parent_id: v?.parent_id ?? null, user_id: peer.user_id,
      user_name: peer.user_name, body: text, created_at: nowMs() });
    return done({ id });
  }

  if (seg[0] === "comments" && seg[1] && seg[2] === "delete") {
    const gate = memberOnly(); if (gate) return gate;
    const comments = await all(ctx, COMMENTS);
    const c = comments.find((x) => x.id === seg[1]);
    if (!c) return json({ error: "not found" }, 404);
    if (c.user_id !== peer.user_id && !isEditor) return json({ error: "not yours" }, 403);
    // Cascade: delete the comment and all descendant replies so no orphans remain.
    const toDelete = new Set<string>([seg[1]]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const x of comments) {
        if (x.parent_id && toDelete.has(x.parent_id) && !toDelete.has(x.id)) { toDelete.add(x.id); grew = true; }
      }
    }
    for (const id of toDelete) await rows(ctx, COMMENTS).delete(id);
    return done({ ok: true, deleted: toDelete.size });
  }

  return json({ error: "not found" }, 404);
}

export default {
  start(ctx: Ctx) {
    clearInterval(timers.get(ctx.frame));
    const check = () => refreshStale(ctx).catch((e) => ctx.log(`refreshing feeds: ${e instanceof Error ? e.message : e}`));
    timers.set(ctx.frame, setInterval(check, CHECK_EVERY_MS));
    check();
  },

  stop(ctx: Ctx) {
    clearInterval(timers.get(ctx.frame));
    timers.delete(ctx.frame);
  },

  async fetch(request: Request, ctx: Ctx): Promise<Response> {
    const { pathname, searchParams: qp } = new URL(request.url);
    const method = request.method;
    const peer = ctx.peer;
    const isEditor = peer.is_sfi_editor || peer.is_owner;
    const isMember = isEditor || peer.is_sfi_member;

    if (!pathname.startsWith("/api/")) {
      if (method !== "GET") return json({ error: "not found" }, 404);
      return ctx.file(pathname);
    }

    // Non-members get a definitive answer: the reading room is for members.
    if (pathname === "/api/bootstrap" && method === "GET" && !isMember) {
      return json({ ready: true, isMember: false });
    }

    // ---- Bootstrap (members) --------------------------------------------------
    if (pathname === "/api/bootstrap" && method === "GET") {
      const [groups, feeds, items, boosts] = await Promise.all([
        all(ctx, GROUPS), all(ctx, FEEDS), all(ctx, ITEMS), all(ctx, BOOSTS),
      ]);
      const myRead = await myReads(ctx);
      const boostedItems = new Set(boosts.map((f) => f.item_id));
      const perFeedUnread: Record<string, number> = {};
      for (const it of items) if (!myRead.has(it.id)) perFeedUnread[it.feed_id] = (perFeedUnread[it.feed_id] ?? 0) + 1;
      return json({
        ready: true, isMember: true, isEditor, isOwner: peer.is_owner, userId: peer.user_id,
        groups: groups.map((g) => ({ id: g.id, name: g.name, sort: g.sort ?? 0 })),
        feeds: feeds.map((f) => ({ id: f.id, title: f.title, url: f.url, site_url: f.site_url,
          group_id: f.group_id, last_fetched: f.last_fetched, last_error: f.last_error,
          unread: perFeedUnread[f.id] ?? 0 })),
        counts: { all: items.length, unread: items.filter((i) => !myRead.has(i.id)).length,
          boosted: items.filter((i) => boostedItems.has(i.id)).length },
      });
    }

    // ---- Every change, one path -----------------------------------------------
    if (method === "POST" || method === "PUT" || method === "DELETE") {
      return handleWrite(ctx, pathToOp(pathname, method), await readBody(request));
    }

    const m = pathname.match(/^\/api\/(feeds|groups|items|comments)(?:\/([^/]+))?(?:\/([a-z]+))?$/);

    // ---- Items list + detail (member read) ------------------------------------
    if (pathname === "/api/items" && method === "GET") {
      if (!isMember) return json({ error: "members only" }, 403);
      const view = qp.get("view") ?? "all", groupId = qp.get("group"), feedId = qp.get("feed");
      const q = (qp.get("q") ?? "").toLowerCase();
      const [items, feeds, boosts, comments] = await Promise.all([
        all(ctx, ITEMS), all(ctx, FEEDS), all(ctx, BOOSTS), all(ctx, COMMENTS),
      ]);
      const feedById = new Map(feeds.map((f) => [f.id, f]));
      const myRead = await myReads(ctx);
      const myBoost = new Set(boosts.filter((f) => f.user_id === peer.user_id).map((f) => f.item_id));
      const boostCount: Record<string, number> = {}, commentCount: Record<string, number> = {};
      for (const f of boosts) boostCount[f.item_id] = (boostCount[f.item_id] ?? 0) + 1;
      for (const c of comments) commentCount[c.item_id] = (commentCount[c.item_id] ?? 0) + 1;
      let list = items;
      if (feedId) list = list.filter((i) => i.feed_id === feedId);
      if (groupId) {
        const inGroup = new Set(feeds.filter((f) => f.group_id === groupId).map((f) => f.id));
        list = list.filter((i) => inGroup.has(i.feed_id));
      }
      if (view === "unread") list = list.filter((i) => !myRead.has(i.id));
      if (view === "boosted") list = list.filter((i) => (boostCount[i.id] ?? 0) > 0);
      if (q) list = list.filter((i) => (i.title + " " + (i.content ?? "")).toLowerCase().includes(q));
      list.sort((a, b) => (b.published_at ?? b.fetched_at) - (a.published_at ?? a.fetched_at));
      return json({ items: list.slice(0, 500).map((i) => ({
        id: i.id, feed_id: i.feed_id, feed_title: feedById.get(i.feed_id)?.title ?? "",
        title: i.title, link: i.link, author: i.author, published_at: i.published_at,
        read: myRead.has(i.id), boosted: myBoost.has(i.id), boost_count: boostCount[i.id] ?? 0, comment_count: commentCount[i.id] ?? 0,
      })) });
    }

    if (m && m[1] === "items" && m[2] && !m[3] && method === "GET") {
      if (!isMember) return json({ error: "members only" }, 403);
      const it = await rows(ctx, ITEMS).get(m[2]) as Row | null;
      if (!it) return json({ error: "not found" }, 404);
      const [boosts, comments] = await Promise.all([all(ctx, BOOSTS), all(ctx, COMMENTS)]);
      return json({
        item: { id: it.id, title: it.title, link: it.link, author: it.author,
          content: it.content, published_at: it.published_at, feed_id: it.feed_id },
        boosts: boosts.filter((f) => f.item_id === m[2]).map((f) => ({ user_id: f.user_id, user_name: f.user_name })),
        comments: comments.filter((c) => c.item_id === m[2])
          .sort((a, b) => a.created_at - b.created_at)
          .map((c) => ({ id: c.id, parent_id: c.parent_id, user_id: c.user_id, user_name: c.user_name, body: c.body, created_at: c.created_at })),
        read: (await myReads(ctx)).has(m[2]),
      });
    }

    return json({ error: "method not allowed" }, 405);
  },
};
