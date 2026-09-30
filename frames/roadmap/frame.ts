// ----------------------------------------------------------------------------------------
// Roadmap — a simple, robust project roadmapping tool (one roadmap per space).
//
// Design axes:
//   privacy:        privacy-public-view  — non-members / Viewer-role members get a live
//                                          read-only view; space editors get the full UI.
//                                          The page reads no table: everything comes from
//                                          GET /api/state, and every write is a route here.
//   data_storage:   the space's tables   — `roadmap_milestones.table.jsonl` and
//                                          `roadmap_tasks.table.jsonl` in the space's frame
//                                          data folder `_fdata/`, synced with it; one
//                                          roadmap per space.
//   view_realtime:  view-collaborative   — every write pushes `{ roadmap: "state" }`, which
//                                          says what to read again and never what it holds.
//   settings_scope: the session          — project meta + links are rows of the
//                                          session's own `settings` table, under
//                                          `roadmap_*` keys; the worker's alone, never synced.
//
// Data model:
//   meta        `settings` rows (the session's own) — project name, overview, links (JSON
//               under `v`); an absent row reads as empty.
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
import type { Ctx } from "@frame-core";
import { sanitizeText, toIntOrNull, clampInt } from "@frame-core";

// ----- The space's tables, in its frame data folder; the settings the session's own -------
const MILESTONES = "roadmap_milestones";
const TASKS = "roadmap_tasks";
const SETTINGS = "settings";

type Column = { name: string; col_type: "text" | "integer"; nullable: boolean; default_val?: string };
const SCHEMAS: Record<string, Column[]> = {
  [MILESTONES]: [
    { name: "kind",         col_type: "text",    nullable: false, default_val: "milestone" }, // milestone | backburner | maybelater
    { name: "title",        col_type: "text",    nullable: false, default_val: "" },
    { name: "target_ms",    col_type: "integer", nullable: true },                            // only for milestones
    { name: "completed",    col_type: "integer", nullable: false, default_val: "0" },
    { name: "completed_ms", col_type: "integer", nullable: false, default_val: "0" },
    { name: "sort_order",   col_type: "integer", nullable: false, default_val: "0" },
    { name: "created_ms",   col_type: "integer", nullable: false, default_val: "0" },
  ],
  [TASKS]: [
    { name: "milestone_id", col_type: "text",    nullable: false, default_val: "" },
    { name: "text",         col_type: "text",    nullable: false, default_val: "" },
    { name: "state",        col_type: "integer", nullable: false, default_val: "0" }, // 0 unstarted | 1 in-progress | 2 complete
    { name: "sort_order",   col_type: "integer", nullable: false, default_val: "0" },
    { name: "actor_id",     col_type: "text",    nullable: false, default_val: "" },
    { name: "actor_name",   col_type: "text",    nullable: false, default_val: "" },
    { name: "created_ms",   col_type: "integer", nullable: false, default_val: "0" },
    { name: "completed_ms", col_type: "integer", nullable: false, default_val: "0" }, // when it last entered state 2 (burn rate)
  ],
};

// ----- Constants ------------------------------------------------------------------------
const MAX_NAME = 160;
const MAX_OVERVIEW = 600;
const MAX_TITLE = 200;
const MAX_TASK = 1000;
const MAX_LABEL = 80;
const MAX_URL = 2048;
const MAX_LINKS = 12;
const BUCKETS: Array<{ kind: string; title: string; sort_order: number }> = [
  { kind: "backburner", title: "Back Burner", sort_order: 1_000_000 },
  { kind: "maybelater", title: "Maybe Later", sort_order: 1_000_001 },
];

function isSafeUrl(u: string): boolean {
  return /^https?:\/\//i.test(u.trim());
}

// ----- Rows -----------------------------------------------------------------------------
type Row = Record<string, unknown> & { id: string };

