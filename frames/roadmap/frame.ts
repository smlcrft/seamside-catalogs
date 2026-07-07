// ----------------------------------------------------------------------------------------
// Roadmap — a simple, robust project roadmapping tool (one roadmap per placement).
//
// Design axes:
//   privacy:        privacy-public-view  — non-members / Viewer-role members get a live
//                                          read-only view; space editors get the full UI.
//   data_storage:   storage-local-db     — one lightweight local SQLite DB on the host,
//                                          every row scoped by sfi_id so each placement is
//                                          its own independent roadmap. NOT peer-synced;
//                                          collaboration happens at the frontend layer —
//                                          all viewers talk to this one backend and refetch
//                                          on push. SQLite keeps large task/milestone sets
//                                          fast to query and reorder.
//   view_realtime:  view-collaborative   — every mutation calls pushToInstance(sfi_id, …)
//                                          so all viewers of the placement refresh live.
//   settings_scope: settings-per-sfi     — project meta + links keyed by peer.sfi_id.
//
// Data model (all rows scoped by sfi_id):
//   meta        one row per placement — project name, overview, links (JSON), accent.
//   milestones  real milestones (kind='milestone', with a target date + completed flag)
//               PLUS two auto-created singleton buckets, kind='backburner' / 'maybelater',
//               which hold parked tasks and never appear on the timeline.
//   tasks       3-state tasks (0 unstarted / 1 in-progress / 2 complete), each belonging to
//               exactly one milestone or bucket, ordered within it by sort_order.
//
// Rules enforced here (not just in the UI):
//   - A milestone may only be marked completed when every one of its tasks is complete.
//   - Reopening a task inside a completed milestone auto-clears the milestone's completed flag.
//   - The two buckets can't be renamed away, deleted, dated, or completed.
// ----------------------------------------------------------------------------------------
import {
  log, serveFileAtPath, jsonReply, parseJsonBody, parsePeerInfo,
  pushToInstance, sanitizeText, toIntOrNull, clampInt,
  DatabaseSync, path, frameDataDir,
} from "@frame-core";

