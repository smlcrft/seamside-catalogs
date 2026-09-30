// ----------------------------------------------------------------------------------------
// Family Budget — an envelope-lite family budget: money in, money out, one month at a time.
//
// Design axes:
//   privacy:        privacy-public-view  — anyone who reaches the frame gets a live
//                                           read-only view of the month; space editors
//                                           record income and expenses. The page reads no
//                                           table: the month comes from GET /api/month,
//                                           and every write is a route here.
//   data_storage:   the space's tables   — `budget_categories` and `budget_transactions`
//                                           (`<name>.table.jsonl` at the space's root),
//                                           synced with the space.
//   view_realtime:  view-collaborative    — every write pushes `{ family_budget: "month" }`,
//                                           which says what to read again and never what
//                                           it holds, so every open page refreshes live.
//   settings_scope: the space            — the currency symbol is the `budget_currency`
//                                           row of `__fc_settings`, its value JSON under `v`.
//
// Categories carry a channel (c1–c12) as their identity color, an income flag, and a
// monthly budget (the envelope; 0 = no envelope set, income categories never have one).
// Transactions carry a category row id, an always-positive amount, an optional note,
// and a plain ISO date (yyyy-mm-dd) — month filtering is a string-prefix compare.
// ----------------------------------------------------------------------------------------
import type { Ctx } from "@frame-core";
import { declareTables, sanitizeText } from "@frame-core";

// ----- Schemas ----------------------------------------------------------------------------
const CATEGORIES = "budget_categories";
const TRANSACTIONS = "budget_transactions";
const SETTINGS = "__fc_settings";

const CATEGORIES_SCHEMA = [
  { name: "name",           col_type: "text" as const,    nullable: false, default_val: "" },
  { name: "channel",        col_type: "text" as const,    nullable: false, default_val: "c1" },
  { name: "is_income",      col_type: "integer" as const, nullable: false, default_val: "0" },
  { name: "monthly_budget", col_type: "real" as const,    nullable: false, default_val: "0" },
];
const TRANSACTIONS_SCHEMA = [
  { name: "category_id", col_type: "text" as const, nullable: false, default_val: "" },
  { name: "amount",      col_type: "real" as const, nullable: false, default_val: "0" },
  { name: "note",        col_type: "text" as const, nullable: false, default_val: "" },
  { name: "date",        col_type: "text" as const, nullable: false, default_val: "" },
];

// ----- The space's tables, named for this frame so no other frame's rows land in them ---
declareTables([
  { key: CATEGORIES,   title: "Budget Categories",   description: "Income and expense categories of this space's budget.", schema: CATEGORIES_SCHEMA },
  { key: TRANSACTIONS, title: "Budget Transactions", description: "Transactions of this space's budget.",                  schema: TRANSACTIONS_SCHEMA },
]);

type Row = Record<string, unknown> & { id: string };
type Schema = typeof CATEGORIES_SCHEMA | typeof TRANSACTIONS_SCHEMA;

const rows = (ctx: Ctx, name: string) => ctx.table<Record<string, unknown>>(name);

const defaultsOf = (schema: Schema): Record<string, unknown> => Object.fromEntries(
  schema.map((c) => [c.name, c.col_type === "text" ? c.default_val : Number(c.default_val)]),
);
const DEFAULTS: Record<string, Record<string, unknown>> = {
  [CATEGORIES]: defaultsOf(CATEGORIES_SCHEMA),
  [TRANSACTIONS]: defaultsOf(TRANSACTIONS_SCHEMA),
  [SETTINGS]: {},
};

/** Write a row over what it held (a new one from the schema's defaults), stamped. */
async function keep(ctx: Ctx, name: string, id: string | null, values: Record<string, unknown>): Promise<Row> {
  const was = id ? await rows(ctx, name).get(id) : null;
  const now = Date.now();
  return await rows(ctx, name).upsert({
    ...(was ?? { ...DEFAULTS[name], _created_at: now }),
    ...values,
    ...(id ? { id } : {}),
    _modified_at: now,
  });
}

async function currency(ctx: Ctx): Promise<string> {
  const row = await rows(ctx, SETTINGS).get("budget_currency");
  try {
    return (row?.v == null ? "" : String(JSON.parse(String(row.v)))) || "$";
  } catch {
    return "$";
  }
}

