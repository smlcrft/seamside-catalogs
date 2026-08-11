// ----------------------------------------------------------------------------------------
// Cafe Orders — order from your phone; a board behind the counter.
//
// Design axes:
//   privacy:        privacy-split-view   — the SAME placement is two different products.
//                                           A customer (anon, or any non-editor) gets the
//                                           menu and a cart; staff (space editors) get the
//                                           order board and the menu editor. This is the
//                                           frame's whole shape, not a disabled state.
//   data_storage:   storage-local        — deliberately NO shared table and NO contract.
//                                           A cafe's menu and its orders are its own; there
//                                           is no second frame acting on the same rows, so
//                                           making the owner graduate and bind tables would
//                                           charge ceremony for nothing. See "When NOT to
//                                           write a contract" in docs/schema-contracts.md.
//   view_realtime:  view-collaborative    — every write pushes, so a new order lands on the
//                                           counter tablet and a "ready" lands on the
//                                           customer's phone without a refresh.
//   settings_scope: settings-per-sfi
//
// MONEY RULES, because this frame can take real money:
//   1. Prices are integer CENTS everywhere. No floats touch a price, ever — 0.1 + 0.2 is
//      not 0.3 and a till may not round like that.
//   2. The total is computed HERE, from the menu, against the item ids and quantities the
//      customer sent. A total that arrives from a client is ignored: it is an input from a
//      stranger on the internet, and this is the one field where believing them costs the
//      cafe money.
//   3. Card details never reach this frame or the cafe's devices. When Stripe is connected
//      the frame creates a Checkout Session through the capability and hands the customer
//      Stripe's own hosted page; the secret key stays in the capability, which the frame
//      cannot read.
// ----------------------------------------------------------------------------------------
import {
  log, serveFileAtPath, jsonReply, parseJsonBody, parsePeerInfo, onUiMessage,
  pushToInstance, sanitizeText, loadJsonFile, saveJsonFile,
  declareTables, ensureTables, table, invokeCapability,
} from "@frame-core";

// ----- Tables (local only — this cafe's own data) ----------------------------------------
const MENU_SCHEMA = [
  { name: "name",        col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "description", col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "price_cents", col_type: "integer" as const, nullable: false, default_val: "0" },
  { name: "category",    col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "sold_out",    col_type: "integer" as const, nullable: false, default_val: "0" },
  { name: "sort_order",  col_type: "integer" as const, nullable: false, default_val: "0" },
];

const ORDERS_SCHEMA = [
  { name: "ref",           col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "customer_name", col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "items_json",    col_type: "text"    as const, nullable: false, default_val: "[]" },
  { name: "total_cents",   col_type: "integer" as const, nullable: false, default_val: "0" },
  { name: "status",        col_type: "text"    as const, nullable: false, default_val: "new" },
  { name: "note",          col_type: "text"    as const, nullable: false, default_val: "" },
  { name: "placed_ms",     col_type: "integer" as const, nullable: false, default_val: "0" },
  { name: "paid",          col_type: "integer" as const, nullable: false, default_val: "0" },
  { name: "payment_ref",   col_type: "text"    as const, nullable: false, default_val: "" },
];

declareTables([
  { key: "menu",   title: "Menu",   description: "Items on this cafe's menu.",   local: true, schema: MENU_SCHEMA },
  { key: "orders", title: "Orders", description: "Orders placed at this cafe.", local: true, schema: ORDERS_SCHEMA },
]);

