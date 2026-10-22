import { json, readJson, requireAuth, route, withOrganisation } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { getGoogleSignInSettings, saveGoogleSignInSettings } from "@/lib/auth/google-sign-in";
import { googleApp } from "@/lib/crm/mail/service";

/**
 * POST `{ organisationId, enabled? }`: uses the Google app an organisation
 * already has (Settings › Email, also used for Gmail and Google Analytics)
 * for signing in. Needs a server admin who is also an admin or owner there.
 */
export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  const body = await readJson(request);
  const { app, organisationId } = await withOrganisation(request, body.organisationId, "admin", async (tx) => ({ app: await googleApp(tx), organisationId: tx.organisationId }));
  await saveGoogleSignInSettings(auth.user, { enabled: body.enabled }, { app, organisationId });
  return json({ settings: await getGoogleSignInSettings(request) });
});
