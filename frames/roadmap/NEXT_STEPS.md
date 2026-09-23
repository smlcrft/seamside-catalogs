# Roadmap — next steps

Where this frame could grow:

- **Assignees & "mine" filter.** Store an explicit `assigned_to` (user_id) per task alongside the actor byline, show the member's space-color dot, and add a filter to show only your tasks across all milestones.
- **Milestone drag-reorder for undated work.** Today milestones sort by target date (undated last). Add manual reordering for milestones that share a date or have none, mirroring the task drag pattern with a `milestones/reorder` route.
- **Rolling burn rate.** The header burn rate is completed-tasks ÷ days-since-first-task. A windowed rate (last 7/14 days) and a naïve projected-finish date ("at this pace, ~Aug 12") would make the Timeline more predictive.
- **Task notes / subtasks.** A collapsible note or a shallow subtask list per task, for milestones where a one-line title isn't enough.
- **Archive completed milestones.** Completed milestones are hidden behind a toggle; a true archive (excluded from all queries, restorable) would keep very long-running roadmaps snappy.
- **CSV / markdown export.** A read-only `/api/export` that streams the roadmap as markdown or CSV for status write-ups.
- **Several roadmaps in one space.** Every roadmap session in a space shows the one pair of `roadmap_*` tables; a `roadmap` column (or tables per roadmap) would let a space hold more than one.
