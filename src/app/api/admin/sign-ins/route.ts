import { json, requireAuth, route, searchParams } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { listSignIns, unseenFlags } from "@/lib/auth/sign-in-log";

/** GET `?flagged=true&remote=true&email=`: the sign-in log, newest first, and how many flags are new (#208). Server admins, on the server computer. */
export const GET = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  const params = searchParams(request);
  const events = await listSignIns({ flaggedOnly: params.get("flagged") === "true", remoteOnly: params.get("remote") === "true", email: params.get("email"), limit: params.get("limit") ? Number(params.get("limit")) || 500 : 500 });
  return json({ events, unseen: await unseenFlags() });
});
