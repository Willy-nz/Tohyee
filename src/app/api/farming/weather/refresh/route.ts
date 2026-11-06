import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { requireOrganisationRole } from "@/lib/auth/guard";
import { assertDemoAllows } from "@/lib/demo/guard";
import { parseOrganisationId } from "@/lib/organisations/registry";
import { refreshWeather } from "@/lib/weather/service";

/** POST: refreshes the forecast now (decision 1544). Bookkeepers and up; at most once every 15 minutes, as each refresh uses API units. */
export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  const body = await readJson(request);
  const membership = await requireOrganisationRole(auth, parseOrganisationId(body.organisationId), "bookkeeper");
  assertDemoAllows(request, membership.organisation);
  const result = await refreshWeather(membership.organisation, { userId: auth.user.id, email: auth.user.email, role: membership.role }, { manual: true });
  return json({ result });
});
