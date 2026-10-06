# Writing a catalog frame against the v1 frame API

Every frame here speaks the v1 frame API (`export default { fetch }`, `ctx`, `window.seamside`); the older entry shape (`self.onNetworkRequest`, `parsePeerInfo`, `table(key, sfiId)`, `pushToInstance`, `frame.api`, `frame.busSend`) is gone from Seamside, and this is how a frame written against it moves. There is one frame API with two surfaces, so the move is a change of style with two real repairs (rules A and B below). Where a frame keeps its data is `seamside1/docs/plans/2026-09-30-frame-data.md`. `frames/help_desk` is the worked example; `frames/storefront` is its relative here, the one that takes payments. Read both before moving a frame.

The API itself: `seamside1/arbiter/framecore.ts` (worker side, read its top comment and the `Ctx` interface), `seamside1/framelib/framelib.js` (page side), `seamside1/docs/agent-primer.md` ("The server half").

## The rules of the move

- **Do not change what a frame does.** Routes, table names, row shapes, setting keys and what each role may do stay as they are. One concern per change. If you find a bug that is not part of the surface, leave it and report it.
- **Keep row shapes.** A row carries `_created_at` and `_modified_at` and starts from the frame's own defaults; rows you write keep doing both.
- **What a frame keeps for itself and others is in the frame data folder:** `ctx.shared.table(name)` (a page reads it as `seamside.table("_fdata/<name>")`) and `ctx.shared.files`, named for the data and never for the frame.
- **A frame's settings are its session's own:** `ctx.own.table("settings")`, one row per setting, the value as JSON under `v`, read with the frame's default when the row is absent (the table starts empty in every session). No page, wire or other frame reaches it. Only what another frame needs in order to work goes in `_fdata`, and never a setting only the owner may change or one that decides who may do what, since any collaborator writes `_fdata` at the door. A marker that shared rows were seeded is shared data, not a setting: it may sit in `_fdata` beside them (`help_desk_setup`), so no session seeds again what an editor removed; where seeding once per session is fine, it is a setting like any other (community_home).
- **Session state** (a timer, a station, a bound list's name) is `ctx.kv`, the worker's alone.
- **Borrow structure, not code.** Each frame keeps its own design and its own words on screen.
- Frames share no code: a helper a frame needs is written in that frame.

## Worker (`frame.ts`)

| Older | v1 |
| --- | --- |
| `self.onNetworkRequest = async (replyPort, path, method, headers, query, body, cookies)` answering with `replyPort.postMessage` / `jsonReply` | `export default { fetch(request, ctx) }` returning a `Response` |
| `parsePeerInfo(query, cookies)` | `ctx.peer` (same fields) |
| `table(key, sfiId)` with `query`, `upsert(id, patch)`, `max`, `countBy`, `deleteWhere` | `ctx.shared.table(name)` (or `ctx.table(path)` for a table of the person's, by the `data` grant) with `get`, `upsert(row)`, `delete`, `all` and `query({ where, order, limit, offset })`, filtered in the store; `max`, `countBy` and `deleteWhere` are a line over `query` |
| `ensureTables`, `openTablePicker`, `renderWaitingForOwner` | gone: every table is ready |
| `declareTables` | kept, `columns` only: it checks required columns on write, and a declaration with none required checks nothing, so leave it out. A table that speaks a contract in `docs/schema-contracts.md` keeps its schema constant for its defaults |
| `frameSettings(sfiId)` | `ctx.own.table("settings")`, rows `{ v: JSON.stringify(value) }` |
| `sessionKv` | `ctx.kv` |
| `serveFileAtPath`, `serveHtmlShell` | `ctx.file(pathname)`; the page asks the worker who it is, nothing is stamped into the HTML |
| `spaceFiles` | `ctx.files` (the person's, by the `data` grant), `ctx.shared.files`, `ctx.own.files` |
| `onUiMessage` + `POST /__ui` | an ordinary route in `fetch`, so the page gets an answer |
| `pushToInstance(sfiId, data)`, `wireTableChangeListener` | `ctx.push({ <frame>: "<what changed>" })` after the write |
| `log(...)` | `ctx.log(...)` |
| `loadJsonFile` / `saveJsonFile` / `frameDataDir` | `ctx.data.read(name)` / `ctx.data.write(name, bytes)`: `data/`, the worker's own folder on this device |

Things that bite:

- **`ctx.table(name).upsert(row)` replaces the row; the old `upsert(id, patch)` merged.** Write one small helper that reads the row, lays the change over it, and stamps it (help_desk's `keep`). A new row starts from the frame's own defaults, since nothing fills them in for you: keep them in a constant and read them from it.
- **A column declared `required` refuses an empty string.** The older `schema` dialect required nothing, so a frame that moves to `columns` marks required only what was never written empty.
- **The pure helpers stay:** `sanitizeText`, `parseJsonBody`, `toIntOrNull`, `clampInt`, `extname` and `contentType` are imported from `@frame-core`.
- **Row ids** are `row.id` now, where the old handle said `row._row_id` / `row.row_id`. What the page is sent keeps the field names it had.
- **Who is asking:** `const editor = ctx.peer.is_sfi_editor || ctx.peer.is_owner; const member = editor || ctx.peer.is_sfi_member;`. `is_anon` means not on the roster, signed in or not. `ctx.peer.user_id` is set for anyone signed in.
- **A worker's write lands for whoever reached it**, a stranger and a viewer included. Every write route decides on `ctx.peer`. Old code that refused to write "because v1 writes a worker's rows as the person" is out of date: the row is the frame's own.
- **A `GET` carries no body.** A `Request` made with one throws.
- **A push carries no data.** Say what to read again (`{ help_desk: "messages" }`), never the rows, an id's details or a name. Every open page of the frame hears it, a stranger's included, and reads again as whoever it is. A push reaches only this frame's pages, so a frame that must follow rows another frame writes has its members' page watch the table (`seamside.kv.watch('t/<table>/', …)`).
- **Work with no visitor** is added only where the frame already refreshes something (a cache with an age, a refresh on visit), at the interval it already implies, and goes in `start(ctx)`: one timer per session, kept in a `Map` by `ctx.frame`, cleared in `stop(ctx)`. There is no peer in a hook. Write rows that are the same whoever writes them: key a row by the thing it records. Everything goes through that `ctx`.
- **An API key** is `await ctx.key(name)`, declared under `permissions_backend.keys`. Never sent to the page.

## Manifest (`frame.json`)

- `permissions.net` becomes `permissions_backend.net`; leave it out when it is empty. Other `permissions` (camera, microphone and the like) stay.
- Remove `permissions.web` and `permissions.web_scripts`: they governed v0's embedded browser.
- Set `app_version_min` to `1.0.12` and `modified_at` to the time of the change.

## Page (`public/`)

- `<link rel="stylesheet" href="/dyn/frame-prefs.css">` and `import … from "/lib/js/framelib.js"`. framelib still exports Preact (`html`, `render`, the hooks), `useFramePush`, `applyChannel` and `frame`; a page built on them stays built on them.
- `window.seamside` exists only where the page imports `/lib/js/framelib.js`: a page that used none of its exports keeps a bare `import "/lib/js/framelib.js";`.
- `await window.seamside.ready` before the first call.
- `frame.api(path, body, method)` becomes a small wrapper over `window.seamside.fetch` that throws the worker's own `error` (help_desk's `api`). `r.json()` there is not a promise.
- `useFramePush` given a map of handlers hears only pushes that carry a `type`; give it a function for `{ <frame>: "<what>" }`.
- `frame.busSend` becomes a request with an answer. Re-read after your own write and let the push bring everyone else along.
- `window.__peer` is gone. Ask the worker (`you: { member, editor }` on the first read) or read `window.seamside.me`. Never decide anything that matters in the page.
- `frame.localStorageGetItem/SetItem` becomes `seamside.prefs.get/set`.
- `frame.alert`, `frame.confirm`, `frame.prompt`, `frame.choose` and `frame.openExternalUrl` have no other form: keep them. `frame.fetch`, `frame.api`, `frame.busSend`, `frame.requestMediaAccess`, `frame.localStorage*` and `WAITING` are gone.
- The keeper's own name is not in `ctx.peer.user_name` (it comes from a roster row, and the owner has none): keep whatever fallback the frame already draws.
- **No `<form>` and no `onSubmit`.** A sandboxed page's form does nothing at all. A `div` with `data-form`, the button's click, Enter on the field, and `reportValidity()` on each control keep what the browser's own checks gave.
- What a `<form>` gave its fields (`autocomplete="off"`) moves onto each control.
- framelib's `Editable` lays a caller's props over its own, so handing it `onFocus`, `onBlur` or `onInput` breaks it; `onKeyDown` is safe.
- **A picture the worker serves is fetched as bytes.** In the sandboxed seating a page has no origin, so `<img src="api/…">` loads nothing: fetch it with `seamside.fetch` and draw it from a blob URL. Bytes going up ride as a `Uint8Array` body through `seamside.fetch`.
- **A vendored library that fetches or starts a Worker by URL** needs both routed: its requests through `seamside.fetch` (MapLibre takes a custom protocol), its worker built from its bytes where the page has no origin (tests/trip_planner.browser.mjs, frames/trip_planner). A library that `console.error`s every failed fetch fails the check offline: give it an error handler.
- **A download is `seamside.saveFile(name, blob)`.** An anchor click with `download` does nothing in the sandboxed seating; `saveFile` is refused at a page's own address with no viewer, so fall back to the anchor there.
- A page loads no outside script, style, font or picture, and reaches no outside host.
- A published page names nobody until the visitor signs in. framelib offers a small Sign in where the page serves itself; a frame that wants its own draws it and calls `seamside.signIn()`.

## The two repairs

**A. A stranger and a viewer write no row at the door.** `KV.PUT`, `KV.DEL` and `KV.ADD` take the collaborator rung. A page that writes `seamside.kv`, `seamside.table(...)` on behalf of a visitor moves that write into the worker, gated on `ctx.peer`.

**B. A stranger reads a table only when its file is published open.** A page that shows a stranger something from a table asks the worker for it, and the worker hands over only what that visitor may see. A page that only ever serves members may go on reading and watching its table.

## Proving it

A frame that loads clean is not yet a frame that works. Each moved frame has two files in `tests/`:

- **`tests/<frame>.json`, the scenario:** door lines sent as `stranger`, `signed` (signed in, on no roster), `viewer`, `collaborator`, `admin` or `owner` (a browser the keeper claimed), against the frame in a members-only space, published or not. `{api}` is `/frames/<id>/api`, `{frame}` is `/frames/<id>`, `{id}` the session's id (a space in a door line's path is written `%20`), `{did:<who>}` a person's ID. A step checks `status`, `has` and `lacks` (text in the answer), `is` (JSON pointers and what each holds), `absent` (JSON pointers that must lead nowhere), keeps values with `save` for later steps as `{name}`, waits with `tries`, or reads a `table` of the space (its rows come back as `{"cells":{…},"id":…}` with keys sorted, so match on a field, never on a run of JSON). `"at": "space"` sends a line to the space's own door (members-only, so nobody is `signed` there), which is how a row is seeded as a collaborator. `"publish": "open"` publishes the frame; leave it out for a frame that is only its members'. `"keys"` sets and allows API keys. A session's own keys and tables no door line reaches (403, which a step may prove); check them through the frame's own routes, and a `"table"` step on a `_` name reads the session's own table (`_settings`). A setting changed mid-scenario is changed through the frame's own route, as the owner if it is owner-only. Run one with `seamside1/scripts/catalog-scenario.sh <frame>`.
- **`tests/<frame>.browser.mjs`, the steps in a browser:** the keeper's browser with the frame seated and, when asked for, a stranger's at the published address. Run with `seamside1/scripts/catalog-check.sh <frame>`, and again with `CATALOG_CHECK_SANDBOX=1` for the page inlined into a sandboxed frame. What was written is read back from the daemon (`rows`, `untilRows`), never from the page; `seed(table, id, cells)` puts a row in a table as the keeper, which is how a frame starts from another frame's table; it raises no push, so reload the page to see it. The steps are handed `address` and `session`, so a space's file is `owner('GET', `spaces/${address}/files/<path>`)` rather than a search of the disk. A session's own keys reach no page: check them through the frame's own routes. The keeper's page is already open when the steps begin. The window is 900 px wide; a frame with a wide layout is widened with `b.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, b.child)`.

`deno check --config seamside1/arbiter/deno.json frames/<frame>/frame.ts` types the worker. The sweep (`sweep::every_catalog_tool_answers` in seamside1's arbiter tier) starts every frame and asks for its entry page.

A pointer drag is `Input.dispatchMouseEvent` with `buttons: 1` (tests/garden_planner.browser.mjs); an HTML drag-and-drop is `Input.setInterceptDrags` then `Input.dispatchDragEvent` (tests/kanban.browser.mjs). In the browser steps, read `textContent` of the page's own root: `innerText` follows `text-transform`, and the document's HTML, and `document.body.textContent`, hold the inline script's source. `click` takes a CSS selector, so mark the one element you mean through `inFrame` first when a selector cannot say it. Enter is `b.press('Enter')`, a field is emptied with `b.clear(selector)`, and a `<select>` is set through `inFrame` with a bubbling `change` event, and a `time` or `date` input by setting its value and firing the bubbling event the page listens for (`input` for `onInput`, `change` for `onChange`; typed digits do not reach it). The rows `rows` hands back keep their cells with the keys sorted: compare field by field, never as a string.

A `mailto:`, `sms:` or `tel:` link handed to the system stops a headless browser taking clicks: stand in for the anchor's click in the viewer's page and check the link it was given.

A frame that calls an outside host is proven offline: run the check with `HTTPS_PROXY=http://127.0.0.1:9 NO_PROXY=127.0.0.1,localhost`, which the worker's Deno honours, and test the failure path. `seamside.prefs` lasts one document in the sandboxed seating, so a remembered choice is expected back only at the frame's own origin.

What neither reaches is said in the change: a call to an outside service, a camera, a second device.
