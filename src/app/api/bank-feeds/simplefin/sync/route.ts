import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { getSimpleFinStatus, syncSimpleFin } from "@/lib/bank/simplefin/service";

/** Sync now: every linked account, in one go. Bookkeepers. Refused at 20 requests in 24 hours. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const { organisation, actor } = await withOrganisation(request, body.organisationId, "bookkeeper", async (_tx, { auth, membership }) => ({
    organisation: membership.organisation,
    actor: { userId: auth.user.id, email: auth.user.email },
  }));
  const result = await syncSimpleFin(organisation, actor, { manual: true });
  const simplefin = await withOrganisation(request, body.organisationId, "viewer", (tx) => getSimpleFinStatus(tx));
  return json({ result, simplefin });
});
