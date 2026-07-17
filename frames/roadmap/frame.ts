// ----------------------------------------------------------------------------------------
// Roadmap — a simple, robust project roadmapping tool (one roadmap per placement).
//
// Design axes:
//   privacy:        privacy-public-view  — non-members / Viewer-role members get a live
//                                          read-only view; space editors get the full UI.
//   data_storage:   storage-local-db     — LocalTables: encrypted at rest on the host,
//                                          scoped per placement so each placement is its
//                                          own independent roadmap. NOT peer-synced;
//                                          collaboration happens at the frontend layer —
//                                          all viewers talk to this one backend and refetch
//                                          on push.
//   view_realtime:  view-collaborative   — every mutation calls pushToInstance(sfi_id, …)
//                                          so all viewers of the placement refresh live.
//   settings_scope: settings-per-sfi     — project meta + links keyed by peer.sfi_id.
//
// Data model (all tables are per-placement LocalTables):
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
  declareTables, ensureTables, table, frameSettings,
} from "@frame-core";

// ----- LocalTables (encrypted, per-placement — no sfi_id columns needed) ----------------
declareTables([
  {
    key: "milestones",
    title: "Roadmap Milestones",
    description: "Milestones and parking buckets for this roadmap.",
    local: true,
    schema: [
      { name: "kind",         col_type: "text",    nullable: false, default_val: "milestone" }, // milestone | backburner | maybelater
      { name: "title",        col_type: "text",    nullable: false, default_val: "" },
      { name: "target_ms",    col_type: "integer", nullable: true },                            // only for milestones
      { name: "completed",    col_type: "integer", nullable: false, default_val: "0" },
      { name: "completed_ms", col_type: "integer", nullable: false, default_val: "0" },
      { name: "sort_order",   col_type: "integer", nullable: false, default_val: "0" },
      { name: "created_ms",   col_type: "integer", nullable: false, default_val: "0" },
    ],
  },
  {
    key: "tasks",
    title: "Roadmap Tasks",
    description: "Tasks, each belonging to one milestone or bucket.",
    local: true,
    schema: [
      { name: "milestone_id", col_type: "text",    nullable: false, default_val: "" },
      { name: "text",         col_type: "text",    nullable: false, default_val: "" },
      { name: "state",        col_type: "integer", nullable: false, default_val: "0" }, // 0 unstarted | 1 in-progress | 2 complete
      { name: "sort_order",   col_type: "integer", nullable: false, default_val: "0" },
      { name: "actor_id",     col_type: "text",    nullable: false, default_val: "" },
      { name: "actor_name",   col_type: "text",    nullable: false, default_val: "" },
      { name: "created_ms",   col_type: "integer", nullable: false, default_val: "0" },
      { name: "completed_ms", col_type: "integer", nullable: false, default_val: "0" }, // when it last entered state 2 (burn rate)
    ],
  },
]);

type Tbl = ReturnType<typeof table>;
type Settings = ReturnType<typeof frameSettings>;
interface Tables { settings: Settings; milestones: Tbl; tasks: Tbl; }

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

// ----- Buckets bootstrap ----------------------------------------------------------------
// Project meta (name/overview/links/accent/public_view) lives in the per-placement
// frameSettings store, which needs no seeding — getMeta reads keys with defaults.
async function ensurePlacement(t: Tables): Promise<void> {
  // Auto-create the two parking buckets once per placement. Each bucket is unique
  // by kind, so key its row by a stable id — a concurrent first-load then converges
  // on one row instead of forking duplicate buckets (the query-then-upsert(null) race).
  for (const b of BUCKETS) {
    const bucketId = `bucket:${b.kind}`;
    if (!(await t.milestones.get(bucketId))) {
      await t.milestones.upsert(bucketId, {
        kind: b.kind, title: b.title, target_ms: null,
        completed: 0, sort_order: b.sort_order, created_ms: Date.now(),
      });
    }
  }
}

// ----- Readers --------------------------------------------------------------------------
async function getMeta(t: Tables) {
  const [name, overview, accent, links, publicView] = await Promise.all([
    t.settings.get<string>("name"),
    t.settings.get<string>("overview"),
    t.settings.get<string>("accent"),
    t.settings.get<Array<{ label: string; url: string }>>("links"),
    t.settings.get<boolean>("public_view"),
  ]);
  return {
    name: name ?? "",
    overview: overview ?? "",
    accent: VALID_ACCENTS.has(accent ?? "") ? accent : "c4",
    links: Array.isArray(links) ? links : [],
    public_view: !!publicView,
  };
}

