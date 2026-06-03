# Checklist — next steps

Where this frame could grow:

- **Due dates / reminders.** Add a nullable `due_ms` column and surface a compact date affordance per item.
- **Assignees.** Store `assigned_to` (user_id) and show the member's space color dot; filter "mine".
- **Section headers.** A second item `kind` ("task" | "header") to group long lists.
- **Archive vs delete.** Soft-complete archiving so finished items can be hidden but recovered.
- **Per-placement settings (settings-per-sfi).** A local JSON prefs file (see `garden_gnome`) for a list title and a "let viewers check off, but not add/delete" policy toggle.
- **Migrate to a SyncTable** if offline-host editing is ever needed — today the list lives in one local SQLite DB on the host and relies on all viewers reaching that backend, with `pushToInstance` driving live refresh.
