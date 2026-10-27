import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { authenticate } from "@/lib/auth/guard";
import { finishAddingPasskey, getPasskeyStatus } from "@/lib/auth/passkeys";

/** GET: your passkeys on Your account (#450), and whether passkeys work on this address. */
export const GET = route(async (request) => {
  const auth = await authenticate(request);
  return json({ passkeys: await getPasskeyStatus(request, auth) }, { headers: { "cache-control": "no-store" } });
});

/** POST `{ response, name }`: adds the passkey the browser just made (after /options). */
export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  const body = await readJson(request, { maxBytes: 64 * 1024 });
  const passkey = await finishAddingPasskey(request, auth, { response: body.response, name: body.name });
  return json({ passkey }, { status: 201 });
});
