import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { getWiseStatus, syncWise } from "@/lib/bank/wise/service";

/** Sync now: every linked Wise currency. Bookkeepers. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const { organisation, actor } = await withOrganisation(request, body.organisationId, "bookkeeper", async (_tx, { auth, membership }) => ({
    organisation: membership.organisation,
    actor: { userId: auth.user.id, email: auth.user.email },
  }));
  const result = await syncWise(organisation, actor);
  const wise = await withOrganisation(request, body.organisationId, "viewer", (tx) => getWiseStatus(tx));
  return json({ result, wise });
});
