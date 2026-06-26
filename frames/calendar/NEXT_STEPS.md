# Calendar — next steps

A few directions this frame could grow, roughly in order of value:

- **Recurrence bounds.** Weekly-recurring events currently repeat forever. Add an optional
  start date and/or "until" date (and maybe an "every N weeks" interval) to the event form,
  stored on `recur` (`{ days, start?, until?, interval? }`). The frontend `eventsForDay`
  expansion is the only place that needs to learn about the bounds.

- **More recurrence shapes.** Monthly ("3rd Tuesday", "the 15th") and yearly (birthdays,
  anniversaries) are the obvious follow-ups. If this keeps growing, consider vendoring a tiny
  RRULE expander into `public/js/` rather than hand-rolling each rule — but keep storage as the
  plain `recur` object so the backend stays dumb.

- **Edit a single occurrence.** Deleting one day of a series is supported (via the recurrence
  `skip` list); the natural next step is *editing* one occurrence — move it, retime it, rename it —
  which means promoting that day into its own one-off event (or an override record keyed by date).

- **Day view.** The size switch is month ⇆ week ⇆ agenda. A single-day column would suit very busy
  days and narrow-but-tall tiles.

- **Time-zone display polish.** Timed events are already authored in the editor's zone and shifted
  to each viewer's local zone on render (all-day events stay floating). Possible follow-ups: a
  per-viewer "show times in zone X" override, and a clearer affordance in month view (the week-view
  and peek panels already surface the origin zone) when an event was set in a far-away zone.

- **iCal export.** A read-only `GET /api/ics` that emits a `.ics` feed would let people subscribe
  from their own calendar app. Recurrence maps cleanly onto `RRULE`, and the stored `tz` gives the
  `TZID` for each timed event.

## A possible new jig

This frame is `privacy-public-view` + `storage-simple-files` with a **per-instance public/private
toggle** layered on top (an editor-controlled `settings.isPublic` that gates the read side for
non-members). That "owner-flips-public-visibility" pattern shows up in several frames; if it keeps
recurring it may be worth capturing as its own small jig rather than re-deriving the gate each time.
