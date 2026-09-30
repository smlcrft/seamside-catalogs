// ----------------------------------------------------------------------------------------
// Help Desk — visitors submit a message (+ email + admin-configured fields); the space's
// members see a realtime inbox with status + correspondence notes.
//
// Auth model:
//   - Not on the space's roster (signed in or not): sees the submit form. A visitor
//     writes no row at the door, so a submission is a route here.
//   - A member of the space: sees the inbox. Every member reads it — the submissions are
//     a table file of the space, which every member can read anyway — and only editors
//     (collaborator and up) change status, add notes, or edit the form.
//   - Submissions, fields and notes are tables in the space's frame data folder
//     (_fdata/help_desk_submissions, _fdata/help_desk_fields, _fdata/help_desk_notes).
//     A stranger reaches none of them: the page reads no table, and every route below
//     decides on ctx.peer, who the door proved is asking.
//
// Realtime: a push says what changed and never what it holds. Every open page of the
// frame hears it, the public form included, and each reads again as whoever it is.
// ----------------------------------------------------------------------------------------
import type { Ctx } from "@frame-core";
import { declareTables } from "@frame-core";

// ----------------------------------------------------------------------------------------
// THE SPACE'S TABLES, in its frame data folder.
// ----------------------------------------------------------------------------------------
const SUBMISSIONS = "help_desk_submissions";
const FIELDS = "help_desk_fields";
const NOTES = "help_desk_notes";
// Settings (title, one-time seed marker) are rows of the space's help_desk_settings table,
// beside the fields the marker guards. Each value is JSON under `v`.
const SETTINGS = "help_desk_settings";

declareTables([
  {
    key: SUBMISSIONS,
    title: "Help Desk Submissions",
    description: "Visitor submissions for this help desk.",
    columns: {
      submitted_at: { type: "number" },
      email: { type: "text", required: true },
      fields_json: { type: "text" },
      status: { type: "text", required: true },
    },
  },
  {
    key: FIELDS,
    title: "Help Desk Fields",
    description: "Admin-configured form fields.",
    columns: {
      label: { type: "text", required: true },
      type: { type: "text", required: true },
      options_json: { type: "text" },
      required: { type: "number" },
      sort_order: { type: "number" },
    },
  },
  {
    key: NOTES,
    title: "Help Desk Notes",
    description: "Admin correspondence notes per submission.",
    columns: {
      submission_id: { type: "text", required: true },
      author_user_id: { type: "text" },
      author_name: { type: "text" },
      body: { type: "text", required: true },
      created_at: { type: "number" },
    },
  },
]);

// ----------------------------------------------------------------------------------------
// HELPERS
// ----------------------------------------------------------------------------------------
type Row = Record<string, unknown> & { id: string };

// Every table, the settings included, is the space's frame data (`_fdata/`), shared with
// every frame and member.
const rows = (ctx: Ctx, name: string) => ctx.shared.table<Record<string, unknown>>(name);

