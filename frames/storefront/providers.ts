// The ways to pay. A hosted one has a page of its own the buyer goes to and
// an API that says whether they paid: two calls, `begin` and `check`. One
// paid by hand has a handle to send money to and nobody to ask, so a member
// marks it paid. Nothing else in this frame names a processor.

import { decimal, type Line, type Shop } from "./lib.ts";

export interface Begin {
  order: string;
  lines: Line[];
  total: number;
  currency: string;
  shop: Shop;
  back: string;
  key: string;
}

export interface Hosted {
  kind: "hosted";
  id: string;
  name: string;
  /** The wallets its page offers once the account has them turned on. */
  carries: string[];
  host: string;
  /** What the shop must say before this can be offered, beside its key. */
  needs?: (shop: Shop) => string | null;
  begin(b: Begin): Promise<{ url: string; ref: string }>;
  check(ref: string, shop: Shop, key: string): Promise<{ paid: boolean; at?: number }>;
}

export interface ByHand {
  kind: "hand";
  id: string;
  name: string;
  handle(shop: Shop): string;
  /** A link that opens the payment already filled in, where there is one. */
  link?(shop: Shop, total: number, currency: string, order: string): string;
}

const base = (p: Hosted, shop: Shop) => shop.stand_in || `https://${p.host}`;

async function said(r: Response, who: string): Promise<Record<string, unknown>> {
  const body = await r.text();
  let v: Record<string, unknown> = {};
  try {
    v = JSON.parse(body);
  } catch { /* not JSON: the status says it */ }
  if (!r.ok) {
    const e = v.error as Record<string, unknown> | string | undefined;
    const why = (typeof e === "object" ? e?.message : e) ?? v.message ?? v.error_description ?? "";
    throw new Error(`${who} answered ${r.status}${why ? `: ${String(why).slice(0, 200)}` : ""}`);
  }
  return v;
}

const stripe: Hosted = {
  kind: "hosted",
  id: "stripe",
  name: "Stripe",
  carries: ["Cards", "Apple Pay", "Google Pay"],
  host: "api.stripe.com",
  async begin(b) {
    const f = new URLSearchParams({
      mode: "payment",
      success_url: b.back,
      cancel_url: b.back,
      client_reference_id: b.order,
      "metadata[order]": b.order,
    });
    b.lines.forEach((l, i) => {
      f.set(`line_items[${i}][quantity]`, String(l.qty));
      f.set(`line_items[${i}][price_data][currency]`, b.currency.toLowerCase());
      f.set(`line_items[${i}][price_data][unit_amount]`, String(l.price));
      f.set(`line_items[${i}][price_data][product_data][name]`, l.name);
    });
    const v = await said(
      await fetch(`${base(this, b.shop)}/v1/checkout/sessions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${b.key}`,
          "content-type": "application/x-www-form-urlencoded",
          "idempotency-key": `storefront-${b.order}`,
        },
        body: f,
      }),
      this.name,
    );
    return { url: String(v.url ?? ""), ref: String(v.id ?? "") };
  },
  async check(ref, shop, key) {
    const v = await said(
      await fetch(`${base(this, shop)}/v1/checkout/sessions/${encodeURIComponent(ref)}`, {
        headers: { authorization: `Bearer ${key}` },
      }),
      this.name,
    );
    return { paid: v.payment_status === "paid" };
  },
};

const square: Hosted = {
  kind: "hosted",
  id: "square",
  name: "Square",
  carries: ["Cards", "Apple Pay", "Google Pay", "Cash App Pay"],
  host: "connect.squareup.com",
  needs: (shop) => (shop.square_location ? null : "Add your Square location ID."),
  async begin(b) {
    const v = await said(
      await fetch(`${base(this, b.shop)}/v2/online-checkout/payment-links`, {
        method: "POST",
        headers: { authorization: `Bearer ${b.key}`, "content-type": "application/json" },
        body: JSON.stringify({
          idempotency_key: `storefront-${b.order}`,
          order: {
            location_id: b.shop.square_location,
            reference_id: b.order,
            line_items: b.lines.map((l) => ({
              name: l.name,
              quantity: String(l.qty),
              base_price_money: { amount: l.price, currency: b.currency },
            })),
          },
          checkout_options: { redirect_url: b.back },
        }),
      }),
      this.name,
    );
    const link = (v.payment_link ?? {}) as Record<string, unknown>;
    return { url: String(link.url ?? ""), ref: String(link.order_id ?? "") };
  },
  async check(ref, shop, key) {
    const v = await said(
      await fetch(`${base(this, shop)}/v2/orders/${encodeURIComponent(ref)}`, {
        headers: { authorization: `Bearer ${key}` },
      }),
      this.name,
    );
    const o = (v.order ?? {}) as Record<string, unknown>;
    const due = (o.net_amount_due_money ?? {}) as Record<string, unknown>;
    const tenders = Array.isArray(o.tenders) ? o.tenders.length : 0;
    return { paid: o.state === "COMPLETED" || (tenders > 0 && Number(due.amount ?? 1) === 0) };
  },
};

