import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { refreshSimpleFinAccounts } from "@/lib/bank/simplefin/service";

/** Asks SimpleFIN for its account list again (no transactions), to link an account added in the Bridge. Admins. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const { organisation, actor } = await withOrganisation(request, body.organisationId, "admin", async (_tx, { auth, membership }) => ({
    organisation: membership.organisation,
    actor: { userId: auth.user.id, email: auth.user.email },
  }));
  return json({ simplefin: await refreshSimpleFinAccounts(organisation, actor, body.connectionId) });
});
