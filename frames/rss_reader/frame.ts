import {
  log, serveFileAtPath, jsonReply, parseJsonBody, onUiMessage, pushToInstance,
  declareTables, ensureTables, table, parsePeerInfo,
} from "@frame-core";
import { parseFeed } from "./lib/parser.ts";
import { discoverFeedUrl, looksLikeFeed } from "./lib/discovery.ts";
import { sanitizeHtml } from "./lib/sanitize.ts";
import { planMerge, type ExistingItem } from "./lib/merge.ts";

const ITEM_CAP = 80;

declareTables([
  { key: "groups", title: "Groups", description: "Feed groups", local: true, schema: [
    { name: "name", col_type: "text", nullable: false },
    { name: "sort", col_type: "integer", nullable: true, default_val: "0" },
  ]},
  { key: "feeds", title: "Feeds", description: "Subscribed feeds", local: true, schema: [
    { name: "url", col_type: "text", nullable: false },
    { name: "site_url", col_type: "text", nullable: true },
    { name: "title", col_type: "text", nullable: false },
    { name: "group_id", col_type: "text", nullable: true },
    { name: "added_by", col_type: "text", nullable: true },
    { name: "last_fetched", col_type: "integer", nullable: true },
    { name: "last_error", col_type: "text", nullable: true },
  ]},
  { key: "items", title: "Items", description: "Feed items", local: true, schema: [
    { name: "feed_id", col_type: "text", nullable: false },
    { name: "guid", col_type: "text", nullable: false },
    { name: "title", col_type: "text", nullable: false },
    { name: "link", col_type: "text", nullable: true },
    { name: "author", col_type: "text", nullable: true },
    { name: "content", col_type: "text", nullable: true },
    { name: "published_at", col_type: "integer", nullable: true },
    { name: "fetched_at", col_type: "integer", nullable: false },
  ]},
  { key: "boosts", title: "Boosts", description: "Co-reader boosts", local: true, schema: [
    { name: "item_id", col_type: "text", nullable: false },
    { name: "user_id", col_type: "text", nullable: false },
    { name: "user_name", col_type: "text", nullable: true },
    { name: "created_at", col_type: "integer", nullable: false },
  ]},
  { key: "comments", title: "Comments", description: "Threaded comments", local: true, schema: [
    { name: "item_id", col_type: "text", nullable: false },
    { name: "parent_id", col_type: "text", nullable: true },
    { name: "user_id", col_type: "text", nullable: false },
    { name: "user_name", col_type: "text", nullable: true },
    { name: "body", col_type: "text", nullable: false },
    { name: "created_at", col_type: "integer", nullable: false },
  ]},
  { key: "reads", title: "Reads", description: "Per-user read state", local: true, schema: [
    { name: "item_id", col_type: "text", nullable: false },
    { name: "user_id", col_type: "text", nullable: false },
    { name: "read_at", col_type: "integer", nullable: false },
  ]},
]);

function nowMs(): number { return Date.now(); }

// deno-lint-ignore no-explicit-any
function readBody(body: any): any {
  try { return parseJsonBody(body) ?? {}; } catch { return {}; }
}

// ----- Fetching the open web ---------------------------------------------------------
// This frame declares `permissions.net: ["*"]`, because a reader has to be able to reach
// whatever the user subscribes to and there is no allowlist that could be written ahead of
// time. The platform answers that grant by running this worker in a SATELLITE PROCESS
// spawned with `--allow-net --deny-net=<loopback>`: it can reach the wider internet and is
// blocked from the user's own machine and local network, so a hostile feed URL cannot be
// turned into a probe of what is running on localhost. That deny list is the platform's to
// enforce, not ours — Deno worker permissions are allow-lists only, which is exactly why
// the sole-"*" case gets its own process (see arbiter.ts, SATELLITE WORKER HOST).
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

// deno-lint-ignore no-explicit-any
async function allRows(peer: any, key: string): Promise<any[]> {
  const t = table(key, peer.sfi_id);
  const { rows } = await t.query({ limit: 5000 });
  return rows;
}

// deno-lint-ignore no-explicit-any
async function cascadeItem(peer: any, itemRowId: string): Promise<void> {
  for (const key of ["reads", "boosts", "comments"]) {
    const t = table(key, peer.sfi_id);
    const rows = (await allRows(peer, key)).filter((r) => r.item_id === itemRowId);
    for (const r of rows) await t.delete(r._row_id);
  }
}

