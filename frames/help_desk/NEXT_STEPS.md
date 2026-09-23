# Help Desk — Next Steps

Ideas for extending this frame:

1. **SMTP / email capability** — Send through an email API the worker reaches (a declared `net` host, its API key a declared key the keeper grants) so admins can reply directly from the inbox instead of bouncing out to a `mailto:` link, and so the visitor gets an automatic "we received your message" confirmation.
2. **Spam & rate limiting** — Throttle anonymous submissions (a worker sees no request headers in v1, so per space and per time window) and add a lightweight honeypot field plus profanity/URL filters. Store rejections in a `spam_log` table so admins can review false positives.
3. **Attachments** — Let visitors attach one small file (image / PDF) that gets saved to `./data/attachments/{space}/{submission_id}/…` (data/ is one folder for every space, and never readable through the door), with an admin download link in the inbox detail view.
4. **Triage & assignment** — Add `assignee_user_id`, `priority`, and `tags` columns, plus filter chips in the inbox (New / Mine / Unassigned / priority). Broadcast assignment changes over the same `pushToInstance` channel.
5. **Saved reply templates** — A `templates` table admins can curate, surfaced in the reply UI (e.g. "Getting started", "Bug report follow-up"). Merge tags like `{{email}}` on insert.
6. **Export / audit** — `GET /api/admin/export?format=csv` for all submissions + notes, plus a read-only activity log for every status change and note add.
7. **Public status page** — A `/status/{public_id}` route where the visitor can come back and see their ticket state (opened, in progress, resolved) with a short opaque token emailed at submit time.
