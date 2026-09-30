// ----------------------------------------------------------------------------------------
// Pancake Stacker — solo arcade game. Scores are the space's `pancake_scores` table: one
// row per player holding their best, so every session of the frame in the space shares
// one board and the space's best is the highest row. Everyone plays their own game; an
// editor's finished game is recorded here, and a new best tells every open page to read
// again ({ game_pancake_stacker: "score" }).
// ----------------------------------------------------------------------------------------
import type { Ctx, PeerInfo } from "@frame-core";
import { declareTables, parseJsonBody, sanitizeText } from "@frame-core";

type HighScore = { high: number; updated_at: number; holder: string };
type Row = Record<string, unknown> & { id: string };

const SCORES = "pancake_scores";
const SCHEMA = [{
  key: SCORES,
  title: "Pancake Stacker scores",
  description: "Each player's best stack in this space.",
  local: true,
  schema: [
    { name: "name",  col_type: "text" as const,    nullable: false, default_val: "" },
    { name: "score", col_type: "integer" as const, nullable: false, default_val: "0" },
    { name: "at",    col_type: "integer" as const, nullable: false, default_val: "0" },
  ],
}];
declareTables(SCHEMA);

/** A new row starts from the schema's defaults, as installed copies' rows did. */
const DEFAULTS: Record<string, unknown> = Object.fromEntries(
  SCHEMA[0].schema.map((c) => [c.name, c.col_type === "integer" ? Number(c.default_val) : c.default_val]),
);

const scores = (ctx: Ctx) => ctx.table<Record<string, unknown>>(SCORES);

/** Write a row over what it held, stamped when it was made and when it changed. */
async function keep(ctx: Ctx, id: string, values: Record<string, unknown>): Promise<void> {
  const was = await scores(ctx).get(id);
  const now = Date.now();
  await scores(ctx).upsert({ ...(was ?? { ...DEFAULTS, _created_at: now }), ...values, id, _modified_at: now });
}

async function getScore(ctx: Ctx): Promise<HighScore> {
  const top = (await scores(ctx).all() as Row[])
    .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0) || (Number(a.at) || 0) - (Number(b.at) || 0))[0];
  return top ? { high: Number(top.score) || 0, updated_at: Number(top.at) || 0, holder: String(top.name ?? "") }
             : { high: 0, updated_at: 0, holder: "" };
}

/** A player's row: their person, or the keeper, who has no roster name. */
function playerOf(peer: PeerInfo): { id: string; name: string } {
  const id = (peer.user_id || (peer.is_owner ? "owner" : "")).replace(/[^A-Za-z0-9_-]/g, "_");
  return { id, name: sanitizeText(peer.user_name || (peer.is_owner ? "the owner" : "anon"), 64) };
}

// Record a finished game's score. Submitting is a write, so it is an editor's.
async function submit(ctx: Ctx, score: unknown): Promise<Response> {
  if (!(ctx.peer.is_sfi_editor || ctx.peer.is_owner)) return Response.json({ error: "editor only" }, { status: 403 });
  const raw = Number(score ?? 0);
  const candidate = Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0;
  const current = await getScore(ctx);
  const new_record = candidate > current.high;
  const me = playerOf(ctx.peer);
  const mine = me.id ? await scores(ctx).get(me.id) : null;
  if (me.id && candidate > (Number(mine?.score) || 0)) {
    await keep(ctx, me.id, { name: me.name, score: candidate, at: Date.now() });
  }
  const updated = new_record ? await getScore(ctx) : current;
  if (new_record) ctx.push({ game_pancake_stacker: "score" });
  return Response.json({ score: updated, new_record });
}

export default {
  async fetch(request: Request, ctx: Ctx): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (request.method === "GET" && !pathname.startsWith("/api/")) return ctx.file(pathname);

    if (pathname === "/api/state" && request.method === "GET") {
      return Response.json({
        score: await getScore(ctx),
        viewer: ctx.peer.user_name || "anon",
        can_record: ctx.peer.is_sfi_editor || ctx.peer.is_owner,
      });
    }

    if (pathname === "/api/submit" && request.method === "POST") {
      const data = parseJsonBody<{ score?: unknown }>(await request.arrayBuffer());
      return submit(ctx, data?.score);
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },
};