/** Write a row over what it held, stamped when it was made and when it changed. */
async function keep(ctx: Ctx, name: string, id: string | null, values: Record<string, unknown>): Promise<Row> {
  const was = id ? await rows(ctx, name).get(id) : null;
  const now = Date.now();
  return await rows(ctx, name).upsert({
    ...(was ?? { _created_at: now }),
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

function parsed<T>(text: unknown, fallback: T): T {
  try {
    return JSON.parse(String(text)) as T;
  } catch {
    return fallback;
  }
}

function hydrateSubmission(row: Row) {
  return {
    id: row.id,
    submitted_at: row.submitted_at,
    email: row.email,
    fields: parsed(row.fields_json || "{}", {}),
    status: row.status,
  };
}

function hydrateField(row: Row) {
  return {
    id: row.id,
    label: String(row.label ?? ""),
    type: String(row.type ?? "text"),
    options: parsed<string[]>(row.options_json || "[]", []),
    required: row.required === 1,
    sort_order: row.sort_order,
  };
}

function hydrateNote(row: Row) {
  return {
    id: row.id,
    submission_id: row.submission_id,
    author_user_id: row.author_user_id,
    author_name: row.author_name,
    body: row.body,
    created_at: row.created_at,
  };
}

const VALID_FIELD_TYPES = new Set(["text", "textarea", "checkbox", "dropdown"]);
const VALID_STATUSES = new Set(["new", "in_progress", "resolved", "archived"]);

async function listFields(ctx: Ctx) {
  return (await rows(ctx, FIELDS).all()).sort(by("sort_order", "_created_at")).map(hydrateField);
}

async function notesOf(ctx: Ctx, submissionId: string): Promise<Row[]> {
  return (await rows(ctx, NOTES).all())
    .filter((n) => n.submission_id === submissionId)
    .sort(by("created_at", "_created_at"));
}

async function setting<T>(ctx: Ctx, key: string, fallback: T): Promise<T> {
  const row = await rows(ctx, SETTINGS).get(key);
  return row?.v == null ? fallback : parsed(row.v, fallback);
}

const setSetting = (ctx: Ctx, key: string, value: unknown) => keep(ctx, SETTINGS, key, { v: JSON.stringify(value) });

// The default seed field uses a fixed id so a concurrent first-load can't create
// duplicate "Message" fields. User-added fields keep random ids.
const DEFAULT_FIELD_ROW = "default_message";

// Seed a default "Message" field the first time the desk is opened. The "seeded" setting
// is the one-time marker — after the initial seed the admin can delete or replace the
// field and subsequent requests, from any session or device, won't re-seed.
async function ensureDefaultFields(ctx: Ctx): Promise<void> {
  if (await setting(ctx, "help_desk_seeded", false)) return;
  await setSetting(ctx, "help_desk_seeded", true);
  await keep(ctx, FIELDS, DEFAULT_FIELD_ROW, {
    label: "Message", type: "textarea", options_json: "[]", required: 0, sort_order: 0,
  });
}

const MAX_DESK_TITLE = 120;

// What changed, never what it holds: each page reads again as whoever it is.
const tell = (ctx: Ctx, what: "messages" | "notes" | "form") => ctx.push({ help_desk: what });

const json = (v: unknown, status = 200) => Response.json(v, { status });
const refuse = (status: number, error: string) => json({ error }, status);

// deno-lint-ignore no-explicit-any
async function body(request: Request): Promise<any> {
  try {
    const v = JSON.parse(await request.text());
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

// Route ids are opaque row-id strings; a path segment must not contain '/'.
const ID_SEG = "([^/]+)";
const RE_STATUS  = new RegExp(`^PUT /admin/messages/${ID_SEG}/status$`);
const RE_NOTES   = new RegExp(`^(GET|POST) /admin/messages/${ID_SEG}/notes$`);
const RE_MESSAGE = new RegExp(`^DELETE /admin/messages/${ID_SEG}$`);
const RE_FIELD   = new RegExp(`^(PUT|DELETE) /admin/fields/${ID_SEG}$`);

// ----------------------------------------------------------------------------------------
// A VISITOR'S SUBMISSION
// ----------------------------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
async function submit(ctx: Ctx, data: any): Promise<Response> {
  if (!data || typeof data.email !== "string") return refuse(400, "email is required");
  const email = data.email.trim();
  if (!email) return refuse(400, "email must not be empty");
  if (email.length > 320) return refuse(413, "email too long");
  const rawFields = (data.fields && typeof data.fields === "object") ? data.fields as Record<string, unknown> : {};

  // Validate required custom fields per the current config and clamp textual values.
  const fields: Record<string, unknown> = {};
  for (const f of await listFields(ctx)) {
    const v = rawFields[f.id];
    if (f.required) {
      if (f.type === "checkbox") {
        if (v !== true) return refuse(400, `"${f.label}" is required`);
      } else if (v === undefined || v === null || String(v).trim() === "") {
        return refuse(400, `"${f.label}" is required`);
      }
    }
    if (v === undefined) continue;
    if (f.type === "checkbox") fields[f.id] = !!v;
    else {
      const s = String(v);
      if (s.length > 10_000) return refuse(413, `"${f.label}" too long`);
      fields[f.id] = s;
    }
  }

  const row = await keep(ctx, SUBMISSIONS, null, {
    submitted_at: Date.now(), email, fields_json: JSON.stringify(fields), status: "new",
  });
  tell(ctx, "messages");
  ctx.log(`Help Desk: submission ${row.id.slice(0, 8)}…`);
  return json({ ok: true, id: row.id });
}

// ----------------------------------------------------------------------------------------
// NETWORKING
// ----------------------------------------------------------------------------------------
export default {
  async fetch(request: Request, ctx: Ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith("/api/")) {
      if (request.method !== "GET") return refuse(404, "Not found.");
      return ctx.file(pathname);
    }
    const route = `${request.method} ${pathname.slice(4)}`;
    const editor = ctx.peer.is_sfi_editor || ctx.peer.is_owner;
    const member = editor || ctx.peer.is_sfi_member;

    // ----- anyone: the form's fields and the desk's title, and who the door says is asking.
    if (route === "GET /config") {
      await ensureDefaultFields(ctx);
      return json({
        fields: await listFields(ctx),
        title: await setting(ctx, "help_desk_title", ""),
        color: ctx.peer.space_color,
        you: { member, editor },
      });
    }

    if (route === "POST /submit") return submit(ctx, await body(request));

    if (!route.includes(" /admin/")) return refuse(404, "unknown route");

    // ----- everything below is a member's to read, and an editor's to change.
    if (!member) return refuse(403, "forbidden");
    await ensureDefaultFields(ctx);

    if (route === "GET /admin/messages") {
      const all = (await rows(ctx, SUBMISSIONS).all()).sort(by("-submitted_at", "-_created_at"));
      return json({ submissions: all.map(hydrateSubmission) });
    }

    if (route === "GET /admin/fields") return json({ fields: await listFields(ctx) });

    const notes = route.match(RE_NOTES);
    if (notes?.[1] === "GET") {
      if (!(await rows(ctx, SUBMISSIONS).get(notes[2]))) return refuse(404, "not found");
      return json({ notes: (await notesOf(ctx, notes[2])).map(hydrateNote) });
    }

    if (request.method === "GET") return refuse(404, "unknown admin route");
    if (!editor) return refuse(403, "forbidden");

    // Set the desk's display name ("" clears it back to the defaults).
    // Shown as the admin h1 and atop the public view.
    if (route === "PUT /admin/title") {
      const data = await body(request);
      if (!data || typeof data.title !== "string") return refuse(400, "title required (string)");
      const title = data.title.trim().slice(0, MAX_DESK_TITLE);
      await setSetting(ctx, "help_desk_title", title);
      tell(ctx, "form");
      return json({ ok: true, title });
    }

    const status = route.match(RE_STATUS);
    if (status) {
      const data = await body(request);
      if (!data?.status || !VALID_STATUSES.has(data.status)) return refuse(400, "invalid status");
      if (!(await rows(ctx, SUBMISSIONS).get(status[1]))) return refuse(404, "not found");
      await keep(ctx, SUBMISSIONS, status[1], { status: data.status });
      tell(ctx, "messages");
      return json({ ok: true });
    }

    if (notes?.[1] === "POST") {
      const id = notes[2];
      const data = await body(request);
      if (!data?.body || typeof data.body !== "string") return refuse(400, "body required");
      if (!(await rows(ctx, SUBMISSIONS).get(id))) return refuse(404, "not found");
      await keep(ctx, NOTES, null, {
        submission_id: id, author_user_id: ctx.peer.user_id, author_name: ctx.peer.user_name || "admin",
        body: data.body, created_at: Date.now(),
      });
      tell(ctx, "notes");
      return json({ notes: (await notesOf(ctx, id)).map(hydrateNote) });
    }

    // Delete submission (cascades its notes).
    const message = route.match(RE_MESSAGE);
    if (message) {
      const id = message[1];
      if (!(await rows(ctx, SUBMISSIONS).get(id))) return refuse(404, "not found");
      for (const n of await notesOf(ctx, id)) await rows(ctx, NOTES).delete(n.id);
      await rows(ctx, SUBMISSIONS).delete(id);
      tell(ctx, "messages");
      return json({ ok: true });
    }

    if (route === "POST /admin/fields") {
      const data = await body(request);
      const label = typeof data?.label === "string" ? data.label.trim() : "";
      if (!label) return refuse(400, "label required");
      if (!data?.type || !VALID_FIELD_TYPES.has(data.type)) return refuse(400, "invalid type");
      const options = Array.isArray(data.options) ? data.options.map(String) : [];
      if (data.type === "dropdown" && options.length === 0) return refuse(400, "dropdown requires at least one option");
      const last = (await rows(ctx, FIELDS).all()).reduce((m, f) => Math.max(m, Number(f.sort_order) || 0), -1);
      const row = await keep(ctx, FIELDS, null, {
        label, type: data.type,
        options_json: JSON.stringify(options),
        required: data.required ? 1 : 0, sort_order: last + 1,
      });
      tell(ctx, "form");
      return json({ ok: true, id: row.id });
    }

    const field = route.match(RE_FIELD);
    if (field) {
      const id = field[2];
      if (!(await rows(ctx, FIELDS).get(id))) return refuse(404, "not found");
      if (field[1] === "DELETE") {
        await rows(ctx, FIELDS).delete(id);
        tell(ctx, "form");
        return json({ ok: true });
      }
      const data = await body(request);
      if (!data) return refuse(400, "invalid body");
      const next: Record<string, unknown> = {};
      if (typeof data.label === "string") {
        if (!data.label.trim()) return refuse(400, "label required");
        next.label = data.label.trim();
      }
      if (typeof data.type === "string") {
        if (!VALID_FIELD_TYPES.has(data.type)) return refuse(400, "invalid type");
        next.type = data.type;
      }
      if (Array.isArray(data.options)) next.options_json = JSON.stringify(data.options.map(String));
      if (typeof data.required === "boolean") next.required = data.required ? 1 : 0;
      await keep(ctx, FIELDS, id, next);
      tell(ctx, "form");
      return json({ ok: true });
    }

    return refuse(404, "unknown admin route");
  },
};
