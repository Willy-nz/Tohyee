import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { startAddingPasskey } from "@/lib/auth/passkeys";
import { assertSignInRate } from "@/lib/auth/rate-limit";

/** POST `{ password }`: the options for the browser's "create a passkey" prompt (#450), after your password again. */
export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  assertSignInRate(request);
  const body = await readJson(request);
  const options = await startAddingPasskey(request, auth, { password: body.password });
  return json({ options }, { headers: { "cache-control": "no-store" } });
});
