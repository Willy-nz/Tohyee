import { json, readJson, route } from "@/lib/api/http";
import { analyticsMember } from "@/lib/analytics/http";
import { previewQuery } from "@/lib/analytics/databases/connections";

type Context = { params: Promise<{ connectionId: string }> };

/**
 * A table's or a typed SELECT's columns, how each would load and the first
 * 20 rows ({ schema, table } or { query }). Admins and owners.
 */
export const POST = route<Context>(async (request, context) => {
  const { connectionId } = await context.params;
  const body = await readJson(request);
  const { organisation, actor } = await analyticsMember(request, body.organisationId, "admin");
  return json(await previewQuery(organisation, actor, /^[1-9]\d{0,17}$/.test(connectionId) ? connectionId : "0", body));
});
