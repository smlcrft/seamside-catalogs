# Frame writes go over the tether (frame.busSend), not HTTP POST/PUT

The common pattern for every frame write, current and upcoming. Why: Android's
webview cannot expose HTTP request bodies to the custom-protocol bridge, so any
`frame.api` POST/PUT reaches the backend with zero bytes (seamside issue #750).
The tether WebSocket carries payloads normally on every platform, and its
UI→frame direction (`BusUiToFrame`) is exactly the shape of a frame write.
Reads are unaffected: `frame.api` GETs stay as they are.

Worked example: the bundled `whiteboard` frame in the seamside app repo
(`chassis/bundled_catalogs/frames/whiteboard/`).

## The shape

**Command + push.** The frontend fires a write and never awaits a response; the
backend mutates and broadcasts the resulting state via `pushToInstance`; every
viewer — the sender included — renders from the push. Most well-built frames
already render from pushes (that's how other viewers see changes), so the
migration is usually a pure transport swap.

### Frontend

```js
// write: fire-and-forget over the tether. `op` dispatches on the backend.
frame.busSend({ op: "element/add", kind: "path", points, color });
// read: unchanged
const state = await frame.api("api/state");
```

If the frame has a single `api(method, path, body)` helper (the house style),
the whole migration is one branch in it:

```js
if (method === "POST" || method === "PUT") {
  frame.busSend({ op: path.replace(/^\/api\//, ""), ...(body || {}) });
  return {};
}
```

### Backend

```ts
import { onUiMessage } from "@frame-core";

onUiMessage((sfiId, data, peer) => {
  // `peer` is the sender's platform-resolved identity — the SAME shape
  // parsePeerInfo yields for HTTP. Gate writes on peer.is_sfi_editor /
  // peer.is_owner exactly like HTTP writes. An unidentified sender parses
  // as anonymous, so a missing identity can only LOSE privileges.
  const d = data as Record<string, unknown>;
  if (d.op === "element/add") mutAddElement(sfiId, d, peer);
  // …
});
```

Keep one mutation function per write, shared by the bus dispatcher and any
HTTP arms you keep for API compatibility — the two entry points must never
drift on validation or role gates. Role gates live INSIDE the mutation
functions.

## Rules

- **Writes: bus. Reads: HTTP GET.** Never a bodied POST/PUT from frame UI code.
- **Import framelib RELATIVE**: `./lib/js/framelib.js`, never the absolute
  `/lib/js/framelib.js`. The relative path is a phantom directory under the
  frame URL that resolves on the frame's HOST device (seamside 0.2.4+), so
  framelib always matches the host the frame runs on; the web viewer maps it
  to its CDN mirror for caching. Requires `app_version_min` ≥ 0.2.4.
- **Feature-detect `frame.busSend` anyway.** Web viewers run the CDN framelib
  and a not-yet-updated host serves an older one — guard with
  `typeof frame.busSend === "function"` and fall back to the HTTP write.
- **No response, by design.** The push is the confirmation; the frontend renders
  from it like every other viewer already does. Don't build request/response on
  top of the bus in a frame — if a flow genuinely needs a reply, that's a
  platform conversation, not a frame workaround.
- **Ordering holds.** One WebSocket, FIFO; the worker processes sequentially.
- **Denied writes are logged, not answered.** A legitimate client never sends a
  write it isn't allowed to make (the UI is role-gated); log server-side.
- **Large/binary payloads (file upload) are still an open question** on #750 —
  keep uploads on their existing path until that's decided.
- Regression coverage lives in the app repo: `harness/tests/tier2_frame_bus_write.rs`
  (payload round-trip + sender identity end-to-end on a real worker).