const CHANNEL_RE = /^c([1-9]|1[0-2])$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Seed structure, not fake content: categories only, no transactions, no envelopes preset.
const SEED_CATEGORIES: Array<[string, string, number]> = [
  ["pay", "c5", 1],
  ["groceries", "c4", 0], ["rent", "c2", 0], ["utilities", "c7", 0],
  ["fun", "c3", 0], ["transport", "c8", 0], ["dining out", "c6", 0],
];

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ----- Queries --------------------------------------------------------------------------
// All joins and aggregation happen here over the tables' rows; the month filter is a
// string-prefix compare on the ISO date column.
async function monthData(ctx: Ctx, month: string) {
  const cats = (await rows(ctx, CATEGORIES).all())
    .sort((a, b) => Number(a._created_at ?? 0) - Number(b._created_at ?? 0));
  const allTx = await rows(ctx, TRANSACTIONS).all();
  const prefix = month + "-";
  const txMonth = allTx.filter((t) => String(t.date).startsWith(prefix));
  txMonth.sort((a, b) =>
    String(b.date).localeCompare(String(a.date)) || (Number(b._created_at ?? 0) - Number(a._created_at ?? 0)));

  const spent = new Map<string, number>();
  for (const t of txMonth) {
    const k = String(t.category_id);
    spent.set(k, (spent.get(k) ?? 0) + Number(t.amount));
  }
  const catById = new Map<string, Row>(cats.map((c) => [c.id, c]));
  let income = 0, expenses = 0;
  for (const t of txMonth) {
    const c = catById.get(String(t.category_id));
    if (c && Number(c.is_income) === 1) income += Number(t.amount);
    else expenses += Number(t.amount);
  }
  return {
    categories: cats.map((c) => ({
      id: c.id, name: c.name, channel: c.channel,
      is_income: Number(c.is_income), monthly_budget: Number(c.monthly_budget),
      spent: spent.get(c.id) ?? 0,
    })),
    transactions: txMonth.map((t) => {
      const c = catById.get(String(t.category_id));
      return {
        id: t.id, category_id: t.category_id,
        category_name: c ? c.name : "", channel: c ? c.channel : "c1",
        is_income: c ? Number(c.is_income) : 0,
        amount: Number(t.amount), note: t.note, date: t.date,
      };
    }),
    totals: { income, expenses, balance: income - expenses },
  };
}

// What changed, never what it holds: each page reads again as whoever it is.
const tell = (ctx: Ctx) => ctx.push({ family_budget: "month" });

const json = (v: unknown, status = 200) => Response.json(v, { status });

