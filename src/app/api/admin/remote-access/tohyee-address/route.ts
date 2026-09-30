import { json, requireAuth, route } from "@/lib/api/http";
import { authenticate, requireServerAdmin } from "@/lib/auth/guard";
import { checkAddressService } from "@/lib/remote/address-service";
import { getTohyeeAddress, releaseTohyeeAddress } from "@/lib/remote/settings";

/** GET: whether the Tohyee address service is answering (it may not be deployed yet). Server admins only. */
export const GET = route(async (request) => {
  const auth = await authenticate(request);
  requireServerAdmin(auth, request);
  return json({ addressService: await checkAddressService() });
});

/** POST: gets this server's Tohyee address (or turns the one it has back on) and starts the connector. */
export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  return json({ remoteAccess: await getTohyeeAddress(auth) });
});

/** DELETE: gives the Tohyee address back to the service and forgets it. */
export const DELETE = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  return json({ remoteAccess: await releaseTohyeeAddress(auth) });
});
