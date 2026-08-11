// ----------------------------------------------------------------------------------------
// Family Budget — an envelope-lite family budget: money in, money out, one month at a time.
//
// Design axes:
//   privacy:        privacy-public-view  — non-members get a live read-only view;
//                                           space editors record income and expenses.
//   data_storage:   storage-graduating   — starts as LocalTables (encrypted at rest on
//                                           the host, zero ceremony); the OWNER can
//                                           graduate THIS placement's data to shared
//                                           SyncTables so other frames bind the same
//                                           rows. Other placements stay local. This is
//                                           the per-placement graduation pattern — see
//                                           docs/table-graduation.md in this repo.
//   view_realtime:  view-collaborative    — every mutation calls pushToInstance(sfi_id, …)
//                                           so all viewers of the placement refresh live;
//                                           graduated placements also refresh on foreign
//                                           writes via table onChange.
//   settings_scope: settings-per-sfi      — backend choice, bindings, and the currency
//                                           symbol are keyed by sfi_id.
//
// Categories carry a channel (c1–c12) as their identity color, an income flag, and a
// monthly budget (the envelope; 0 = no envelope set, income categories never have one).
// Transactions carry a category row id, an always-positive amount, an optional note,
// and a plain ISO date (yyyy-mm-dd) — month filtering is a string-prefix compare.
// ----------------------------------------------------------------------------------------
import {
  log, serveFileAtPath, jsonReply, parseJsonBody, parsePeerInfo, onUiMessage,
  pushToInstance, sanitizeText, loadJsonFile, saveJsonFile,
  declareTables, ensureTables, table,
} from "@frame-core";

// ----- Schemas (one source of truth for the local AND shared declarations) --------------
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

// ----- LocalTables (the install-time default: encrypted, per-placement, zero ceremony) --
declareTables([
  { key: "categories",   title: "Budget Categories",   description: "Income and expense categories for this placement's budget.", local: true, schema: CATEGORIES_SCHEMA },
  { key: "transactions", title: "Budget Transactions", description: "Transactions for this placement's budget.",                  local: true, schema: TRANSACTIONS_SCHEMA },
]);

// Shared decls are registered LAZILY — declaring a synced table up-front would pop the
// owner's binding modal on frame start (the host refires bindings for every missing
// non-local decl). Only a placement that graduated (or is graduating) registers them.
let sharedDeclsRegistered = false;
function ensureSharedDecls(): void {
  if (sharedDeclsRegistered) return;
  sharedDeclsRegistered = true;
  declareTables([
    {
      key: "categories_shared", title: "Budget Categories",
      description: "Categories of a shared budget. Create a new table, or pick the one other frames should read.",
      schema: CATEGORIES_SCHEMA,
    },
    {
      key: "transactions_shared", title: "Budget Transactions",
      description: "Transactions of a shared budget. Create a new table, or pick the one other frames should read.",
      schema: TRANSACTIONS_SCHEMA,
    },
  ]);
}

// ----- Per-placement settings: backend choice + the currency symbol ---------------------
// pending_graduation modes: "convert" copies this placement's local rows into the freshly
// bound shared tables; "adopt" just binds existing shared tables (no copy — the budget
// shows whatever they contain). Local rows are untouched either way.
type Backend = "local" | "shared";
type GradMode = "convert" | "adopt";
type SfiSettings = { backend: Backend; pending_graduation?: GradMode; currency?: string };
const allSettings: Record<string, SfiSettings> = loadJsonFile(import.meta.url, "settings.json", {});
function getSettings(sfiId: string): SfiSettings {
  const s = allSettings[sfiId];
  return s ? { ...s, backend: s.backend ?? "local" } : { backend: "local" };
}
function saveSettings(sfiId: string, s: SfiSettings): void {
  allSettings[sfiId] = s;
  saveJsonFile(import.meta.url, "settings.json", allSettings);
}

type Tbl = ReturnType<typeof table>;
type Peer = ReturnType<typeof parsePeerInfo>;

/** The placement's data tables, resolved through its backend choice. Same handle API
 * either way — everything below this line is backend-agnostic. */
function dataTables(sfiId: string, s: SfiSettings): { categories: Tbl; transactions: Tbl } {
  const shared = s.backend === "shared";
  return {
    categories: table(shared ? "categories_shared" : "categories", sfiId),
    transactions: table(shared ? "transactions_shared" : "transactions", sfiId),
  };
}