// ----- Per-placement settings -------------------------------------------------------------
type PaymentMode = "counter" | "stripe";
type Shop = {
  shop_name: string;
  currency: string;        // ISO code, e.g. "usd" — Stripe wants lowercase
  symbol: string;          // what customers see, e.g. "$"
  ordering_open: boolean;
  pickup_note: string;
  payment_mode: PaymentMode;
  next_ref: number;        // drives the short human code a customer reads out
};
const DEFAULT_SHOP: Shop = {
  shop_name: "Cafe", currency: "usd", symbol: "$", ordering_open: true,
  pickup_note: "Collect at the counter.", payment_mode: "counter", next_ref: 1,
};
const allShops: Record<string, Shop> = loadJsonFile(import.meta.url, "shops.json", {});
function getShop(sfiId: string): Shop {
  return { ...DEFAULT_SHOP, ...(allShops[sfiId] ?? {}) };
}
function saveShop(sfiId: string, s: Shop): void {
  allShops[sfiId] = s;
  saveJsonFile(import.meta.url, "shops.json", allShops);
}

type Peer = ReturnType<typeof parsePeerInfo>;
type Tbl = ReturnType<typeof table>;
type WriteResult = { status: number; body: unknown };

const STATUSES = ["new", "making", "ready", "collected", "cancelled"] as const;
type Status = typeof STATUSES[number];
const isStatus = (v: unknown): v is Status => (STATUSES as readonly string[]).includes(String(v));

/** A short code the customer can read out at the counter: A1…A99, then B1… . Much easier
 * to say than a row id, and it resets per placement rather than per day so two orders can
 * never share a code while both are still open. */
function mintRef(shop: Shop): string {
  const n = shop.next_ref;
  shop.next_ref = n + 1;
  const letter = String.fromCharCode(65 + Math.floor((n - 1) / 99) % 26);
  return letter + String(((n - 1) % 99) + 1);
}

async function readyTables(peer: Peer): Promise<boolean> {
  const quiet = { ...peer, is_owner: false } as Peer;
  let r = ensureTables(quiet);
  for (const key of ["menu", "orders"]) {
    if (!r.byKey[key]) {
      try { await table(key, peer.sfi_id).query({ limit: 1 }); } catch (e) { log(`cafe_orders: ensure "${key}" failed: ${e}`); }
      r = ensureTables(quiet);
    }
  }
  return !!r.byKey["menu"] && !!r.byKey["orders"];
}

function notify(sfiId: string) {
  pushToInstance(sfiId, { type: "cafe_changed" });
}

// ----- Reads --------------------------------------------------------------------------------
type MenuItem = {
  id: string; name: string; description: string;
  price_cents: number; category: string; sold_out: boolean; sort_order: number;
};

async function listMenu(t: Tbl): Promise<MenuItem[]> {
  const { rows } = await t.query({ order_by: [{ col: "sort_order" }] });
  return rows.map((r) => ({
    id: String(r._row_id), name: String(r.name ?? ""), description: String(r.description ?? ""),
    price_cents: Number(r.price_cents) || 0, category: String(r.category ?? ""),
    sold_out: !!Number(r.sold_out), sort_order: Number(r.sort_order) || 0,
  }));
}

type OrderLine = { name: string; qty: number; price_cents: number };

async function listOrders(t: Tbl) {
  const { rows } = await t.query({ order_by: [{ col: "placed_ms", dir: "desc" }], limit: 200 });
  return rows.map((r) => {
    let items: OrderLine[] = [];
    try { const p = JSON.parse(String(r.items_json ?? "[]")); if (Array.isArray(p)) items = p; } catch { /* a corrupt line list must not take down the board */ }
    return {
      id: r._row_id, ref: r.ref, customer_name: r.customer_name, items,
      total_cents: Number(r.total_cents) || 0, status: String(r.status || "new"),
      note: r.note, placed_ms: Number(r.placed_ms) || 0,
      paid: !!Number(r.paid), payment_ref: r.payment_ref,
    };
  });
}

