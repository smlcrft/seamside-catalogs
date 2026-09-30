# Next steps

The frame is intentionally lean — a `members` list of the space chosen per session (Member Manager's roster, read only), the shared `library_assets` table in the space's frame data folder (`_fdata`), the library's rules and who may edit as rows of the session's own settings (the owner's alone, so no collaborator rewrites them at the door), and a single-page UI. Some natural extensions:

1. **Reservations / waitlist** — let members reserve an item that's currently checked out and notify the next person when it's checked back in.
2. **Checkout history** — a third table that logs each checkout/checkin event so the community can see who has used an item over time and spot popular items.
3. **Search & filter** — add a search input and toggle chips to filter by status (available / checked out / overdue / issue) and by item type.
4. **Photo per item** — store a small photo per asset as a file of the space (`Community Library/<item>/`, through `ctx.files`) so members can recognize tools and gear at a glance.
5. **Email-on-overdue** — send through an email API the worker reaches (a declared `net` host and a key the keeper grants) so the frame can nudge borrowers when items pass their due date.
6. **Per-item borrow override** — let owners set a different max borrow duration for a specific item (e.g. consumables get shorter loans), independent of the library's default.
7. **Bulk import** — accept a CSV drop to seed the catalog quickly when first standing up the library.
8. **QR-code labels** — generate a printable label per item that, when scanned, deep-links into the frame with that asset selected for fast checkout.
