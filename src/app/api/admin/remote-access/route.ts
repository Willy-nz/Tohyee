import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { authenticate, requireServerAdmin } from "@/lib/auth/guard";
import { applyRemoteAccess, getRemoteAccess, updateRemoteAccess } from "@/lib/remote/settings";

/** GET: remote access settings and the tunnel connector's state (the token is never returned). Server admins only. */
export const GET = route(async (request) => {
  const auth = await authenticate(request);
  requireServerAdmin(auth);
  return json({ remoteAccess: await getRemoteAccess() });
});

/** Saves remote access: `enabled`, `tunnelToken` (blank keeps it), `publicUrl`; `clear: true` removes it. */
export const PUT = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth);
  return json({ remoteAccess: await updateRemoteAccess(auth, await readJson(request)) });
});

/** Restarts the tunnel connector with the saved settings. */
export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth);
  const { stopTunnel } = await import("@/lib/remote/tunnel");
  stopTunnel();
  await applyRemoteAccess();
  return json({ remoteAccess: await getRemoteAccess() });
});