// deno-lint-ignore no-explicit-any
async function body(request: Request): Promise<Record<string, any> | null> {
  try {
    const v = JSON.parse(await request.text());
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

// ----- Writes ---------------------------------------------------------------------------
// `op` is the API path with "/api/" stripped (e.g. "tx/<id>/delete"); `v` is the parsed
// payload. Writes answer { ok: true }; every page, the writer's included, reads again.
// deno-lint-ignore no-explicit-any
async function write(ctx: Ctx, op: string, v: Record<string, any> | null): Promise<Response> {
  // Every op below mutates state and is editor-only: strangers AND viewer-role members
  // are refused by the same gate.
  if (!(ctx.peer.is_sfi_editor || ctx.peer.is_owner)) return json({ error: "editors only" }, 403);

  const ok = () => {
    tell(ctx);
    return json({ ok: true });
  };

  // --- The space's settings ------------------------------------------------------------
  if (op === "settings") {
    await keep(ctx, SETTINGS, "budget_currency", { v: JSON.stringify(sanitizeText(v?.currency, 4) || "$") });
    return ok();
  }

  // --- Categories -------------------------------------------------------------------------
  if (op === "category") {
    const name = sanitizeText(v?.name, 60);
    if (!name) return json({ error: "name required" }, 400);
    const channelRaw = typeof v?.channel === "string" ? v.channel : "";
    const existing = (await rows(ctx, CATEGORIES).all()).length;
    const channel = CHANNEL_RE.test(channelRaw) ? channelRaw : `c${(existing % 12) + 1}`;
    await keep(ctx, CATEGORIES, null, { name, channel, is_income: v?.is_income ? 1 : 0, monthly_budget: 0 });
    return ok();
  }

  if (op.startsWith("category/")) {
    const [id, action] = op.slice("category/".length).split("/");
    const row = id ? await rows(ctx, CATEGORIES).get(id) : null;
    if (!id || !row) return json({ error: "bad id" }, 400);
    if (action === "delete") {
      for (const t of await rows(ctx, TRANSACTIONS).all()) {
        if (t.category_id === id) await rows(ctx, TRANSACTIONS).delete(t.id);
      }
      await rows(ctx, CATEGORIES).delete(id);
      return ok();
    }
    if (action) return json({ error: "not found" }, 404);
    const next: Record<string, unknown> = {};
    if (v?.name !== undefined) {
      const name = sanitizeText(v.name, 60);
      if (name) next.name = name;
    }
    if (typeof v?.channel === "string" && CHANNEL_RE.test(v.channel)) next.channel = v.channel;
    if (v?.monthly_budget !== undefined) {
      // The envelope: a non-negative number; income categories never carry one.
      if (Number(row.is_income) === 1) next.monthly_budget = 0;
      else {
        const n = Number(v.monthly_budget);
        if (Number.isFinite(n) && n >= 0) next.monthly_budget = n;
      }
    }
    if (Object.keys(next).length) await keep(ctx, CATEGORIES, id, next);
    return ok();
  }

  // --- Transactions -----------------------------------------------------------------------
  if (op === "tx") {
    const categoryId = typeof v?.category_id === "string" ? v.category_id : "";
    if (!categoryId || !(await rows(ctx, CATEGORIES).get(categoryId))) return json({ error: "bad category" }, 400);
    const amount = Math.abs(Number(v?.amount));
    if (!Number.isFinite(amount) || amount <= 0) return json({ error: "amount required" }, 400);
    const dateRaw = typeof v?.date === "string" ? v.date : "";
    await keep(ctx, TRANSACTIONS, null, {
      category_id: categoryId, amount,
      note: sanitizeText(v?.note, 200),
      date: DATE_RE.test(dateRaw) ? dateRaw : today(),
    });
    return ok();
  }

  if (op.startsWith("tx/")) {
    const [id, action] = op.slice("tx/".length).split("/");
    if (!id || !(await rows(ctx, TRANSACTIONS).get(id))) return json({ error: "bad id" }, 400);
    if (action === "delete") {
      await rows(ctx, TRANSACTIONS).delete(id);
      return ok();
    }
    if (action) return json({ error: "not found" }, 404);
    const next: Record<string, unknown> = {};
    if (typeof v?.category_id === "string" && v.category_id && (await rows(ctx, CATEGORIES).get(v.category_id))) {
      next.category_id = v.category_id;
    }
    if (v?.amount !== undefined) {
      const amount = Math.abs(Number(v.amount));
      if (Number.isFinite(amount) && amount > 0) next.amount = amount;
    }
    if (v?.note !== undefined) next.note = sanitizeText(v.note, 200);
    if (typeof v?.date === "string" && DATE_RE.test(v.date)) next.date = v.date;
    if (Object.keys(next).length) await keep(ctx, TRANSACTIONS, id, next);
    return ok();
  }

  return json({ error: "not found" }, 404);
}

// ----- Networking -----------------------------------------------------------------------
export default {
  async fetch(request: Request, ctx: Ctx): Promise<Response> {
    const { pathname, searchParams } = new URL(request.url);
    const editor = ctx.peer.is_sfi_editor || ctx.peer.is_owner;
    const member = editor || ctx.peer.is_sfi_member;

    // Static assets — open to everyone, including read-only visitors.
    if (request.method === "GET" && !pathname.startsWith("/api/")) return ctx.file(pathname);

    // Who the door says is asking — drives which render mode the page shows.
    if (pathname === "/api/whoami" && request.method === "GET") {
      return json({
        is_anon:       ctx.peer.is_anon,
        is_sfi_member: member,
        is_sfi_editor: editor,
        is_owner:      ctx.peer.is_owner,
        user_id:       ctx.peer.user_id,
        user_name:     ctx.peer.user_name,
        space_color:   ctx.peer.space_color,
      });
    }

    if (pathname.startsWith("/api/") && (request.method === "POST" || request.method === "PUT")) {
      return write(ctx, pathname.slice("/api/".length), await body(request));
    }

    // Read — open to everyone (a read-only view of the month).
    if (pathname === "/api/month" && request.method === "GET") {
      const monthRaw = searchParams.get("month") ?? "";
      const month = MONTH_RE.test(monthRaw) ? monthRaw : new Date().toISOString().slice(0, 7);
      // First-open seeding: an editor's first look at an empty budget lands the starter
      // categories (no transactions, no envelopes preset). Never for read-only visitors —
      // a GET from them must not write.
      if (editor && (await rows(ctx, CATEGORIES).all()).length === 0) {
        for (const [name, channel, isIncome] of SEED_CATEGORIES) {
          await keep(ctx, CATEGORIES, null, { name, channel, is_income: isIncome, monthly_budget: 0 });
        }
      }
      return json({ month, settings: { currency: await currency(ctx) }, ...(await monthData(ctx, month)) });
    }

    return json({ error: "not found" }, 404);
  },
};