// deno-lint-ignore no-explicit-any
async function ingestFeed(peer: any, feedRowId: string, feedUrl: string): Promise<{ title: string; inserted: number }> {
  const resp = await fetchUrl(feedUrl);
  const parsed = parseFeed(resp.body, feedUrl);
  const itemsT = table("items", peer.sfi_id);
  const existingAll = await allRows(peer, "items");
  const existing: ExistingItem[] = existingAll.filter((i) => i.feed_id === feedRowId)
    .map((i) => ({ _row_id: i._row_id, guid: i.guid, published_at: i.published_at, fetched_at: i.fetched_at }));
  const { toInsert, toPrune } = planMerge(existing, parsed.items, ITEM_CAP);
  const ts = nowMs();
  for (const p of toInsert) {
    await itemsT.upsert(null, { feed_id: feedRowId, guid: p.guid, title: p.title, link: p.link,
      author: p.author, content: sanitizeHtml(p.content), published_at: p.published_at, fetched_at: ts });
  }
  for (const rid of toPrune) { await itemsT.delete(rid); await cascadeItem(peer, rid); }
  return { title: parsed.title, inserted: toInsert.length };
}

// ----- Writes ---------------------------------------------------------------------------
// ONE shared mutation path for both transports. `op` is the API path with "api/" stripped,
// so "items/<id>/boost" and "comments/<id>/delete" read the same on the wire as they did
// as URLs. Role gates live here, and every mutation ends by pushing — this frame promises
// co-readers and threaded comments, and before this nothing was live: two people never saw
// each other's comments without reloading by hand.
type WriteResult = { status: number; body: unknown };

/** Map an HTTP path+method onto the same op string the bus uses, so the fallback arm and
 * the tether arm cannot drift into different behaviour. */
function pathToOp(reqPath: string, method: string): string | null {
  if (!reqPath.startsWith("/api/")) return null;
  const rest = reqPath.slice("/api/".length);
  if (method === "DELETE") return rest + "/delete";
  return rest;   // POST /api/feeds -> "feeds";  PUT /api/feeds/<id> -> "feeds/<id>"
}