// The settings are the session's own table; every other table is the space's frame data
// (`_fdata/`), shared with every frame and member.
const rows = (ctx: Ctx, name: string) =>
  name === SETTINGS ? ctx.own.table<Record<string, unknown>>(name) : ctx.shared.table<Record<string, unknown>>(name);

const defaultsOf = (name: string): Record<string, unknown> => Object.fromEntries(
  (SCHEMAS[name] ?? [])
    .filter((c) => c.default_val !== undefined)
    .map((c) => [c.name, c.col_type === "integer" ? Number(c.default_val) : c.default_val]),
);

/** Write a row over what it held (a new one from the schema's defaults), stamped. */
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

function cmp(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a ?? "").localeCompare(String(b ?? ""));
}

/** Order by these columns, each ascending. */
const by = (...cols: string[]) => (a: Row, b: Row) => {
  for (const c of cols) {
    const d = cmp(a[c], b[c]);
    if (d) return d;
  }
  return 0;
};

/** The largest value of `col` among these rows, or null when none holds one. */
function maxOf(list: Row[], col: string): unknown {
  let best: unknown = null;
  for (const r of list) {
    const v = r[col];
    if (v === null || v === undefined) continue;
    if (best === null || cmp(v, best) > 0) best = v;
  }
  return best;
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

const tasksIn = async (ctx: Ctx, milestoneId: string) =>
  (await rows(ctx, TASKS).all()).filter((r) => r.milestone_id === milestoneId);

const openIn = async (ctx: Ctx, milestoneId: string) =>
  (await tasksIn(ctx, milestoneId)).filter((r) => Number(r.state ?? 0) < 2).length;

// ----- Buckets bootstrap ----------------------------------------------------------------
async function ensurePlacement(ctx: Ctx): Promise<void> {
  // Auto-create the two parking buckets once per space, on an editor's write. Each bucket is unique
  // by kind, so key its row by a stable id — a concurrent first-load then converges
  // on one row instead of forking duplicate buckets.
  for (const b of BUCKETS) {
    const bucketId = `bucket:${b.kind}`;
    if (!(await rows(ctx, MILESTONES).get(bucketId))) {
      await keep(ctx, MILESTONES, bucketId, {
        kind: b.kind, title: b.title, target_ms: null,
        completed: 0, sort_order: b.sort_order, created_ms: Date.now(),
      });
    }
  }
}

// ----- Readers --------------------------------------------------------------------------
async function getMeta(ctx: Ctx) {
  const [name, overview, links] = await Promise.all([
    setting<string>(ctx, "roadmap_name"),
    setting<string>(ctx, "roadmap_overview"),
    setting<Array<{ label: string; url: string }>>(ctx, "roadmap_links"),
  ]);
  return {
    name: name ?? "",
    overview: overview ?? "",
    links: Array.isArray(links) ? links : [],
  };
}

async function listMilestones(ctx: Ctx) {
  const all = (await rows(ctx, MILESTONES).all()).sort(by("sort_order", "_created_at"));
  const out = all.map((r) => ({
    id: r.id, kind: r.kind, title: r.title, target_ms: r.target_ms,
    completed: r.completed, completed_ms: r.completed_ms, sort_order: r.sort_order,
  }));
  // A read writes nothing, so a bucket no editor has written yet is shown as it will be.
  for (const b of BUCKETS) {
    if (!out.some((m) => m.kind === b.kind)) {
      out.push({ id: `bucket:${b.kind}`, kind: b.kind, title: b.title, target_ms: null, completed: 0, completed_ms: 0, sort_order: b.sort_order });
    }
  }
  return out;
}

async function listTasks(ctx: Ctx) {
  const all = (await rows(ctx, TASKS).all()).sort(by("milestone_id", "sort_order", "_created_at"));
  return all.map((r) => ({
    id: r.id, milestone_id: r.milestone_id, text: r.text, state: r.state,
    sort_order: r.sort_order, actor_name: r.actor_name,
    created_ms: r.created_ms, completed_ms: r.completed_ms,
  }));
}

async function snapshot(ctx: Ctx) {
  return { meta: await getMeta(ctx), milestones: await listMilestones(ctx), tasks: await listTasks(ctx) };
}

// What changed, never what it holds: each page reads again as whoever it is.
const tell = (ctx: Ctx) => ctx.push({ roadmap: "state" });

const json = (v: unknown, status = 200) => Response.json(v, { status });

// deno-lint-ignore no-explicit-any
async function body(request: Request): Promise<any> {
  try {
    const v = JSON.parse(await request.text());
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

// ----- Guards ---------------------------------------------------------------------------
async function milestoneRow(ctx: Ctx, id: string) {
  if (!id) return null;
  return await rows(ctx, MILESTONES).get(id);
}

async function nextTaskOrder(ctx: Ctx, milestoneId: string): Promise<number> {
  return Number(maxOf(await tasksIn(ctx, milestoneId), "sort_order") ?? -1) + 1;
}

// Re-derive a milestone's completed flag from its tasks: it may only stay completed while
// every task is complete (state 2). Called after any task mutation.
async function reconcileMilestone(ctx: Ctx, milestoneId: string): Promise<void> {
  const ms = await milestoneRow(ctx, milestoneId);
  if (!ms || ms.kind !== "milestone" || !ms.completed) return;
  if (await openIn(ctx, milestoneId) > 0) {
    await keep(ctx, MILESTONES, milestoneId, { completed: 0, completed_ms: 0 });
  }
}

// ----- Writes ---------------------------------------------------------------------------
// `op` is the API path with the leading `/api/` stripped (e.g. "task/<id>", "tasks/reorder").
// Every success answers with the full snapshot.
// deno-lint-ignore no-explicit-any
async function write(ctx: Ctx, op: string, v: any): Promise<Response> {
  // Everything here mutates — editor-only. Never gate on is_sfi_member (Viewer-role
  // members would slip through).
  if (!(ctx.peer.is_sfi_editor || ctx.peer.is_owner)) return json({ error: "editors only" }, 403);
  await ensurePlacement(ctx);
  const ok = async () => json(await snapshot(ctx));

  // ----- Project settings: name / overview / links --------------------------------------
  if (op === "settings") {
    if (v?.name !== undefined) {
      await setSetting(ctx, "roadmap_name", sanitizeText(v.name, MAX_NAME));
    }
    if (v?.overview !== undefined) {
      await setSetting(ctx, "roadmap_overview", sanitizeText(v.overview, MAX_OVERVIEW));
    }
    if (v?.links !== undefined) {
      const raw = Array.isArray(v.links) ? v.links : [];
      // deno-lint-ignore no-explicit-any
      const links = raw.slice(0, MAX_LINKS).map((l: any) => ({
        label: sanitizeText(l?.label, MAX_LABEL),
        url: sanitizeText(l?.url, MAX_URL).trim(),
      })).filter((l: { label: string; url: string }) => l.label && l.url && isSafeUrl(l.url));
      await setSetting(ctx, "roadmap_links", links);
    }
    await setSetting(ctx, "roadmap_updated_ms", Date.now());
    tell(ctx);
    return await ok();
  }

  // ----- Milestones ---------------------------------------------------------------------
  if (op === "milestone/add") {
    const title = sanitizeText(v?.title, MAX_TITLE) || "Untitled milestone";
    const target = v?.target_ms == null ? null : toIntOrNull(v.target_ms);
    // Real milestones sort ahead of the two buckets (which live at 1_000_000+).
    const real = (await rows(ctx, MILESTONES).all()).filter((r) => r.kind === "milestone");
    const next = Number(maxOf(real, "sort_order") ?? -1) + 1;
    await keep(ctx, MILESTONES, null, {
      kind: "milestone", title, target_ms: target, completed: 0,
      sort_order: next, created_ms: Date.now(),
    });
    tell(ctx);
    return await ok();
  }

  if (op.startsWith("milestone/delete/")) {
    const id = op.slice("milestone/delete/".length);
    if (!id) return json({ error: "bad id" }, 400);
    const ms = await milestoneRow(ctx, id);
    if (!ms) return json({ error: "not found" }, 404);
    if (ms.kind !== "milestone") return json({ error: "buckets can't be deleted" }, 400);
    // Deleting a milestone deletes its tasks with it (the UI confirms with the count first).
    for (const t of await tasksIn(ctx, id)) await rows(ctx, TASKS).delete(t.id);
    await rows(ctx, MILESTONES).delete(id);
    tell(ctx);
    return await ok();
  }

  if (op.startsWith("milestone/")) {
    const id = op.slice("milestone/".length);
    if (!id) return json({ error: "bad id" }, 400);
    const ms = await milestoneRow(ctx, id);
    if (!ms) return json({ error: "not found" }, 404);
    const isBucket = ms.kind !== "milestone";

    if (v?.title !== undefined && !isBucket) {
      await keep(ctx, MILESTONES, id, { title: sanitizeText(v.title, MAX_TITLE) || "Untitled milestone" });
    }
    if (v?.target_ms !== undefined && !isBucket) {
      const target = v.target_ms == null ? null : toIntOrNull(v.target_ms);
      await keep(ctx, MILESTONES, id, { target_ms: target });
    }
    if (v?.completed !== undefined && !isBucket) {
      const want = clampInt(toIntOrNull(v.completed) ?? 0, 0, 1);
      if (want === 1) {
        // Gate: every task must be complete first.
        const open = await openIn(ctx, id);
        if (open > 0) {
          return json({ error: "finish all tasks before completing this milestone", open }, 409);
        }
        await keep(ctx, MILESTONES, id, { completed: 1, completed_ms: Date.now() });
      } else {
        await keep(ctx, MILESTONES, id, { completed: 0, completed_ms: 0 });
      }
    }
    tell(ctx);
    return await ok();
  }

  // ----- Tasks --------------------------------------------------------------------------
  if (op === "task/add") {
    const milestoneId = typeof v?.milestone_id === "string" ? v.milestone_id : "";
    if (!milestoneId || !(await milestoneRow(ctx, milestoneId))) {
      return json({ error: "bad milestone" }, 400);
    }
    // `texts` (a pasted list → one task per line) takes precedence over the single
    // `text` (which may itself be multi-line, from a Shift+Enter task — kept as one row).
    let items: string[];
    if (Array.isArray(v?.texts)) {
      items = v.texts.map((x: unknown) => sanitizeText(x, MAX_TASK)).filter((s: string) => s.length > 0);
    } else {
      const txt = sanitizeText(v?.text, MAX_TASK);
      items = txt ? [txt] : [];
    }
    if (items.length === 0) return json({ error: "text required" }, 400);
    const now = Date.now();
    let order = await nextTaskOrder(ctx, milestoneId);
    for (const text of items) {
      await keep(ctx, TASKS, null, { milestone_id: milestoneId, text, state: 0, sort_order: order++, created_ms: now });
    }
    await reconcileMilestone(ctx, milestoneId); // fresh (unstarted) tasks reopen a "done" milestone
    tell(ctx);
    return await ok();
  }

  if (op.startsWith("task/delete/")) {
    const id = op.slice("task/delete/".length);
    if (!id) return json({ error: "bad id" }, 400);
    const task = await rows(ctx, TASKS).get(id);
    if (!task) return json({ error: "not found" }, 404);
    await rows(ctx, TASKS).delete(id);
    await reconcileMilestone(ctx, task.milestone_id as string); // deleting the last open task can complete a milestone's set
    tell(ctx);
    return await ok();
  }

  // Reorder within one destination list (also used for cross-list drops): body carries the
  // destination milestone_id and the full ordered list of task ids that now live in it.
  if (op === "tasks/reorder") {
    const dest = typeof v?.milestone_id === "string" ? v.milestone_id : "";
    if (!dest || !(await milestoneRow(ctx, dest))) return json({ error: "bad milestone" }, 400);
    const ids = Array.isArray(v?.ids)
      ? v.ids.filter((x: unknown): x is string => typeof x === "string" && !!x)
      : [];
    // Only touch ids that actually exist (never phantom-create).
    const known = new Set((await rows(ctx, TASKS).all()).map((r) => r.id));
    for (let i = 0; i < ids.length; i++) {
      if (known.has(ids[i])) await keep(ctx, TASKS, ids[i], { milestone_id: dest, sort_order: i });
    }
    await reconcileMilestone(ctx, dest);
    tell(ctx);
    return await ok();
  }

  if (op.startsWith("task/")) {
    const id = op.slice("task/".length);
    if (!id) return json({ error: "bad id" }, 400);
    const task = await rows(ctx, TASKS).get(id);
    if (!task) return json({ error: "not found" }, 404);

    if (v?.state !== undefined) {
      const state = clampInt(toIntOrNull(v.state) ?? 0, 0, 2);
      if (state === 0) {
        await keep(ctx, TASKS, id, { state: 0, actor_id: "", actor_name: "", completed_ms: 0 });
      } else {
        // The keeper has no roster name; say who they are rather than "someone".
        const actorName = sanitizeText(ctx.peer.user_name, 80) || (ctx.peer.is_owner ? "the owner" : "someone");
        const completedMs = state === 2 ? Date.now() : 0;
        await keep(ctx, TASKS, id, { state, actor_id: ctx.peer.user_id ?? "", actor_name: actorName, completed_ms: completedMs });
      }
    }
    if (v?.text !== undefined) {
      await keep(ctx, TASKS, id, { text: sanitizeText(v.text, MAX_TASK) });
    }
    // Move to another milestone/bucket (drag across lists appends to the destination end;
    // /api/tasks/reorder then fixes the exact position).
    if (v?.milestone_id !== undefined) {
      const dest = typeof v.milestone_id === "string" ? v.milestone_id : "";
      if (!dest || !(await milestoneRow(ctx, dest))) return json({ error: "bad milestone" }, 400);
      await keep(ctx, TASKS, id, { milestone_id: dest, sort_order: await nextTaskOrder(ctx, dest) });
      await reconcileMilestone(ctx, dest);
    }
    await reconcileMilestone(ctx, task.milestone_id as string);
    tell(ctx);
    return await ok();
  }

  return json({ error: "not found" }, 404);
}

// ----- Networking -----------------------------------------------------------------------
export default {
  async fetch(request: Request, ctx: Ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    const editor = ctx.peer.is_sfi_editor || ctx.peer.is_owner;

    // Static assets — open to everyone, including anon read-only viewers.
    if (request.method === "GET" && !pathname.startsWith("/api/")) return ctx.file(pathname);

    // Identity probe — drives which render mode the frontend shows.
    if (pathname === "/api/whoami" && request.method === "GET") {
      return json({
        is_anon: ctx.peer.is_anon,
        is_sfi_member: editor || ctx.peer.is_sfi_member,
        is_sfi_editor: editor,
        is_owner: ctx.peer.is_owner,
        user_id: ctx.peer.user_id,
        user_name: ctx.peer.user_name,
        space_color: ctx.peer.space_color,
      });
    }

    // Full read, open to every viewer who reaches the frame. Whether a non-member can reach
    // it at all is the platform's call (the space's tier, the frame published), never the frame's.
    if (pathname === "/api/state" && request.method === "GET") return json(await snapshot(ctx));

    if (pathname.startsWith("/api/") && request.method === "POST") {
      return write(ctx, pathname.slice("/api/".length), await body(request));
    }

    return json({ error: "not found" }, 404);
  },
};