async function listMilestones(t: Tables) {
  const { rows } = await t.milestones.query({
    order_by: [{ col: "sort_order" }, { col: "_created_at" }],
  });
  return rows.map((r) => ({
    id: r._row_id, kind: r.kind, title: r.title, target_ms: r.target_ms,
    completed: r.completed, completed_ms: r.completed_ms, sort_order: r.sort_order,
  }));
}

async function listTasks(t: Tables) {
  const { rows } = await t.tasks.query({
    order_by: [{ col: "milestone_id" }, { col: "sort_order" }, { col: "_created_at" }],
  });
  return rows.map((r) => ({
    id: r._row_id, milestone_id: r.milestone_id, text: r.text, state: r.state,
    sort_order: r.sort_order, actor_name: r.actor_name,
    created_ms: r.created_ms, completed_ms: r.completed_ms,
  }));
}

async function snapshot(t: Tables) {
  return { meta: await getMeta(t), milestones: await listMilestones(t), tasks: await listTasks(t) };
}

function notify(sfiId: string) {
  pushToInstance(sfiId, { type: "roadmap_changed" });
}

// ----- Ownership guards -----------------------------------------------------------------
async function milestoneRow(t: Tables, id: string) {
  if (!id) return null;
  return await t.milestones.get(id);
}

async function nextTaskOrder(t: Tables, milestoneId: string): Promise<number> {
  return Number(await t.tasks.max("sort_order", { milestone_id: milestoneId }) ?? -1) + 1;
}

