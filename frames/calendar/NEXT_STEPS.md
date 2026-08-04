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

## Do not re-add a public/private toggle

This frame used to carry a per-instance `settings.isPublic` that gated the read side for
non-members. It has been removed, and an earlier version of this note proposed promoting that
"owner-flips-public-visibility" pattern into a jig — don't. Public access is decided by the
**platform** (public sharing on the placement), not by the frame. A frame that keeps its own
gate produces the bug this pattern always produced: you share the frame publicly, the visitor
opens the link, and the frame tells them it's private because its own flag defaulted to off.

The rule this frame now follows, and the one to follow in new frames:

- If a request reaches the frame, the viewer is allowed to be here. Reads are open.
- The `parsePeerInfo` flags shape the *view* and gate *writes* — never read access.
- Gate writes on `is_sfi_editor`, never on `is_sfi_member` (Viewer-role members would slip
  through) and never on `!is_anon`.
- A reduced projection for non-members (fewer columns, identities withheld) is fine: that is
  what a public view looks like, not an access gate.
