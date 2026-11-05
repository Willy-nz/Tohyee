import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { requestReprocess } from "@/lib/farming/vegetation/service";

type Context = { params: Promise<{ sceneId: string }> };

/** Works out a kept date again with today's paddock boundaries (decision 1528). Earlier numbers stay. Owners and admins. */
export const POST = route<Context>(async (request, context) => {
  const { sceneId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "admin", (tx) => requestReprocess(tx, sceneId));
  return json(result);
});