// Re-derive a milestone's completed flag from its tasks: it may only stay completed while
// every task is complete (state 2). Called after any task mutation.
async function reconcileMilestone(t: Tables, milestoneId: string): Promise<void> {
  const ms = await milestoneRow(t, milestoneId);
  if (!ms || ms.kind !== "milestone" || !ms.completed) return;
  const open = await t.tasks.query({ where: { milestone_id: milestoneId, state: { lt: 2 } }, limit: 1 });
  if (open.total > 0) {
    await t.milestones.upsert(milestoneId, { completed: 0, completed_ms: 0 });
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

  if (!sfiId) return jsonReply(replyPort, 400, { error: "sfi_id missing" });
  // Local tables are always ready; the gate stays so a future graduation to
  // synced tables needs no code change here.
  const ready = ensureTables(peer);
  if (!ready.ready) return jsonReply(replyPort, 503, { error: "table not bound" });
  const t: Tables = {
    settings: frameSettings(sfiId),
    milestones: table("milestones", sfiId),
    tasks: table("tasks", sfiId),
  };

  // Full read. Members always see it; non-members only when the editor has turned on
  // public viewing — otherwise they get a { private: true } marker and nothing else.
  if (reqPath === "/api/state" && method === "GET") {
    await ensurePlacement(t);
    const meta = await getMeta(t);
    if (!peer.is_sfi_member && !meta.public_view) return jsonReply(replyPort, 200, { private: true });
    return jsonReply(replyPort, 200, { meta, milestones: await listMilestones(t), tasks: await listTasks(t) });
  }

  // Everything below mutates — editor-only. Never gate on is_sfi_member (Viewer-role
  // members would slip through); gate on is_sfi_editor.
  const editorOnly = async () => {
    if (!peer.is_sfi_editor) { jsonReply(replyPort, 403, { error: "editors only" }); return false; }
    await ensurePlacement(t);
    return true;
  };
  const ok = async () => jsonReply(replyPort, 200, await snapshot(t));

  // ----- Project settings: name / overview / links / accent -----------------------------
  if (reqPath === "/api/settings" && method === "POST") {
    if (!(await editorOnly())) return;
    const v = parseJsonBody<{ name?: unknown; overview?: unknown; links?: unknown; accent?: unknown; public_view?: unknown }>(body);
    if (v?.public_view !== undefined) {
      await t.settings.set("public_view", !!(toIntOrNull(v.public_view) ?? 0));
    }
    if (v?.name !== undefined) {
      await t.settings.set("name", sanitizeText(v.name, MAX_NAME));
    }
    if (v?.overview !== undefined) {
      await t.settings.set("overview", sanitizeText(v.overview, MAX_OVERVIEW));
    }
    if (v?.accent !== undefined) {
      const a = sanitizeText(v.accent, 4);
      if (!VALID_ACCENTS.has(a)) return jsonReply(replyPort, 400, { error: "invalid accent" });
      await t.settings.set("accent", a);
    }
    if (v?.links !== undefined) {
      const raw = Array.isArray(v.links) ? v.links : [];
      const links = raw.slice(0, MAX_LINKS).map((l: any) => ({
        label: sanitizeText(l?.label, MAX_LABEL),
        url: sanitizeText(l?.url, MAX_URL).trim(),
      })).filter((l) => l.label && l.url && isSafeUrl(l.url));
      await t.settings.set("links", links);
    }
    await t.settings.set("updated_ms", Date.now());
    notify(sfiId);
    return await ok();
  }

  // ----- Milestones ---------------------------------------------------------------------
  if (reqPath === "/api/milestone/add" && method === "POST") {
    if (!(await editorOnly())) return;
    const v = parseJsonBody<{ title?: unknown; target_ms?: unknown }>(body);
    const title = sanitizeText(v?.title, MAX_TITLE) || "Untitled milestone";
    const target = v?.target_ms == null ? null : toIntOrNull(v.target_ms);
    // Real milestones sort ahead of the two buckets (which live at 1_000_000+).
    const next = Number(await t.milestones.max("sort_order", { kind: "milestone" }) ?? -1) + 1;
    await t.milestones.upsert(null, {
      kind: "milestone", title, target_ms: target, completed: 0,
      sort_order: next, created_ms: Date.now(),
    });
    notify(sfiId);
    return await ok();
  }

  if (reqPath.startsWith("/api/milestone/") && !reqPath.startsWith("/api/milestone/delete/")
      && reqPath !== "/api/milestone/add" && method === "POST") {
    if (!(await editorOnly())) return;
    const id = reqPath.slice("/api/milestone/".length);
    if (!id) return jsonReply(replyPort, 400, { error: "bad id" });
    const ms = await milestoneRow(t, id);
    if (!ms) return jsonReply(replyPort, 404, { error: "not found" });
    const v = parseJsonBody<{ title?: unknown; target_ms?: unknown; completed?: unknown }>(body);
    const isBucket = ms.kind !== "milestone";

    if (v?.title !== undefined && !isBucket) {
      await t.milestones.upsert(id, { title: sanitizeText(v.title, MAX_TITLE) || "Untitled milestone" });
    }
    if (v?.target_ms !== undefined && !isBucket) {
      const target = v.target_ms == null ? null : toIntOrNull(v.target_ms);
      await t.milestones.upsert(id, { target_ms: target });
    }
    if (v?.completed !== undefined && !isBucket) {
      const want = clampInt(toIntOrNull(v.completed) ?? 0, 0, 1);
      if (want === 1) {
        // Gate: every task must be complete first.
        const open = await t.tasks.query({ where: { milestone_id: id, state: { lt: 2 } }, limit: 1 });
        if (open.total > 0) {
          return jsonReply(replyPort, 409, { error: "finish all tasks before completing this milestone", open: open.total });
        }
        await t.milestones.upsert(id, { completed: 1, completed_ms: Date.now() });
      } else {
        await t.milestones.upsert(id, { completed: 0, completed_ms: 0 });
      }
    }
    notify(sfiId);
    return await ok();
  }

  if (reqPath.startsWith("/api/milestone/delete/") && method === "POST") {
    if (!(await editorOnly())) return;
    const id = reqPath.slice("/api/milestone/delete/".length);
    if (!id) return jsonReply(replyPort, 400, { error: "bad id" });
    const ms = await milestoneRow(t, id);
    if (!ms) return jsonReply(replyPort, 404, { error: "not found" });
    if (ms.kind !== "milestone") return jsonReply(replyPort, 400, { error: "buckets can't be deleted" });
    // Deleting a milestone deletes its tasks with it (the UI confirms with the count first).
    await t.tasks.deleteWhere({ milestone_id: id });
    await t.milestones.delete(id);
    notify(sfiId);
    return await ok();
  }

  // ----- Tasks --------------------------------------------------------------------------
  if (reqPath === "/api/task/add" && method === "POST") {
    if (!(await editorOnly())) return;
    const v = parseJsonBody<{ milestone_id?: unknown; text?: unknown; texts?: unknown }>(body);
    const milestoneId = typeof v?.milestone_id === "string" ? v.milestone_id : "";
    if (!milestoneId || !(await milestoneRow(t, milestoneId))) {
      return jsonReply(replyPort, 400, { error: "bad milestone" });
    }
    // `texts` (a pasted list → one task per line) takes precedence over the single
    // `text` (which may itself be multi-line, from a Shift+Enter task — kept as one row).
    let items: string[];
    if (Array.isArray(v?.texts)) {
      items = v.texts.map((x) => sanitizeText(x, MAX_TASK)).filter((s) => s.length > 0);
    } else {
      const txt = sanitizeText(v?.text, MAX_TASK);
      items = txt ? [txt] : [];
    }
    if (items.length === 0) return jsonReply(replyPort, 400, { error: "text required" });
    const now = Date.now();
    let order = await nextTaskOrder(t, milestoneId);
    for (const text of items) {
      await t.tasks.upsert(null, { milestone_id: milestoneId, text, state: 0, sort_order: order++, created_ms: now });
    }
    await reconcileMilestone(t, milestoneId); // fresh (unstarted) tasks reopen a "done" milestone
    notify(sfiId);
    return await ok();
  }

  if (reqPath.startsWith("/api/task/") && !reqPath.startsWith("/api/task/delete/")
      && reqPath !== "/api/task/add" && method === "POST") {
    if (!(await editorOnly())) return;
    const id = reqPath.slice("/api/task/".length);
    if (!id) return jsonReply(replyPort, 400, { error: "bad id" });
    const task = await t.tasks.get(id);
    if (!task) return jsonReply(replyPort, 404, { error: "not found" });
    const v = parseJsonBody<{ state?: unknown; text?: unknown; milestone_id?: unknown }>(body);

    if (v?.state !== undefined) {
      const state = clampInt(toIntOrNull(v.state) ?? 0, 0, 2);
      if (state === 0) {
        await t.tasks.upsert(id, { state: 0, actor_id: "", actor_name: "", completed_ms: 0 });
      } else {
        const actorName = sanitizeText(peer.user_name, 80) || "someone";
        const completedMs = state === 2 ? Date.now() : 0;
        await t.tasks.upsert(id, { state, actor_id: peer.user_id ?? "", actor_name: actorName, completed_ms: completedMs });
      }
    }
    if (v?.text !== undefined) {
      await t.tasks.upsert(id, { text: sanitizeText(v.text, MAX_TASK) });
    }
    // Move to another milestone/bucket (drag across lists appends to the destination end;
    // /api/tasks/reorder then fixes the exact position).
    if (v?.milestone_id !== undefined) {
      const dest = typeof v.milestone_id === "string" ? v.milestone_id : "";
      if (!dest || !(await milestoneRow(t, dest))) return jsonReply(replyPort, 400, { error: "bad milestone" });
      await t.tasks.upsert(id, { milestone_id: dest, sort_order: await nextTaskOrder(t, dest) });
      await reconcileMilestone(t, dest);
    }
    await reconcileMilestone(t, task.milestone_id as string);
    notify(sfiId);
    return await ok();
  }

  if (reqPath.startsWith("/api/task/delete/") && method === "POST") {
    if (!(await editorOnly())) return;
    const id = reqPath.slice("/api/task/delete/".length);
    if (!id) return jsonReply(replyPort, 400, { error: "bad id" });
    const task = await t.tasks.get(id);
    if (!task) return jsonReply(replyPort, 404, { error: "not found" });
    await t.tasks.delete(id);
    await reconcileMilestone(t, task.milestone_id as string); // deleting the last open task can complete a milestone's set
    notify(sfiId);
    return await ok();
  }

  // Reorder within one destination list (also used for cross-list drops): body carries the
  // destination milestone_id and the full ordered list of task ids that now live in it.
  if (reqPath === "/api/tasks/reorder" && method === "POST") {
    if (!(await editorOnly())) return;
    const v = parseJsonBody<{ milestone_id?: unknown; ids?: unknown }>(body);
    const dest = typeof v?.milestone_id === "string" ? v.milestone_id : "";
    if (!dest || !(await milestoneRow(t, dest))) return jsonReply(replyPort, 400, { error: "bad milestone" });
    const ids = Array.isArray(v?.ids)
      ? v.ids.filter((x): x is string => typeof x === "string" && !!x)
      : [];
    // Only touch ids that actually exist (never phantom-create via upsert).
    const { rows } = await t.tasks.query({});
    const known = new Set(rows.map((r) => r._row_id));
    for (let i = 0; i < ids.length; i++) {
      if (known.has(ids[i])) await t.tasks.upsert(ids[i], { milestone_id: dest, sort_order: i });
    }
    await reconcileMilestone(t, dest);
    notify(sfiId);
    return await ok();
  }

  return jsonReply(replyPort, 404, { error: "not found" });
};

log("Roadmap frame is up and running!");