// ----- Stripe -------------------------------------------------------------------------------
/** Create a hosted Checkout Session for an order and return its URL, or null if Stripe is
 * not connected / the call failed. Card data never comes near this frame: the customer is
 * handed Stripe's own page, and the secret key lives in the capability where frame code
 * cannot read it.
 *
 * NOTE: Stripe's REST API takes form-encoded bodies with bracket notation
 * (`line_items[0][price_data][unit_amount]`). The capability layer sends `encoding: "form"`
 * capabilities that way; on an older host that only speaks JSON this call fails cleanly and
 * the order falls back to paying at the counter rather than stranding the customer. */
async function stripeCheckoutUrl(shop: Shop, ref: string, lines: OrderLine[], returnUrl: string): Promise<string | null> {
  const params: Record<string, unknown> = {
    mode: "payment",
    success_url: returnUrl,
    cancel_url: returnUrl,
    client_reference_id: ref,
    line_items: lines.map((l) => ({
      quantity: l.qty,
      price_data: {
        currency: shop.currency,
        unit_amount: l.price_cents,
        product_data: { name: l.name },
      },
    })),
  };
  try {
    const r = await invokeCapability("stripe", "v1/checkout/sessions", params);
    if (!r.success) { log(`cafe_orders: stripe checkout failed (status ${r.status})`); return null; }
    const parsed = JSON.parse(r.result_json || "{}");
    const url = typeof parsed?.url === "string" ? parsed.url : null;
    if (!url) log("cafe_orders: stripe returned no checkout url");
    return url;
  } catch (e) {
    log(`cafe_orders: stripe invoke threw: ${e}`);
    return null;
  }
}

