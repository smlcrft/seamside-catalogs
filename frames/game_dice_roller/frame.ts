// ----------------------------------------------------------------------------------------
// API:
//   POST /api/roll   — roll for this session: 204, or 403 for anyone below collaborator.
//                      Every open page is told to read again ({ game_dice_roller: "roll" }).
//                      Editors roll; others watch.
//   GET  /api/state  — the session's last roll { value, sides, can_roll, roll_time_ms, n }:
//                      `n` counts rolls, so a page tells a new roll from the one it showed.
//                      Held in memory: a restarted worker starts at "?".
// ----------------------------------------------------------------------------------------
import type { Ctx } from "@frame-core";

const settings = { roll_time_ms: 1000, sides: 6 };

/** Per-session last roll, keyed by ctx.frame. */
const lastRoll = new Map<string, { value: number; n: number }>();

const json = (v: unknown, status = 200) => Response.json(v, { status });

export default {
  fetch(request: Request, ctx: Ctx): Promise<Response> | Response {
    const { pathname } = new URL(request.url);
    const editor = ctx.peer.is_sfi_editor || ctx.peer.is_owner;

    if (pathname === "/api/roll" && request.method === "POST") {
      if (!editor) return json({ error: "editor only" }, 403);
      const n = (lastRoll.get(ctx.frame)?.n ?? 0) + 1;
      lastRoll.set(ctx.frame, { value: Math.ceil(Math.random() * settings.sides), n });
      ctx.push({ game_dice_roller: "roll" });
      return new Response(null, { status: 204 });
    }
    if (pathname === "/api/state" && request.method === "GET") {
      const last = lastRoll.get(ctx.frame);
      return json({
        value: last?.value ?? 0, sides: settings.sides, can_roll: editor,
        roll_time_ms: settings.roll_time_ms, n: last?.n ?? 0,
      });
    }
    if (request.method === "GET") return ctx.file(pathname);
    return json({ error: "Not found.", code: "NOT_FOUND" }, 404);
  },
};
