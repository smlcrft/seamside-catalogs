// Storefront's server half. A buyer is a stranger and writes nothing at the
// door, so everything they do is a route here: the menu they are shown, the
// order they place, the payment they begin. A member's acts are routes too,
// gated on who the door proved they are, so the page is one page wherever
// it was opened.
//
// What a shop keeps is in the space's frame data folder, named for the
// data and never for this frame (`offerings`, `orders`, `shop`), so a
// kitchen or an accounting frame beside it reads the same tables; each
// table's pictures sit in a folder of its base name beside it.
//
// Payments are checked by asking the processor, never by being told: no
// processor can reach this machine. `start` sets that asking on a timer for
// each space this frame runs in, so an order is marked paid with nobody
// looking at the page.

import type { Ctx } from "@frame-core";
import { declareTables } from "@frame-core";
import {
  bySort,
  code,
  doneAt,
  imageName,
  imageType,
  isCode,
  type Item,
  itemOf,
  money,
  type Order,
  pictureOf,
  priced,
  receipt,
  returnTo,
  type Shop,
  shopOf,
  stale,
  summary,
  text,
} from "./lib.ts";
import { BY_HAND, HOSTED, type Hosted, way } from "./providers.ts";

const CHECK_EVERY_MS = 60_000;
/** Orders one worker will take in a minute, from everyone: a page anyone can
 *  open must not be a way to fill a table. */
const ORDERS_A_MINUTE = 30;

const session = (ctx: Ctx) => ctx.frame.split("/").pop() || "storefront";

/** A picture's path in the frame data folder: an item's beside the
 *  offerings table, the shop's logo beside the shop table. */
const picture = (of: "offerings" | "shop", name: string) => `${of}/${name}`;

/** How this shop is published, which is where a processor may send a buyer
 *  back: `open` at its plain address, `keyed` when the address opens only
 *  with a key (by link, or to members) that no processor may be handed, so
 *  the buyer pays in a tab of its own and lands on a page that names nothing,
 *  or `none`, when there is no address for a buyer at all. */
type Reach = "open" | "keyed" | "none";
async function reach(ctx: Ctx): Promise<Reach> {
  const v = (await ctx.kv.get(`publish/frames/${session(ctx)}`))?.value;
  return !v ? "none" : v === "open" ? "open" : "keyed";
}

declareTables([
  { key: "offerings", columns: { name: { type: "text", required: true } } },
  { key: "orders", columns: { status: { type: "text", required: true } } },
]);

const json = (v: unknown, status = 200) => Response.json(v, { status });
const refuse = (status: number, error: string) => json({ error }, status);

const shopTable = (ctx: Ctx) => ctx.shared.table<Record<string, unknown>>("shop");
const offerings = (ctx: Ctx) => ctx.shared.table<Record<string, unknown>>("offerings");
const orders = (ctx: Ctx) => ctx.shared.table<Order>("orders");

async function shopIn(ctx: Ctx): Promise<Shop> {
  return shopOf(await shopTable(ctx).get("shop"));
}

async function menuIn(ctx: Ctx): Promise<Item[]> {
  const rows = await offerings(ctx).all();
  return rows.map(itemOf).filter((i): i is Item => i !== null).sort(bySort);
}

/** Whether a key can be spent, in the daemon's own words when it cannot. */
async function keyFor(ctx: Ctx, id: string): Promise<{ key: string; why: string }> {
  try {
    return { key: await ctx.key(id), why: "" };
  } catch (e) {
    return { key: "", why: (e as Error).message };
  }
}

/** The ways this shop can be paid right now. */
async function ways(ctx: Ctx, shop: Shop) {
  const out: Array<Record<string, unknown>> = [];
  const how = await reach(ctx);
  for (const p of how === "none" ? [] : HOSTED) {
    const { key } = await keyFor(ctx, p.id);
    if (key && !p.needs?.(shop)) out.push({ id: p.id, kind: p.kind, name: p.name, carries: p.carries, tab: how === "keyed" });
  }
  for (const p of BY_HAND) if (p.handle(shop)) out.push({ id: p.id, kind: p.kind, name: p.name });
  return out;
}

// What changed, never what it holds: each page reads again as whoever it is.
const tell = (ctx: Ctx, what: "orders" | "shop") => ctx.push({ storefront: what });

/** Ask the processor about one order and write what it says. The row is the
 *  same whoever writes it, so two devices checking one order agree. */
async function settle(ctx: Ctx, shop: Shop, o: Order, now: number): Promise<Order> {
  const p = way(o.way);
  if (o.status === "pending" && p?.kind === "hosted" && o.ref) {
    const { key } = await keyFor(ctx, p.id);
    if (key) {
      const { paid, at } = await (p as Hosted).check(o.ref, shop, key);
      if (paid) {
        const done: Order = { ...o, status: "paid", paid_at: at ?? now };
        await orders(ctx).upsert(done);
        tell(ctx, "orders");
        return done;
      }
    }
  }
  if (stale(o, now)) {
    const gone: Order = { ...o, status: "expired" };
    await orders(ctx).upsert(gone);
    return gone;
  }
  return o;
}

