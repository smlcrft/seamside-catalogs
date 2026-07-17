// ----------------------------------------------------------------------------------------
// Help Desk — anonymous visitors submit a message (+ email + admin-configured fields);
// known users of the space see a realtime inbox with status + correspondence notes.
//
// Auth model:
//   - Anonymous request: peer.is_anon OR user_id is empty. Sees the submit form.
//   - Known user (admin): !peer.is_anon AND user_id is set. Sees the placement's inbox.
//     Storage is LocalTables (encrypted at rest, host-local, not peer-synced), scoped
//     per placement — the same space can host multiple independent help desk placements
//     and each has its own inbox/fields.
//
// Realtime: submissions, status changes, notes, and field-config edits are pushed to every
// live viewer of this placement via pushToInstance(sfi_id, …); framecore handles viewer
// tracking automatically based on authenticated requests.
// ----------------------------------------------------------------------------------------
import {
  log, serveFileAtPath, serveHtmlShell, pushToInstance, parsePeerInfo,
  parseJsonBody, declareTables, ensureTables, table, frameSettings,
} from "@frame-core";

// ----------------------------------------------------------------------------------------
// LOCALTABLES — encrypted, per-placement (no sfi_id columns needed).
// ----------------------------------------------------------------------------------------
declareTables([
  {
    key: "submissions",
    title: "Help Desk Submissions",
    description: "Visitor submissions for this help desk placement.",
    local: true,
    schema: [
      { name: "submitted_at", col_type: "integer", nullable: false, default_val: "0" },
      { name: "email",        col_type: "text",    nullable: false, default_val: "" },
      { name: "fields_json",  col_type: "text",    nullable: false, default_val: "{}" },
      { name: "status",       col_type: "text",    nullable: false, default_val: "new" },
    ],
  },
  {
    key: "field_configs",
    title: "Help Desk Fields",
    description: "Admin-configured form fields for this placement.",
    local: true,
    schema: [
      { name: "label",        col_type: "text",    nullable: false, default_val: "" },
      { name: "type",         col_type: "text",    nullable: false, default_val: "text" },
      { name: "options_json", col_type: "text",    nullable: false, default_val: "[]" },
      { name: "required",     col_type: "integer", nullable: false, default_val: "0" },
      { name: "sort_order",   col_type: "integer", nullable: false, default_val: "0" },
    ],
  },
  {
    key: "notes",
    title: "Help Desk Notes",
    description: "Admin correspondence notes per submission.",
    local: true,
    schema: [
      { name: "submission_id",  col_type: "text",    nullable: false, default_val: "" },
      { name: "author_user_id", col_type: "text",    nullable: false, default_val: "" },
      { name: "author_name",    col_type: "text",    nullable: false, default_val: "" },
      { name: "body",           col_type: "text",    nullable: false, default_val: "" },
      { name: "created_at",     col_type: "integer", nullable: false, default_val: "0" },
    ],
  },
]);
// Per-placement settings (title, one-time seed marker) live in the built-in
// frameSettings(sfi) key/value store — no bespoke "meta" table, no singleton race.

// ----------------------------------------------------------------------------------------
// HELPERS
// ----------------------------------------------------------------------------------------
type Tbl = ReturnType<typeof table>;

function hydrateSubmission(row: any) {
  return {
    id: row._row_id,
    submitted_at: row.submitted_at,
    email: row.email,
    fields: JSON.parse(row.fields_json || "{}"),
    status: row.status,
  };
}

function hydrateField(row: any) {
  return {
    id: row._row_id,
    label: row.label,
    type: row.type,
    options: JSON.parse(row.options_json || "[]"),
    required: row.required === 1,
    sort_order: row.sort_order,
  };
}

function hydrateNote(row: any) {
  return {
    id: row._row_id,
    submission_id: row.submission_id,
    author_user_id: row.author_user_id,
    author_name: row.author_name,
    body: row.body,
    created_at: row.created_at,
  };
}

const VALID_FIELD_TYPES = new Set(["text", "textarea", "checkbox", "dropdown"]);
const VALID_STATUSES = new Set(["new", "in_progress", "resolved", "archived"]);

