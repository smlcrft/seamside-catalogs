// ----------------------------------------------------------------------------------------
// API:
//   bus op "roll"    — roll for this placement (frame.busSend; POST /api/roll kept as the
//                      HTTP fallback); the result is pushed via BusFrameToUi to every live
//                      viewer of the placement (pushToInstance keyed by sfi_id).
//   GET  /api/state  — return the last roll for this placement { value, sides }
// ----------------------------------------------------------------------------------------
import { log, serveFileAtPath, pushToInstance, parsePeerInfo, jsonReply, loadJsonFile, onUiMessage } from "@frame-core";
// --
const settings = { roll_time_ms: 1000, sides: 6, ...loadJsonFile<Partial<{ roll_time_ms: number; sides: number }>>(import.meta.url, "settings.json", {}) };
// --
const lastRoll = new Map<string, number>(); // Per-placement last-roll value (keyed by sfi_id).
// Perform a roll for a placement and push the animated result to every viewer of it.
// Shared by the bus dispatcher and the HTTP fallback; rolling is a write, so it gates
// on the sender's editor role.
function doRoll(sfi_id: string, peer: ReturnType<typeof parsePeerInfo>): boolean {
  if (!sfi_id || !peer.is_sfi_editor) return false;
  const value = Math.ceil(Math.random() * settings.sides);
  lastRoll.set(sfi_id, value);
  pushToInstance(sfi_id, { type: "rolled", value, sides: settings.sides, roll_time_ms: settings.roll_time_ms });
  return true;
}
// -- Bus writes (frame.busSend → BusUiToFrame); denials are logged, not answered --
onUiMessage((sfi_id, data, peer) => {
  const d = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  if (d.op === "roll" && !doRoll(sfi_id, peer)) log("dice roller: bus op roll denied");
});
// -- HTTP routes --
self.onNetworkRequest = async function (replyPort, reqPath, method, _headers, query, _body, cookies) {
  const peer = parsePeerInfo(query, cookies);
  if (reqPath === "/api/roll" && method === "POST") {
    if (doRoll(peer.sfi_id, peer)) replyPort.postMessage({ status: 204, contentType: "text/plain", body: null });
    else jsonReply(replyPort, 403, { error: "editor only" });
  } else if (reqPath === "/api/state" && method === "GET") {
    jsonReply(replyPort, 200, { value: lastRoll.get(peer.sfi_id) ?? 0, sides: settings.sides });
  } else if (method === "GET") {
    serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url));
  } else {
    replyPort.postMessage({ status: 404, body: JSON.stringify({ error: "Not found.", code: "NOT_FOUND" }), contentType: "application/json" });
  }
};
// --
log("Dice roller frame is up and running!");