// ----- Writes ---------------------------------------------------------------------------------
// One shared mutation path for both transports (frame.busSend → onUiMessage, and the HTTP
// POST arm for older viewers). Role gates live here so the two can never drift.
//
// The gate is NOT uniform in this frame, which is the point: placing an order is the one
// write a stranger is allowed to make, because that is the entire product. Everything else
// — the board, the menu, the shop settings — is staff-only.
async function handleWrite(sfiId: string, op: string, v: Record<string, unknown> | null, peer: Peer): Promise<WriteResult> {
  if (!(await readyTables(peer))) return { status: 503, body: { error: "tables not ready" } };
  const menu = table("menu", sfiId);
  const orders = table("orders", sfiId);
  const shop = getShop(sfiId);
  const isStaff = !!peer.is_sfi_editor;

  const ok = async (extra?: Record<string, unknown>): Promise<WriteResult> => {
    notify(sfiId);
    return { status: 200, body: { ok: true, ...(extra ?? {}) } };
  };

  // --- Placing an order: open to everyone, including anonymous customers --------------
  if (op === "order") {
    if (!shop.ordering_open) return { status: 409, body: { error: "ordering is closed" } };

    const wanted = Array.isArray(v?.items) ? v!.items as unknown[] : [];
    if (!wanted.length) return { status: 400, body: { error: "empty order" } };

    // Price the order from OUR menu, not from what the client sent. Quantities are
    // clamped so a stray 10^9 can't mint a nonsense total, and a sold-out or unknown
    // item is dropped rather than guessed at.
    const rowsById = new Map((await listMenu(menu)).map((m) => [m.id, m]));
    const lines: OrderLine[] = [];
    let total = 0;
    for (const w of wanted) {
      if (!w || typeof w !== "object") continue;
      const o = w as Record<string, unknown>;
      const item = rowsById.get(String(o.id ?? ""));
      if (!item || item.sold_out) continue;
      const qty = Math.max(1, Math.min(99, Math.round(Number(o.qty) || 0)));
      lines.push({ name: String(item.name), qty, price_cents: item.price_cents });
      total += qty * item.price_cents;
    }
    if (!lines.length) return { status: 400, body: { error: "nothing orderable in that order" } };

    const ref = mintRef(shop);
    saveShop(sfiId, shop);   // persist the counter even if the rest fails, so refs never repeat

    const { row_id } = await orders.upsert(null, {
      ref,
      customer_name: sanitizeText(v?.customer_name, 60) || "Someone",
      items_json: JSON.stringify(lines),
      total_cents: total,
      status: "new",
      note: sanitizeText(v?.note, 200),
      placed_ms: Date.now(),
      paid: 0,
      payment_ref: "",
    });

    // Card payment is optional and must never block the order: if Stripe is not connected
    // or the call fails, the order still stands and is simply paid for at the counter.
    let pay_url: string | null = null;
    if (shop.payment_mode === "stripe") {
      pay_url = await stripeCheckoutUrl(shop, ref, lines, sanitizeText(v?.return_url, 500) || "https://seamside.com");
    }
    notify(sfiId);
    return { status: 200, body: { ok: true, order_id: row_id, ref, total_cents: total, pay_url } };
  }

  // --- Everything below is staff-only ---------------------------------------------------
  if (!isStaff) return { status: 403, body: { error: "staff only" } };

  if (op.startsWith("order/")) {
    const [id, action] = op.slice("order/".length).split("/");
    if (!id || !(await orders.get(id))) return { status: 400, body: { error: "bad id" } };
    if (action === "status") {
      const next = String(v?.status ?? "");
      if (!isStatus(next)) return { status: 400, body: { error: "bad status" } };
      await orders.upsert(id, { status: next });
      return ok();
    }
    if (action === "paid") {
      await orders.upsert(id, { paid: Number(v?.paid) ? 1 : 0 });
      return ok();
    }
    if (action === "delete") {
      await orders.delete(id);
      return ok();
    }
    return { status: 404, body: { error: "not found" } };
  }

  // Sweep the day's finished tickets off the board in one go.
  if (op === "orders/clear_done") {
    await orders.deleteWhere({ status: "collected" });
    await orders.deleteWhere({ status: "cancelled" });
    return ok();
  }

  // --- Menu -------------------------------------------------------------------------------
  if (op === "item") {
    const name = sanitizeText(v?.name, 120);
    if (!name) return { status: 400, body: { error: "name required" } };
    const { rows } = await menu.query({ order_by: [{ col: "sort_order", dir: "desc" }], limit: 1 });
    const nextOrder = rows.length ? (Number(rows[0].sort_order) || 0) + 1 : 0;
    await menu.upsert(null, {
      name,
      description: sanitizeText(v?.description, 200),
      price_cents: Math.max(0, Math.min(1_000_000, Math.round(Number(v?.price_cents) || 0))),
      category: sanitizeText(v?.category, 40),
      sold_out: 0,
      sort_order: nextOrder,
    });
    return ok();
  }

  if (op.startsWith("item/")) {
    const [id, action] = op.slice("item/".length).split("/");
    if (!id || !(await menu.get(id))) return { status: 400, body: { error: "bad id" } };
    if (action === "delete") { await menu.delete(id); return ok(); }
    if (action) return { status: 404, body: { error: "not found" } };
    const patch: Record<string, unknown> = {};
    if (v?.name !== undefined) { const n = sanitizeText(v.name, 120); if (n) patch.name = n; }
    if (v?.description !== undefined) patch.description = sanitizeText(v.description, 200);
    if (v?.category !== undefined) patch.category = sanitizeText(v.category, 40);
    if (v?.price_cents !== undefined) patch.price_cents = Math.max(0, Math.min(1_000_000, Math.round(Number(v.price_cents) || 0)));
    if (v?.sold_out !== undefined) patch.sold_out = Number(v.sold_out) ? 1 : 0;
    if (Object.keys(patch).length) await menu.upsert(id, patch);
    return ok();
  }

  // --- Shop settings (owner-only: these decide whether money changes hands) -------------
  if (op === "shop") {
    if (!peer.is_owner) return { status: 403, body: { error: "owner only" } };
    const next: Shop = { ...shop };
    if (v?.shop_name !== undefined) next.shop_name = sanitizeText(v.shop_name, 80) || DEFAULT_SHOP.shop_name;
    if (v?.pickup_note !== undefined) next.pickup_note = sanitizeText(v.pickup_note, 200);
    if (v?.symbol !== undefined) next.symbol = sanitizeText(v.symbol, 4) || "$";
    if (v?.currency !== undefined) next.currency = (sanitizeText(v.currency, 8) || "usd").toLowerCase();
    if (v?.ordering_open !== undefined) next.ordering_open = !!v.ordering_open;
    if (v?.payment_mode !== undefined) next.payment_mode = v.payment_mode === "stripe" ? "stripe" : "counter";
    saveShop(sfiId, next);
    return ok();
  }

  return { status: 404, body: { error: "not found" } };
}

