import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { removeLauncher } from "@/lib/farming/launchers";

type Context = { params: Promise<{ launcherId: string }> };

/** Removes a farm app tile. Admins. */
export const DELETE = route<Context>(async (request, context) => {
  const { launcherId } = await context.params;
  const launchers = await withOrganisation(request, searchParams(request).get("organisationId"), "admin", (tx) => removeLauncher(tx, launcherId));
  return json({ launchers });
});
