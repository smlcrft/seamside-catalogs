// Storefront's pure part: money, the menu, a cart priced from it, an order's
// code. No network and no storage, so `deno test` drives all of it.

export interface Item {
  id: string;
  name: string;
  description: string;
  /** In the currency's smallest unit (cents), so no sum ever rounds. */
  price: number;
  min_qty: number;
  /** 0 is no limit. */
  max_qty: number;
  step: number;
  available: boolean;
  sort: number;
  /** A picture's file name beside the offerings table, or none. */
  image: string;
}

export interface Line {
  id: string;
  name: string;
  price: number;
  qty: number;
}

export interface Shop {
  name: string;
  currency: string;
  open: boolean;
  /** One line shown with the menu: where to pick up, when. */
  note: string;
  /** The logo's file name beside the shop table, or none. */
  logo: string;
  /** The channel the shop wears, `c1`…`c12`; none is the frame's own. */
  color: string;
  venmo: string;
  cashapp: string;
  zelle: string;
  square_location: string;
  /** A processor's API served somewhere else, for a check. */
  stand_in: string;
}

export type Status = "pending" | "awaiting" | "paid" | "cancelled" | "expired";

export interface Order {
  id: string;
  at: number;
  status: Status;
  total: number;
  currency: string;
  summary: string;
  items_json: string;
  buyer: string;
  note: string;
  /** How it is being paid, once chosen. */
  way: string;
  /** The processor's own name for the payment. */
  ref: string;
  paid_at: number;
}

export const MAX_LINES = 40;
export const MAX_QTY = 999;
/** A hosted checkout page lasts a day; an order nobody paid goes with it. */
export const PENDING_MS = 24 * 60 * 60 * 1000;

export const text = (v: unknown, max: number) =>
  // deno-lint-ignore no-control-regex
  String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

const whole = (v: unknown, fallback: number, min: number, max: number) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

export function currencyOf(v: unknown): string {
  const c = String(v ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) return "USD";
  try {
    new Intl.NumberFormat("en", { style: "currency", currency: c });
    return c;
  } catch {
    return "USD";
  }
}

/** How many decimal places a currency is written with: 2 for USD, 0 for JPY. */
export function decimals(currency: string): number {
  return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

/** `1250` → `"12.50"`: what a processor that takes decimal strings is sent. */
export function decimal(minor: number, currency: string): string {
  const d = decimals(currency);
  return (minor / 10 ** d).toFixed(d);
}

export function money(minor: number, currency: string): string {
  return new Intl.NumberFormat("en", { style: "currency", currency }).format(minor / 10 ** decimals(currency));
}

export function shopOf(row: Record<string, unknown> | null): Shop {
  const r = row ?? {};
  return {
    name: text(r.name, 80),
    currency: currencyOf(r.currency),
    open: r.open !== false,
    note: text(r.note, 200),
    logo: imageName(r.logo),
    color: /^c([1-9]|1[0-2])$/.test(String(r.color ?? "")) ? String(r.color) : "",
    venmo: text(r.venmo, 40).replace(/^@/, ""),
    cashapp: text(r.cashapp, 40).replace(/^\$/, ""),
    zelle: text(r.zelle, 80),
    square_location: text(r.square_location, 40),
    stand_in: /^https?:\/\/[^\s]+$/.test(String(r.stand_in ?? "")) ? String(r.stand_in).replace(/\/+$/, "") : "",
  };
}

export function itemOf(row: Record<string, unknown>): Item | null {
  const name = text(row.name, 80);
  const id = text(row.id, 64);
  if (!id || !name) return null;
  const step = whole(row.step, 1, 1, MAX_QTY);
  const min = whole(row.min_qty, 1, 1, MAX_QTY);
  const max = whole(row.max_qty, 0, 0, MAX_QTY);
  return {
    id,
    name,
    description: text(row.description, 280),
    price: whole(row.price, 0, 0, 100_000_000),
    min_qty: min,
    max_qty: max && max < min ? min : max,
    step,
    available: row.available !== false,
    sort: whole(row.sort, 0, 0, 1_000_000),
    image: imageName(row.image),
  };
}

// ------------------------------------------------------------------ pictures

/** A picture is kept small: the page sizes it down before it is sent. */
export const MAX_IMAGE_BYTES = 1024 * 1024;

const KINDS: Array<{ ext: string; type: string; is: (b: Uint8Array) => boolean }> = [
  { ext: "jpg", type: "image/jpeg", is: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: "png", type: "image/png", is: (b) => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v) },
  {
    ext: "webp",
    type: "image/webp",
    is: (b) => [0x52, 0x49, 0x46, 0x46].every((v, i) => b[i] === v) && [0x57, 0x45, 0x42, 0x50].every((v, i) => b[i + 8] === v),
  },
];

