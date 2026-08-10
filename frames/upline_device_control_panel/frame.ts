// ----------------------------------------------------------------------------------------
// Demo: Local Device — a GENERIC interface to any Upline serial peripheral.
//
// The frame hardcodes nothing about the device. It renders whatever the device's own
// descriptor declares, so the same frame works for a thermometer, a servo rig, or
// something neither existed when this was written.
//
// Shows the full framecore local-device paradigm:
//   1. declareLocalDevices([...])        — name the keys this frame uses. They MUST match
//                                          frame.json's `permissions.local_devices`.
//   2. ensureLocalDevices(peer)          — gate every request; prompts the owner to pick a
//                                          device FOR THIS PLACEMENT.
//   3. localDevice(key, sfi).info()      — the schema: keys, modes, types, ranges, commands.
//   4. localDevice(key, sfi).state()     — latest value per key (last-wins, §14.2).
//   5. localDevice(key, sfi).onEvent()   — live records, host-throttled.
//   6. .set() / .run() / .read()         — write, execute, and request a value.
//
// Grants are PER PLACEMENT, like SyncTable bindings: place this frame twice and each
// copy can watch a different device. `sfi_id` is threaded through every call for
// exactly that reason.
//
// `requires_keys` in frame.json is a MINIMUM, not an exact shape — a device with extra
// keys still matches, and the UI simply renders those too.
//
// HTTP API:
//   GET /api/device — descriptor + current values + grant status for this placement
//   tether { type: "set", key, value } / { type: "run", command } — see onUiMessage
// ----------------------------------------------------------------------------------------
import {
  log, serveFileAtPath, parsePeerInfo, jsonReply,
  declareLocalDevices, ensureLocalDevices, localDevice, pushToInstance, onUiMessage,
  frameSettings,
} from "@frame-core";

// Per-placement setting: may viewers who are NOT space members drive this device?
//
// Default OFF, and deliberately so — this is the one switch that turns a frame
// shared by link into a remote control for physical hardware on the owner's
// desk. Only a space EDITOR may change it; an anon viewer can never grant
// themselves access, which is the property that makes the toggle safe to offer
// at all.
//
// It widens WHO MAY ASK. It does not widen what may happen: the host still
// checks the grant, the key's declared mode, and the range on every write.
const PUBLIC_CONTROL = "allow_public_control";

// Per-key presentation override, e.g. `view:rgb` -> "palette". §11.1 gives the
// DEFAULT widget for a type; this records where an editor chose a different one
// so every viewer of this placement — members and anon alike — sees the same
// interface.
//
// Editor-level, not member-level: it is cosmetic, but it is SHARED cosmetic
// state, and a Viewer-role member changing what everyone else sees is a
// surprising amount of reach for read-only access.
const VIEW_PREFIX = "view:";

async function viewModes(sfiId: string): Promise<Record<string, string>> {
  if (!sfiId) return {};
  const all = await frameSettings(sfiId).all();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(VIEW_PREFIX) && typeof v === "string") out[k.slice(VIEW_PREFIX.length)] = v;
  }
  return out;
}

async function publicControlEnabled(sfiId: string): Promise<boolean> {
  if (!sfiId) return false;
  return (await frameSettings(sfiId).get<boolean>(PUBLIC_CONTROL, false)) === true;
}

/** May this viewer act on the device right now? */
async function mayAct(peer: { sfi_id: string; is_sfi_editor: boolean }): Promise<boolean> {
  return peer.is_sfi_editor || (await publicControlEnabled(peer.sfi_id));
}

// One declared key. The host maps it to a different physical device per placement.
declareLocalDevices(["sensor"]);

// Placements that have subscribed. A frame placed twice gets two independent streams.
const wired = new Set<string>();

function wireEvents(sfiId: string) {
  if (!sfiId || wired.has(sfiId)) return;
  wired.add(sfiId);
  localDevice("sensor", sfiId).onEvent((e) => {
    // Push to the placement the record came from — never broadcast, or placement A
    // would see placement B's device readings.
    pushToInstance(e.sfi_id, { type: "device_tick", at_ms: e.at_ms, values: e.values });
  });
}

