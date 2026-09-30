// ----------------------------------------------------------------------------------------
// File Folder — a shared file drop over one folder of the space.
//
// Design axes:
//   privacy:        privacy-public-view  — anyone who can reach this frame can list and download
//                                           the folder's files; whether a non-member can reach it
//                                           at all is the platform's call (the space's tier and
//                                           whether the frame is published). The owner sets the
//                                           frame's write side: only they, or all editors.
//   data_storage:   storage-space-files  — the files are files of the space, in one folder
//                                           (default "File Folder/"), so they show in the space,
//                                           sync with it and open in other tools. Which folder,
//                                           and the sharing settings, are this session's settings.
//   view_realtime:  view-collaborative    — every change is pushed, so every open page reads
//                                           the folder again as whoever it is.
//   settings_scope: settings-per-session  — `__fc_settings` rows `folder` and `prefs`.
// ----------------------------------------------------------------------------------------
import type { Ctx, PeerInfo } from "@frame-core";
import { clampInt, contentType, extname } from "@frame-core";

type Prefs = {
  who_can_add: "owner" | "editors";       // who may upload / delete
  max_size_mb: number;                    // per-file size cap
  max_files: number;                      // per-folder file count cap
};
// A request reaches the worker whole up to 8 MiB and is refused past it, so no per-file
// limit can be larger.
const MAX_SIZE_MB = 8;
const DEFAULT_PREFS: Prefs = { who_can_add: "owner", max_size_mb: MAX_SIZE_MB, max_files: 10 };
const DEFAULT_FOLDER = "File Folder";

// Settings are rows of this session's own `__fc_settings`, the value as JSON under `v`.
const SETTINGS = "__fc_settings";

async function setSetting(ctx: Ctx, key: string, value: unknown) {
  const t = ctx.table<Record<string, unknown>>(SETTINGS);
  const was = await t.get(key), now = Date.now();
  await t.upsert({ ...(was ?? { _created_at: now }), id: key, v: JSON.stringify(value), _modified_at: now });
}

// A missing row is written on first read, from the session key an older copy kept (`prefs`
// as JSON, `folder` as text) or else the default, and the key goes: a key written at the
// door later is never taken up.
async function setting(ctx: Ctx, key: string, keyIsJson: boolean, fallback: unknown): Promise<unknown> {
  const row = await ctx.table<Record<string, unknown>>(SETTINGS).get(key);
  if (row?.v != null) {
    try { return JSON.parse(String(row.v)); } catch { return null; }
  }
  const old = await ctx.kv.get(key);
  let value: unknown = old?.value ?? fallback;
  if (keyIsJson && old?.value != null) {
    try { value = JSON.parse(old.value); } catch { value = fallback; }
  }
  await setSetting(ctx, key, value);
  if (old) await ctx.kv.del(key);
  return value;
}

async function getPrefs(ctx: Ctx): Promise<Prefs> {
  const saved = await setting(ctx, "prefs", true, DEFAULT_PREFS);
  const p = { ...DEFAULT_PREFS, ...(saved && typeof saved === "object" ? saved as Partial<Prefs> : {}) };
  return {
    who_can_add: p.who_can_add === "editors" ? "editors" : "owner",
    max_size_mb: clampInt(Number(p.max_size_mb) || MAX_SIZE_MB, 1, MAX_SIZE_MB),
    max_files: clampInt(Number(p.max_files) || DEFAULT_PREFS.max_files, 1, 1000),
  };
}

// A folder of the space as a clean relative path: no dot segments, never `_meta`.
function cleanFolder(raw: unknown): string | null {
  const parts = String(raw ?? "").split("/").map((s) => s.replace(/[\x00-\x1f]/g, "").trim()).filter(Boolean);
  if (!parts.length || parts.length > 8) return null;
  if (parts.some((p) => p.startsWith(".") || p === "_meta" || p.length > 120)) return null;
  return parts.join("/");
}
async function getFolder(ctx: Ctx): Promise<string> {
  return cleanFolder(await setting(ctx, "folder", false, DEFAULT_FOLDER)) || DEFAULT_FOLDER;
}

// Reduce an incoming filename to a safe basename (no path traversal, no control chars).
function safeName(raw: unknown): string {
  let n = String(raw ?? "").split(/[\\/]/).pop() || "";
  n = n.replace(/[\x00-\x1f]/g, "").replace(/^\.+/, "").trim();
  if (n.length > 200) n = n.slice(0, 200);
  return n;
}

