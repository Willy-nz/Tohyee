import { json, route, searchParams } from "@/lib/api/http";
import { analyticsMember } from "@/lib/analytics/http";
import { listObjects } from "@/lib/analytics/databases/connections";

type Context = { params: Promise<{ connectionId: string }> };

/** The tables and views the connection's user can see. Admins and owners. */
export const GET = route<Context>(async (request, context) => {
  const { connectionId } = await context.params;
  const { organisation, actor } = await analyticsMember(request, searchParams(request).get("organisationId"), "admin");
  const objects = await listObjects(organisation, actor, /^[1-9]\d{0,17}$/.test(connectionId) ? connectionId : "0");
  return json({ objects });
});