async function listFields(fields: Tbl) {
  const { rows } = await fields.query({ order_by: [{ col: "sort_order" }, { col: "_created_at" }] });
  return rows.map(hydrateField);
}

async function listNotes(notes: Tbl, submissionId: string) {
  const { rows } = await notes.query({
    where: { submission_id: submissionId },
    order_by: [{ col: "created_at" }, { col: "_created_at" }],
  });
  return rows.map(hydrateNote);
}

type Settings = ReturnType<typeof frameSettings>;

// The default seed field uses a fixed id so a concurrent first-load can't create
// duplicate "Message" fields. User-added fields keep random ids.
const DEFAULT_FIELD_ROW = "default_message";

// Seed a default "Message" field the first time we see a placement. The "seeded"
// setting is the one-time marker — after the initial seed the admin can delete or
// replace the field and subsequent requests won't re-seed.
async function ensureDefaultFields(settings: Settings, fields: Tbl): Promise<void> {
  if (await settings.get("seeded")) return;
  await settings.set("seeded", true);
  await fields.upsert(DEFAULT_FIELD_ROW, { label: "Message", type: "textarea", options_json: "[]", required: 0, sort_order: 0 });
}

const MAX_DESK_TITLE = 120;

/// This placement's display name ("" = unset; UIs fall back to their defaults).
async function getTitle(settings: Settings): Promise<string> {
  return (await settings.get<string>("title", "")) || "";
}

// Route ids are opaque row-id strings (hex); a path segment must not contain '/'.
const ID_SEG = "([^/]+)";
const RE_STATUS  = new RegExp(`^/api/admin/messages/${ID_SEG}/status$`);
const RE_NOTES   = new RegExp(`^/api/admin/messages/${ID_SEG}/notes$`);
const RE_MESSAGE = new RegExp(`^/api/admin/messages/${ID_SEG}$`);
const RE_FIELD   = new RegExp(`^/api/admin/fields/${ID_SEG}$`);

