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
//   3. localDevice(key, frame).info()    — the schema: keys, modes, types, ranges, commands.
//   4. localDevice(key, frame).state()   — latest value per key (last-wins, §14.2).
//   5. localDevice(key, frame).onEvent() — live records, host-throttled.
//   6. .set() / .run() / .read()         — write, execute, and request a value.
//
// v1 has no local-device bus yet: `ensureLocalDevices` reports the key missing, so every
// visitor is shown "no device connected", and `localDevice()` throws.
//
// Grants are PER PLACEMENT: place this frame twice and each copy can watch a different
// device. The session (`ctx.frame`) is threaded through every device call for that reason.
//
// `requires_keys` in frame.json is a MINIMUM, not an exact shape — a device with extra
// keys still matches, and the UI simply renders those too.
//
// HTTP API (under /api):
//   GET  /device                  descriptor + current values + grant status
//   POST /set {key, value} · /read {name} · /run {command, args}
//   PUT  /settings/public_control {enabled} · /settings/view {key, mode}
//        /settings/hidden {key, enabled}
// A push says only what to read again: { local_device_controller: "values" | "settings" }.
// ----------------------------------------------------------------------------------------
import type { Ctx, PeerInfo } from "@frame-core";
import { declareLocalDevices, ensureLocalDevices, localDevice } from "@frame-core";

// Settings: rows of the session's own `settings` table, one per key, the value as JSON
// under `v`. Only this worker reads them.

// May viewers who are NOT space members drive this device?
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
// so every viewer — members and anon alike — sees the same interface.
//
// Editor-level, not member-level: it is cosmetic, but it is SHARED cosmetic
// state, and a Viewer-role member changing what everyone else sees is a
// surprising amount of reach for read-only access.
const VIEW_PREFIX = "view:";

// Keys hidden from people outside the space, e.g. `hidden:servo` -> true.
//
// Enforced in the WORKER, not in CSS. A non-member never receives a hidden key's
// schema or its value, so hiding is real rather than cosmetic — the widget is
// absent because the data is absent. Space members (including Viewers) still see
// everything; this draws the line at the space boundary, not at edit permission.
const HIDDEN_PREFIX = "hidden:";

const TOPIC = "local_device_controller";

// The handle `localDevice` gives where a device bus exists. framecore types it
// `never` while there is none, so the frame names the shape it relies on.
type Value = string | number | boolean;
interface Entry { key: string; [field: string]: unknown }
interface Device {
  info(): {
    uuid: string; name: string; desc: string; online: boolean; read_only: boolean;
    can_command: boolean; rx_bytes: number; keys: Entry[]; commands: Entry[];
  } | null;
  state(): Record<string, string>;
  onEvent(cb: (e: unknown) => void): void;
  set(values: Record<string, Value>): Promise<void>;
  read(name: string): Promise<void>;
  run(command: string, args: Record<string, Value>): Promise<void>;
}
const sensor = (ctx: Ctx) => localDevice("sensor", ctx.frame) as unknown as Device;

type Row = Record<string, unknown> & { id: string };

const settingsTable = (ctx: Ctx) => ctx.own.table<Record<string, unknown>>("settings");

async function allSettings(ctx: Ctx): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const r of await settingsTable(ctx).all() as Row[]) {
    try {
      out[r.id] = JSON.parse(String(r.v));
    } catch { /* skip corrupt */ }
  }
  return out;
}

/** Write a setting over its row, stamped when it was made and when it changed. */
async function setSetting(ctx: Ctx, key: string, value: unknown): Promise<void> {
  const was = await settingsTable(ctx).get(key);
  const now = Date.now();
  await settingsTable(ctx).upsert({
    ...(was ?? { _created_at: now }),
    v: JSON.stringify(value),
    id: key,
    _modified_at: now,
  });
}

/** Drop hidden entries for anyone outside the space. Works for keys and commands
 *  alike — both are addressed by `key`, so one namespace covers both. */
function visibleOnly<T extends { key: string }>(list: T[], hidden: string[], isMember: boolean): T[] {
  return isMember ? list : list.filter((e) => !hidden.includes(e.key));
}

const hiddenKeys = (all: Record<string, unknown>) =>
  Object.entries(all)
    .filter(([k, v]) => k.startsWith(HIDDEN_PREFIX) && v === true)
    .map(([k]) => k.slice(HIDDEN_PREFIX.length));

function viewModes(all: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(VIEW_PREFIX) && typeof v === "string") out[k.slice(VIEW_PREFIX.length)] = v;
  }
  return out;
}

const isEditor = (peer: PeerInfo) => peer.is_sfi_editor || peer.is_owner;

/** May this viewer act on the device right now? */
async function mayAct(ctx: Ctx): Promise<boolean> {
  return isEditor(ctx.peer) || (await allSettings(ctx))[PUBLIC_CONTROL] === true;
}

// One declared key. The host maps it to a different physical device per placement.
declareLocalDevices(["sensor"]);

// Placements that have subscribed. A frame placed twice gets two independent streams.
const wired = new Set<string>();

function wireEvents(ctx: Ctx) {
  if (wired.has(ctx.frame)) return;
  wired.add(ctx.frame);
  // A push reaches every open page, a stranger's included, and carries nothing:
  // each page reads /api/device again as whoever it is, so a hidden key's value
  // reaches only the people allowed to see it.
  sensor(ctx).onEvent(() => ctx.push({ [TOPIC]: "values" }));
}

const json = (v: unknown, status = 200) => Response.json(v, { status });
const refuse = (status: number, error: string) => json({ error }, status);