/** Every order still waiting, asked about. One that fails is said in the log
 *  and asked about again next time. */
async function reconcile(ctx: Ctx): Promise<number> {
  const shop = await shopIn(ctx);
  const now = Date.now();
  let settled = 0;
  for (const o of await orders(ctx).all()) {
    if (o.status !== "pending" && o.status !== "awaiting") continue;
    try {
      if ((await settle(ctx, shop, o, now)).status !== o.status) settled++;
    } catch (e) {
      ctx.log(`order ${o.id}: ${(e as Error).message}`);
    }
  }
  return settled;
}

/** A picture nothing shows any more goes with what showed it. */
async function drop(ctx: Ctx, of: "offerings" | "shop", name: string) {
  await ctx.shared.files.remove(picture(of, name)).catch((e) => ctx.log(`picture ${name}: ${(e as Error).message}`));
}

const timers = new Map<string, ReturnType<typeof setInterval>>();
let taken: number[] = [];

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const v = JSON.parse(await request.text());
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export default {
  start(ctx: Ctx) {
    clearInterval(timers.get(ctx.frame));
    const check = () => reconcile(ctx).catch((e) => ctx.log(`checking payments: ${(e as Error).message}`));
    timers.set(ctx.frame, setInterval(check, CHECK_EVERY_MS));
    check();
  },

  stop(ctx: Ctx) {
    clearInterval(timers.get(ctx.frame));
    timers.delete(ctx.frame);
  },

  async fetch(request: Request, ctx: Ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith("/api/")) return ctx.file(pathname);
    const route = `${request.method} ${pathname.slice(4)}`;
    const editor = ctx.peer.is_sfi_editor || ctx.peer.is_owner;
    const member = editor || ctx.peer.is_sfi_member;
    const one = /^(GET|POST) \/orders?\/([^/]+)$/.exec(route);

    if (route === "GET /shop") {
      const shop = await shopIn(ctx);
      const menu = await menuIn(ctx);
      return json({
        shop: { name: shop.name, currency: shop.currency, open: shop.open, note: shop.note, logo: shop.logo, color: shop.color },
        items: editor ? menu : menu.filter((i) => i.available),
        ways: await ways(ctx, shop),
        you: { editor, member },
      });
    }

    // A picture of the shop's, by the name this frame gave it: the folder is
    // the members', so a buyer is handed the one file and never the folder.
    const shown = /^GET \/image\/(offerings|shop)\/([^/]+)$/.exec(route);
    if (shown) {
      const name = imageName(shown[2]);
      const bytes = name ? await ctx.shared.files.read(picture(shown[1] as "offerings" | "shop", name)) : null;
      if (!bytes) return refuse(404, "There is no picture by that name.");
      return new Response(bytes as unknown as BodyInit, { headers: { "content-type": imageType(name) } });
    }

    if (route === "POST /order") {
      const shop = await shopIn(ctx);
      if (!shop.open) return refuse(409, "This shop is not taking orders right now.");
      const now = Date.now();
      taken = taken.filter((t) => now - t < 60_000);
      if (taken.length >= ORDERS_A_MINUTE) return refuse(429, "Too many orders at once. Try again in a minute.");
      const asked = await body(request);
      const cart = priced(await menuIn(ctx), asked.items);
      if ("error" in cart) return refuse(400, cart.error);
      const buyer = text(asked.name, 80);
      if (!buyer) return refuse(400, "Add a name for the order.");
      taken.push(now);
      const o: Order = {
        id: code(),
        at: now,
        status: "pending",
        total: cart.total,
        currency: shop.currency,
        summary: summary(cart.lines),
        items_json: JSON.stringify(cart.lines),
        buyer,
        note: text(asked.note, 280),
        way: "",
        ref: "",
        paid_at: 0,
      };
      await orders(ctx).upsert(o);
      tell(ctx, "orders");
      return json({ order: receipt(o), ways: await ways(ctx, shop) });
    }

    if (route === "POST /pay") {
      const asked = await body(request);
      if (!isCode(asked.order)) return refuse(400, "That order code is not one of ours.");
      const o = await orders(ctx).get(String(asked.order));
      if (!o) return refuse(404, "No order has that code.");
      if (o.status === "paid") return json({ order: receipt(o) });
      if (o.status !== "pending" && o.status !== "awaiting") return refuse(409, "This order is closed. Start a new one.");
      const shop = await shopIn(ctx);
      const p = way(String(asked.way ?? ""));
      if (!p) return refuse(400, "Choose how to pay.");
      if (p.kind === "hand") {
        if (!p.handle(shop)) return refuse(409, `${p.name} is not set up for this shop.`);
        const next: Order = { ...o, status: "awaiting", way: p.id, ref: "" };
        await orders(ctx).upsert(next);
        tell(ctx, "orders");
        return json({
          order: receipt(next),
          hand: {
            name: p.name,
            handle: p.handle(shop),
            amount: money(o.total, o.currency),
            link: p.link?.(shop, o.total, o.currency, o.id) ?? "",
          },
        });
      }
      const how = await reach(ctx);
      if (how === "none") return refuse(409, `${p.name} is offered once this shop is published.`);
      const back = how === "open" ? returnTo(asked.back, o.id) : doneAt(asked.back);
      if (!back) return refuse(400, "This page could not say where to come back to.");
      const { key, why } = await keyFor(ctx, p.id);
      if (!key || p.needs?.(shop)) {
        ctx.log(`${p.name}: ${why || p.needs?.(shop)}`);
        return refuse(409, `${p.name} is not set up for this shop.`);
      }
      try {
        const began = await p.begin({
          order: o.id,
          lines: JSON.parse(o.items_json),
          total: o.total,
          currency: o.currency,
          shop,
          back,
          key,
        });
        if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)/.test(began.url) || !began.ref) {
          throw new Error(`${p.name} gave no page to pay on`);
        }
        const next: Order = { ...o, status: "pending", way: p.id, ref: began.ref };
        await orders(ctx).upsert(next);
        return json({ order: receipt(next), url: began.url });
      } catch (e) {
        ctx.log(`${p.name}: ${(e as Error).message}`);
        return refuse(502, `${p.name} could not start the payment. Try again, or choose another way to pay.`);
      }
    }

    if (one?.[1] === "GET") {
      if (!isCode(one[2])) return refuse(404, "No order has that code.");
      const o = await orders(ctx).get(one[2]);
      if (!o) return refuse(404, "No order has that code.");
      try {
        return json({ order: receipt(await settle(ctx, await shopIn(ctx), o, Date.now())) });
      } catch (e) {
        ctx.log(`order ${o.id}: ${(e as Error).message}`);
        return json({ order: receipt(o) });
      }
    }

    // Everything below is a member's.
    if (!member) return refuse(403, "Sign in as a member of this space to see this.");

    if (route === "GET /orders") {
      const all = await orders(ctx).all();
      return json({ orders: all.sort((a, b) => b.at - a.at).slice(0, 200) });
    }

    if (route === "POST /reconcile") return json({ settled: await reconcile(ctx) });

    if (!editor) return refuse(403, "Changing the shop takes the collaborator role.");

    if (one?.[1] === "POST") {
      const o = await orders(ctx).get(one[2]);
      if (!o) return refuse(404, "No order has that code.");
      const to = String((await body(request)).status ?? "");
      if (to !== "paid" && to !== "cancelled") return refuse(400, "An order is marked paid or cancelled.");
      await orders(ctx).upsert({ ...o, status: to, paid_at: to === "paid" ? o.paid_at || Date.now() : 0 });
      tell(ctx, "orders");
      return json({ ok: true });
    }

    if (route === "GET /setup") {
      const shop = await shopIn(ctx);
      const hosted = [];
      for (const p of HOSTED) {
        const { key, why } = await keyFor(ctx, p.id);
        hosted.push({
          id: p.id,
          name: p.name,
          carries: p.carries,
          ready: !!key && !p.needs?.(shop),
          why: key ? p.needs?.(shop) ?? "" : why,
        });
      }
      return json({
        shop,
        hosted,
        hand: BY_HAND.map((p) => ({ id: p.id, name: p.name, handle: p.handle(shop) })),
        reach: await reach(ctx),
      });
    }

    const put = /^PUT \/image\/(offerings|shop)$/.exec(route);
    if (put) {
      const bytes = new Uint8Array(await request.arrayBuffer());
      const kind = pictureOf(bytes);
      if (!kind) return refuse(400, "That is not a picture this shop can show. Use a JPEG, a PNG or a WebP under 1 MB.");
      const name = `${crypto.randomUUID().slice(0, 8)}.${kind.ext}`;
      await ctx.shared.files.write(picture(put[1] as "offerings" | "shop", name), bytes);
      return json({ name });
    }

    if (route === "PUT /shop") {
      const was = await shopIn(ctx);
      const shop = shopOf({ ...was, ...(await body(request)) });
      if (was.logo && was.logo !== shop.logo) await drop(ctx, "shop", was.logo);
      await shopTable(ctx).upsert({ id: "shop", ...shop });
      tell(ctx, "shop");
      return json({ shop });
    }

    if (route === "PUT /item") {
      const asked = await body(request);
      const item = itemOf({ ...asked, id: text(asked.id, 64) || crypto.randomUUID().slice(0, 8) });
      if (!item) return refuse(400, "An item needs a name.");
      const was = (await menuIn(ctx)).find((i) => i.id === item.id);
      if (was?.image && was.image !== item.image) await drop(ctx, "offerings", was.image);
      await offerings(ctx).upsert({ ...item });
      tell(ctx, "shop");
      return json({ item });
    }

    const gone = /^DELETE \/item\/([^/]+)$/.exec(route);
    if (gone) {
      const was = (await menuIn(ctx)).find((i) => i.id === decodeURIComponent(gone[1]));
      if (was?.image) await drop(ctx, "offerings", was.image);
      await offerings(ctx).delete(decodeURIComponent(gone[1]));
      tell(ctx, "shop");
      return json({ ok: true });
    }

    return refuse(404, "Storefront has nothing at that address.");
  },
};