// ----------------------------------------------------------------------------------------
// NETWORKING
// ----------------------------------------------------------------------------------------
self.onNetworkRequest = async function (replyPort, reqPath, method, _headers, query, body, cookies) {
  const send = (data: unknown, status = 200) => replyPort.postMessage({
    status, contentType: "application/json", body: JSON.stringify(data),
  });
  const peer = parsePeerInfo(query, cookies);
  const sfiId = peer.sfi_id;
  const anon = peer.is_anon || !peer.user_id;

  // ----- index.html: serve a single bundled response (html + inlined css + per-viewer
  // window.__peer stamp) so the UI can render without an extra /api/whoami round-trip.
  // The script is inline in index.html as <script type="module"> so it can import
  // /lib/js/framelib.js — inlineJs would flatten that to a non-module <script>, which
  // can't use ES module imports, so it's intentionally omitted here.
  if (reqPath === "/index.html" && method === "GET") {
    return serveHtmlShell(replyPort, new URL("./public/index.html", import.meta.url), {
      peer,
      inlineCss: ["index.css"],
    });
  }

  if (reqPath.startsWith("/api/")) {
    if (!sfiId) return send({ error: "sfi_id missing" }, 400);
    // Local tables are always ready; the gate stays so a future graduation to
    // synced tables needs no code change here.
    const tables = ensureTables(peer);
    if (!tables.ready) return send({ error: "table not bound" }, 503);
    const submissions = table("submissions", sfiId);
    const fieldsTbl   = table("field_configs", sfiId);
    const notesTbl    = table("notes", sfiId);
    const settings    = frameSettings(sfiId);

    // ----- public: fetch the form field config for this placement (anon or admin).
    // Includes the placement's display title so the public view can show it.
    if (reqPath === "/api/config" && method === "GET") {
      await ensureDefaultFields(settings, fieldsTbl);
      return send({ fields: await listFields(fieldsTbl), title: await getTitle(settings) });
    }

    // ----- public: anonymous submission endpoint.
    if (reqPath === "/api/submit" && method === "POST") {
      const data = parseJsonBody(body);
      if (!data || typeof data.email !== "string") {
        return send({ error: "email is required" }, 400);
      }
      const email = data.email.trim();
      if (!email) return send({ error: "email must not be empty" }, 400);
      if (email.length > 320) return send({ error: "email too long" }, 413);
      const rawFields = (data.fields && typeof data.fields === "object") ? data.fields as Record<string, unknown> : {};

      // Validate required custom fields per the current config and clamp textual values.
      const configured = await listFields(fieldsTbl);
      const fields: Record<string, unknown> = {};
      for (const f of configured) {
        const v = rawFields[String(f.id)];
        if (f.required) {
          if (f.type === "checkbox") {
            if (v !== true) return send({ error: `"${f.label}" is required` }, 400);
          } else if (v === undefined || v === null || String(v).trim() === "") {
            return send({ error: `"${f.label}" is required` }, 400);
          }
        }
        if (v === undefined) continue;
        if (f.type === "checkbox") fields[String(f.id)] = !!v;
        else {
          const s = String(v);
          if (s.length > 10_000) return send({ error: `"${f.label}" too long` }, 413);
          fields[String(f.id)] = s;
        }
      }

      const now = Date.now();
      const { row_id } = await submissions.upsert(null, {
        submitted_at: now, email, fields_json: JSON.stringify(fields), status: "new",
      });
      const row = await submissions.get(row_id);
      const sub = hydrateSubmission(row);
      pushToInstance(sfiId, { type: "hd_new_submission", sfi_id: sfiId, submission: sub });
      log(`Help Desk: submission ${row_id.slice(0, 8)}… in placement ${sfiId.slice(0, 8)}… from ${email}`);
      return send({ ok: true, id: row_id });
    }

    // ----- admin: everything past this point requires a known user.
    if (reqPath.startsWith("/api/admin/")) {
      if (anon) return send({ error: "forbidden" }, 403);
      await ensureDefaultFields(settings, fieldsTbl);

      // Heartbeat — kept so the admin UI can ping cheaply; realtime is delivered via pushToInstance.
      if (reqPath === "/api/admin/register" && method === "POST") {
        return send({ ok: true });
      }

      // Set this placement's display name (any space member; "" clears it back
      // to the defaults). Shown as the admin h1 and atop the public view.
      if (reqPath === "/api/admin/title" && method === "PUT") {
        const data = parseJsonBody(body);
        if (!data || typeof data.title !== "string") return send({ error: "title required (string)" }, 400);
        const title = data.title.trim().slice(0, MAX_DESK_TITLE);
        await settings.set("title", title);
        pushToInstance(sfiId, { type: "hd_title_changed", sfi_id: sfiId, title });
        return send({ ok: true, title });
      }

      // Inbox listing.
      if (reqPath === "/api/admin/messages" && method === "GET") {
        const { rows } = await submissions.query({
          order_by: [{ col: "submitted_at", dir: "desc" }, { col: "_created_at", dir: "desc" }],
        });
        return send({ submissions: rows.map(hydrateSubmission) });
      }

      // Status change.
      const statusMatch = reqPath.match(RE_STATUS);
      if (statusMatch && method === "PUT") {
        const id = statusMatch[1];
        const data = parseJsonBody(body);
        if (!data?.status || !VALID_STATUSES.has(data.status)) return send({ error: "invalid status" }, 400);
        if (!(await submissions.get(id))) return send({ error: "not found" }, 404);
        await submissions.upsert(id, { status: data.status });
        pushToInstance(sfiId, { type: "hd_submission_updated", sfi_id: sfiId, id, status: data.status });
        return send({ ok: true });
      }

      // Notes list.
      const notesListMatch = reqPath.match(RE_NOTES);
      if (notesListMatch && method === "GET") {
        const id = notesListMatch[1];
        if (!(await submissions.get(id))) return send({ error: "not found" }, 404);
        return send({ notes: await listNotes(notesTbl, id) });
      }

      // Add note.
      if (notesListMatch && method === "POST") {
        const id = notesListMatch[1];
        const data = parseJsonBody(body);
        if (!data?.body || typeof data.body !== "string") return send({ error: "body required" }, 400);
        if (!(await submissions.get(id))) return send({ error: "not found" }, 404);
        const authorName = peer.user_name || "admin";
        await notesTbl.upsert(null, {
          submission_id: id, author_user_id: peer.user_id, author_name: authorName,
          body: data.body, created_at: Date.now(),
        });
        const notes = await listNotes(notesTbl, id);
        pushToInstance(sfiId, { type: "hd_note_added", sfi_id: sfiId, submission_id: id, notes });
        return send({ notes });
      }

      // Delete submission (cascades its notes).
      const deleteMatch = reqPath.match(RE_MESSAGE);
      if (deleteMatch && method === "DELETE") {
        const id = deleteMatch[1];
        if (!(await submissions.get(id))) return send({ error: "not found" }, 404);
        await notesTbl.deleteWhere({ submission_id: id });
        await submissions.delete(id);
        pushToInstance(sfiId, { type: "hd_submission_deleted", sfi_id: sfiId, id });
        return send({ ok: true });
      }

      // Field config list.
      if (reqPath === "/api/admin/fields" && method === "GET") {
        return send({ fields: await listFields(fieldsTbl) });
      }

      // Create field.
      if (reqPath === "/api/admin/fields" && method === "POST") {
        const data = parseJsonBody(body);
        if (!data?.label || typeof data.label !== "string") return send({ error: "label required" }, 400);
        if (!data?.type || !VALID_FIELD_TYPES.has(data.type)) return send({ error: "invalid type" }, 400);
        const options = Array.isArray(data.options) ? data.options.map(String) : [];
        if (data.type === "dropdown" && options.length === 0) return send({ error: "dropdown requires at least one option" }, 400);
        const nextOrder = Number(await fieldsTbl.max("sort_order") ?? -1) + 1;
        const { row_id } = await fieldsTbl.upsert(null, {
          label: data.label.trim(), type: data.type,
          options_json: JSON.stringify(options),
          required: data.required ? 1 : 0, sort_order: nextOrder,
        });
        pushToInstance(sfiId, { type: "hd_fields_changed", sfi_id: sfiId });
        return send({ ok: true, id: row_id });
      }

      // Update / delete field.
      const fieldIdMatch = reqPath.match(RE_FIELD);
      if (fieldIdMatch && method === "PUT") {
        const id = fieldIdMatch[1];
        if (!(await fieldsTbl.get(id))) return send({ error: "not found" }, 404);
        const data = parseJsonBody(body);
        if (!data) return send({ error: "invalid body" }, 400);
        if (typeof data.label === "string") await fieldsTbl.upsert(id, { label: data.label.trim() });
        if (typeof data.type === "string") {
          if (!VALID_FIELD_TYPES.has(data.type)) return send({ error: "invalid type" }, 400);
          await fieldsTbl.upsert(id, { type: data.type });
        }
        if (Array.isArray(data.options)) {
          await fieldsTbl.upsert(id, { options_json: JSON.stringify(data.options.map(String)) });
        }
        if (typeof data.required === "boolean") {
          await fieldsTbl.upsert(id, { required: data.required ? 1 : 0 });
        }
        pushToInstance(sfiId, { type: "hd_fields_changed", sfi_id: sfiId });
        return send({ ok: true });
      }

      if (fieldIdMatch && method === "DELETE") {
        const id = fieldIdMatch[1];
        if (!(await fieldsTbl.get(id))) return send({ error: "not found" }, 404);
        await fieldsTbl.delete(id);
        pushToInstance(sfiId, { type: "hd_fields_changed", sfi_id: sfiId });
        return send({ ok: true });
      }

      return send({ error: "unknown admin route" }, 404);
    }
  }

  // ----- static file fallback.
  if (method === "GET") {
    serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url));
  } else {
    replyPort.postMessage({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Not found.", code: "NOT_FOUND" }) });
  }
};

log("Help Desk frame is up and running!");
