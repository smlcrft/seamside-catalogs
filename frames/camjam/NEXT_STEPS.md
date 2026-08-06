# CamJam — next steps

Deliberately small. The frame does one thing: one member at a time, a still on an
interval, fanned out to whoever is watching. Everything below is a *possible* next move,
not a TODO — most of them would cost more error surface than they're worth.

## Worth considering

- **Per-viewer quality.** The rung is one setting for everyone. A viewer on a big tile
  and a viewer on a thumbnail get identical bytes. The host could keep the incoming still
  plus one downscale and let `/api/state` serve whichever the viewer asked for — the size
  cap and the ladder are already host-side, so only the serve path would change.
- **Auto-rung.** The ladder is a manual owner choice; the host could pick a rung from the
  observed viewer count (a 12-person space probably doesn't want the 1080px rung).
- **A "raise hand" queue.** Today taking over is immediate and unannounced. A one-row
  queue (`frameSettings` is enough) would let the next person ask instead of interrupt.
- **Mirror the sharer's own preview.** The sharer currently watches the same round-tripped
  still as everyone else, which is honest but lags by up to one interval. A local
  `<video>` preview beside it would show both.
- **Remember the chosen camera.** `frame.localStorageSetItem` could hold the last
  `deviceId` per placement so a returning sharer doesn't re-pick.

## Deliberately NOT here

- **Audio.** `permissions.microphone` stays `false`. Adding it would cost every viewer a
  broader consent prompt for a feature this frame doesn't have.
- **Recording / history.** The still lives in a module-level `Map` on the host and is
  gone when sharing stops or the worker restarts. Persisting it would turn a glanceable
  presence signal into a surveillance archive — a different frame, with a different name.
- **Real video (WebRTC).** That's the platform's call feature, not a frame's. The whole
  point here is the low-bandwidth, low-stakes middle ground between "nothing" and "a call".

## Might be worth a jig

There's no jig for **ephemeral host-memory state** — data that is deliberately never
persisted, keyed per placement, with a self-expiring holder. This frame, a "who's typing"
indicator, and a presence roster all want the same shape. If a third one shows up, it
belongs in `../jigs/` as `storage-ephemeral-memory`.
