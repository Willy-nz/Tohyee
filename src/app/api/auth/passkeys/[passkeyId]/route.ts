import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { removeOwnPasskey, renamePasskey } from "@/lib/auth/passkeys";

type Context = { params: Promise<{ passkeyId: string }> };

/** PATCH `{ name }`: renames one of your passkeys (#450). */
export const PATCH = route<Context>(async (request, context) => {
  const auth = await requireAuth(request);
  const { passkeyId } = await context.params;
  const body = await readJson(request);
  return json({ passkey: await renamePasskey(auth, passkeyId, { name: body.name }) });
});

/** DELETE: removes one of your passkeys; sessions it signed in (other than this one) end. */
export const DELETE = route<Context>(async (request, context) => {
  const auth = await requireAuth(request);
  const { passkeyId } = await context.params;
  await removeOwnPasskey(auth, passkeyId);
  return json({ ok: true });
});