/** True when BOTH shared bindings exist for this placement (post-graduation). */
function sharedBound(sfiId: string): boolean {
  try { table("categories_shared", sfiId); table("transactions_shared", sfiId); return true; } catch { return false; }
}

/** ensureTables, but QUIET and with local tables awaited.
 * Quiet: is_owner stripped, so a missing shared binding never fires the owner's binding
 * modal from a passive path (once one placement graduates, the shared decls exist
 * worker-globally — a plain ensureTables(owner) would pop the picker on every OTHER
 * placement). Only the explicit graduate/waiting paths call ensureTables with owner
 * privilege. Awaited: a fresh placement's local self-ensure is async, so touch missing
 * local tables with a no-op query, then re-read. */
async function readyLocalTables(peer: Peer): Promise<boolean> {
  const quiet = { ...peer, is_owner: false } as Peer;
  let r = ensureTables(quiet);
  const missing = ["categories", "transactions"].filter((k) => !r.byKey[k]);
  if (missing.length) {
    for (const k of missing) {
      try { await table(k, peer.sfi_id).query({ limit: 1 }); } catch (e) { log(`budget: ensure "${k}" failed: ${e}`); }
    }
    r = ensureTables(quiet);
  }
  return !!(r.byKey["categories"] && r.byKey["transactions"]);
}

// ----- Graduation: flip this placement to the freshly bound shared tables ---------------
// "convert" first copies the local rows in. Row ids are PRESERVED (upsert(localRowId, …)
// creates with that id), which keeps the transactions.category_id references valid with
// no remapping and makes a rerun after a partial copy an idempotent overwrite.
// pending_graduation is only cleared after a full pass.
async function runGraduation(sfiId: string, settings: SfiSettings): Promise<void> {
  const mode = settings.pending_graduation!;
  let copied = "";
  if (mode === "convert") {
    const sharedCategories = table("categories_shared", sfiId);
    const sharedTransactions = table("transactions_shared", sfiId);
    const { rows: cats } = await table("categories", sfiId).query({});
    for (const r of cats) {
      await sharedCategories.upsert(r._row_id, {
        name: r.name, channel: r.channel, is_income: r.is_income, monthly_budget: r.monthly_budget,
      });
    }
    const { rows: txs } = await table("transactions", sfiId).query({});
    for (const r of txs) {
      await sharedTransactions.upsert(r._row_id, {
        category_id: r.category_id, amount: r.amount, note: r.note, date: r.date,
      });
    }
    copied = ` (${cats.length} categories, ${txs.length} transactions copied)`;
  }

  settings.backend = "shared";
  delete settings.pending_graduation;
  saveSettings(sfiId, settings);
  wireSharedListeners(sfiId);
  pushToInstance(sfiId, { type: "budget_changed" });
  log(`budget: placement ${sfiId} moved to shared tables (${mode})${copied}`);
}

