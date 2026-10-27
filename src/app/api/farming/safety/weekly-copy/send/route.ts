import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { requireCopySender, sendSafetyCopy } from "@/lib/safety/weekly-copy";

/**
 * Sends this week's copy now (owners and admins). The email goes after the
 * check's transaction, never inside one; it's recorded only if the mail
 * server accepts it.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const { organisation, actor } = await withOrganisation(request, body.organisationId, "admin", async (tx, context) => {
    await requireCopySender(tx);
    return { organisation: context.membership.organisation, actor: tx.actor };
  });
  const result = await sendSafetyCopy(organisation, { force: true, actor });
  return json(result);
});
