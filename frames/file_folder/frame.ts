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
//                                           and the sharing settings, are this session's keys.
//   view_realtime:  view-collaborative    — every change calls pushToInstance so all viewers
//                                           refresh live.
//   settings_scope: settings-per-session  — sessionKv `folder` and `prefs`.
// ----------------------------------------------------------------------------------------
import {
  log, jsonReply, parseJsonBody, parsePeerInfo, pushToInstance, sessionKv, spaceFiles,
  serveFileAtPath, clampInt, contentType, extname, onUiMessage,
} from "@frame-core";

type Peer = ReturnType<typeof parsePeerInfo>;
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

async function getPrefs(): Promise<Prefs> {
  let saved: Partial<Prefs> = {};
  try { saved = JSON.parse((await sessionKv.get("prefs"))?.value || "{}"); } catch { /* defaults */ }
  const p = { ...DEFAULT_PREFS, ...saved };
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
async function getFolder(): Promise<string> {
  return cleanFolder((await sessionKv.get("folder"))?.value) || DEFAULT_FOLDER;
}

// Reduce an incoming filename to a safe basename (no path traversal, no control chars).
function safeName(raw: unknown): string {
  let n = String(raw ?? "").split(/[\\/]/).pop() || "";
  n = n.replace(/[\x00-\x1f]/g, "").replace(/^\.+/, "").trim();
  if (n.length > 200) n = n.slice(0, 200);
  return n;
}

type FileRow = { id: string; name: string; size: number; link: boolean };
async function listFiles(folder: string): Promise<FileRow[]> {
  const entries = await spaceFiles.list(folder).catch(() => []);
  return entries.filter((e) => !e.dir)
    .map((e) => ({ id: e.name, name: e.name, size: e.bytes, link: e.link }))
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

function canAdd(peer: Peer, p: Prefs): boolean {
  return p.who_can_add === "editors" ? peer.is_sfi_editor : peer.is_owner;
}

async function stateFor(peer: Peer) {
  const prefs = await getPrefs(), folder = await getFolder();
  return {
    me: {
      is_anon: peer.is_anon, is_sfi_member: peer.is_sfi_member,
      is_sfi_editor: peer.is_sfi_editor, is_owner: peer.is_owner,
      user_name: peer.user_name,
    },
    prefs, folder,
    can_add: canAdd(peer, prefs),
    can_move: peer.is_sfi_editor,
    files: await listFiles(folder),
  };
}

// ----- Shared write logic ---------------------------------------------------------------
// The HTTP POST arms and the bus dispatcher (frame.busSend → onUiMessage) both land here, so
// the role gates cannot drift. `op` is the API path with the leading "api/" stripped. The
// binary upload (/api/upload) stays HTTP-only.
type WriteResult = { status: number; body: unknown };

async function handleWrite(sfiId: string, op: string, v: Record<string, unknown>, peer: Peer): Promise<WriteResult> {
  // Owner-only: this session's sharing preferences.
  if (op === "prefs") {
    if (!peer.is_owner) return { status: 403, body: { error: "owner only" } };
    const next: Prefs = {
      who_can_add: v.who_can_add === "editors" ? "editors" : "owner",
      max_size_mb: clampInt(Number(v.max_size_mb) || MAX_SIZE_MB, 1, MAX_SIZE_MB),
      max_files:   clampInt(Number(v.max_files) || DEFAULT_PREFS.max_files, 1, 1000),
    };
    await sessionKv.put("prefs", JSON.stringify(next));
    pushToInstance(sfiId, { type: "folder_changed" });
    return { status: 200, body: await stateFor(peer) };
  }

  // Editors: which folder of the space this session shows.
  if (op === "folder") {
    if (!peer.is_sfi_editor) return { status: 403, body: { error: "editors only" } };
    const folder = cleanFolder(v.folder);
    if (!folder) return { status: 400, body: { error: "not a folder of this space" } };
    await sessionKv.put("folder", folder);
    pushToInstance(sfiId, { type: "folder_changed" });
    return { status: 200, body: await stateFor(peer) };
  }

  // Delete — gated by who_can_add (same right as adding). Something linked in is not ours.
  if (op.startsWith("delete/")) {
    if (!canAdd(peer, await getPrefs())) return { status: 403, body: { error: "not allowed to delete files" } };
    const name = nameOnPath(op.slice("delete/".length));
    const folder = await getFolder();
    const f = (await listFiles(folder)).find((x) => x.name === name);
    if (!f) return { status: 404, body: { error: "not found" } };
    if (f.link) return { status: 403, body: { error: "linked in by someone; not this folder's to delete" } };
    await spaceFiles.remove(`${folder}/${name}`);
    pushToInstance(sfiId, { type: "folder_changed" });
    return { status: 200, body: await stateFor(peer) };
  }

  return { status: 404, body: { error: "not found" } };
}

// Fire-and-forget: denials are logged, not answered — a legitimate client never sends a
// write it isn't allowed to make, and every mutation confirms itself via pushToInstance.
onUiMessage(async (sfiId, data, peer) => {
  if (!sfiId || typeof data !== "object" || data === null) return;
  const { op, ...v } = data as Record<string, unknown>;
  if (typeof op !== "string") return;
  const r = await handleWrite(sfiId, op, v, peer);
  if (r.status !== 200) log(`file_folder: bus op ${op} → ${r.status} (${JSON.stringify(r.body)})`);
});

// ----- Networking -----------------------------------------------------------------------
self.onNetworkRequest = async function (replyPort, reqPath, method, headers, query, body, cookies) {
  const peer = parsePeerInfo(query, cookies);

  if (method === "GET" && !reqPath.startsWith("/api/")) {
    return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url), headers);
  }

  if (reqPath === "/api/state" && method === "GET") {
    return jsonReply(replyPort, 200, await stateFor(peer));
  }

  if ((reqPath === "/api/prefs" || reqPath === "/api/folder") && method === "POST") {
    const r = await handleWrite(peer.sfi_id, reqPath.slice("/api/".length), parseJsonBody<Record<string, unknown>>(body) || {}, peer);
    return jsonReply(replyPort, r.status, r.body);
  }

  // Upload — gated by who_can_add. Filename rides in ?name=, bytes are the raw body.
  if (reqPath === "/api/upload" && method === "POST") {
    const prefs = await getPrefs();
    if (!canAdd(peer, prefs)) return jsonReply(replyPort, 403, { error: "not allowed to add files" });
    const name = safeName(query.name);
    if (!name) return jsonReply(replyPort, 400, { error: "missing file name" });
    const folder = await getFolder();
    if ((await listFiles(folder)).length >= prefs.max_files) {
      return jsonReply(replyPort, 409, { error: `file limit reached (${prefs.max_files})` });
    }
    if (body.byteLength > prefs.max_size_mb * 1024 * 1024) {
      return jsonReply(replyPort, 413, { error: `file exceeds ${prefs.max_size_mb} MB` });
    }
    const taken = new Set((await spaceFiles.list(folder).catch(() => [])).map((e) => e.name));
    await spaceFiles.write(`${folder}/${freeName(name, taken)}`, new Uint8Array(body));
    pushToInstance(peer.sfi_id, { type: "folder_changed" });
    return jsonReply(replyPort, 200, await stateFor(peer));
  }

  // Download — open to everyone who reaches the frame, from this session's folder only.
  if (reqPath.startsWith("/api/download/") && method === "GET") {
    const name = nameOnPath(reqPath.slice("/api/download/".length));
    const buf = name ? await spaceFiles.read(`${await getFolder()}/${name}`).catch(() => null) : null;
    if (!buf) return jsonReply(replyPort, 404, { error: "not found" });
    const mime = contentType(extname(name)) || "application/octet-stream";
    return replyPort.postMessage({ status: 200, body: buf, contentType: mime }, [buf.buffer as ArrayBuffer]);
  }

  if (reqPath.startsWith("/api/delete/") && method === "POST") {
    const r = await handleWrite(peer.sfi_id, reqPath.slice("/api/".length), {}, peer);
    return jsonReply(replyPort, r.status, r.body);
  }

  return jsonReply(replyPort, 404, { error: "not found" });
};

log("File Folder frame is up and running!");