type FileRow = { id: string; name: string; size: number };
async function listFiles(ctx: Ctx, folder: string): Promise<FileRow[]> {
  const entries = await ctx.files.list(folder).catch(() => []);
  return entries.filter((e) => !e.dir)
    .map((e) => ({ id: e.name, name: e.name, size: e.bytes }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
// A file's name as the page sends it on a path (encodeURIComponent).
function nameOnPath(raw: string): string {
  try { return safeName(decodeURIComponent(raw)); } catch { return safeName(raw); }
}
// A name not yet in the folder: "a.png", then "a (2).png", …
function freeName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  const ext = extname(name), stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 2; ; i++) if (!taken.has(`${stem} (${i})${ext}`)) return `${stem} (${i})${ext}`;
}

function canAdd(peer: PeerInfo, p: Prefs): boolean {
  return p.who_can_add === "editors" ? peer.is_sfi_editor : peer.is_owner;
}

async function stateFor(ctx: Ctx) {
  const peer = ctx.peer;
  const prefs = await getPrefs(ctx), folder = await getFolder(ctx);
  return {
    me: {
      is_anon: peer.is_anon, is_sfi_member: peer.is_sfi_member,
      is_sfi_editor: peer.is_sfi_editor, is_owner: peer.is_owner,
      user_name: peer.user_name,
    },
    prefs, folder,
    can_add: canAdd(peer, prefs),
    can_move: peer.is_sfi_editor,
    files: await listFiles(ctx, folder),
  };
}

// What changed, never what it holds: each page reads the folder again as whoever it is.
const tell = (ctx: Ctx, what: "files" | "settings") => ctx.push({ file_folder: what });

const json = (v: unknown, status = 200) => Response.json(v, { status });
const refuse = (status: number, error: string) => json({ error }, status);

// deno-lint-ignore no-explicit-any
async function body(request: Request): Promise<any> {
  try {
    const v = JSON.parse(await request.text());
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export default {
  async fetch(request: Request, ctx: Ctx): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;
    const peer = ctx.peer;

    if (!pathname.startsWith("/api/")) {
      if (method !== "GET") return refuse(404, "not found");
      return ctx.file(pathname);
    }

    if (pathname === "/api/state" && method === "GET") return json(await stateFor(ctx));

    // Owner-only: this session's sharing preferences.
    if (pathname === "/api/prefs" && method === "POST") {
      if (!peer.is_owner) return refuse(403, "owner only");
      const v = await body(request);
      const next: Prefs = {
        who_can_add: v.who_can_add === "editors" ? "editors" : "owner",
        max_size_mb: clampInt(Number(v.max_size_mb) || MAX_SIZE_MB, 1, MAX_SIZE_MB),
        max_files:   clampInt(Number(v.max_files) || DEFAULT_PREFS.max_files, 1, 1000),
      };
      await setSetting(ctx, "prefs", next);
      tell(ctx, "settings");
      return json(await stateFor(ctx));
    }

    // Editors: which folder of the space this session shows.
    if (pathname === "/api/folder" && method === "POST") {
      if (!peer.is_sfi_editor) return refuse(403, "editors only");
      const folder = cleanFolder((await body(request)).folder);
      if (!folder) return refuse(400, "not a folder of this space");
      await setSetting(ctx, "folder", folder);
      tell(ctx, "settings");
      return json(await stateFor(ctx));
    }

    // Upload — gated by who_can_add. Filename rides in ?name=, bytes are the raw body.
    if (pathname === "/api/upload" && method === "POST") {
      const prefs = await getPrefs(ctx);
      if (!canAdd(peer, prefs)) return refuse(403, "not allowed to add files");
      const name = safeName(url.searchParams.get("name"));
      if (!name) return refuse(400, "missing file name");
      const folder = await getFolder(ctx);
      if ((await listFiles(ctx, folder)).length >= prefs.max_files) {
        return refuse(409, `file limit reached (${prefs.max_files})`);
      }
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength > prefs.max_size_mb * 1024 * 1024) {
        return refuse(413, `file exceeds ${prefs.max_size_mb} MB`);
      }
      const taken = new Set((await ctx.files.list(folder).catch(() => [])).map((e) => e.name));
      await ctx.files.write(`${folder}/${freeName(name, taken)}`, bytes);
      tell(ctx, "files");
      return json(await stateFor(ctx));
    }

    // Download — open to everyone who reaches the frame, from this session's folder only.
    if (pathname.startsWith("/api/download/") && method === "GET") {
      const name = nameOnPath(pathname.slice("/api/download/".length));
      const buf = name ? await ctx.files.read(`${await getFolder(ctx)}/${name}`).catch(() => null) : null;
      if (!buf) return refuse(404, "not found");
      const mime = contentType(extname(name)) || "application/octet-stream";
      return new Response(buf as Uint8Array<ArrayBuffer>, { headers: { "content-type": mime } });
    }

    // Delete — gated by who_can_add (same right as adding).
    if (pathname.startsWith("/api/delete/") && method === "POST") {
      if (!canAdd(peer, await getPrefs(ctx))) return refuse(403, "not allowed to delete files");
      const name = nameOnPath(pathname.slice("/api/delete/".length));
      const folder = await getFolder(ctx);
      const f = (await listFiles(ctx, folder)).find((x) => x.name === name);
      if (!f) return refuse(404, "not found");
      await ctx.files.remove(`${folder}/${name}`);
      tell(ctx, "files");
      return json(await stateFor(ctx));
    }

    return refuse(404, "not found");
  },
};