/** What a picture is, read from its first bytes and never from its name: a
 *  JPEG, a PNG or a WebP. Anything else — an SVG, which can carry a script,
 *  among them — is no picture here. */
export function pictureOf(bytes: Uint8Array): { ext: string; type: string } | null {
  if (bytes.length < 12 || bytes.length > MAX_IMAGE_BYTES) return null;
  const k = KINDS.find((k) => k.is(bytes));
  return k ? { ext: k.ext, type: k.type } : null;
}

/** A picture's name as this frame writes them, or none: never a path. */
export function imageName(v: unknown): string {
  const s = String(v ?? "");
  return /^[a-z0-9][a-z0-9_-]{0,63}\.(jpg|png|webp)$/.test(s) ? s : "";
}

export const imageType = (name: string) => KINDS.find((k) => name.endsWith(`.${k.ext}`))?.type ?? "";

export const bySort = (a: Item, b: Item) => a.sort - b.sort || a.name.localeCompare(b.name);

/** Whether `qty` is one this item is sold in: at least its least, at most its
 *  most, and a whole number of steps above its least. */
export function qtyAllowed(item: Item, qty: number): boolean {
  if (!Number.isInteger(qty) || qty < item.min_qty || qty > MAX_QTY) return false;
  if (item.max_qty && qty > item.max_qty) return false;
  return (qty - item.min_qty) % item.step === 0;
}

/** A cart priced from the menu as it stands: what the buyer sent is ids and
 *  quantities, never a price. */
export function priced(
  menu: Item[],
  asked: unknown,
): { lines: Line[]; total: number } | { error: string } {
  if (!Array.isArray(asked) || !asked.length) return { error: "Nothing was chosen." };
  if (asked.length > MAX_LINES) return { error: "That is too many items for one order." };
  const lines: Line[] = [];
  for (const a of asked as Array<Record<string, unknown>>) {
    const item = menu.find((m) => m.id === String(a?.id ?? ""));
    if (!item || !item.available) return { error: "Something you chose is no longer sold. Look at the menu again." };
    if (lines.some((l) => l.id === item.id)) return { error: "An item was listed twice." };
    const qty = Number(a?.qty);
    if (!qtyAllowed(item, qty)) return { error: `${item.name} is not sold in that amount.` };
    lines.push({ id: item.id, name: item.name, price: item.price, qty });
  }
  const total = lines.reduce((t, l) => t + l.price * l.qty, 0);
  if (total <= 0) return { error: "There is nothing to pay for." };
  return { lines, total };
}

export const summary = (lines: Line[]) => lines.map((l) => `${l.qty} × ${l.name}`).join(", ");

/** Eight characters a person can read out and type into a payment's note:
 *  no 0, O, 1, I or L. It is also what opens the order, so it is random. */
export function code(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const A = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  return [...random(8)].map((b) => A[b % A.length]).join("");
}

export const isCode = (v: unknown) => /^[2-9A-HJKMNP-Z]{8}$/.test(String(v ?? ""));

/** What an order's buyer, holding its code, is shown: never who else bought. */
export function receipt(o: Order) {
  return {
    code: o.id,
    at: o.at,
    status: o.status,
    total: o.total,
    currency: o.currency,
    summary: o.summary,
    way: o.way,
    paid_at: o.paid_at,
  };
}

export const stale = (o: Order, now: number) =>
  (o.status === "pending" || o.status === "awaiting") && now - o.at > PENDING_MS;

/** Where the buyer is sent back to: the shop's public address, and nothing a
 *  script could be written in. A processor keeps what it is sent, so the
 *  address carries no key: a fragment stays only when it is a bare address,
 *  which is how a viewer on this machine names a published thing. */
export function returnTo(v: unknown, order: string): string | null {
  const u = httpsOrLocal(v);
  if (!u) return null;
  if (!/^#[ybndrfg8ejkmcpqxot1uwisza345h769]{52}(\/[^:#]*)?$/.test(u.hash)) u.hash = "";
  u.searchParams.delete("s");
  u.searchParams.set("order", order);
  return u.href;
}

/** Where a buyer is sent when the shop opens only with a key (published by
 *  link, or to members): the viewer's own page that sends them back to the
 *  tab they paid from. It names nothing of the shop, so a processor keeps
 *  nothing that opens it; the shop's tab sees the payment by asking. */
export function doneAt(v: unknown): string | null {
  const u = httpsOrLocal(v);
  if (!u) return null;
  const local = /(^|\.)localhost$|^127\.0\.0\.1$/.test(u.hostname);
  const host = u.host.replace(/^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}\./, "");
  return `${u.protocol}//${host}${local ? "/v/" : "/"}paid.html`;
}

function httpsOrLocal(v: unknown): URL | null {
  let u: URL;
  try {
    u = new URL(String(v ?? ""));
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && /(^|\.)localhost$|^127\.0\.0\.1$/.test(u.hostname))) return null;
  return u;
}