onUiMessage(async (sfiId, data, peer) => {
  if (!sfiId || typeof data !== "object" || data === null) return;
  const d = data as Record<string, unknown>;
  if (typeof d.op !== "string") return;
  const r = await handleWrite(sfiId, d.op, d, peer);
  if (r.status !== 200) log(`cafe_orders: bus op ${d.op} → ${r.status} (${JSON.stringify(r.body)})`);
});

// ----- Networking -----------------------------------------------------------------------------
self.onNetworkRequest = async function (replyPort, reqPath, method, headers, query, body, cookies) {
  const peer = parsePeerInfo(query, cookies);
  const sfiId = peer.sfi_id;

  if (method === "GET" && !reqPath.startsWith("/api/")) {
    return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url), headers);
  }

  if (reqPath === "/api/whoami" && method === "GET") {
    return jsonReply(replyPort, 200, {
      is_anon:       peer.is_anon,
      is_sfi_member: peer.is_sfi_member,
      is_sfi_editor: peer.is_sfi_editor,
      is_owner:      peer.is_owner,
      user_id:       peer.user_id,
      user_name:     peer.user_name,
      space_color:   peer.space_color,
    });
  }

  // Placing an order is a POST a stranger may make, so the write arm stays open here and
  // handleWrite does the per-op gating.
  if (reqPath.startsWith("/api/") && (method === "POST" || method === "PUT")) {
    const r = await handleWrite(sfiId, reqPath.slice("/api/".length), parseJsonBody<Record<string, unknown>>(body), peer);
    return jsonReply(replyPort, r.status, r.body);
  }

  if (!(await readyTables(peer))) return jsonReply(replyPort, 503, { error: "tables not ready" });
  const shop = getShop(sfiId);

  if (reqPath === "/api/state" && method === "GET") {
    const menuRows = await listMenu(table("menu", sfiId));
    const staff = !!peer.is_sfi_editor;
    return jsonReply(replyPort, 200, {
      shop: {
        shop_name: shop.shop_name, symbol: shop.symbol, currency: shop.currency,
        ordering_open: shop.ordering_open, pickup_note: shop.pickup_note,
        payment_mode: shop.payment_mode,
      },
      // Customers never see a sold-out item's row disappear (that reads as "we removed it")
      // — they see it struck through, so the menu stays the same shape all day.
      menu: menuRows,
      // The board is staff-only: an order carries a stranger's name and what they bought.
      orders: staff ? await listOrders(table("orders", sfiId)) : [],
      is_staff: staff,
      is_owner: peer.is_owner,
    });
  }

  // A customer polling their own ticket: by row id, and it returns ONLY the status and
  // ref, never the name or the contents — the id is the only thing they hold, and a
  // guessed id must not leak somebody else's order.
  if (reqPath.startsWith("/api/order/") && method === "GET") {
    const id = reqPath.slice("/api/order/".length);
    const row = id ? await table("orders", sfiId).get(id) : null;
    if (!row) return jsonReply(replyPort, 404, { error: "not found" });
    return jsonReply(replyPort, 200, { ref: row.ref, status: row.status, paid: !!Number(row.paid) });
  }

  return jsonReply(replyPort, 404, { error: "not found" });
};

log("Cafe Orders frame is up and running!");