// Foreign writes to a graduated placement's tables (another frame bound to the same
// table, a peer device) should refresh viewers just like our own writes do. Our own
// writes also fire this — the extra refresh is cheap and keeps the wiring simple.
const wiredShared = new Set<string>();
function wireSharedListeners(sfiId: string): void {
  if (wiredShared.has(sfiId)) return;
  wiredShared.add(sfiId);
  try {
    table("categories_shared", sfiId).onChange(() => notify(sfiId));
    table("transactions_shared", sfiId).onChange(() => notify(sfiId));
  } catch {
    wiredShared.delete(sfiId); // not bound yet — rewired after graduation completes
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
// All joins and aggregation happen here in TS over plain table queries; the month filter
// is a string-prefix compare on the ISO date column.
async function monthData(categories: Tbl, transactions: Tbl, month: string) {
  const { rows: cats } = await categories.query({ order_by: [{ col: "_created_at" }] });
  const { rows: allTx } = await transactions.query({});
  const prefix = month + "-";
  const txMonth = allTx.filter((t) => String(t.date).startsWith(prefix));
  txMonth.sort((a, b) =>
    String(b.date).localeCompare(String(a.date)) || (b._created_at - a._created_at));

  const spent = new Map<string, number>();
  for (const t of txMonth) {
    const k = String(t.category_id);
    spent.set(k, (spent.get(k) ?? 0) + Number(t.amount));
  }
  const catById = new Map<string, (typeof cats)[number]>(cats.map((c) => [c._row_id, c]));
  let income = 0, expenses = 0;
  for (const t of txMonth) {
    const c = catById.get(String(t.category_id));
    if (c && Number(c.is_income) === 1) income += Number(t.amount);
    else expenses += Number(t.amount);
  }
  return {
    categories: cats.map((c) => ({
      id: c._row_id, name: c.name, channel: c.channel,
      is_income: Number(c.is_income), monthly_budget: Number(c.monthly_budget),
      spent: spent.get(c._row_id) ?? 0,
    })),
    transactions: txMonth.map((t) => {
      const c = catById.get(String(t.category_id));
      return {
        id: t._row_id, category_id: t.category_id,
        category_name: c ? c.name : "", channel: c ? c.channel : "c1",
        is_income: c ? Number(c.is_income) : 0,
        amount: Number(t.amount), note: t.note, date: t.date,
      };
    }),
    totals: { income, expenses, balance: income - expenses },
  };
}

function notify(sfiId: string) {
  pushToInstance(sfiId, { type: "budget_changed" });
}

// ----- Writes ---------------------------------------------------------------------------
// One shared mutation path for BOTH transports: the bus dispatcher below (frame.busSend →
// onUiMessage, the primary write path) and the HTTP POST arm in onNetworkRequest (kept for
// older viewers whose framelib has no busSend). `op` is the API path with "api/" stripped
// (e.g. "tx/<id>/delete"); `v` is the parsed payload. Role gates live here so the two
// entry points can never drift. Writes answer { ok: true } — viewers, the sender
// included, render from the budget_changed push.
type WriteResult = { status: number; body: unknown };

async function handleWrite(sfiId: string, op: string, v: Record<string, unknown> | null, peer: Peer): Promise<WriteResult> {
  const settings = getSettings(sfiId);

  // Re-register the shared decls for placements that graduated or are mid-graduation
  // (decls don't survive worker restarts; bindings do).
  if (settings.backend === "shared" || settings.pending_graduation) ensureSharedDecls();

  // Finish a pending graduation the moment both shared bindings exist.
  if (settings.pending_graduation && sharedBound(sfiId)) {
    try { await runGraduation(sfiId, settings); } catch (e) { log(`budget: graduation failed (will retry): ${e}`); }
  }

  // Graduated placement whose bindings are missing (fresh worker on a new host, or the
  // owner closed the picker mid-graduation recovery): every write waits.
  if (settings.backend === "shared" && !sharedBound(sfiId)) {
    return { status: 503, body: { error: "table not bound" } };
  }
  if (settings.backend === "shared") wireSharedListeners(sfiId);

  // Local tables resolve with zero ceremony; awaiting keeps a fresh placement's first
  // request from racing the self-ensure. Quiet — see readyLocalTables.
  if (settings.backend === "local" && !(await readyLocalTables(peer))) {
    return { status: 503, body: { error: "table not ready" } };
  }
  const { categories, transactions } = dataTables(sfiId, settings);

  // Every op below mutates state and is editor-only. Non-members AND Viewer-role
  // members are rejected with the same gate (never gate writes on is_sfi_member —
  // Viewer-role members would slip through).
  if (!peer.is_sfi_editor) return { status: 403, body: { error: "editors only" } };

  const ok = (): WriteResult => {
    notify(sfiId);
    return { status: 200, body: { ok: true } };
  };

  // --- Data backend (owner-only): per-placement graduation local → shared -------------
  if (op === "data/graduate") {
    if (!peer.is_owner) return { status: 403, body: { error: "owner only" } };
    if (settings.backend === "shared") return { status: 400, body: { error: "already shared" } };
    settings.pending_graduation = v?.mode === "adopt" ? "adopt" : "convert";
    saveSettings(sfiId, settings);
    ensureSharedDecls();
    ensureTables(peer); // fires the owner's binding modals (categories, then transactions)
    notify(sfiId);
    return { status: 200, body: { waiting: true } };
  }
  if (op === "data/cancel_graduate") {
    if (!peer.is_owner) return { status: 403, body: { error: "owner only" } };
    delete settings.pending_graduation;
    saveSettings(sfiId, settings);
    notify(sfiId);
    return { status: 200, body: { ok: true } };
  }

  // --- Per-placement settings -----------------------------------------------------------
  if (op === "settings") {
    settings.currency = sanitizeText(v?.currency, 4) || "$";
    saveSettings(sfiId, settings);
    return ok();
  }

  // --- Categories -------------------------------------------------------------------------
  if (op === "category") {
    const name = sanitizeText(v?.name, 60);
    if (!name) return { status: 400, body: { error: "name required" } };
    const channelRaw = typeof v?.channel === "string" ? v.channel : "";
    const existing = (await categories.query({})).rows.length;
    const channel = CHANNEL_RE.test(channelRaw) ? channelRaw : `c${(existing % 12) + 1}`;
    await categories.upsert(null, {
      name, channel, is_income: v?.is_income ? 1 : 0, monthly_budget: 0,
    });
    return ok();
  }

  if (op.startsWith("category/")) {
    const [id, action] = op.slice("category/".length).split("/");
    const row = id ? await categories.get(id) : null;
    if (!id || !row) return { status: 400, body: { error: "bad id" } };
    if (action === "delete") {
      await transactions.deleteWhere({ category_id: id });
      await categories.delete(id);
      return ok();
    }
    if (action) return { status: 404, body: { error: "not found" } };
    if (v?.name !== undefined) {
      const name = sanitizeText(v.name, 60);
      if (name) await categories.upsert(id, { name });
    }
    if (typeof v?.channel === "string" && CHANNEL_RE.test(v.channel)) {
      await categories.upsert(id, { channel: v.channel });
    }
    if (v?.monthly_budget !== undefined) {
      // The envelope: a non-negative number; income categories never carry one.
      if (Number(row.is_income) === 1) {
        await categories.upsert(id, { monthly_budget: 0 });
      } else {
        const n = Number(v.monthly_budget);
        if (Number.isFinite(n) && n >= 0) await categories.upsert(id, { monthly_budget: n });
      }
    }
    return ok();
  }

  // --- Transactions -----------------------------------------------------------------------
  if (op === "tx") {
    const categoryId = typeof v?.category_id === "string" ? v.category_id : "";
    if (!categoryId || !(await categories.get(categoryId))) return { status: 400, body: { error: "bad category" } };
    const amount = Math.abs(Number(v?.amount));
    if (!Number.isFinite(amount) || amount <= 0) return { status: 400, body: { error: "amount required" } };
    const dateRaw = typeof v?.date === "string" ? v.date : "";
    await transactions.upsert(null, {
      category_id: categoryId, amount,
      note: sanitizeText(v?.note, 200),
      date: DATE_RE.test(dateRaw) ? dateRaw : today(),
    });
    return ok();
  }

  if (op.startsWith("tx/")) {
    const [id, action] = op.slice("tx/".length).split("/");
    if (!id || !(await transactions.get(id))) return { status: 400, body: { error: "bad id" } };
    if (action === "delete") {
      await transactions.delete(id);
      return ok();
    }
    if (action) return { status: 404, body: { error: "not found" } };
    if (typeof v?.category_id === "string" && v.category_id && (await categories.get(v.category_id))) {
      await transactions.upsert(id, { category_id: v.category_id });
    }
    if (v?.amount !== undefined) {
      const amount = Math.abs(Number(v.amount));
      if (Number.isFinite(amount) && amount > 0) await transactions.upsert(id, { amount });
    }
    if (v?.note !== undefined) {
      await transactions.upsert(id, { note: sanitizeText(v.note, 200) });
    }
    if (typeof v?.date === "string" && DATE_RE.test(v.date)) {
      await transactions.upsert(id, { date: v.date });
    }
    return ok();
  }

  return { status: 404, body: { error: "not found" } };
}

// ----- Bus dispatcher — the frontend's write path (frame.busSend → BusUiToFrame) --------
// `peer` is the sender's platform-resolved identity, same shape as parsePeerInfo; the
// role gates live inside handleWrite. Denials are logged, not answered — a legitimate
// client never sends a write it isn't allowed to make.
onUiMessage(async (sfiId, data, peer) => {
  if (!sfiId || typeof data !== "object" || data === null) return;
  const d = data as Record<string, unknown>;
  if (typeof d.op !== "string") return;
  const r = await handleWrite(sfiId, d.op, d, peer);
  if (r.status !== 200) log(`budget: bus op ${d.op} → ${r.status} (${JSON.stringify(r.body)})`);
});

// ----- Networking -----------------------------------------------------------------------
self.onNetworkRequest = async function (replyPort, reqPath, method, headers, query, body, cookies) {
  const peer = parsePeerInfo(query, cookies);
  const sfiId = peer.sfi_id;

  // Static assets — open to everyone, including anon read-only viewers.
  if (method === "GET" && !reqPath.startsWith("/api/")) {
    return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url), headers);
  }

  // Identity probe — drives which render mode the frontend shows.
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

  // Writes — the HTTP arm of the shared write path (see handleWrite above).
  if (reqPath.startsWith("/api/") && (method === "POST" || method === "PUT")) {
    const r = await handleWrite(sfiId, reqPath.slice("/api/".length), parseJsonBody<Record<string, unknown>>(body), peer);
    return jsonReply(replyPort, r.status, r.body);
  }

  const settings = getSettings(sfiId);

  // Re-register the shared decls for placements that graduated or are mid-graduation
  // (decls don't survive worker restarts; bindings do).
  if (settings.backend === "shared" || settings.pending_graduation) ensureSharedDecls();

  // Finish a pending graduation the moment both shared bindings exist.
  if (settings.pending_graduation && sharedBound(sfiId)) {
    try { await runGraduation(sfiId, settings); } catch (e) { log(`budget: graduation failed (will retry): ${e}`); }
  }
  // Mid-graduation and the picker was dismissed (or the app restarted): the owner's
  // next look at the budget brings it back. Pending is an explicit owner-initiated
  // state, so the auto-refire is wanted here, unlike the quiet passive paths.
  if (settings.pending_graduation && peer.is_owner && !sharedBound(sfiId)
      && reqPath === "/api/month" && method === "GET") {
    ensureTables(peer);
  }

  // Graduated placement whose bindings are missing (fresh worker on a new host, or the
  // owner closed the picker mid-graduation recovery): every data route waits; the month
  // route re-fires the owner's binding modal so they can finish.
  if (settings.backend === "shared" && !sharedBound(sfiId)) {
    if (reqPath === "/api/month" && method === "GET") {
      if (peer.is_owner) ensureTables(peer);
      return jsonReply(replyPort, 200, {
        waiting_for_binding: true, is_owner: peer.is_owner,
        storage: { backend: settings.backend, pending: false, can_manage: peer.is_owner },
      });
    }
    return jsonReply(replyPort, 503, { error: "table not bound" });
  }
  if (settings.backend === "shared") wireSharedListeners(sfiId);

  // Local tables resolve with zero ceremony; awaiting keeps a fresh placement's first
  // request from racing the self-ensure. Quiet — see readyLocalTables.
  if (settings.backend === "local" && !(await readyLocalTables(peer))) {
    return jsonReply(replyPort, 503, { error: "table not ready" });
  }
  const { categories, transactions } = dataTables(sfiId, settings);

  // Read — open to everyone (non-members get a read-only view of this placement's month).
  if (reqPath === "/api/month" && method === "GET") {
    const monthRaw = typeof query?.month === "string" ? query.month : "";
    const month = MONTH_RE.test(monthRaw) ? monthRaw : new Date().toISOString().slice(0, 7);
    // First-open seeding: an editor's first look at an empty budget lands the starter
    // categories (no transactions, no envelopes preset). Never seeded for read-only
    // viewers — a GET from a viewer must not mutate.
    if (peer.is_sfi_editor && settings.backend === "local"
        && (await categories.query({ limit: 1 })).rows.length === 0) {
      for (const [name, channel, isIncome] of SEED_CATEGORIES) {
        await categories.upsert(null, { name, channel, is_income: isIncome, monthly_budget: 0 });
      }
    }
    return jsonReply(replyPort, 200, {
      month,
      settings: { currency: settings.currency || "$" },
      storage: {
        backend: settings.backend,
        pending: !!settings.pending_graduation,
        can_manage: peer.is_owner,
      },
      ...(await monthData(categories, transactions, month)),
    });
  }

  return jsonReply(replyPort, 404, { error: "not found" });
};

log("Family Budget frame is up and running!");
