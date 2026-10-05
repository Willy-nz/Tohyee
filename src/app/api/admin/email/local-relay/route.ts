import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { authenticate, requireServerAdmin } from "@/lib/auth/guard";
import { getLocalMailRelay, updateLocalMailRelay } from "@/lib/email/local-relay";

/** GET: whether organisations may send through a mail server on this computer or its local network. Server admins only. */
export const GET = route(async (request) => {
  const auth = await authenticate(request);
  requireServerAdmin(auth, request);
  return json({ localRelay: await getLocalMailRelay() });
});

/** Turns "Allow local mail relay" on or off: `allowed` (true or false). Server admins only; recorded in the server's audit trail. */
export const PUT = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  return json({ localRelay: await updateLocalMailRelay(auth, await readJson(request)) });
});
