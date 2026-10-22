import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { authenticate, requireServerAdmin } from "@/lib/auth/guard";
import { getGoogleSignInSettings, saveGoogleSignInSettings } from "@/lib/auth/google-sign-in";
import { roleAtLeast } from "@/lib/auth/roles";
import { listMembershipsForUser } from "@/lib/organisations/registry";

async function answer(request: Request, userId: string) {
  const memberships = await listMembershipsForUser(userId);
  return {
    settings: await getGoogleSignInSettings(request),
    // Organisations whose Google app this admin may copy (they're an admin or owner there).
    organisations: memberships.filter((m) => roleAtLeast(m.role, "admin")).map((m) => ({ id: m.organisation.id, displayName: m.organisation.displayName })),
  };
}

/** GET: Sign in with Google's server settings (#424). Server admins, on the server computer. */
export const GET = route(async (request) => {
  const auth = await authenticate(request);
  requireServerAdmin(auth, request);
  return json(await answer(request, auth.user.id));
});

/** PUT `{ enabled, clientId, clientSecret? }`: saves them (a blank secret keeps the saved one). */
export const PUT = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  const body = await readJson(request);
  await saveGoogleSignInSettings(auth.user, { enabled: body.enabled, clientId: body.clientId, clientSecret: body.clientSecret });
  return json(await answer(request, auth.user.id));
});
