import { json, readJson, route } from "@/lib/api/http";
import { analyticsMember } from "@/lib/analytics/http";
import { runLoad } from "@/lib/analytics/sources";

type Context = { params: Promise<{ sourceId: string }> };

/** Loads the source now and waits until it's done. Admins and owners. */
export const POST = route<Context>(async (request, context) => {
  const { sourceId } = await context.params;
  const body = await readJson(request);
  const { organisation, actor } = await analyticsMember(request, body.organisationId, "admin");
  const run = await runLoad(organisation, actor, /^\d{1,18}$/.test(sourceId) ? sourceId : "0", "manual");
  return json({ run });
});