// PayPal's key is its two halves as one value, `client id:secret`, since a
// key here is one string.
async function paypalToken(at: string, key: string): Promise<string> {
  const v = await said(
    await fetch(`${at}/v1/oauth2/token`, {
      method: "POST",
      headers: { authorization: `Basic ${btoa(key)}`, "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    }),
    "PayPal",
  );
  return String(v.access_token ?? "");
}

const paypal: Hosted = {
  kind: "hosted",
  id: "paypal",
  name: "PayPal",
  carries: ["PayPal", "Venmo", "Cards"],
  host: "api-m.paypal.com",
  async begin(b) {
    const at = base(this, b.shop);
    const amount = (minor: number) => ({ currency_code: b.currency, value: decimal(minor, b.currency) });
    const v = await said(
      await fetch(`${at}/v2/checkout/orders`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${await paypalToken(at, b.key)}`,
          "content-type": "application/json",
          "paypal-request-id": `storefront-${b.order}`,
        },
        body: JSON.stringify({
          intent: "CAPTURE",
          purchase_units: [{
            reference_id: b.order,
            custom_id: b.order,
            amount: { ...amount(b.total), breakdown: { item_total: amount(b.total) } },
            items: b.lines.map((l) => ({ name: l.name.slice(0, 127), quantity: String(l.qty), unit_amount: amount(l.price) })),
          }],
          payment_source: {
            paypal: { experience_context: { return_url: b.back, cancel_url: b.back, user_action: "PAY_NOW" } },
          },
        }),
      }),
      this.name,
    );
    const links = (Array.isArray(v.links) ? v.links : []) as Array<Record<string, unknown>>;
    const go = links.find((l) => l.rel === "payer-action") ?? links.find((l) => l.rel === "approve");
    return { url: String(go?.href ?? ""), ref: String(v.id ?? "") };
  },
  // The buyer's yes is not the money: an approved order is captured here,
  // and only a completed one is paid.
  async check(ref, shop, key) {
    const at = base(this, shop);
    const headers = { authorization: `Bearer ${await paypalToken(at, key)}`, "content-type": "application/json" };
    const order = `${at}/v2/checkout/orders/${encodeURIComponent(ref)}`;
    let v = await said(await fetch(order, { headers }), this.name);
    if (v.status === "APPROVED") {
      v = await said(
        await fetch(`${order}/capture`, {
          method: "POST",
          headers: { ...headers, "paypal-request-id": `storefront-capture-${ref}` },
        }),
        this.name,
      );
    }
    return { paid: v.status === "COMPLETED" };
  },
};

const venmo: ByHand = {
  kind: "hand",
  id: "venmo",
  name: "Venmo",
  handle: (shop) => (shop.venmo ? `@${shop.venmo}` : ""),
  link: (shop, total, currency, order) =>
    `https://venmo.com/?${new URLSearchParams({ txn: "pay", recipients: shop.venmo, amount: decimal(total, currency), note: order })}`,
};

const cashapp: ByHand = {
  kind: "hand",
  id: "cashapp",
  name: "Cash App",
  handle: (shop) => (shop.cashapp ? `$${shop.cashapp}` : ""),
  link: (shop, total, currency) => `https://cash.app/$${encodeURIComponent(shop.cashapp)}/${decimal(total, currency)}`,
};

const zelle: ByHand = {
  kind: "hand",
  id: "zelle",
  name: "Zelle",
  handle: (shop) => shop.zelle,
};

export const HOSTED: Hosted[] = [stripe, square, paypal];
export const BY_HAND: ByHand[] = [venmo, cashapp, zelle];
export const way = (id: string): Hosted | ByHand | undefined => [...HOSTED, ...BY_HAND].find((w) => w.id === id);