// deno-lint-ignore no-explicit-any
async function handleWrite(peer: any, op: string, v: any): Promise<WriteResult> {
  const sfiId = peer.sfi_id;
  const isEditor = !!peer.is_sfi_editor;
  const isMember = !!peer.is_sfi_member;
  const seg = op.split("/");

  // Reading along with everyone else is a member's right; changing what the room
  // subscribes to is an editor's. Never gate on is_sfi_member for editor work — a
  // Viewer-role member would slip through.
  const editorOnly = (): WriteResult | null => isEditor ? null : { status: 403, body: { error: "editors only" } };
  const memberOnly = (): WriteResult | null => isMember ? null : { status: 403, body: { error: "members only" } };

  const done = (body: unknown): WriteResult => {
    pushToInstance(sfiId, { type: "feeds_changed" });
    return { status: 200, body };
  };

  // ---- Feeds -------------------------------------------------------------------------
  if (op === "feeds") {
    const gate = editorOnly(); if (gate) return gate;
    const url = String(v?.url ?? "").trim();
    if (!url) return { status: 400, body: { error: "a url is required" } };
    let feedUrl = url;
    // Paste a site, get its feed: probe first, and if it isn't a feed look for one.
    try {
      const probe = await fetchUrl(feedUrl);
      if (!looksLikeFeed(probe.body)) {
        const discovered = discoverFeedUrl(probe.body, feedUrl);
        if (!discovered) return { status: 200, body: { error: "no feed found at that URL" } };
        feedUrl = discovered;
      }
    } catch (e) { return { status: 200, body: { error: String(e instanceof Error ? e.message : e) } }; }

    const feedsT = table("feeds", sfiId);
    const { row_id } = await feedsT.upsert(null, { url: feedUrl, site_url: url, title: feedUrl,
      group_id: null, added_by: peer.user_id, last_fetched: null, last_error: null });
    try {
      const { title } = await ingestFeed(peer, row_id, feedUrl);
      await feedsT.upsert(row_id, { title, last_fetched: nowMs(), last_error: null });
      return done({ id: row_id, title });
    } catch (e) {
      // The feed is kept with its error recorded rather than dropped: the subscription is
      // still what the person asked for, and a site that is down today may be up tomorrow.
      const msg = String(e instanceof Error ? e.message : e);
      await feedsT.upsert(row_id, { last_error: msg, last_fetched: nowMs() });
      return done({ id: row_id, title: feedUrl, warning: msg });
    }
  }
  if (seg[0] === "feeds" && seg[1] && seg[2] === "delete") {
    const gate = editorOnly(); if (gate) return gate;
    const items = (await allRows(peer, "items")).filter((i) => i.feed_id === seg[1]);
    for (const it of items) { await table("items", sfiId).delete(it._row_id); await cascadeItem(peer, it._row_id); }
    await table("feeds", sfiId).delete(seg[1]);
    return done({ ok: true });
  }
  if (seg[0] === "feeds" && seg[1] && !seg[2]) {
    const gate = editorOnly(); if (gate) return gate;
    const patch: Record<string, unknown> = {};
    if (v?.title !== undefined) patch.title = String(v.title);
    if (v?.group_id !== undefined) patch.group_id = v.group_id ?? null;
    if (Object.keys(patch).length) await table("feeds", sfiId).upsert(seg[1], patch);
    return done({ ok: true });
  }

  // ---- Groups ------------------------------------------------------------------------
  if (op === "groups") {
    const gate = editorOnly(); if (gate) return gate;
    const name = String(v?.name ?? "").trim();
    if (!name) return { status: 400, body: { error: "a name is required" } };
    const { row_id } = await table("groups", sfiId).upsert(null, { name, sort: 0 });
    return done({ id: row_id, name });
  }
  if (seg[0] === "groups" && seg[1] && seg[2] === "delete") {
    const gate = editorOnly(); if (gate) return gate;
    // Feeds outlive their group — losing a group must not lose what you subscribed to.
    const feeds = (await allRows(peer, "feeds")).filter((f) => f.group_id === seg[1]);
    for (const f of feeds) await table("feeds", sfiId).upsert(f._row_id, { group_id: null });
    await table("groups", sfiId).delete(seg[1]);
    return done({ ok: true });
  }
  if (seg[0] === "groups" && seg[1] && !seg[2]) {
    const gate = editorOnly(); if (gate) return gate;
    const patch: Record<string, unknown> = {};
    if (v?.name !== undefined) patch.name = String(v.name).trim();
    if (v?.sort !== undefined) patch.sort = Number(v.sort) || 0;
    if (Object.keys(patch).length) await table("groups", sfiId).upsert(seg[1], patch);
    return done({ ok: true });
  }

  // ---- Refresh -----------------------------------------------------------------------
  if (op === "refresh") {
    const gate = editorOnly(); if (gate) return gate;
    const feedId = v?.feed_id ? String(v.feed_id) : "";
    const feeds = (await allRows(peer, "feeds")).filter((f) => !feedId || f._row_id === feedId);
    const feedsT = table("feeds", sfiId);
    let inserted = 0;
    for (const f of feeds) {
      // One bad feed must not abort the sweep — record its error and carry on.
      try {
        const r = await ingestFeed(peer, f._row_id, f.url); inserted += r.inserted;
        await feedsT.upsert(f._row_id, { last_fetched: nowMs(), last_error: null });
      } catch (e) {
        await feedsT.upsert(f._row_id, { last_fetched: nowMs(), last_error: String(e instanceof Error ? e.message : e) });
      }
    }
    return done({ refreshed: feeds.length, inserted });
  }

  // ---- Read / boost / comment (member) -----------------------------------------------
  if (seg[0] === "items" && seg[1] && seg[2] === "read") {
    const gate = memberOnly(); if (gate) return gate;
    const readsT = table("reads", sfiId);
    const mine = (await allRows(peer, "reads")).find((r) => r.item_id === seg[1] && r.user_id === peer.user_id);
    const want = !!v?.read;
    if (want && !mine) await readsT.upsert(null, { item_id: seg[1], user_id: peer.user_id, read_at: nowMs() });
    if (!want && mine) await readsT.delete(mine._row_id);
    // Read state is PERSONAL, so it does not push: nobody else's view changes, and a
    // push here would make every j-keypress reload the room.
    return { status: 200, body: { ok: true, read: want } };
  }

  if (seg[0] === "items" && seg[1] && seg[2] === "boost") {
    const gate = memberOnly(); if (gate) return gate;
    const boostsT = table("boosts", sfiId);
    const mine = (await allRows(peer, "boosts")).find((f) => f.item_id === seg[1] && f.user_id === peer.user_id);
    const on = !!v?.on;
    if (on && !mine) await boostsT.upsert(null, { item_id: seg[1], user_id: peer.user_id, user_name: peer.user_name, created_at: nowMs() });
    if (!on && mine) await boostsT.delete(mine._row_id);
    return done({ ok: true, on });
  }

  if (seg[0] === "items" && seg[1] && seg[2] === "comments") {
    const gate = memberOnly(); if (gate) return gate;
    const text = String(v?.body ?? "").trim();
    if (!text) return { status: 400, body: { error: "empty comment" } };
    const { row_id } = await table("comments", sfiId).upsert(null, {
      item_id: seg[1], parent_id: v?.parent_id ?? null, user_id: peer.user_id,
      user_name: peer.user_name, body: text, created_at: nowMs() });
    return done({ id: row_id });
  }

  if (seg[0] === "comments" && seg[1] && seg[2] === "delete") {
    const gate = memberOnly(); if (gate) return gate;
    const all = await allRows(peer, "comments");
    const c = all.find((x) => x._row_id === seg[1]);
    if (!c) return { status: 404, body: { error: "not found" } };
    if (c.user_id !== peer.user_id && !isEditor) return { status: 403, body: { error: "not yours" } };
    // Cascade: delete the comment and all descendant replies so no orphans remain.
    const toDelete = new Set<string>([seg[1]]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const x of all) {
        if (x.parent_id && toDelete.has(x.parent_id) && !toDelete.has(x._row_id)) { toDelete.add(x._row_id); grew = true; }
      }
    }
    const commentsT = table("comments", sfiId);
    for (const id of toDelete) await commentsT.delete(id);
    return done({ ok: true, deleted: toDelete.size });
  }

  return { status: 404, body: { error: "not found" } };
}

