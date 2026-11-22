import { api } from "./api";
import { authorize } from "./authorize";

/** Everything outside `/mcp` that reaches the Worker: `/authorize` and the dashboard API. */
export const defaultHandler: ExportedHandler<Env> = {
  fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === "/authorize") return authorize(request, env);
    if (pathname.startsWith("/api/")) return api(request, env, ctx);
    return Response.json({ error: "Not found." }, { status: 404 });
  },
};