// ----- Local SQLite (per-host; every row scoped by sfi_id) ------------------------------
const db = new DatabaseSync(path.join(frameDataDir(import.meta.url), "roadmap.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    sfi_id     TEXT PRIMARY KEY,
    name       TEXT    NOT NULL DEFAULT '',
    overview   TEXT    NOT NULL DEFAULT '',
    links_json TEXT    NOT NULL DEFAULT '[]',
    accent     TEXT    NOT NULL DEFAULT 'c4',
    updated_ms INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS milestones (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    sfi_id       TEXT    NOT NULL,
    kind         TEXT    NOT NULL DEFAULT 'milestone',   -- milestone | backburner | maybelater
    title        TEXT    NOT NULL DEFAULT '',
    target_ms    INTEGER,                                 -- nullable; only for milestones
    completed    INTEGER NOT NULL DEFAULT 0,
    completed_ms INTEGER NOT NULL DEFAULT 0,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    created_ms   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ms_sfi ON milestones (sfi_id, sort_order, id);

  CREATE TABLE IF NOT EXISTS tasks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    sfi_id       TEXT    NOT NULL,
    milestone_id INTEGER NOT NULL,
    text         TEXT    NOT NULL DEFAULT '',
    state        INTEGER NOT NULL DEFAULT 0,              -- 0 unstarted | 1 in-progress | 2 complete
    sort_order   INTEGER NOT NULL DEFAULT 0,
    actor_id     TEXT    NOT NULL DEFAULT '',
    actor_name   TEXT    NOT NULL DEFAULT '',
    created_ms   INTEGER NOT NULL,
    completed_ms INTEGER NOT NULL DEFAULT 0               -- when it last entered state 2 (burn rate)
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_sfi ON tasks (sfi_id, milestone_id, sort_order, id);
`);

// Back-fill for placements created before public_view existed. Default 0 = private:
// non-members see nothing until an editor opts the roadmap into public viewing.
try { db.exec("ALTER TABLE meta ADD COLUMN public_view INTEGER NOT NULL DEFAULT 0"); } catch { /* already present */ }

// ----- Constants ------------------------------------------------------------------------
const MAX_NAME = 160;
const MAX_OVERVIEW = 600;
const MAX_TITLE = 200;
const MAX_TASK = 1000;
const MAX_LABEL = 80;
const MAX_URL = 2048;
const MAX_LINKS = 12;
const VALID_ACCENTS = new Set(
  Array.from({ length: 12 }, (_, i) => "c" + (i + 1)),
);
const BUCKETS: Array<{ kind: string; title: string; sort_order: number }> = [
  { kind: "backburner", title: "Back Burner", sort_order: 1_000_000 },
  { kind: "maybelater", title: "Maybe Later", sort_order: 1_000_001 },
];

function isSafeUrl(u: string): boolean {
  return /^https?:\/\//i.test(u.trim());
}

// ----- Meta + buckets bootstrap ---------------------------------------------------------
function ensurePlacement(sfiId: string): void {
  if (!sfiId) return;
  const has = db.prepare("SELECT sfi_id FROM meta WHERE sfi_id = ?").get(sfiId);
  if (!has) {
    db.prepare(
      "INSERT INTO meta (sfi_id, name, overview, links_json, accent, updated_ms) VALUES (?, '', '', '[]', 'c4', ?)",
    ).run(sfiId, Date.now());
  }
  // Auto-create the two parking buckets once per placement.
  for (const b of BUCKETS) {
    const exists = db.prepare(
      "SELECT id FROM milestones WHERE sfi_id = ? AND kind = ?",
    ).get(sfiId, b.kind);
    if (!exists) {
      db.prepare(
        "INSERT INTO milestones (sfi_id, kind, title, target_ms, completed, sort_order, created_ms) VALUES (?, ?, ?, NULL, 0, ?, ?)",
      ).run(sfiId, b.kind, b.title, b.sort_order, Date.now());
    }
  }
}

// ----- Readers --------------------------------------------------------------------------
function getMeta(sfiId: string) {
  const m = db.prepare(
    "SELECT name, overview, links_json, accent, public_view FROM meta WHERE sfi_id = ?",
  ).get(sfiId) as { name: string; overview: string; links_json: string; accent: string; public_view: number } | undefined;
  let links: Array<{ label: string; url: string }> = [];
  try { links = JSON.parse(m?.links_json ?? "[]"); } catch { links = []; }
  return {
    name: m?.name ?? "",
    overview: m?.overview ?? "",
    accent: VALID_ACCENTS.has(m?.accent ?? "") ? m!.accent : "c4",
    links: Array.isArray(links) ? links : [],
    public_view: !!m?.public_view,
  };
}

function listMilestones(sfiId: string) {
  return db.prepare(
    "SELECT id, kind, title, target_ms, completed, completed_ms, sort_order FROM milestones WHERE sfi_id = ? ORDER BY sort_order, id",
  ).all(sfiId);
}

function listTasks(sfiId: string) {
  return db.prepare(
    "SELECT id, milestone_id, text, state, sort_order, actor_name, created_ms, completed_ms FROM tasks WHERE sfi_id = ? ORDER BY milestone_id, sort_order, id",
  ).all(sfiId);
}

function snapshot(sfiId: string) {
  return { meta: getMeta(sfiId), milestones: listMilestones(sfiId), tasks: listTasks(sfiId) };
}

function notify(sfiId: string) {
  pushToInstance(sfiId, { type: "roadmap_changed" });
}

// ----- Ownership guards -----------------------------------------------------------------
function milestoneRow(sfiId: string, id: number) {
  return db.prepare("SELECT id, kind, completed FROM milestones WHERE id = ? AND sfi_id = ?").get(id, sfiId) as
    | { id: number; kind: string; completed: number }
    | undefined;
}

function nextTaskOrder(sfiId: string, milestoneId: number): number {
  const row = db.prepare(
    "SELECT COALESCE(MAX(sort_order), -1) AS m FROM tasks WHERE sfi_id = ? AND milestone_id = ?",
  ).get(sfiId, milestoneId) as { m: number };
  return row.m + 1;
}

// Re-derive a milestone's completed flag from its tasks: it may only stay completed while
// every task is complete (state 2). Called after any task mutation.
function reconcileMilestone(sfiId: string, milestoneId: number): void {
  const ms = milestoneRow(sfiId, milestoneId);
  if (!ms || ms.kind !== "milestone" || !ms.completed) return;
  const open = db.prepare(
    "SELECT COUNT(*) AS n FROM tasks WHERE sfi_id = ? AND milestone_id = ? AND state < 2",
  ).get(sfiId, milestoneId) as { n: number };
  if (open.n > 0) {
    db.prepare("UPDATE milestones SET completed = 0, completed_ms = 0 WHERE id = ? AND sfi_id = ?")
      .run(milestoneId, sfiId);
  }
}

// ----- Networking -----------------------------------------------------------------------
self.onNetworkRequest = async function (replyPort, reqPath, method, headers, query, body, cookies) {
  const peer = parsePeerInfo(query, cookies);
  const sfiId = peer.sfi_id;

  // Static assets — open to everyone, including anon read-only viewers.
  if (method === "GET" && !reqPath.startsWith("/api/")) {
    return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url), headers);
  }

  // Identity probe — drives which render mode the frontend shows.
  if (reqPath === "/api/whoami" && method === "GET") {
    return jsonReply(replyPort, 200, {
      is_anon: peer.is_anon,
      is_sfi_member: peer.is_sfi_member,
      is_sfi_editor: peer.is_sfi_editor,
      is_owner: peer.is_owner,
      user_id: peer.user_id,
      user_name: peer.user_name,
    });
  }

  // Full read. Members always see it; non-members only when the editor has turned on
  // public viewing — otherwise they get a { private: true } marker and nothing else.
  if (reqPath === "/api/state" && method === "GET") {
    if (!sfiId) return jsonReply(replyPort, 200, { meta: getMeta(""), milestones: [], tasks: [] });
    ensurePlacement(sfiId);
    const meta = getMeta(sfiId);
    if (!peer.is_sfi_member && !meta.public_view) return jsonReply(replyPort, 200, { private: true });
    return jsonReply(replyPort, 200, { meta, milestones: listMilestones(sfiId), tasks: listTasks(sfiId) });
  }

  // Everything below mutates — editor-only. Never gate on is_sfi_member (Viewer-role
  // members would slip through); gate on is_sfi_editor.
  const editorOnly = () => {
    if (!peer.is_sfi_editor) { jsonReply(replyPort, 403, { error: "editors only" }); return false; }
    if (!sfiId) { jsonReply(replyPort, 400, { error: "sfi_id missing" }); return false; }
    ensurePlacement(sfiId);
    return true;
  };
  const ok = () => jsonReply(replyPort, 200, snapshot(sfiId));

  // ----- Project settings: name / overview / links / accent -----------------------------
  if (reqPath === "/api/settings" && method === "POST") {
    if (!editorOnly()) return;
    const v = parseJsonBody<{ name?: unknown; overview?: unknown; links?: unknown; accent?: unknown; public_view?: unknown }>(body);
    if (v?.public_view !== undefined) {
      const on = (toIntOrNull(v.public_view) ?? 0) ? 1 : 0;
      db.prepare("UPDATE meta SET public_view = ?, updated_ms = ? WHERE sfi_id = ?").run(on, Date.now(), sfiId);
    }
    if (v?.name !== undefined) {
      db.prepare("UPDATE meta SET name = ?, updated_ms = ? WHERE sfi_id = ?")
        .run(sanitizeText(v.name, MAX_NAME), Date.now(), sfiId);
    }
    if (v?.overview !== undefined) {
      db.prepare("UPDATE meta SET overview = ?, updated_ms = ? WHERE sfi_id = ?")
        .run(sanitizeText(v.overview, MAX_OVERVIEW), Date.now(), sfiId);
    }
    if (v?.accent !== undefined) {
      const a = sanitizeText(v.accent, 4);
      if (!VALID_ACCENTS.has(a)) return jsonReply(replyPort, 400, { error: "invalid accent" });
      db.prepare("UPDATE meta SET accent = ?, updated_ms = ? WHERE sfi_id = ?").run(a, Date.now(), sfiId);
    }
    if (v?.links !== undefined) {
      const raw = Array.isArray(v.links) ? v.links : [];
      const links = raw.slice(0, MAX_LINKS).map((l: any) => ({
        label: sanitizeText(l?.label, MAX_LABEL),
        url: sanitizeText(l?.url, MAX_URL).trim(),
      })).filter((l) => l.label && l.url && isSafeUrl(l.url));
      db.prepare("UPDATE meta SET links_json = ?, updated_ms = ? WHERE sfi_id = ?")
        .run(JSON.stringify(links), Date.now(), sfiId);
    }
    notify(sfiId);
    return ok();
  }

  // ----- Milestones ---------------------------------------------------------------------
  if (reqPath === "/api/milestone/add" && method === "POST") {
    if (!editorOnly()) return;
    const v = parseJsonBody<{ title?: unknown; target_ms?: unknown }>(body);
    const title = sanitizeText(v?.title, MAX_TITLE) || "Untitled milestone";
    const target = v?.target_ms == null ? null : toIntOrNull(v.target_ms);
    // Real milestones sort ahead of the two buckets (which live at 1_000_000+).
    const row = db.prepare(
      "SELECT COALESCE(MAX(sort_order), -1) AS m FROM milestones WHERE sfi_id = ? AND kind = 'milestone'",
    ).get(sfiId) as { m: number };
    db.prepare(
      "INSERT INTO milestones (sfi_id, kind, title, target_ms, completed, sort_order, created_ms) VALUES (?, 'milestone', ?, ?, 0, ?, ?)",
    ).run(sfiId, title, target, row.m + 1, Date.now());
    notify(sfiId);
    return ok();
  }

  if (reqPath.startsWith("/api/milestone/") && !reqPath.startsWith("/api/milestone/delete/")
      && reqPath !== "/api/milestone/add" && method === "POST") {
    if (!editorOnly()) return;
    const id = toIntOrNull(reqPath.slice("/api/milestone/".length));
    if (id == null) return jsonReply(replyPort, 400, { error: "bad id" });
    const ms = milestoneRow(sfiId, id);
    if (!ms) return jsonReply(replyPort, 404, { error: "not found" });
    const v = parseJsonBody<{ title?: unknown; target_ms?: unknown; completed?: unknown }>(body);
    const isBucket = ms.kind !== "milestone";

    if (v?.title !== undefined && !isBucket) {
      db.prepare("UPDATE milestones SET title = ? WHERE id = ? AND sfi_id = ?")
        .run(sanitizeText(v.title, MAX_TITLE) || "Untitled milestone", id, sfiId);
    }
    if (v?.target_ms !== undefined && !isBucket) {
      const target = v.target_ms == null ? null : toIntOrNull(v.target_ms);
      db.prepare("UPDATE milestones SET target_ms = ? WHERE id = ? AND sfi_id = ?").run(target, id, sfiId);
    }
    if (v?.completed !== undefined && !isBucket) {
      const want = clampInt(toIntOrNull(v.completed) ?? 0, 0, 1);
      if (want === 1) {
        // Gate: every task must be complete first.
        const open = db.prepare(
          "SELECT COUNT(*) AS n FROM tasks WHERE sfi_id = ? AND milestone_id = ? AND state < 2",
        ).get(sfiId, id) as { n: number };
        if (open.n > 0) {
          return jsonReply(replyPort, 409, { error: "finish all tasks before completing this milestone", open: open.n });
        }
        db.prepare("UPDATE milestones SET completed = 1, completed_ms = ? WHERE id = ? AND sfi_id = ?")
          .run(Date.now(), id, sfiId);
      } else {
        db.prepare("UPDATE milestones SET completed = 0, completed_ms = 0 WHERE id = ? AND sfi_id = ?")
          .run(id, sfiId);
      }
    }
    notify(sfiId);
    return ok();
  }

  if (reqPath.startsWith("/api/milestone/delete/") && method === "POST") {
    if (!editorOnly()) return;
    const id = toIntOrNull(reqPath.slice("/api/milestone/delete/".length));
    if (id == null) return jsonReply(replyPort, 400, { error: "bad id" });
    const ms = milestoneRow(sfiId, id);
    if (!ms) return jsonReply(replyPort, 404, { error: "not found" });
    if (ms.kind !== "milestone") return jsonReply(replyPort, 400, { error: "buckets can't be deleted" });
    // Deleting a milestone deletes its tasks with it (the UI confirms with the count first).
    db.prepare("DELETE FROM tasks WHERE milestone_id = ? AND sfi_id = ?").run(id, sfiId);
    db.prepare("DELETE FROM milestones WHERE id = ? AND sfi_id = ?").run(id, sfiId);
    notify(sfiId);
    return ok();
  }

  // ----- Tasks --------------------------------------------------------------------------
  if (reqPath === "/api/task/add" && method === "POST") {
    if (!editorOnly()) return;
    const v = parseJsonBody<{ milestone_id?: unknown; text?: unknown }>(body);
    const milestoneId = toIntOrNull(v?.milestone_id);
    if (milestoneId == null || !milestoneRow(sfiId, milestoneId)) {
      return jsonReply(replyPort, 400, { error: "bad milestone" });
    }
    const text = sanitizeText(v?.text, MAX_TASK);
    if (!text) return jsonReply(replyPort, 400, { error: "text required" });
    db.prepare(
      "INSERT INTO tasks (sfi_id, milestone_id, text, state, sort_order, created_ms) VALUES (?, ?, ?, 0, ?, ?)",
    ).run(sfiId, milestoneId, text, nextTaskOrder(sfiId, milestoneId), Date.now());
    reconcileMilestone(sfiId, milestoneId); // a fresh (unstarted) task reopens a "done" milestone
    notify(sfiId);
    return ok();
  }

  if (reqPath.startsWith("/api/task/") && !reqPath.startsWith("/api/task/delete/")
      && reqPath !== "/api/task/add" && method === "POST") {
    if (!editorOnly()) return;
    const id = toIntOrNull(reqPath.slice("/api/task/".length));
    if (id == null) return jsonReply(replyPort, 400, { error: "bad id" });
    const task = db.prepare("SELECT id, milestone_id FROM tasks WHERE id = ? AND sfi_id = ?")
      .get(id, sfiId) as { id: number; milestone_id: number } | undefined;
    if (!task) return jsonReply(replyPort, 404, { error: "not found" });
    const v = parseJsonBody<{ state?: unknown; text?: unknown; milestone_id?: unknown }>(body);

    if (v?.state !== undefined) {
      const state = clampInt(toIntOrNull(v.state) ?? 0, 0, 2);
      if (state === 0) {
        db.prepare("UPDATE tasks SET state = 0, actor_id = '', actor_name = '', completed_ms = 0 WHERE id = ? AND sfi_id = ?")
          .run(id, sfiId);
      } else {
        const actorName = sanitizeText(peer.user_name, 80) || "someone";
        const completedMs = state === 2 ? Date.now() : 0;
        db.prepare("UPDATE tasks SET state = ?, actor_id = ?, actor_name = ?, completed_ms = ? WHERE id = ? AND sfi_id = ?")
          .run(state, peer.user_id ?? "", actorName, completedMs, id, sfiId);
      }
    }
    if (v?.text !== undefined) {
      const text = sanitizeText(v.text, MAX_TASK);
      db.prepare("UPDATE tasks SET text = ? WHERE id = ? AND sfi_id = ?").run(text, id, sfiId);
    }
    // Move to another milestone/bucket (drag across lists appends to the destination end;
    // /api/tasks/reorder then fixes the exact position).
    if (v?.milestone_id !== undefined) {
      const dest = toIntOrNull(v.milestone_id);
      if (dest == null || !milestoneRow(sfiId, dest)) return jsonReply(replyPort, 400, { error: "bad milestone" });
      db.prepare("UPDATE tasks SET milestone_id = ?, sort_order = ? WHERE id = ? AND sfi_id = ?")
        .run(dest, nextTaskOrder(sfiId, dest), id, sfiId);
      reconcileMilestone(sfiId, dest);
    }
    reconcileMilestone(sfiId, task.milestone_id);
    notify(sfiId);
    return ok();
  }

  if (reqPath.startsWith("/api/task/delete/") && method === "POST") {
    if (!editorOnly()) return;
    const id = toIntOrNull(reqPath.slice("/api/task/delete/".length));
    if (id == null) return jsonReply(replyPort, 400, { error: "bad id" });
    const task = db.prepare("SELECT milestone_id FROM tasks WHERE id = ? AND sfi_id = ?")
      .get(id, sfiId) as { milestone_id: number } | undefined;
    if (!task) return jsonReply(replyPort, 404, { error: "not found" });
    db.prepare("DELETE FROM tasks WHERE id = ? AND sfi_id = ?").run(id, sfiId);
    reconcileMilestone(sfiId, task.milestone_id); // deleting the last open task can complete a milestone's set
    notify(sfiId);
    return ok();
  }

  // Reorder within one destination list (also used for cross-list drops): body carries the
  // destination milestone_id and the full ordered list of task ids that now live in it.
  if (reqPath === "/api/tasks/reorder" && method === "POST") {
    if (!editorOnly()) return;
    const v = parseJsonBody<{ milestone_id?: unknown; ids?: unknown }>(body);
    const dest = toIntOrNull(v?.milestone_id);
    if (dest == null || !milestoneRow(sfiId, dest)) return jsonReply(replyPort, 400, { error: "bad milestone" });
    const ids = Array.isArray(v?.ids)
      ? v.ids.map((x) => toIntOrNull(x)).filter((x): x is number => x != null)
      : [];
    const update = db.prepare(
      "UPDATE tasks SET milestone_id = ?, sort_order = ? WHERE id = ? AND sfi_id = ?",
    );
    ids.forEach((id, i) => update.run(dest, i, id, sfiId));
    reconcileMilestone(sfiId, dest);
    notify(sfiId);
    return ok();
  }

  return jsonReply(replyPort, 404, { error: "not found" });
};

log("Roadmap frame is up and running!");
