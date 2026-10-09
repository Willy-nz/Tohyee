import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { authenticate } from "@/lib/auth/guard";
import { endOwnSessions, listSessions } from "@/lib/auth/session-list";

/** GET: where you're signed in (#208). */
export const GET = route(async (request) => {
  const auth = await authenticate(request);
  return json({ sessions: await listSessions(auth.user.id, auth.sessionId) });
});

/** DELETE `{ id }` (16 characters from the list) or `{ id: "others" }`: signs that session, or every other one, out. */
export const DELETE = route(async (request) => {
  const auth = await requireAuth(request);
  const body = await readJson(request);
  const ended = await endOwnSessions(auth.user.id, auth.sessionId, body.id);
  return json({ ended, sessions: await listSessions(auth.user.id, auth.sessionId) });
});
