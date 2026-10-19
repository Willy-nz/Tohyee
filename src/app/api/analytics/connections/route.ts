import { json, readJson, route, searchParams } from "@/lib/api/http";
import { analyticsMember } from "@/lib/analytics/http";
import { checkConnectionInput, listConnections, requireAnalyticsOn, saveNewConnection } from "@/lib/analytics/databases/connections";
import { withOrganisationTransaction } from "@/lib/db/org-transaction";

/**
 * External database connections for Analytics (decisions 602-604). Admins
 * and owners only, as with every source setup; passwords are never sent back.
 */
export const GET = route(async (request) => {
  const { organisation, actor } = await analyticsMember(request, searchParams(request).get("organisationId"), "admin");
  const connections = await withOrganisationTransaction(organisation, actor, async (tx) => {
    await requireAnalyticsOn(tx);
    return listConnections(tx);
  }, { readOnly: true });
  return json({ connections });
});

/** Tests the connection, then saves it (name, engine, host, port, instanceName, database, username, password, encryption). */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const { organisation, actor } = await analyticsMember(request, body.organisationId, "admin");
  await withOrganisationTransaction(organisation, actor, (tx) => requireAnalyticsOn(tx), { readOnly: true });
  const checked = await checkConnectionInput(organisation, actor, body);
  const connection = await withOrganisationTransaction(organisation, actor, (tx) => saveNewConnection(tx, body, checked.settings, checked.password));
  return json({ connection, test: checked.result }, { status: 201 });
});
