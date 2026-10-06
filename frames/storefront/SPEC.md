# Storefront — the contract

A small shop as one frame: a menu its keepers set, a page where anyone chooses and pays, and the orders as they arrive. It is the example of two things no other shipped frame shows: a stranger acting through a frame's worker, and a worker doing work with no visitor (`start`, thesis M8, amended 2026-09-29).

**Register.** Consumer for the shop a buyer sees; instrument for the three pages a member works in (Orders · Menu · Setup). One serif line, the shop's name. Channel 4. The one moment: when an order is paid, its receipt blooms in once, in the success colour with a tick and a ring that spreads and fades (`--os-cSuccess`, its `-muted` ground).

## Who does what

| Who | Sees | May |
| --- | --- | --- |
| Anyone (a stranger, a viewer) | The shop: what is for sale, the total, the ways to pay, their own order by its code | Place an order, begin a payment, look their order up |
| A member | Orders | Read every order, ask the processors again |
| A collaborator and up | Menu, Setup | Change items and the shop, mark an order paid or cancelled |

A buyer writes no row at the door (`policy::RULES`: every row write is the collaborator's), so everything a buyer does is a route of the worker. A member's acts are routes too, gated on `ctx.peer`, so the page is one page at the space's link and at the frame's published address. The page reads no table.

## What it keeps

A shop is kept in the space's **frame data folder**, `_fdata/`, which every frame of the space reads and writes with no grant and which syncs to every member ([docs/plans/2026-09-30-frame-data.md](../../../docs/plans/2026-09-30-frame-data.md)). Its tables are named for the data and never for this frame, so a kitchen frame, an inventory frame or a customer menu beside it reads the same offerings and orders and the shop stays one shop. A space holds one shop; a second storefront session in the same space serves the same one.

- **The tables** are `_fdata/offerings.table.jsonl`, `_fdata/orders.table.jsonl` and `_fdata/shop.table.jsonl` (one row, `shop`), reached through the worker's `ctx.shared` and open in the table tool from the space's Frame data folder.
- **The pictures** sit in a folder of each table's base name beside it: an item's in `_fdata/offerings/<name>`, the logo in `_fdata/shop/<name>`. They are files of the space, synced like any other, written through the worker.
- **An item:** `name`, `description`, `price` (the currency's smallest unit, so no sum rounds), `min_qty` (1), `max_qty` (0 is no limit), `step` (1), `available`, `sort`, `image` (a picture's name, or none). Its id never changes; an order keeps the name and price as they were.
- **An order:** its id is its code, eight characters with no 0, O, 1, I or L. `at`, `status` (`pending` · `awaiting` · `paid` · `cancelled` · `expired`), `total`, `currency`, `summary`, `items_json`, `buyer`, `note`, `way`, `ref` (the processor's own name for the payment), `paid_at`. The code is what opens an order, so it is random; a receipt names nobody.
- **The shop:** `name`, `currency`, `open`, `note`, `logo` (a picture's name, or none), `color` (one of the theme's twelve channels by name, `c1`…`c12`; none is the frame's own, `c4`), `venmo`, `cashapp`, `zelle`, `square_location`, and `stand_in` (a processor's API served elsewhere, for a check; the page never shows it and the runtime reaches it only if the manifest grants the host).

**A picture** is a JPEG, a PNG or a WebP under 1 MB, told by its first bytes and never by its name, so an SVG (which can carry a script) is none. The page makes it small before it is sent (800 px an item's, 400 px a logo's). The worker names it, so a name is never a path; one that nothing shows any more is removed with what showed it. A buyer is handed a picture by its name through the worker, and never the folder.

**The shop's color is a channel, not a value:** the person's own theme decides what `c7` looks like, in day and in night, so a shop never sets a color that a theme cannot read.

## Ways to pay

| Way | Kind | Needs | Confirmed by |
| --- | --- | --- | --- |
| Stripe | hosted | key `stripe` | asking Stripe for the checkout session |
| Square | hosted | key `square`, the location ID | asking Square for the order |
| PayPal | hosted | key `paypal`, as `client id:secret` | asking PayPal for the order, and capturing one the buyer approved |
| Venmo · Cash App · Zelle | by hand | the shop's handle | a collaborator's Mark paid |

Apple Pay, Google Pay and the rest are not ways of their own: a processor's page offers them once its account has them on, and the page says which under each processor's name. `providers.ts` is the only file that names a processor; a hosted one is two calls, `begin` and `check`. A way is offered to buyers only while it can be used: a hosted one whose key is set and allowed **and whose shop is published**, one by hand whose handle is filled in.

**A processor sends the buyer back to an address it keeps, so that address carries no key, and how the frame is published decides where it is** (the worker reads `publish/frames/<id>`, and Setup says which, in words for the people who run the shop). Published to anyone (`open`), the way back is the shop's public link: `https://<address>.<zone>/?order=<code>` on the hosted stage, the viewer's own link to that address on this machine, with no key and no session. Published by link or to members, that address opens only with a key no processor may be handed (invariant 2), so a hosted way opens the processor in a tab of its own and the buyer is sent back to `paid.html`, the viewer's page that names nothing (`https://<zone>/paid.html`, `/v/paid.html` at a daemon) and tells them to return to the shop's tab, which asks about the order (on return, and every 5 s) and shows it paid. Not published, there is no address for a buyer at all: a hosted way is not offered and cannot be begun. What is paid by hand needs no way back and is offered either way.

**No processor can reach this machine, so nothing is told: everything is asked.** An order waiting on a hosted payment is asked about when its buyer looks (on return, and every 5 s while their page is showing), when a member asks, and every 60 s by the worker's own timer, set in `start` for each space the frame runs in. What changed is pushed to the shop's open pages as a word (`orders`, `shop`) and never as data, and each page reads again as whoever it is, so a buyer's page learns nothing of another's order. A row marked paid is the same row whoever writes it, so two devices running the shop agree. An order nobody paid is `expired` after a day.

## Routes (`/api/…`)

`GET shop` · `GET image/<offerings|shop>/<name>` · `POST order {items: [{id, qty}], name, note}` · `POST pay {order, way, back}` · `GET order/<code>` are anyone's. `GET orders` · `POST reconcile` are a member's. `POST order/<code> {status}` · `GET setup` · `PUT shop` · `PUT image/<offerings|shop>` · `PUT item` · `DELETE item/<id>` are a collaborator's. A cart is priced from the menu as it stands; what a buyer sends is ids and quantities. One worker takes 30 orders a minute from everyone.

## States the page draws

Opening · the shop's logo and color, or the frame's own · nothing for sale (a buyer's words, a collaborator's words and act) · the menu with nothing chosen (Place order off) · a cart · not taking orders · no way to pay set up · choosing a way · waiting on a hosted payment · sending by hand · paid · closed (cancelled, expired) · a refusal in the worker's own words under the act that met it.

## Left out, on purpose

Tax, shipping, discounts, stock counts, refunds, more than one picture of an item, more than one currency per shop. A refund is made at the processor.

## Proofs

`deno test frames/storefront/test/` (the pure part) · in seamside1, checked out beside this repo: `seamside/tests/suite/storefront.rs` (the worker against a stand-in processor, a stranger at the published address of a members-only space, paid with nobody visiting) · `scripts/storefront-check.sh` (both pages through the real viewer, the worker's timer included).

## Not yet proven

- **Square and PayPal against their own APIs.** Both are written from their documented shapes and have met no live account; Stripe's two calls are the ones the stand-in answers. PENDING: a sandbox account each.
- **The way back on the hosted stage.** A buyer returns to `https://<address>.<zone>/?order=<code>`; the page also keeps the code on the device, so a return that loses the query still finds the order. On this machine the way back is proven through the viewer (`scripts/storefront-check.sh`); the stage leg has not been run.
- **A page seated with no origin of its own** (the inlined fallback) keeps nothing between visits, so a buyer returning there is shown the menu and not their receipt. The order is paid and in the shop's table all the same.
- **A published storefront in a members-only space, opened in the keeper's own local viewer by somebody not signed in**, reads "members only": this daemon's frame origin asks the space's tier before the frame's reach. Away from this machine a stranger comes by the published address, which is proven.
