import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { requireOrganisationRole } from "@/lib/auth/guard";
import { assertDemoAllows } from "@/lib/demo/guard";
import { parseOrganisationId } from "@/lib/organisations/registry";
import { testWeatherConnection } from "@/lib/weather/service";

/** POST: tests the key with MetService, costing one API unit (decision 1545). Admins. */
export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  const body = await readJson(request);
  const membership = await requireOrganisationRole(auth, parseOrganisationId(body.organisationId), "admin");
  assertDemoAllows(request, membership.organisation);
  const test = await testWeatherConnection(membership.organisation, { userId: auth.user.id, email: auth.user.email, role: membership.role });
  return json({ test });
});
