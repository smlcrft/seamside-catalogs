// ----------------------------------------------------------------------------------------
// File Folder — a simple shared file bucket, one per placement (sfi_id).
//
// Design axes:
//   privacy:        privacy-public-view  — owner configures whether downloads are open to
//                                           anyone with the link or members-only, and whether
//                                           only the owner or all editors may add files.
//   data_storage:   storage-simple-files — files live on disk in the frame's data dir under a
//                                           per-sfi subfolder; a single prefs.json holds the
//                                           owner's per-sfi sharing settings. No DB / SyncTable.
//   view_realtime:  view-collaborative    — every change calls pushToInstance so all viewers
//                                           of the placement refresh live.
//   settings_scope: settings-per-sfi      — everything is keyed by peer.sfi_id.
// ----------------------------------------------------------------------------------------
import {
  log, jsonReply, parseJsonBody, parsePeerInfo, pushToInstance,
  loadJsonFile, saveJsonFile, frameDataDir, serveFileAtPath,
  clampInt, contentType, extname, path,
} from "@frame-core";

// ----- Per-sfi sharing preferences (single local JSON file: { [sfi_id]: Prefs }) --------
type Prefs = {
  who_can_add: "owner" | "editors";       // who may upload / delete
  who_can_download: "members" | "anyone";  // who may list / download
  max_size_mb: number;                     // per-file size cap
  max_files: number;                       // per-placement file count cap
};
const DEFAULT_PREFS: Prefs = {
  who_can_add: "owner",
  who_can_download: "members",
  max_size_mb: 100,
  max_files: 10,
};
const PREFS_FILE = "prefs.json";

function getPrefs(sfiId: string): Prefs {
  const all = loadJsonFile<Record<string, Partial<Prefs>>>(import.meta.url, PREFS_FILE, {});
  return { ...DEFAULT_PREFS, ...(all[sfiId] || {}) };
}
function setPrefs(sfiId: string, next: Prefs): void {
  const all = loadJsonFile<Record<string, Prefs>>(import.meta.url, PREFS_FILE, {});
  all[sfiId] = next;
  saveJsonFile(import.meta.url, PREFS_FILE, all);
}

// ----- Files on disk --------------------------------------------------------------------
// data/buckets/<sfi_slug>/<file_id>/<original_name>   — one file per id folder.
const BUCKETS_DIR = path.join(frameDataDir(import.meta.url), "buckets");

function sfiSlug(sfiId: string): string {
  return (sfiId || "").replace(/[^a-zA-Z0-9_-]/g, "_") || "default";
}
function bucketDir(sfiId: string): string {
  return path.join(BUCKETS_DIR, sfiSlug(sfiId));
}
// Reduce an incoming filename to a safe basename (no path traversal, no control chars).
function safeName(raw: unknown): string {
  let n = String(raw ?? "").split(/[\\/]/).pop() || "";
  n = n.replace(/[\x00-\x1f]/g, "").replace(/^\.+/, "").trim();
  if (n.length > 200) n = n.slice(0, 200);
  return n;
}
const ID_RE = /^[0-9a-fA-F-]{8,64}$/;

function listFiles(sfiId: string) {
  const dir = bucketDir(sfiId);
  let ids: Deno.DirEntry[];
  try { ids = [...Deno.readDirSync(dir)]; } catch { return []; }
  const out: { id: string; name: string; size: number; modified_ms: number }[] = [];
  for (const e of ids) {
    if (!e.isDirectory || !ID_RE.test(e.name)) continue;
    const inner = path.join(dir, e.name);
    let kid: Deno.DirEntry | undefined;
    try { kid = [...Deno.readDirSync(inner)].find((k) => k.isFile); } catch { continue; }
    if (!kid) continue;
    let size = 0, mtime = 0;
    try { const st = Deno.statSync(path.join(inner, kid.name)); size = st.size; mtime = st.mtime?.getTime() || 0; } catch { /* skip */ }
    out.push({ id: e.name, name: kid.name, size, modified_ms: mtime });
  }
  out.sort((a, b) => b.modified_ms - a.modified_ms);
  return out;
}
// Resolve the single stored file inside a given id folder (validated).
function fileInBucket(sfiId: string, id: string): { full: string; name: string } | null {
  if (!ID_RE.test(id)) return null;
  const inner = path.join(bucketDir(sfiId), id);
  try {
    const kid = [...Deno.readDirSync(inner)].find((k) => k.isFile);
    if (!kid) return null;
    return { full: path.join(inner, kid.name), name: kid.name };
  } catch { return null; }
}

// ----- Permission predicates ------------------------------------------------------------
function canAdd(peer: ReturnType<typeof parsePeerInfo>, p: Prefs): boolean {
  return p.who_can_add === "editors" ? peer.is_sfi_editor : peer.is_owner;
}
function canView(peer: ReturnType<typeof parsePeerInfo>, p: Prefs): boolean {
  return p.who_can_download === "anyone" ? true : peer.is_sfi_member;
}

