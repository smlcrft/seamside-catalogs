// ASCII Runner — the page is the whole game; this half only serves its files.
import type { Ctx } from "@frame-core";

export default {
  fetch(request: Request, ctx: Ctx): Promise<Response> | Response {
    if (request.method === "GET") return ctx.file(new URL(request.url).pathname);
    return Response.json({ error: "Method not allowed.", code: "METHOD_NOT_ALLOWED" }, { status: 405 });
  },
};
