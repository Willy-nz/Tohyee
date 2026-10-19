import { json, readJson, route } from "@/lib/api/http";
import { analyticsMember } from "@/lib/analytics/http";
import { checkConnectionInput, requireAnalyticsOn } from "@/lib/analytics/databases/connections";
import { withOrganisationTransaction } from "@/lib/db/org-transaction";

/**
 * Tests connection details without saving them. With connectionId and no
 * password, the saved password is used, but only for the same server,
 * database and user. Admins and owners.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const { organisation, actor } = await analyticsMember(request, body.organisationId, "admin");
  await withOrganisationTransaction(organisation, actor, (tx) => requireAnalyticsOn(tx), { readOnly: true });
  const savedId = body.connectionId === undefined || body.connectionId === null || body.connectionId === "" ? undefined : String(body.connectionId);
  const { result } = await checkConnectionInput(organisation, actor, body, savedId);
  return json({ ok: true, ...result });
});
