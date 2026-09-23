# Checklist — next steps

Where this frame could grow:

- **Due dates / reminders.** Add a nullable `due_ms` column and surface a compact date affordance per item.
- **Assignees.** Store `assigned_to` (user_id) and show the member's space color dot; filter "mine".
- **Section headers.** A second item `kind` ("task" | "header") to group long lists.
- **Archive vs delete.** Soft-complete archiving so finished items can be hidden but recovered.
- **Per-space settings.** A list title and a "let viewers check off, but not add/delete" policy toggle.
- **Several lists in one space.** Every checklist session in a space shows the one `checklist` table; a `list` column (or a table per list) would let a space hold more than one.