// deno-lint-ignore no-explicit-any
async function body(request: Request): Promise<any> {
  try {
    const v = JSON.parse(await request.text());
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

async function describe(ctx: Ctx): Promise<Response> {
  const peer = ctx.peer;
  const ensured = ensureLocalDevices(peer);
  // Distinguish "the owner needs to connect one" from "you're a guest" — a
  // viewer shouldn't be told to click something only the owner can see.
  const notConnected = () => json({ connected: false, can_connect: peer.is_owner, missing: ensured.missingKeys });
  if (!ensured.ready) return notConnected();
  wireEvents(ctx);
  const dev = sensor(ctx);
  const info = dev.info();
  if (!info) return notConnected();
  const all = await allSettings(ctx);
  const hidden = hiddenKeys(all);
  const member = isEditor(peer) || peer.is_sfi_member;
  return json({
    connected: true,
    can_edit: await mayAct(ctx),
    // Only an editor sees or changes the settings. An anon viewer is told
    // nothing about them — the affordance simply is not there.
    is_editor: isEditor(peer),
    public_control: all[PUBLIC_CONTROL] === true,
    views: viewModes(all),
    uuid: info.uuid,
    name: info.name,
    desc: info.desc,
    online: info.online,
    read_only: info.read_only,
    can_command: info.can_command,
    // The schema IS the UI spec — the frontend builds every control from this.
    // Mode picks the kind of control, type picks the widget (§11.1).
    //
    // Hidden keys are STRIPPED for non-members rather than flagged: a viewer
    // outside the space never learns the key exists, and cannot read its value
    // out of the response. Members get the full schema plus the hidden list so
    // an editor can see what is hidden and unhide it.
    keys: visibleOnly(info.keys, hidden, member),
    commands: visibleOnly(info.commands, hidden, member),
    hidden: member ? hidden : [],
    // `_r|0` means the device has no receive path, so nothing is writable.
    rx_bytes: info.rx_bytes,
    values: member
      ? dev.state()
      : Object.fromEntries(Object.entries(dev.state()).filter(([k]) => !hidden.includes(k))),
  });
}

const WRITES = new Set([
  "POST /set", "POST /read", "POST /run",
  "PUT /settings/public_control", "PUT /settings/view", "PUT /settings/hidden",
]);

export default {
  async fetch(request: Request, ctx: Ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith("/api/")) {
      if (request.method !== "GET") return refuse(404, "not found");
      return ctx.file(pathname);
    }
    const route = `${request.method} ${pathname.slice(4)}`;
    if (route === "GET /device") return describe(ctx);
    if (!WRITES.has(route)) return refuse(404, "not found");
    const msg = (await body(request)) ?? {};
    const named = (v: unknown): v is string => typeof v === "string" && v !== "";

    // Visibility is editor-level, like presentation. It decides what people
    // outside the space can see of this device, so it is a sharing decision.
    if (route === "PUT /settings/hidden") {
      if (!isEditor(ctx.peer)) return refuse(403, "only space editors can hide keys");
      if (!named(msg.key)) return refuse(400, "key required");
      if (msg.enabled === true) await setSetting(ctx, HIDDEN_PREFIX + msg.key, true);
      else await settingsTable(ctx).delete(HIDDEN_PREFIX + msg.key); // shown is the default; don't store it
      ctx.push({ [TOPIC]: "settings" });
      return json({ ok: true });
    }

    // Presentation is editor-level. It moves no hardware, so it does not need the
    // control gate — but it IS shared state that every viewer sees, so it takes
    // the same edit permission as any other shared change.
    if (route === "PUT /settings/view") {
      if (!isEditor(ctx.peer)) return refuse(403, "only space editors can change the layout");
      if (!named(msg.key) || !named(msg.mode)) return refuse(400, "key and mode required");
      await setSetting(ctx, VIEW_PREFIX + msg.key, msg.mode);
      ctx.push({ [TOPIC]: "settings" });
      return json({ ok: true });
    }

    // Changing the sharing switch is EDITOR-ONLY, always, and is checked before
    // anything else. If an anon viewer could flip this they would be granting
    // themselves control, which would make the whole toggle worthless.
    if (route === "PUT /settings/public_control") {
      if (!isEditor(ctx.peer)) return refuse(403, "only space editors can change sharing");
      await setSetting(ctx, PUBLIC_CONTROL, msg.enabled === true);
      ctx.push({ [TOPIC]: "settings" });
      return json({ ok: true });
    }

    // Who may drive the device: an editor always, or anyone if public control is
    // switched on. The HOST independently re-checks the grant, the key's declared
    // mode, and the range before anything reaches the wire — that is the real
    // boundary, and this check only decides who is allowed to ask.
    if (!(await mayAct(ctx))) return refuse(403, "you don't have permission to control this device");
    if (route === "POST /set" && !named(msg.key)) return refuse(400, "key required");
    if (route === "POST /read" && !named(msg.name)) return refuse(400, "name required");
    if (route === "POST /run" && !named(msg.command)) return refuse(400, "command required");

    // The placement is the session serving this request, never the body: a grant
    // belongs to a placement, so letting the payload name one would let a viewer
    // at placement A drive placement B's device.
    try {
      const dev = sensor(ctx);
      if (route === "POST /set") {
        await dev.set({ [msg.key]: msg.value as Value });
      } else if (route === "POST /read") {
        // §11.1: a control that has never seen a value asks for one instead of
        // waiting for the device to volunteer it. The value returns as an
        // ordinary report, not as this call's result.
        await dev.read(msg.name);
      } else {
        // Arguments by NAME — the host maps them into declaration order (§8.2).
        await dev.run(msg.command, msg.args ?? {});
      }
      return json({ ok: true });
    } catch (e) {
      // The host's message is specific ("above the device maximum of 160") and is the
      // whole point of set()/run() rejecting instead of silently no-op'ing.
      return refuse(409, String((e as Error)?.message ?? e));
    }
  },
};