self.onNetworkRequest = async function (replyPort, reqPath, method, _headers, query, _body, cookies) {
  const peer = parsePeerInfo(query, cookies);
  const ensured = ensureLocalDevices(peer);
  wireEvents(peer.sfi_id);

  if (method === "GET" && !reqPath.startsWith("/api/")) {
    return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url));
  }

  if (reqPath === "/api/device" && method === "GET") {
    const dev = localDevice("sensor", peer.sfi_id);
    const info = dev.info();
    if (!info) {
      // Distinguish "the owner needs to connect one" from "you're a guest" — a
      // viewer shouldn't be told to click something only the owner can see.
      return jsonReply(replyPort, 200, {
        connected: false,
        can_connect: peer.is_owner,
        missing: ensured.missingKeys,
      });
    }
    return jsonReply(replyPort, 200, {
      connected: true,
      can_edit: await mayAct(peer),
      // Only an editor sees or changes the sharing switch. An anon viewer is
      // told nothing about it — the affordance simply is not there.
      // Both settings — presentation and control sharing — are editor-level.
      is_editor: peer.is_sfi_editor,
      public_control: await publicControlEnabled(peer.sfi_id),
      views: await viewModes(peer.sfi_id),
      uuid: info.uuid,
      name: info.name,
      desc: info.desc,
      online: info.online,
      read_only: info.read_only,
      can_command: info.can_command,
      // The schema IS the UI spec — the frontend builds every control from this.
      // Mode picks the kind of control, type picks the widget (§11.1).
      keys: info.keys,
      commands: info.commands,
      // `_r|0` means the device has no receive path, so nothing is writable.
      rx_bytes: info.rx_bytes,
      values: dev.state(),
    });
  }

  return jsonReply(replyPort, 404, { error: "not found", path: reqPath });
};

// Writes arrive over the TETHER (HTTP write bodies are dropped on Android), so the
// outcome goes back via pushToInstance rather than as a response.
//
// `peer` is reconstructed by the HOST from its own identity cookies — absent identity
// parses as anonymous, so a spoofed delivery can only lose privileges.
onUiMessage(async (sfiId, data, peer) => {
  const msg = data as {
    type?: string; key?: string; name?: string;
    value?: string | number | boolean; command?: string;
    args?: Record<string, string | number | boolean>;
    enabled?: boolean; mode?: string;
  };
  if (msg?.type !== "set" && msg?.type !== "run" && msg?.type !== "read"
      && msg?.type !== "set_public_control" && msg?.type !== "set_view") return;

  // Presentation is editor-level. It moves no hardware, so it does not need the
  // control gate — but it IS shared state that every viewer of this placement
  // sees, so it takes the same edit permission as any other shared change.
  if (msg.type === "set_view") {
    if (!peer.is_sfi_editor) {
      return pushToInstance(sfiId, { type: "act_result", ok: false, error: "only space editors can change the layout" });
    }
    if (!msg.key || !msg.mode) return;
    await frameSettings(sfiId).set(VIEW_PREFIX + msg.key, msg.mode);
    return pushToInstance(sfiId, { type: "settings_changed" });
  }

  // Changing the sharing switch is EDITOR-ONLY, always, and is checked before
  // anything else. If an anon viewer could flip this they would be granting
  // themselves control, which would make the whole toggle worthless.
  if (msg.type === "set_public_control") {
    if (!peer.is_sfi_editor) {
      return pushToInstance(sfiId, { type: "act_result", ok: false, error: "only space editors can change sharing" });
    }
    await frameSettings(sfiId).set(PUBLIC_CONTROL, msg.enabled === true);
    return pushToInstance(sfiId, { type: "settings_changed", public_control: msg.enabled === true });
  }

  // Who may drive the device: an editor always, or anyone if this placement has
  // public control switched on. The HOST independently re-checks the grant, the
  // key's declared mode, and the range before anything reaches the wire — that
  // is the real boundary, and this check only decides who is allowed to ask.
  if (!(await mayAct(peer))) {
    return pushToInstance(sfiId, { type: "act_result", ok: false, error: "you don't have permission to control this device" });
  }

  // The placement comes from the HOST's delivery, not from the message body: a grant
  // belongs to a placement, so letting the payload name one would let a viewer at
  // placement A drive placement B's device.
  const dev = localDevice("sensor", sfiId);
  try {
    if (msg.type === "set") {
      if (!msg.key) return;
      await dev.set({ [msg.key]: msg.value as string | number | boolean });
    } else if (msg.type === "read") {
      // §11.1: a control that has never seen a value asks for one instead of
      // waiting for the device to volunteer it. The value returns as an
      // ordinary report, not as this call's result.
      if (!msg.name) return;
      await dev.read(msg.name);
      return; // nothing to confirm; the report is the answer
    } else {
      if (!msg.command) return;
      // Arguments by NAME — the host maps them into declaration order (§8.2).
      await dev.run(msg.command, msg.args ?? {});
    }
    pushToInstance(sfiId, { type: "act_result", ok: true });
  } catch (e) {
    // The host's message is specific ("above the device maximum of 160") and is the
    // whole point of set()/run() rejecting instead of silently no-op'ing.
    pushToInstance(sfiId, { type: "act_result", ok: false, error: String((e as Error)?.message ?? e) });
  }
});

log("local device demo: ready");
