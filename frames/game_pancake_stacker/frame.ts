// ----------------------------------------------------------------------------------------
// Pancake Stacker — solo arcade game. Scores are the space's `pancake_scores` table: one
// row per player holding their best, so every session of the frame in the space shares
// one board and the space's best is the highest row. Everyone plays their own game; an
// editor's finished game is recorded, pushed live.
// ----------------------------------------------------------------------------------------
import {
  log, serveFileAtPath, jsonReply, parseJsonBody, parsePeerInfo,
  declareTables, table, sanitizeText, pushToInstance, onUiMessage,
} from "@frame-core";

type Peer = ReturnType<typeof parsePeerInfo>;
type HighScore = { high: number; updated_at: number; holder: string };

declareTables([{
  key: "pancake_scores",
  title: "Pancake Stacker scores",
  description: "Each player's best stack in this space.",
  local: true,
  schema: [
    { name: "name",  col_type: "text",    nullable: false, default_val: "" },
    { name: "score", col_type: "integer", nullable: false, default_val: "0" },
    { name: "at",    col_type: "integer", nullable: false, default_val: "0" },
  ],
}]);
const scores = () => table("pancake_scores");

async function getScore(): Promise<HighScore> {
  const { rows } = await scores().query({ order_by: [{ col: "score", dir: "desc" }, { col: "at", dir: "asc" }], limit: 1 });
  const top = rows[0];
  return top ? { high: Number(top.score) || 0, updated_at: Number(top.at) || 0, holder: String(top.name ?? "") }
             : { high: 0, updated_at: 0, holder: "" };
}

/** A player's row: their person, or the keeper, who has no roster name. */
function playerOf(peer: Peer): { id: string; name: string } {
  const id = (peer.user_id || (peer.is_owner ? "owner" : "")).replace(/[^A-Za-z0-9_-]/g, "_");
  return { id, name: sanitizeText(peer.user_name || (peer.is_owner ? "the owner" : "anon"), 64) };
}

// Record a finished game's score. Shared by the bus dispatcher and the HTTP fallback;
// submitting is a write, so it gates on the sender's editor role. The result is pushed
// to every live viewer — the submitter included, which is how their HUD updates.
async function mutSubmit(sfi: string, score: unknown, peer: Peer): Promise<{ status: number; body: unknown }> {
  if (!peer.is_sfi_editor) return { status: 403, body: { error: "editor only" } };
  const raw = Number(score ?? 0);
  const candidate = Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0;
  const current = await getScore();
  const new_record = candidate > current.high;
  const me = playerOf(peer);
  const mine = me.id ? await scores().get(me.id) : null;
  if (me.id && candidate > (Number(mine?.score) || 0)) {
    await scores().upsert(me.id, { name: me.name, score: candidate, at: Date.now() });
  }
  const updated = new_record ? await getScore() : current;
  pushToInstance(sfi, { type: "score", score: updated, new_record });
  return { status: 200, body: { score: updated, new_record } };
}

// Bus writes (frame.busSend → BusUiToFrame); denials are logged, not answered.
onUiMessage(async (sfiId, data, peer) => {
  if (!sfiId || typeof data !== "object" || data === null) return;
  const d = data as Record<string, unknown>;
  if (d.op === "submit") {
    const r = await mutSubmit(sfiId, d.score, peer);
    if (r.status !== 200) log(`pancake stacker: bus op submit → ${r.status}`);
  }
});

self.onNetworkRequest = async function (replyPort, reqPath, method, _headers, query, body, cookies) {
  const peer = parsePeerInfo(query, cookies);
  const sfi = peer.sfi_id || "default";

  if (method === "GET" && !reqPath.startsWith("/api/")) {
    return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url));
  }

  if (reqPath === "/api/state" && method === "GET") {
    return jsonReply(replyPort, 200, {
      score: await getScore(),
      viewer: peer.user_name || "anon",
      can_record: peer.is_sfi_editor,
    });
  }

  if (reqPath === "/api/submit" && method === "POST") {
    const data = parseJsonBody<{ score?: unknown }>(body);
    const r = await mutSubmit(sfi, data?.score, peer);
    return jsonReply(replyPort, r.status, r.body);
  }

  return jsonReply(replyPort, 404, { error: "not found" });
};