// ----- Bus dispatcher — the frontend's write path (frame.busSend -> BusUiToFrame) -------
onUiMessage(async (sfiId, data, peer) => {
  if (!sfiId || typeof data !== "object" || data === null) return;
  const d = data as Record<string, unknown>;
  if (typeof d.op !== "string") return;
  const r = await handleWrite(peer, d.op, d);
  if (r.status !== 200) log(`rss_reader: bus op ${d.op} -> ${r.status} (${JSON.stringify(r.body)})`);
});

self.onNetworkRequest = async function (replyPort, reqPath, method, headers, query, body, cookies) {
  // Non-/api GET → serve the frontend (forward headers for 304 revalidation).
  if (method === "GET" && !reqPath.startsWith("/api/")) {
    return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url), headers);
  }

  const peer = parsePeerInfo(query, cookies);

  // Non-members get a definitive bootstrap answer without needing tables bound.
  if (reqPath === "/api/bootstrap" && method === "GET" && !peer.is_sfi_member) {
    return jsonReply(replyPort, 200, { ready: true, isMember: false });
  }

  const tables = await ensureTables(peer);
  if (!tables.ready) return jsonReply(replyPort, 503, { error: "waiting for owner" });

  // ---- Bootstrap (members) --------------------------------------------------
  if (reqPath === "/api/bootstrap" && method === "GET") {
    const [groups, feeds, items, boosts, reads] = await Promise.all([
      allRows(peer, "groups"), allRows(peer, "feeds"), allRows(peer, "items"),
      allRows(peer, "boosts"), allRows(peer, "reads"),
    ]);
    const myRead = new Set(reads.filter((r) => r.user_id === peer.user_id).map((r) => r.item_id));
    const boostedItems = new Set(boosts.map((f) => f.item_id));
    const perFeedUnread: Record<string, number> = {};
    for (const it of items) if (!myRead.has(it._row_id)) perFeedUnread[it.feed_id] = (perFeedUnread[it.feed_id] ?? 0) + 1;
    return jsonReply(replyPort, 200, {
      ready: true, isMember: true, isEditor: peer.is_sfi_editor, isOwner: peer.is_owner, userId: peer.user_id,
      groups: groups.map((g) => ({ id: g._row_id, name: g.name, sort: g.sort ?? 0 })),
      feeds: feeds.map((f) => ({ id: f._row_id, title: f.title, url: f.url, site_url: f.site_url,
        group_id: f.group_id, last_fetched: f.last_fetched, last_error: f.last_error,
        unread: perFeedUnread[f._row_id] ?? 0 })),
      counts: { all: items.length, unread: items.filter((i) => !myRead.has(i._row_id)).length,
        boosted: items.filter((i) => boostedItems.has(i._row_id)).length },
    });
  }

  // ---- Shared route helpers -------------------------------------------------
  const m = reqPath.match(/^\/api\/(feeds|groups|items|comments)(?:\/([^/]+))?(?:\/([a-z]+))?$/);
  const requireEditor = () => { if (!peer.is_sfi_editor) { jsonReply(replyPort, 403, { error: "editors only" }); return false; } return true; };
  const requireMember = () => { if (!peer.is_sfi_member) { jsonReply(replyPort, 403, { error: "members only" }); return false; } return true; };

  // ---- Every mutation, one path --------------------------------------------
  // Writes go over the tether (frame.busSend -> onUiMessage) because Android's webview
  // drops HTTP request bodies (#750); this HTTP arm stays for older viewers and for the
  // two calls whose RESULT the caller needs. Both entry points land in handleWrite, so
  // the role gates can never drift apart.
  if (method === "POST" || method === "PUT" || method === "DELETE") {
    const op = pathToOp(reqPath, method);
    if (!op) return jsonReply(replyPort, 404, { error: "not found" });
    const r = await handleWrite(peer, op, readBody(body));
    return jsonReply(replyPort, r.status, r.body);
  }

  // ---- Items list + detail (member read) ------------------------------------
  if (reqPath === "/api/items" && method === "GET") {
    if (!requireMember()) return;
    const qp = new URLSearchParams(query);
    const view = qp.get("view") ?? "all", groupId = qp.get("group"), feedId = qp.get("feed");
    const q = (qp.get("q") ?? "").toLowerCase();
    const [items, feeds, boosts, comments, reads] = await Promise.all([
      allRows(peer, "items"), allRows(peer, "feeds"), allRows(peer, "boosts"),
      allRows(peer, "comments"), allRows(peer, "reads"),
    ]);
    const feedById = new Map(feeds.map((f) => [f._row_id, f]));
    const myRead = new Set(reads.filter((r) => r.user_id === peer.user_id).map((r) => r.item_id));
    const myBoost = new Set(boosts.filter((f) => f.user_id === peer.user_id).map((f) => f.item_id));
    const boostCount: Record<string, number> = {}, commentCount: Record<string, number> = {};
    for (const f of boosts) boostCount[f.item_id] = (boostCount[f.item_id] ?? 0) + 1;
    for (const c of comments) commentCount[c.item_id] = (commentCount[c.item_id] ?? 0) + 1;
    let rows = items;
    if (feedId) rows = rows.filter((i) => i.feed_id === feedId);
    if (groupId) {
      const inGroup = new Set(feeds.filter((f) => f.group_id === groupId).map((f) => f._row_id));
      rows = rows.filter((i) => inGroup.has(i.feed_id));
    }
    if (view === "unread") rows = rows.filter((i) => !myRead.has(i._row_id));
    if (view === "boosted") rows = rows.filter((i) => (boostCount[i._row_id] ?? 0) > 0);
    if (q) rows = rows.filter((i) => (i.title + " " + (i.content ?? "")).toLowerCase().includes(q));
    rows.sort((a, b) => (b.published_at ?? b.fetched_at) - (a.published_at ?? a.fetched_at));
    return jsonReply(replyPort, 200, { items: rows.slice(0, 500).map((i) => ({
      id: i._row_id, feed_id: i.feed_id, feed_title: feedById.get(i.feed_id)?.title ?? "",
      title: i.title, link: i.link, author: i.author, published_at: i.published_at,
      read: myRead.has(i._row_id), boosted: myBoost.has(i._row_id), boost_count: boostCount[i._row_id] ?? 0, comment_count: commentCount[i._row_id] ?? 0,
    })) });
  }

  if (m && m[1] === "items" && m[2] && !m[3] && method === "GET") {
    if (!requireMember()) return;
    const items = await allRows(peer, "items");
    const it = items.find((i) => i._row_id === m[2]);
    if (!it) return jsonReply(replyPort, 404, { error: "not found" });
    const [boosts, comments, reads] = await Promise.all([allRows(peer, "boosts"), allRows(peer, "comments"), allRows(peer, "reads")]);
    return jsonReply(replyPort, 200, {
      item: { id: it._row_id, title: it.title, link: it.link, author: it.author,
        content: it.content, published_at: it.published_at, feed_id: it.feed_id },
      boosts: boosts.filter((f) => f.item_id === m[2]).map((f) => ({ user_id: f.user_id, user_name: f.user_name })),
      comments: comments.filter((c) => c.item_id === m[2])
        .sort((a, b) => a.created_at - b.created_at)
        .map((c) => ({ id: c._row_id, parent_id: c.parent_id, user_id: c.user_id, user_name: c.user_name, body: c.body, created_at: c.created_at })),
      read: reads.some((r) => r.user_id === peer.user_id && r.item_id === m[2]),
    });
  }

  return jsonReply(replyPort, 405, { error: "method not allowed" });
};