function stateFor(peer: ReturnType<typeof parsePeerInfo>) {
  const prefs = getPrefs(peer.sfi_id);
  const view = canView(peer, prefs);
  return {
    me: {
      is_anon: peer.is_anon, is_sfi_member: peer.is_sfi_member,
      is_sfi_editor: peer.is_sfi_editor, is_owner: peer.is_owner,
      user_name: peer.user_name,
    },
    prefs,
    can_add: canAdd(peer, prefs),
    can_view: view,
    files: view ? listFiles(peer.sfi_id) : [],
  };
}

// ----- Networking -----------------------------------------------------------------------
self.onNetworkRequest = async function (replyPort, reqPath, method, headers, query, body, cookies) {
  const peer = parsePeerInfo(query, cookies);

  // Static assets — open to everyone (the read-only / gated views still need the shell).
  if (method === "GET" && !reqPath.startsWith("/api/")) {
    return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url), headers);
  }

  // Full UI state in one round trip.
  if (reqPath === "/api/state" && method === "GET") {
    return jsonReply(replyPort, 200, stateFor(peer));
  }

  // Owner-only: update this placement's sharing preferences.
  if (reqPath === "/api/prefs" && method === "POST") {
    if (!peer.is_owner) return jsonReply(replyPort, 403, { error: "owner only" });
    const v = parseJsonBody<Partial<Prefs>>(body) || {};
    const next: Prefs = {
      who_can_add:      v.who_can_add === "editors" ? "editors" : "owner",
      who_can_download: v.who_can_download === "anyone" ? "anyone" : "members",
      max_size_mb:      clampInt(Number(v.max_size_mb) || DEFAULT_PREFS.max_size_mb, 1, 1024),
      max_files:        clampInt(Number(v.max_files) || DEFAULT_PREFS.max_files, 1, 1000),
    };
    setPrefs(peer.sfi_id, next);
    pushToInstance(peer.sfi_id, { type: "folder_changed" });
    return jsonReply(replyPort, 200, stateFor(peer));
  }

  // Upload — gated by who_can_add. Filename rides in ?name=, bytes are the raw body.
  if (reqPath === "/api/upload" && method === "POST") {
    const prefs = getPrefs(peer.sfi_id);
    if (!canAdd(peer, prefs)) return jsonReply(replyPort, 403, { error: "not allowed to add files" });
    const name = safeName(query.name);
    if (!name) return jsonReply(replyPort, 400, { error: "missing file name" });
    if (listFiles(peer.sfi_id).length >= prefs.max_files) {
      return jsonReply(replyPort, 409, { error: `file limit reached (${prefs.max_files})` });
    }
    if (body.byteLength > prefs.max_size_mb * 1024 * 1024) {
      return jsonReply(replyPort, 413, { error: `file exceeds ${prefs.max_size_mb} MB` });
    }
    const id = crypto.randomUUID();
    const dir = path.join(bucketDir(peer.sfi_id), id);
    Deno.mkdirSync(dir, { recursive: true });
    Deno.writeFileSync(path.join(dir, name), new Uint8Array(body));
    pushToInstance(peer.sfi_id, { type: "folder_changed" });
    return jsonReply(replyPort, 200, stateFor(peer));
  }

  // Download — gated by who_can_download. Served as an attachment with the original name.
  if (reqPath.startsWith("/api/download/") && method === "GET") {
    const prefs = getPrefs(peer.sfi_id);
    if (!canView(peer, prefs)) return jsonReply(replyPort, 403, { error: "members only" });
    const found = fileInBucket(peer.sfi_id, reqPath.slice("/api/download/".length));
    if (!found) return jsonReply(replyPort, 404, { error: "not found" });
    let buf: Uint8Array;
    try { buf = Deno.readFileSync(found.full); } catch { return jsonReply(replyPort, 404, { error: "not found" }); }
    const mime = contentType(extname(found.name)) || "application/octet-stream";
    const asciiName = found.name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
    return replyPort.postMessage({
      status: 200, body: buf, contentType: mime,
      headers: { "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(found.name)}` },
    }, [buf.buffer]);
  }

  // Delete — gated by who_can_add (same right as adding).
  if (reqPath.startsWith("/api/delete/") && method === "POST") {
    const prefs = getPrefs(peer.sfi_id);
    if (!canAdd(peer, prefs)) return jsonReply(replyPort, 403, { error: "not allowed to delete files" });
    const id = reqPath.slice("/api/delete/".length);
    if (!ID_RE.test(id)) return jsonReply(replyPort, 400, { error: "bad id" });
    try { Deno.removeSync(path.join(bucketDir(peer.sfi_id), id), { recursive: true }); } catch { /* already gone */ }
    pushToInstance(peer.sfi_id, { type: "folder_changed" });
    return jsonReply(replyPort, 200, stateFor(peer));
  }

  return jsonReply(replyPort, 404, { error: "not found" });
};

log("File Folder frame is up and running!");
